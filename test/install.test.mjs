import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'agent-tidy.mjs');
const OVERRIDES = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME', 'DSH_AGENTS_HOME', 'XDG_CONFIG_HOME'];

function sandbox() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tidy-home-'));
    const env = { ...process.env, HOME: home, USERPROFILE: home };
    // 这些变量优先于 HOME；不清掉会写到真实目录
    for (const k of OVERRIDES) delete env[k];
    assert.ok(OVERRIDES.every((k) => !(k in env)) && env.HOME !== os.homedir());
    const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const p = (...s) => path.join(home, ...s);
    const write = (rel, content) => {
        fs.mkdirSync(path.dirname(p(rel)), { recursive: true });
        fs.writeFileSync(p(rel), typeof content === 'string' ? content : JSON.stringify(content));
    };
    return { home, env, run, p, write, read: (rel) => fs.readFileSync(p(rel), 'utf8'), json: (rel) => JSON.parse(fs.readFileSync(p(rel), 'utf8')) };
}

const runFails = (fn) => {
    try {
        fn();
    } catch (e) {
        return `${e.stdout || ''}${e.stderr || ''}`;
    }
    assert.fail('预期命令失败');
};

const ours = (hooks, ev) => (hooks[ev] || []).flatMap((g) => g.hooks).filter((h) => h.command.includes('agent-tidy'));

function dshBridge(sb, configPath = sb.p('.dsh', 'hooks.json')) {
    sb.write('.dsh/cordis.patch.yml', `- insert:\n    - id: "cmhub-hooks-claude-code"\n      name: "@deepseek-ai/dsh-hooks-claude-code"\n      config:\n        configPath: "${configPath}"\n`);
}

test('安装三个 agent：保留原有内容、幂等、可完整卸载', () => {
    const sb = sandbox();
    sb.write('.claude/CLAUDE.md', '# 我的规则\n- 中文交流\n');
    const userHook = { type: 'command', command: 'bash ~/.claude/hooks/notify.sh' };
    sb.write('.claude/settings.json', { model: 'x', hooks: { Stop: [{ matcher: '*', hooks: [userHook] }] } });
    fs.mkdirSync(sb.p('.agents', 'skills', 'doc-audit'), { recursive: true }); // 同名的用户 skill
    dshBridge(sb);

    sb.run('install', '-a', 'claude,codex,dsh');
    const again = sb.run('install', '-a', 'claude,codex,dsh');
    assert.doesNotMatch(again.replace(/.*state\.json.*\n/g, ''), /更新|创建/, '第二次安装不应改动任何文件');
    assert.equal(sb.read('.claude/CLAUDE.md.agent-tidy.bak'), '# 我的规则\n- 中文交流\n', '备份必须保留安装前的原始内容');

    const claudeMd = sb.read('.claude/CLAUDE.md');
    assert.match(claudeMd, /^# 我的规则/);
    assert.equal(claudeMd.split('agent-tidy:start').length - 1, 1);
    for (const f of ['.codex/AGENTS.md', '.dsh/AGENTS.md']) assert.equal(sb.read(f).split('agent-tidy:start').length - 1, 1);

    const settings = sb.json('.claude/settings.json');
    assert.equal(settings.model, 'x');
    assert.deepEqual(settings.hooks.Stop[0].hooks[0], userHook);
    for (const ev of ['SessionStart', 'PreToolUse', 'Stop']) assert.equal(ours(settings.hooks, ev).length, 1, ev);
    assert.match(ours(settings.hooks, 'Stop')[0].command, /run-hook\.sh" guard-diff --agent claude$/);
    assert.equal(ours(sb.json('.codex/hooks.json').hooks, 'Stop').length, 1);

    assert.ok(fs.lstatSync(sb.p('.claude', 'skills', 'change-impact')).isSymbolicLink());
    assert.ok(fs.lstatSync(sb.p('.agents', 'skills', 'ui-verify')).isSymbolicLink());
    assert.ok(!fs.lstatSync(sb.p('.agents', 'skills', 'doc-audit')).isSymbolicLink(), '同名 skill 不能被覆盖');
    assert.match(sb.read('.config/git/ignore'), /\.agent-handoff\.md/);
    assert.ok(fs.existsSync(sb.p('.claude', 'settings.json.agent-tidy.bak')));
    assert.match(sb.run('status'), /Claude Code\s+规则 ✓\s+skills 5\/5\s+hooks 3/);

    // 只卸载 codex：共享的 ~/.agents/skills 仍被 dsh 使用，必须保留
    sb.run('uninstall', '-a', 'codex');
    assert.doesNotMatch(sb.read('.codex/AGENTS.md'), /agent-tidy/);
    assert.ok(fs.lstatSync(sb.p('.agents', 'skills', 'ui-verify')).isSymbolicLink());

    sb.run('uninstall');
    assert.equal(sb.read('.claude/CLAUDE.md'), '# 我的规则\n- 中文交流\n');
    assert.deepEqual(sb.json('.claude/settings.json'), { model: 'x', hooks: { Stop: [{ matcher: '*', hooks: [userHook] }] } });
    assert.ok(!fs.existsSync(sb.p('.agents', 'skills', 'ui-verify')));
    assert.ok(fs.existsSync(sb.p('.agents', 'skills', 'doc-audit')));
    assert.ok(!fs.existsSync(sb.p('.agents', 'agent-tidy')));
    assert.doesNotMatch(sb.read('.config/git/ignore'), /agent-tidy/);
});

test('dsh：按桥读取的文件和现有包裹格式写入，不产生混合形状', () => {
    const sb = sandbox();
    const existing = { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'curl x' }] }] } };
    sb.write('.dsh/hooks.json', existing);
    dshBridge(sb);
    sb.run('install', '-a', 'dsh', '--skip', 'gitignore');

    const data = sb.json('.dsh/hooks.json');
    assert.deepEqual(Object.keys(data), ['hooks'], '顶层只能有 hooks 包裹层');
    assert.deepEqual(data.hooks.UserPromptSubmit, existing.hooks.UserPromptSubmit);
    assert.equal(ours(data.hooks, 'Stop').length, 1);

    sb.run('uninstall', '-a', 'dsh');
    assert.deepEqual(sb.json('.dsh/hooks.json'), existing);
});

test('dsh：已有裸事件格式时按裸格式写入；桥指向其他文件时写那个文件', () => {
    const sb = sandbox();
    sb.write('.dsh/custom-hooks.json', { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] });
    dshBridge(sb, '~/.dsh/custom-hooks.json');
    sb.run('install', '-a', 'dsh', '--skip', 'gitignore');
    const data = sb.json('.dsh/custom-hooks.json');
    assert.ok(!('hooks' in data));
    assert.equal(data.Stop.length, 2);
    assert.ok(!fs.existsSync(sb.p('.dsh', 'hooks.json')));
});

test('dsh：没有挂载插件桥时跳过 hooks，规则和 skills 照常安装', () => {
    const sb = sandbox();
    fs.mkdirSync(sb.p('.dsh'));
    const out = sb.run('install', '-a', 'dsh', '--skip', 'gitignore');
    assert.match(out, /未挂载 hooks 插件桥/);
    assert.ok(!fs.existsSync(sb.p('.dsh', 'hooks.json')));
    assert.match(sb.read('.dsh/AGENTS.md'), /agent-tidy:start/);
    assert.match(sb.run('status'), /hooks 插件桥：未挂载/);
});

test('预检：任一目标配置损坏时不写入任何文件', () => {
    const sb = sandbox();
    sb.write('.codex/hooks.json', '{ broken');
    const out = runFails(() => sb.run('install', '-a', 'claude,codex'));
    assert.match(out, /预检失败，未写入任何文件/);
    assert.equal(sb.read('.codex/hooks.json'), '{ broken');
    assert.ok(!fs.existsSync(sb.p('.agents', 'agent-tidy')));
    assert.ok(!fs.existsSync(sb.p('.claude', 'CLAUDE.md')));
});

test('status：配置损坏时降级显示而不是退出；安装目录缺失时提示', () => {
    const sb = sandbox();
    sb.run('install', '-a', 'claude,codex', '--skip', 'gitignore');
    sb.write('.codex/hooks.json', 'null');
    const out = sb.run('status');
    assert.match(out, /Codex\s+规则 ✓\s+skills 5\/5\s+hooks ⚠ 配置损坏/);
    assert.match(out, /Claude Code\s+规则 ✓/);

    fs.rmSync(sb.p('.agents', 'agent-tidy', 'hooks'), { recursive: true });
    assert.match(sb.run('status'), /安装目录缺失或不完整/);
});

test('state.json 丢失时：卸载单个 agent 不会误删其他 agent 仍在使用的安装目录', () => {
    const sb = sandbox();
    sb.run('install', '-a', 'claude,codex');
    fs.rmSync(sb.p('.agents', 'agent-tidy', 'state.json'));

    sb.run('uninstall', '-a', 'codex');
    assert.ok(fs.existsSync(sb.p('.agents', 'agent-tidy', 'hooks', 'guard-diff.mjs')), 'claude 仍有残留，安装目录必须保留');
    assert.match(sb.read('.config/git/ignore'), /agent-tidy/);
    assert.ok(fs.lstatSync(sb.p('.claude', 'skills', 'ui-verify')).isSymbolicLink());

    // 不带 -a 时按磁盘残留卸载干净
    sb.run('uninstall');
    assert.doesNotMatch(sb.read('.claude/CLAUDE.md'), /agent-tidy/);
    assert.ok(!fs.existsSync(sb.p('.agents', 'agent-tidy')));
});

test('个人偏好覆盖文件合并进规则区块', () => {
    const sb = sandbox();
    sb.write('.agents/agent-tidy.local.md', '- 用中文交流；代码、命令、路径保持原样。');
    sb.run('install', '-a', 'codex', '--skip', 'gitignore');
    const text = sb.read('.codex/AGENTS.md');
    assert.match(text, /## 个人偏好/);
    assert.match(text, /用中文交流/);
    assert.ok(text.indexOf('用中文交流') < text.indexOf('agent-tidy:end'));
});

test('Codex：提示未审批的 hook', () => {
    const sb = sandbox();
    sb.run('install', '-a', 'codex', '--skip', 'gitignore');
    const file = sb.p('.codex', 'hooks.json');
    sb.write('.codex/config.toml', `[hooks.state."${file}:session_start:0:0"]\ntrusted_hash = "sha256:x"\n`);
    assert.match(sb.run('status'), /有 2 个 hook 尚未在 Codex 中审批/);
});

test('dry-run 不写任何文件', () => {
    const sb = sandbox();
    assert.match(sb.run('install', '-a', 'codex', '--dry-run'), /dry-run/);
    assert.deepEqual(fs.readdirSync(sb.home), []);
});

test('启动器：安装时记录的 node 失效后回退到其他 node', { skip: process.platform === 'win32' }, () => {
    const sb = sandbox();
    sb.run('install', '-a', 'claude', '--skip', 'gitignore');
    fs.writeFileSync(sb.p('.agents', 'agent-tidy', 'node-path'), '/nonexistent/node');
    const env = { ...sb.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
    const out = execFileSync(sb.p('.agents', 'agent-tidy', 'hooks', 'run-hook.sh'), ['session-start', '--agent', 'claude'],
        { env, input: '{}', encoding: 'utf8' });
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /CPU \d+ 核/);
});

test('hooks 端到端：会话基线、提醒一次、危险命令、一致性检查', () => {
    const sb = sandbox();
    sb.run('install', '-a', 'claude', '--skip', 'gitignore');
    const hook = (name, input, agent = 'claude') => execFileSync(sb.p('.agents', 'agent-tidy', 'hooks', 'run-hook.sh'),
        [name, '--agent', agent], { env: sb.env, input: JSON.stringify(input), encoding: 'utf8' });

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tidy-repo-'));
    const put = (rel, text) => {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), text);
    };
    const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { env: sb.env, stdio: 'ignore' });
    put('src/Svc.java', 'class Svc {\n    int computeTotal() { return 1; }\n}\n');
    put('src/test/SvcTest.java', 'class SvcTest {}\n');
    put('docs/billing.md', '# 计费\n合计由 `Svc.java#computeTotal` 计算。\n');
    g('init', '-q');
    g('add', '-A');
    g('commit', '-q', '-m', 'init');
    put('old-notes.md', '会话开始前就存在的未提交文档\n');

    const sid = `t-${process.pid}-${Date.now()}`;
    const start = JSON.parse(hook('session-start', { session_id: sid, cwd: repo, source: 'startup' }));
    assert.match(start.hookSpecificOutput.additionalContext, /CPU \d+ 核/);
    assert.equal(hook('guard-diff', { session_id: sid, cwd: repo }), '', '会话前的改动不算');

    // 改名函数但不改文档和测试
    put('src/Svc.java', 'class Svc {\n    int computeTotalAmount() {\n        int base = 1;\n        int tax = 0;\n        return base + tax;\n    }\n}\n');
    const stop = JSON.parse(hook('guard-diff', { session_id: sid, cwd: repo }));
    assert.equal(stop.decision, 'block');
    assert.match(stop.reason, /`computeTotal` → docs\/billing\.md:2/);
    assert.match(stop.reason, /锚点 Svc\.java#computeTotal 已不存在/);
    assert.match(stop.reason, /没有改动任何测试/);
    assert.doesNotMatch(stop.reason, /old-notes\.md/);
    assert.equal(hook('guard-diff', { session_id: sid, cwd: repo }), '', '同一组问题只提醒一次');

    // 补齐文档和测试后，新问题（新增文档 + 环境事实）会再次提醒
    put('docs/billing.md', '# 计费\n合计由 `Svc.java#computeTotalAmount` 计算。\n');
    put('src/test/SvcTest.java', 'class SvcTest { void total() {} }\n');
    put('AGENTS.md', '# 规则\n本机资源不够，不能运行 768MB 以上的进程\n');
    put('docs/design-notes.md', '# 设计\n');
    const stop2 = JSON.parse(hook('guard-diff', { session_id: sid, cwd: repo }));
    assert.match(stop2.reason, /环境事实/);
    assert.match(stop2.reason, /design-notes\.md/);
    assert.doesNotMatch(stop2.reason, /computeTotal`/);

    const ask = JSON.parse(hook('guard-tool', { tool_name: 'Bash', tool_input: { command: 'bash -c "git reset --hard"' } }));
    assert.equal(ask.hookSpecificOutput.permissionDecision, 'ask');
    const deny = JSON.parse(hook('guard-tool', { tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'rm -rf src'] } }, 'codex'));
    assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(hook('guard-tool', { tool_name: 'Bash', tool_input: { command: 'ls' } }), '');
    for (const [tool, file] of [['Edit', '/x/CLAUDE.md'], ['str_replace_editor', '/x/agents.md'], ['Write', '/h/.codex/rules/a.md']]) {
        const r = JSON.parse(hook('guard-tool', { tool_name: tool, tool_input: { file_path: file } }));
        assert.equal(r.hookSpecificOutput.permissionDecision, 'ask', `${tool} ${file}`);
    }
});
