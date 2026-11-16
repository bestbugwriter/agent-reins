#!/usr/bin/env node
// Stop：检查本会话内的改动（含会话中的提交）：文档数量、环境事实、测试、代码与文档/注释的一致性，同一组问题只提醒一次
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readInput, agentArg, emit, runHook, git, gitRoot, gitStatus, fileHash, loadState, saveState, updateState, snapshot, gitHead, EMPTY_TREE } from './lib.mjs';
import { reviewChanges, resolveConfig, TEST_FILE } from './checks.mjs';

// 一次 git diff 取 base 到工作区的全部已跟踪改动（含会话中的提交），按文件拆出新增/删除行
function trackedDiff(root, base) {
    const files = new Map();
    let out;
    try {
        out = git(root, ['diff', '-U0', '--no-color', '--no-ext-diff', base]);
    } catch {
        return null;
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

// diff --name-status -z：R/C 的旧路径在前、新路径在后（与 status porcelain 相反）
function changedEntries(root, base) {
    let out;
    try {
        out = git(root, ['diff', '--name-status', '-M', '-z', base]);
    } catch {
        return [];
    }
    const parts = out.split('\0').filter(Boolean);
    const entries = [];
    for (let i = 0; i < parts.length; i++) {
        const code = `${parts[i][0]} `;
        if (code[0] === 'R' || code[0] === 'C') {
            entries.push({ code, from: parts[i + 1], path: parts[i + 2] });
            i += 2;
        } else {
            entries.push({ code, path: parts[i + 1] });
            i += 1;
        }
    }
    return entries;
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
    let file = path.join(root, '.agent-reins.json');
    if (!fs.existsSync(file)) file = path.join(root, '.agent-tidy.json'); // 旧名配置兼容读取
    let raw;
    if (fs.existsSync(file)) {
        try {
            raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (e) {
            return { ...resolveConfig(undefined, { hasOpenspec: fs.existsSync(path.join(root, 'openspec')) }), error: `${path.basename(file)} 不是合法 JSON（${e.message}）` };
        }
    }
    const resolved = resolveConfig(raw, { hasOpenspec: fs.existsSync(path.join(root, 'openspec')) });
    if (resolved.error) resolved.error = `${path.basename(file)}：${resolved.error}`;
    return resolved;
}

await runHook(async () => {
    const input = await readInput();
    const agent = agentArg();
    const root = gitRoot(input.cwd);
    if (!root) return;

    let state = loadState(input, root);
    if (!state) {
        // 没有会话基线（例如 hook 安装前已开始的会话）：现在建立，避免把历史改动算到本会话
        saveState(input, root, { root, baseline: snapshot(root), baselineCommit: gitHead(root), reminded: [] });
        return;
    }
    const head = gitHead(root);
    if (state.baselineCommit === undefined) {
        state.baselineCommit = head; // 旧版本状态：只查此后的提交
        saveState(input, root, state);
    } else if (state.baselineCommit && head && state.baselineCommit !== head) {
        try {
            git(root, ['merge-base', '--is-ancestor', state.baselineCommit, head]);
        } catch {
            // 会话中切了分支：跨分支 diff 会把无关文件全算进来，重建基线
            state = { root, baseline: snapshot(root), baselineCommit: head, reminded: [] };
            saveState(input, root, state);
        }
    }

    // base 到工作区的 diff 天然包含会话中的提交；无提交历史时用空树，覆盖"会话中首次提交"
    const base = state.baselineCommit || (head ? EMPTY_TREE : null);
    const candidates = new Map();
    if (base) for (const e of changedEntries(root, base)) candidates.set(e.path, e);
    for (const e of gitStatus(root)) if (e.code === '??' || !candidates.has(e.path)) candidates.set(e.path, e);
    // 内容与基线一致的不算本会话改动（会话前就脏、被原样提交的文件也排除）
    const entries = [...candidates.values()].filter((e) => state.baseline[e.path] !== fileHash(root, e.path));
    if (!entries.length) return;
    const diff = base ? trackedDiff(root, base) : null;
    const changes = entries.map((e) => {
        if (e.code === '??' || !diff) return { ...e, added: wholeFile(root, e.path), removed: [] };
        return { ...e, ...(diff.get(e.path) || { added: [], removed: [] }) };
    });

    const { config, error } = loadConfig(root);
    const findings = reviewChanges({
        changes,
        config,
        repoHasTests: git(root, ['ls-files']).split('\n').some((f) => TEST_FILE.test(f)),
        testsRun: (state.tests || []).length > 0,
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
    if (error) findings.push(`${error}。已按默认配置检查，请修正。`);
    if (!findings.length) return;

    const key = crypto.createHash('sha1').update(findings.join('\n')).digest('hex');
    if (state.reminded.includes(key)) return;
    updateState(input, root, (s) => { (s.reminded ??= []).push(key); });

    const reason = `[agent-reins] 结束前请检查以下问题：\n- ${findings.join('\n- ')}\n`
        + `请修正；如果确实是用户要求的或确认无关，向用户说明后再结束。`;
    if (agent === 'kimi') {
        // Kimi 用 exit 2 + stderr 阻断；exitCode 让 stderr 写完再退出，hook 出错时仍 fail-open
        process.stderr.write(`${reason}\n`);
        process.exitCode = 2;
        return;
    }
    emit({ decision: 'block', reason });
});