#!/usr/bin/env node
// PostToolUse：记录本会话运行过的测试命令，供 guard-diff 核对"改了逻辑却没跑测试"
// 只记运行、不判成败：各 agent 的 tool_response 形状不一致，结果由规则要求 agent 如实汇报
import { readInput, runHook, gitRoot, updateState } from './lib.mjs';

const TEST_CMD = [
    /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/,
    /\bpytest\b/,
    /\bpython[3]?\s+-m\s+(pytest|unittest)\b/,
    /\bnode\s+--test\b/,
    /\b(go|cargo|deno|swift|flutter)\s+test\b/,
    /\b(mvn|mvnw|gradle|gradlew)\b[^|;&]*\btest\b/,
    /\b(vitest|jest|mocha|rspec|phpunit|ctest)\b/,
    /\bdotnet\s+test\b/,
    /\bmake\s+test\b/,
    /\bnpx\s+[^|;&]*\b(vitest|jest|mocha)\b/,
];

await runHook(async () => {
    const input = await readInput();
    const ti = input.tool_input || {};
    let cmd = ti.command ?? ti.cmd;
    if (Array.isArray(cmd)) cmd = cmd.join(' ');
    if (typeof cmd !== 'string' || !TEST_CMD.some((re) => re.test(cmd))) return;
    const root = gitRoot(input.cwd);
    if (!root) return;
    updateState(input, root, (s) => {
        s.tests = [...(s.tests || []), cmd.replace(/\s+/g, ' ').trim().slice(0, 120)].slice(-20);
    });
});