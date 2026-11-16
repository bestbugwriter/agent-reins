#!/usr/bin/env node
// PreToolUse：危险命令要求确认；Claude Code / dsh / Qoder 修改 agent 指令文件（含 shell 改写）时要求确认
import { readInput, agentArg, emit, runHook } from './lib.mjs';
import { findDanger, shellWriteTargets } from './danger.mjs';

// macOS 默认大小写不敏感，agents.md 与 AGENTS.md 是同一个文件
const RULE_FILE = /(^|[\/\\])(AGENTS|CLAUDE)(\.local|\.override)?\.md$|[\/\\]\.(claude|codex)[\/\\]rules[\/\\]/i;
const EDIT_TOOL = /edit|write|str_replace|create|patch/i;
const SHELL_TOOL = /^(bash|shell|exec|local_shell|terminal)$/i;

function decide(agent, reason) {
    // Codex / Kimi 不支持 ask，只能 deny；用户确认后可自己执行该命令
    const deny = agent === 'codex' || agent === 'kimi';
    const suffix = agent === 'codex' ? '请先向用户说明影响并征得同意，由用户自己执行或放行。' : '';
    const out = {
        permissionDecision: deny ? 'deny' : 'ask',
        permissionDecisionReason: `[agent-reins] ${reason}。${suffix}`,
    };
    // Kimi 文档的输出形状不带 hookEventName
    emit({ hookSpecificOutput: agent === 'kimi' ? out : { hookEventName: 'PreToolUse', ...out } });
}

await runHook(async () => {
    const input = await readInput();
    const agent = agentArg();
    const ti = input.tool_input || {};
    const command = ti.command ?? ti.cmd;

    const danger = findDanger(command);
    if (danger) return decide(agent, `危险操作：${danger}`);

    // Codex / Kimi 只能 deny，拦截改指令文件代价过高，交给规则约束
    if (agent === 'codex' || agent === 'kimi') return;
    const file = ti.file_path || ti.path || ti.filePath || '';
    if (EDIT_TOOL.test(input.tool_name || '') && RULE_FILE.test(file)) {
        return decide(agent, `正在修改 agent 指令文件 ${file}，会影响之后的每个会话`);
    }
    if (typeof command === 'string' && SHELL_TOOL.test(input.tool_name || '')) {
        const target = shellWriteTargets(command).find((t) => RULE_FILE.test(t));
        if (target) decide(agent, `正在通过 shell 改写 agent 指令文件 ${target}，会影响之后的每个会话`);
    }
});