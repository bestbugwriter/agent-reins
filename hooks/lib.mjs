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

// macOS 的 os.freemem() 不含可回收的文件缓存，数值常常只有几百 MB，会让 agent 误判内存不足；
// 按活动监视器的口径用 free + inactive + speculative + purgeable 估算可用内存
export function availableMemory(platform = process.platform, vmStat = () => execFileSync('vm_stat', { encoding: 'utf8' })) {
    if (platform !== 'darwin') return os.freemem(); // Linux 下 libuv 返回 MemAvailable
    try {
        const out = vmStat();
        const page = Number(out.match(/page size of (\d+) bytes/)?.[1] || 4096);
        const pages = (name) => Number(out.match(new RegExp(`Pages ${name}:\\s+(\\d+)`))?.[1] || 0);
        return (pages('free') + pages('inactive') + pages('speculative') + pages('purgeable')) * page;
    } catch {
        return null;
    }
}

// hook 自身出错时不能阻断 agent：报到 stderr，正常退出
export async function runHook(main) {
    try {
        await main();
    } catch (e) {
        process.stderr.write(`[agent-reins] hook 出错（已跳过）：${e && e.stack ? e.stack : e}\n`);
    }
}

function stateFile(input, root) {
    const key = input.session_id || input.thread_id || `cwd-${root}`;
    const name = crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 16);
    const dir = path.join(os.tmpdir(), 'agent-reins');
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
    return execFileSync('git', ['-C', root, '-c', 'core.quotePath=false', ...args], {
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

export const MAX_ENTRIES = 5000;

// 返回 [{ code: 'XY', path, from? }]，包含未跟踪文件（逐个列出）
export function gitStatus(root) {
    const out = git(root, ['status', '--porcelain=v1', '-z', '-uall']);
    const parts = out.split('\0').filter(Boolean);
    const entries = [];
    for (let i = 0; i < parts.length; i++) {
        const code = parts[i].slice(0, 2);
        const entry = { code, path: parts[i].slice(3) };
        if (code[0] === 'R' || code[0] === 'C') entry.from = parts[++i]; // -z 下原路径紧跟在新路径之后
        entries.push(entry);
    }
    if (entries.length > MAX_ENTRIES) {
        process.stderr.write(`[agent-reins] 工作区有 ${entries.length} 个改动，只检查前 ${MAX_ENTRIES} 个\n`);
    }
    return entries.slice(0, MAX_ENTRIES);
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
