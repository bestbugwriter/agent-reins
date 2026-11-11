// hooks 公共工具：读取 stdin、输出决策、会话状态、git 变更
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export async function readInput() {
    if (process.stdin.isTTY) return {};
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    try {
        return JSON.parse(raw || '{}');
    } catch {
        return {};
    }
}

export function agentArg() {
    const i = process.argv.indexOf('--agent');
    return i > 0 ? process.argv[i + 1] : 'claude';
}

export function emit(obj) {
    process.stdout.write(JSON.stringify(obj));
}

// hook 自身出错时不能阻断 agent：报到 stderr，正常退出
export async function runHook(main) {
    try {
        await main();
    } catch (e) {
        process.stderr.write(`[agent-tidy] hook 出错（已跳过）：${e && e.stack ? e.stack : e}\n`);
    }
}

function stateFile(input, root) {
    const key = input.session_id || input.thread_id || `cwd-${root}`;
    const name = crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 16);
    const dir = path.join(os.tmpdir(), 'agent-tidy');
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${name}.json`);
}

export function loadState(input, root) {
    try {
        return JSON.parse(fs.readFileSync(stateFile(input, root), 'utf8'));
    } catch {
        return null;
    }
}

export function saveState(input, root, state) {
    fs.writeFileSync(stateFile(input, root), JSON.stringify(state));
}

export function git(root, args) {
    return execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 64 * 1024 * 1024,
    });
}

export function gitRoot(cwd) {
    try {
        return git(cwd || process.cwd(), ['rev-parse', '--show-toplevel']).trim();
    } catch {
        return null;
    }
}

// 返回 [{ code: 'XY', path }]，包含未跟踪文件（逐个列出）
export function gitStatus(root) {
    const out = git(root, ['status', '--porcelain=v1', '-z', '-uall']);
    const parts = out.split('\0').filter(Boolean);
    const entries = [];
    for (let i = 0; i < parts.length; i++) {
        const code = parts[i].slice(0, 2);
        entries.push({ code, path: parts[i].slice(3) });
        if (code[0] === 'R' || code[0] === 'C') i++; // 重命名带一个原路径
    }
    return entries.slice(0, 5000);
}

export function fileHash(root, rel) {
    const abs = path.join(root, rel);
    try {
        const st = fs.statSync(abs);
        if (!st.isFile()) return 'not-file';
        if (st.size > 5 * 1024 * 1024) return `big-${st.size}-${st.mtimeMs}`;
        return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
    } catch {
        return 'missing';
    }
}

export function snapshot(root) {
    const files = {};
    for (const e of gitStatus(root)) files[e.path] = fileHash(root, e.path);
    return files;
}
