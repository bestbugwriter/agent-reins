import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'agent-tidy.mjs');

function sandbox() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tidy-home-'));
    const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: '' };
    for (const k of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME', 'DSH_AGENTS_HOME', 'XDG_CONFIG_HOME']) delete env[k];
    const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    return { home, env, run, p: (...s) => path.join(home, ...s), read: (...s) => fs.readFileSync(path.join(home, ...s), 'utf8') };
}

const json = (s) => JSON.parse(s);

test('安装到三个 agent：保留原有内容、幂等、可完整卸载', () => {
    const sb = sandbox();
    fs.mkdirSync(sb.p('.claude'), { recursive: true });
    fs.writeFileSync(sb.p('.claude', 'CLAUDE.md'), '# 我的规则\n- 中文交流\n');
    const userHook = { type: 'command', command: 'bash ~/.claude/hooks/notify.sh' };
    fs.writeFileSync(sb.p('.claude', 'settings.json'), JSON.stringify({ model: 'x', hooks: { Stop: [{ matcher: '*', hooks: [userHook] }] } }));
    fs.mkdirSync(sb.p('.agents', 'skills', 'doc-audit'), { recursive: true }); // 同名的用户 skill

    sb.run('install', '-a', 'claude,codex,dsh');
    sb.run('install', '-a', 'claude,codex,dsh'); // 第二次安装应无副作用

    const claudeMd = sb.read('.claude', 'CLAUDE.md');
    assert.match(claudeMd, /^# 我的规则/);
    assert.equal(claudeMd.split('agent-tidy:start').length - 1, 1);
    for (const f of [['.codex', 'AGENTS.md'], ['.dsh', 'AGENTS.md']]) {
        assert.equal(sb.read(...f).split('agent-tidy:start').length - 1, 1);
    }

    const settings = json(sb.read('.claude', 'settings.json'));
    assert.equal(settings.model, 'x');
    assert.deepEqual(settings.hooks.Stop[0].hooks[0], userHook);
    for (const ev of ['SessionStart', 'PreToolUse', 'Stop']) {
        const ours = settings.hooks[ev].flatMap((g) => g.hooks).filter((h) => h.command.includes('agent-tidy'));
        assert.equal(ours.length, 1, ev);
    }
    assert.ok(json(sb.read('.codex', 'hooks.json')).hooks.Stop);
    assert.ok(json(sb.read('.dsh', 'hooks.json')).Stop, 'dsh 的 hooks.json 没有 hooks 包裹层');

    assert.ok(fs.lstatSync(sb.p('.claude', 'skills', 'pick-dependency')).isSymbolicLink());
    assert.ok(fs.lstatSync(sb.p('.agents', 'skills', 'ui-verify')).isSymbolicLink());
    assert.ok(!fs.lstatSync(sb.p('.agents', 'skills', 'doc-audit')).isSymbolicLink(), '同名 skill 不能被覆盖');
    assert.match(sb.read('.config', 'git', 'ignore'), /\.agent-handoff\.md/);
    assert.ok(fs.existsSync(sb.p('.claude', 'settings.json.agent-tidy.bak')));

    assert.match(sb.run('status'), /Claude Code\s+规则 ✓\s+skills 4\/4\s+hooks 3/);

    // 只卸载 codex：共享的 ~/.agents/skills 仍被 dsh 使用，必须保留
    sb.run('uninstall', '-a', 'codex');
    assert.doesNotMatch(sb.read('.codex', 'AGENTS.md'), /agent-tidy/);
    assert.ok(fs.lstatSync(sb.p('.agents', 'skills', 'ui-verify')).isSymbolicLink());

    sb.run('uninstall');
    assert.equal(sb.read('.claude', 'CLAUDE.md'), '# 我的规则\n- 中文交流\n');
    const after = json(sb.read('.claude', 'settings.json'));
    assert.deepEqual(after, { model: 'x', hooks: { Stop: [{ matcher: '*', hooks: [userHook] }] } });
    assert.ok(!fs.existsSync(sb.p('.agents', 'skills', 'ui-verify')));
    assert.ok(fs.existsSync(sb.p('.agents', 'skills', 'doc-audit')));
    assert.ok(!fs.existsSync(sb.p('.agents', 'agent-tidy')));
    assert.doesNotMatch(sb.read('.config', 'git', 'ignore'), /agent-tidy/);
});

test('dry-run 不写任何文件', () => {
    const sb = sandbox();
    const out = sb.run('install', '-a', 'codex', '--dry-run');
    assert.match(out, /dry-run/);
    assert.deepEqual(fs.readdirSync(sb.home), []);
});

test('非法 JSON 配置时停止，不覆盖', () => {
    const sb = sandbox();
    fs.mkdirSync(sb.p('.codex'));
    fs.writeFileSync(sb.p('.codex', 'hooks.json'), '{ broken');
    assert.throws(() => sb.run('install', '-a', 'codex', '--skip', 'gitignore'), /不是合法 JSON/);
    assert.equal(sb.read('.codex', 'hooks.json'), '{ broken');
});

test('hooks 端到端：会话基线、环境事实拦截一次、危险命令', () => {
    const sb = sandbox();
    sb.run('install', '-a', 'claude', '--skip', 'gitignore');
    const hook = (name, input, agent = 'claude') => execFileSync(process.execPath,
        [sb.p('.agents', 'agent-tidy', 'hooks', name), '--agent', agent],
        { env: sb.env, input: JSON.stringify(input), encoding: 'utf8' });

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tidy-repo-'));
    const g = (...a) => execFileSync('git', ['-C', repo, ...a], { env: sb.env, stdio: 'ignore' });
    g('init', '-q');
    fs.writeFileSync(path.join(repo, 'old-notes.md'), '会话开始前就存在的未提交文档\n');

    const sid = `t-${Date.now()}`;
    const start = json(hook('session-start.mjs', { session_id: sid, cwd: repo, source: 'startup' }));
    assert.match(start.hookSpecificOutput.additionalContext, /CPU \d+ 核/);

    assert.equal(hook('guard-diff.mjs', { session_id: sid, cwd: repo }), '', '会话前的改动不算');

    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# 规则\n本机资源不够，不能运行 768MB 以上的进程\n');
    fs.writeFileSync(path.join(repo, 'design-notes.md'), '# 设计\n');
    const stop = json(hook('guard-diff.mjs', { session_id: sid, cwd: repo }));
    assert.equal(stop.decision, 'block');
    assert.match(stop.reason, /环境事实/);
    assert.match(stop.reason, /design-notes\.md/);
    assert.doesNotMatch(stop.reason, /old-notes\.md/);
    assert.equal(hook('guard-diff.mjs', { session_id: sid, cwd: repo }), '', '同一组问题只提醒一次');

    const ask = json(hook('guard-tool.mjs', { tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }));
    assert.equal(ask.hookSpecificOutput.permissionDecision, 'ask');
    const deny = json(hook('guard-tool.mjs', { tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'rm -rf src'] } }, 'codex'));
    assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(hook('guard-tool.mjs', { tool_name: 'Bash', tool_input: { command: 'ls' } }), '');
    const rule = json(hook('guard-tool.mjs', { tool_name: 'Edit', tool_input: { file_path: '/x/CLAUDE.md' } }));
    assert.equal(rule.hookSpecificOutput.permissionDecision, 'ask');
});
