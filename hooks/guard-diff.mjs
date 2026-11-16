#!/usr/bin/env node
// Stop：检查本会话内的改动（文档数量、环境事实、测试、代码与文档/注释的一致性），同一组问题只提醒一次
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readInput, emit, runHook, git, gitRoot, gitStatus, fileHash, loadState, saveState, snapshot } from './lib.mjs';
import { reviewChanges, resolveConfig, TEST_FILE } from './checks.mjs';

// 一次 git diff 取全部已跟踪改动，按文件拆出新增/删除行
function trackedDiff(root) {
    const files = new Map();
    let out;
    try {
        out = git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', 'HEAD']);
    } catch {
        return null; // 仓库还没有任何提交
    }
    let cur = null;
    let oldPath = null;
    let ln = 0;
    let oldLn = 0;
    for (const l of out.split('\n')) {
        if (l.startsWith('--- ')) {
            oldPath = l === '--- /dev/null' ? null : l.slice(6);
        } else if (l.startsWith('+++ ')) {
            const p = l === '+++ /dev/null' ? oldPath : l.slice(6);
            cur = { added: [], removed: [] };
            files.set(p, cur);
        } else if (l.startsWith('@@')) {
            const h = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
            if (h) [oldLn, ln] = [Number(h[1]), Number(h[2])];
        } else if (cur && l.startsWith('+')) {
            cur.added.push({ line: ln++, text: l.slice(1) });
        } else if (cur && l.startsWith('-')) {
            cur.removed.push({ line: oldLn++, text: l.slice(1) });
        }
    }
    return files;
}

function readText(root, rel) {
    try {
        const buf = fs.readFileSync(path.join(root, rel));
        if (buf.length > 512 * 1024 || buf.subarray(0, 8000).includes(0)) return null;
        return buf.toString('utf8');
    } catch {
        return null;
    }
}

function wholeFile(root, rel) {
    const text = readText(root, rel);
    return text === null ? [] : text.split('\n').map((t, i) => ({ line: i + 1, text: t }));
}

function grepLines(root, args) {
    try {
        return git(root, ['grep', '-n', '-I', ...args]).split('\n').filter(Boolean).map((l) => {
            const m = l.match(/^(.*?):(\d+):(.*)$/);
            return m && { file: m[1], line: Number(m[2]), text: m[3] };
        }).filter(Boolean);
    } catch {
        return []; // 没有匹配时 git grep 返回 1
    }
}

function loadConfig(root) {
    const file = path.join(root, '.agent-reins.json');
    let raw;
    if (fs.existsSync(file)) {
        try {
            raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            return { ...resolveConfig(undefined, { hasOpenspec: fs.existsSync(path.join(root, 'openspec')) }), error: `不是合法 JSON（${e.message}）` };
        }
    }
    return resolveConfig(raw, { hasOpenspec: fs.existsSync(path.join(root, 'openspec')) });
}

await runHook(async () => {
    const input = await readInput();
    const root = gitRoot(input.cwd);
    if (!root) return;

    const state = loadState(input, root);
    if (!state) {
        // 没有会话基线（例如 hook 安装前已开始的会话）：现在建立，避免把历史改动算到本会话
        saveState(input, root, { root, baseline: snapshot(root), reminded: [] });
        return;
    }

    const entries = gitStatus(root).filter((e) => state.baseline[e.path] !== fileHash(root, e.path));
    if (!entries.length) return;
    const diff = trackedDiff(root);
    const changes = entries.map((e) => {
        if (e.code === '??' || !diff) return { ...e, added: wholeFile(root, e.path), removed: [] };
        return { ...e, ...(diff.get(e.path) || { added: [], removed: [] }) };
    });

    const { config, error } = loadConfig(root);
    const findings = reviewChanges({
        changes,
        config,
        repoHasTests: git(root, ['ls-files']).split('\n').some((f) => TEST_FILE.test(f)),
        readFile: (rel) => readText(root, rel),
        refsTo: (ids, exclude) => {
            const skip = new Set(exclude);
            return grepLines(root, ['-w', '-F', ...ids.flatMap((id) => ['-e', id]), '--', '.', ':(exclude).scratch'])
                .filter((r) => !skip.has(r.file))
                .flatMap((r) => ids.filter((id) => new RegExp(`\\b${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(r.text))
                    .map((id) => ({ id, file: r.file, line: r.line })));
        },
        docRefsTo: (targets) => grepLines(root, ['-F', ...targets.flatMap((t) => ['-e', t, '-e', path.basename(t)]), '--', '*.md', '*.mdx']),
    });
    if (error) findings.push(`.agent-reins.json 格式错误：${error}。已按默认配置检查，请修正。`);
    if (!findings.length) return;

    const key = crypto.createHash('sha1').update(findings.join('\n')).digest('hex');
    if (state.reminded.includes(key)) return;
    state.reminded.push(key);
    saveState(input, root, state);

    emit({
        decision: 'block',
        reason: `[agent-reins] 结束前请检查以下问题：\n- ${findings.join('\n- ')}\n`
            + `请修正；如果确实是用户要求的或确认无关，向用户说明后再结束。`,
    });
});
