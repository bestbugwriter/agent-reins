#!/usr/bin/env node
// SessionStart：实时提供本机环境（不落盘），记录会话开始时的工作区基线，压缩后重申要点
import fs from 'node:fs';
import os from 'node:os';
import { readInput, emit, runHook, gitRoot, loadState, saveState, snapshot } from './lib.mjs';

const PLATFORM = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' };

const COMPACT_REMINDER = `上下文刚被压缩，重申 agent-tidy 要点：
- 改动范围与需求一致，不加需求外的抽象、兜底和测试。
- 改了行为、接口或配置，同一次改动里同步测试、文档和注释（change-impact）。
- 默认不新增文档；过程产物写 .scratch/，不入库。
- 环境事实不写进入库文件；失效的事实直接删除。
- 说"完成"必须附证据；不得删改测试来让测试通过。危险操作先确认。`;

const gb = (n) => (n / 1024 ** 3).toFixed(1);

await runHook(async () => {
    const input = await readInput();
    const cwd = input.cwd || process.cwd();

    let disk = '';
    try {
        const s = fs.statfsSync(cwd);
        disk = `，工作目录所在磁盘可用 ${gb(s.bavail * s.bsize)} GB`;
    } catch {
        // 老版本 Node 没有 statfsSync，省略磁盘信息
    }
    const lines = [
        `本机环境（会话开始时实时检测，仅用于本次会话判断能否运行重负载；不要写进任何项目文件）：`
            + `${PLATFORM[process.platform] || process.platform} ${os.release()} ${os.arch()}，`
            + `CPU ${os.cpus().length} 核，内存 ${gb(os.totalmem())} GB（当前空闲约 ${gb(os.freemem())} GB）${disk}。`,
    ];
    if (input.source === 'compact') lines.push(COMPACT_REMINDER);

    // 只在会话第一次启动时记录基线，resume/compact 沿用原基线
    const root = gitRoot(cwd);
    if (root && !loadState(input, root)) {
        saveState(input, root, { root, baseline: snapshot(root), reminded: [] });
    }

    emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: lines.join('\n') } });
});
