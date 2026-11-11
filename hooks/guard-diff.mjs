#!/usr/bin/env node
// Stop：检查本会话内的改动（新增文档、环境事实、删测试/加 skip、文档远多于代码），同一组问题只提醒一次
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readInput, emit, runHook, git, gitRoot, gitStatus, fileHash, loadState, saveState, snapshot } from './lib.mjs';
import { reviewChanges } from './checks.mjs';

function addedLines(root, entry) {
    if (entry.code.includes('D')) return [];
    if (entry.code === '??') return wholeFile(root, entry.path);
    let out;
    try {
        out = git(root, ['diff', '-U0', 'HEAD', '--', entry.path]);
    } catch {
        return wholeFile(root, entry.path); // 仓库还没有任何提交
    }
    const added = [];
    let ln = 0;
    for (const l of out.split('\n')) {
        const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (h) {
            ln = Number(h[1]);
        } else if (l.startsWith('+') && !l.startsWith('+++')) {
            added.push({ line: ln++, text: l.slice(1) });
        }
    }
    return added;
}

function wholeFile(root, rel) {
    try {
        const buf = fs.readFileSync(path.join(root, rel));
        if (buf.length > 512 * 1024 || buf.subarray(0, 8000).includes(0)) return [];
        return buf.toString('utf8').split('\n').map((text, i) => ({ line: i + 1, text }));
    } catch {
        return [];
    }
}

function allowDocs(root) {
    try {
        return JSON.parse(fs.readFileSync(path.join(root, '.agent-tidy.json'), 'utf8')).allowDocs || [];
    } catch {
        return [];
    }
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

    const changes = gitStatus(root)
        .filter((e) => state.baseline[e.path] !== fileHash(root, e.path))
        .map((e) => ({ ...e, added: addedLines(root, e) }));
    const findings = reviewChanges(changes, allowDocs(root));
    if (!findings.length) return;

    const key = crypto.createHash('sha1').update(findings.join('\n')).digest('hex');
    if (state.reminded.includes(key)) return;
    state.reminded.push(key);
    saveState(input, root, state);

    emit({
        decision: 'block',
        reason: `[agent-tidy] 结束前请检查以下问题：\n- ${findings.join('\n- ')}\n`
            + `请修正；如果确实是用户要求的，向用户说明后再结束。`,
    });
});
