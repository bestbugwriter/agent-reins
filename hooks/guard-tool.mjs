#!/usr/bin/env node
// PreToolUse：危险命令要求确认；Claude Code / dsh 修改 agent 指令文件时要求确认
import { readInput, agentArg, emit, runHook } from './lib.mjs';
import { findDanger } from './danger.mjs';

// macOS 默认大小写不敏感，agents.md 与 AGENTS.md 是同一个文件
const RULE_FILE = /(^|[\/\\])(AGENTS|CLAUDE)(\.local|\.override)?\.md$|[\/\\]\.(claude|codex)[\/\\]rules[\/\\]/i;
const EDIT_TOOL = /edit|write|str_replace|create|patch/i;

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

    const danger = findDanger(ti.command ?? ti.cmd);
    if (danger) return decide(agent, `危险操作：${danger}`);

    // Codex 只能 deny，拦截改指令文件代价过高，交给规则约束
    if (agent === 'codex') return;
    const file = ti.file_path || ti.path || ti.filePath || '';
    if (EDIT_TOOL.test(input.tool_name || '') && RULE_FILE.test(file)) {
        decide(agent, `正在修改 agent 指令文件 ${file}，会影响之后的每个会话`);
    }
});
