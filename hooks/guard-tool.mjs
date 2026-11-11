#!/usr/bin/env node
// PreToolUse：危险命令要求确认；Claude Code / dsh 修改 agent 指令文件时要求确认
import { readInput, agentArg, emit, runHook } from './lib.mjs';
import { findDanger, RULE_FILE } from './checks.mjs';

function decide(agent, reason) {
    // Codex 不支持 ask，只能 deny；用户确认后可自己执行该命令
    const decision = agent === 'codex' ? 'deny' : 'ask';
    const suffix = agent === 'codex' ? '请先向用户说明影响并征得同意，由用户自己执行或放行。' : '';
    emit({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision,
            permissionDecisionReason: `[agent-tidy] ${reason}。${suffix}`,
        },
    });
}

await runHook(async () => {
    const input = await readInput();
    const agent = agentArg();
    const ti = input.tool_input || {};

    let cmd = ti.command ?? ti.cmd;
    if (Array.isArray(cmd)) cmd = cmd.join(' ');
    const danger = findDanger(cmd);
    if (danger) return decide(agent, `危险操作：${danger}`);

    if (agent === 'codex') return;
    const file = ti.file_path || ti.path || '';
    if (/Edit|Write/i.test(input.tool_name || '') && RULE_FILE.test(file)) {
        decide(agent, `正在修改 agent 指令文件 ${file}，会影响之后的每个会话`);
    }
});
