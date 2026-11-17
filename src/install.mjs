// install / uninstall / status 的实现。所有写操作经过 Fs，以支持 --dry-run
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, kitHome, overlayFile, gitIgnoreFile, dshBridges, dshProfiles, dshBridgePackage } from './agents.mjs';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;

const MD_START = '<!-- agent-reins:start（由 agent-reins 管理，重新安装会覆盖此区块）-->';
const MD_END = '<!-- agent-reins:end -->';
const IGNORE_START = '# >>> agent-reins >>>';
const IGNORE_END = '# <<< agent-reins <<<';
const HOOK_MARK = /agent-reins[\/\\]hooks[\/\\]/;
const TOML_START = '# >>> agent-reins >>>';
const TOML_END = '# <<< agent-reins <<<';
const KIT_PARTS = ['rules', 'skills', 'hooks', 'templates'];
export const PARTS = ['rules', 'skills', 'hooks', 'gitignore'];
const IS_WIN = process.platform === 'win32';

class Fs {
    constructor(dryRun, log) {
        this.dryRun = dryRun;
        this.log = log;
    }

    write(file, content) {
        const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        if (old === content) return;
        this.log(`${old === null ? '创建' : '更新'} ${file}`);
        if (this.dryRun) return;
        // 只在第一次修改时备份，保留安装 agent-reins 之前的原始内容
        const bak = `${file}.agent-reins.bak`;
        if (old !== null && !fs.existsSync(bak)) fs.copyFileSync(file, bak);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }

    link(target, linkPath) {
        this.log(`链接 ${linkPath} -> ${target}`);
        if (this.dryRun) return;
        fs.mkdirSync(path.dirname(linkPath), { recursive: true });
        if (isOurLink(linkPath)) fs.unlinkSync(linkPath);
        fs.symlinkSync(target, linkPath, IS_WIN ? 'junction' : 'dir');
    }

    remove(p) {
        this.log(`删除 ${p}`);
        if (!this.dryRun) fs.rmSync(p, { recursive: true, force: true });
    }

    copyKit() {
        const dest = kitHome();
        this.log(`复制规则、skills、hooks 到 ${dest}`);
        if (this.dryRun || path.resolve(dest) === PKG_ROOT) return;
        for (const part of KIT_PARTS) {
            fs.rmSync(path.join(dest, part), { recursive: true, force: true });
            fs.cpSync(path.join(PKG_ROOT, part), path.join(dest, part), { recursive: true });
        }
        fs.chmodSync(path.join(dest, 'hooks', 'run-hook.sh'), 0o755);
        fs.writeFileSync(path.join(dest, 'node-path'), process.execPath);
    }
}

function isOurLink(p) {
    try {
        if (!fs.lstatSync(p).isSymbolicLink()) return false;
        return path.resolve(path.dirname(p), fs.readlinkSync(p)).startsWith(kitHome());
    } catch {
        return false;
    }
}

function lexists(p) {
    try {
        fs.lstatSync(p);
        return true;
    } catch {
        return false;
    }
}

const readText = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

function readJson(f) {
    const text = readText(f).trim();
    if (!text) return {};
    let data;
    try {
        data = JSON.parse(text);
    } catch (e) {
        throw new Error(`${f} 不是合法 JSON：${e.message}`);
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${f} 顶层不是 JSON 对象`);
    return data;
}

// 返回托管区块前后的文本；没有区块时返回 null
function splitBlock(text, start, end) {
    const i = text.indexOf(start);
    if (i < 0) return null;
    const j = text.indexOf(end, i);
    if (j < 0) throw new Error(`找到 "${start}" 但缺少结束标记，可能被手工改过，请手动修复后重试`);
    return [text.slice(0, i).replace(/\s*$/, ''), text.slice(j + end.length).replace(/^\s*/, '')];
}

const join = (...parts) => {
    const out = parts.filter((p) => p.trim()).join('\n\n');
    return out ? `${out.replace(/\s*$/, '')}\n` : '';
};

export function upsertBlock(text, start, end, body) {
    const block = `${start}\n${body.trim()}\n${end}`;
    const split = splitBlock(text, start, end);
    return split ? join(split[0], block, split[1]) : join(text.replace(/\s*$/, ''), block);
}

export function removeBlock(text, start, end) {
    const split = splitBlock(text, start, end);
    return split ? join(split[0], split[1]) : text;
}

// hooks 文件有两种形状：{"hooks": {Event: [...]}} 或 {Event: [...]}，按文件现有形状写入
function hooksMap(data) {
    if (data.hooks && typeof data.hooks === 'object' && !Array.isArray(data.hooks)) return data.hooks;
    if (Object.values(data).some(Array.isArray)) return data;
    data.hooks = {};
    return data.hooks;
}

function hookCommand(id, script) {
    if (IS_WIN) return `"${process.execPath}" "${path.join(kitHome(), 'hooks', `${script}.mjs`)}" --agent ${id}`;
    return `"${path.join(kitHome(), 'hooks', 'run-hook.sh')}" ${script} --agent ${id}`;
}

function hookEntries(id) {
    const a = AGENTS[id];
    const group = (script, timeout, matcher) => ({
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: 'command', command: hookCommand(id, script), timeout }],
    });
    const entries = {
        SessionStart: [group('session-start', 10)],
        PreToolUse: [group('guard-tool', 10, a.toolMatcher)],
        Stop: [group('guard-diff', 30)],
        PostToolUse: [group('track-test', 10, a.postToolMatcher || 'Bash')],
    };
    // Kimi 的压缩是独立事件，不经过 SessionStart source=compact
    if (id === 'kimi') entries.PostCompact = [group('session-start', 10)];
    return entries;
}

// TOML basic string：转义反斜杠和双引号（Windows 路径、含单引号的路径都安全）
const tomlString = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function tomlHookBlock(id) {
    const lines = [];
    for (const [ev, groups] of Object.entries(hookEntries(id))) {
        for (const g of groups) {
            lines.push('[[hooks]]', `event = ${tomlString(ev)}`);
            if (g.matcher) lines.push(`matcher = ${tomlString(g.matcher)}`);
            lines.push(`command = ${tomlString(g.hooks[0].command)}`, `timeout = ${g.hooks[0].timeout}`);
        }
    }
    return lines.join('\n');
}

// 返回 TOML 托管区块的内容；无区块返回 null，标记不完整时抛出
function tomlBlockBody(text) {
    if (!splitBlock(text, TOML_START, TOML_END)) return null;
    const i = text.indexOf(TOML_START) + TOML_START.length;
    return text.slice(i, text.indexOf(TOML_END, i));
}

const isOurHook = (h) => HOOK_MARK.test(String(h.command || ''));

function stripOurHooks(hooks) {
    for (const [ev, groups] of Object.entries(hooks)) {
        if (!Array.isArray(groups)) continue;
        const kept = groups
            .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurHook(h)) }))
            .filter((g) => g.hooks.length);
        if (kept.length) hooks[ev] = kept;
        else delete hooks[ev];
    }
}

// 返回 { count, error }；配置损坏时不抛出，交给调用方降级显示
function ourHooks(file, format) {
    try {
        if (format === 'toml') {
            const body = tomlBlockBody(readText(file));
            return { count: body ? (body.match(/^\[\[hooks\]\]\s*$/gm) || []).length : 0, found: [] };
        }
        const hooks = hooksMap(readJson(file));
        const found = [];
        for (const [ev, groups] of Object.entries(hooks)) {
            if (!Array.isArray(groups)) continue;
            groups.forEach((g, gi) => (g.hooks || []).forEach((h, hi) => isOurHook(h) && found.push({ ev, gi, hi })));
        }
        return { count: found.length, found };
    } catch (e) {
        return { count: 0, found: [], error: e.message };
    }
}

// Codex 对新增或变化的 hook 默认跳过，需在 Codex 中审批后写入 config.toml 的 trusted_hash
function codexUntrusted(found) {
    const toml = readText(AGENTS.codex.configToml());
    const file = AGENTS.codex.hooksFile();
    const snake = (ev) => ev.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();
    return found.filter(({ ev, gi, hi }) => {
        const key = `[hooks.state."${file}:${snake(ev)}:${gi}:${hi}"]`;
        const at = toml.indexOf(key);
        return at < 0 || !/^trusted_hash\s*=/m.test(toml.slice(at, toml.indexOf('\n[', at + 1) >>> 0));
    }).length;
}

function skillNames() {
    return fs.readdirSync(path.join(PKG_ROOT, 'skills')).filter((n) => fs.existsSync(path.join(PKG_ROOT, 'skills', n, 'SKILL.md')));
}

function rulesBody() {
    const base = fs.readFileSync(path.join(PKG_ROOT, 'rules', 'AGENTS.md'), 'utf8').trim();
    const overlay = readText(overlayFile()).trim();
    return overlay ? `${base}\n\n## 个人偏好（来自 ${overlayFile()}）\n${overlay}` : base;
}

// dsh 每个挂载了桥的 profile 对应一个文件；其他 agent 只有一个
const hooksFiles = (a) => (a.hooksFiles ? a.hooksFiles() : [a.hooksFile()]);
const cleanupFiles = (a) => (a.cleanupHooksFiles ? a.cleanupHooksFiles() : hooksFiles(a));

const statePath = () => path.join(kitHome(), 'state.json');

export function readState() {
    try {
        const s = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
        return { agents: [], ...s };
    } catch {
        return { agents: [] };
    }
}

// 磁盘上能归属到该 agent 的残留：规则区块或 hook 条目（共享 skills 目录无法归属）
function hasLeftovers(id) {
    const a = AGENTS[id];
    return readText(a.rulesFile()).includes(MD_START) || cleanupFiles(a).some((f) => ourHooks(f, a.hooksFormat).count > 0);
}

function preflight(agents, parts) {
    const errors = [];
    const tryRead = (fn) => {
        try {
            fn();
        } catch (e) {
            errors.push(e.message);
        }
    };
    for (const id of agents) {
        const a = AGENTS[id];
        if (parts.includes('rules')) tryRead(() => splitBlock(readText(a.rulesFile()), MD_START, MD_END));
        if (parts.includes('hooks')) {
            if (a.hooksFormat === 'toml') tryRead(() => splitBlock(readText(a.hooksFile()), TOML_START, TOML_END));
            else for (const f of hooksFiles(a)) tryRead(() => readJson(f));
        }
    }
    if (parts.includes('gitignore')) tryRead(() => splitBlock(readText(gitIgnoreFile()), IGNORE_START, IGNORE_END));
    if (errors.length) throw new Error(`预检失败，未写入任何文件：\n  - ${errors.join('\n  - ')}`);
}

export function install({ agents, parts = PARTS, dryRun = false, log = console.log }) {
    preflight(agents, parts);
    const fsx = new Fs(dryRun, log);
    const kit = kitHome();
    const state = readState();
    const saveState = () => {
        if (!dryRun) fsx.write(statePath(), `${JSON.stringify({ ...state, version: VERSION, nodeBin: process.execPath }, null, 2)}\n`);
    };
    fsx.copyKit();
    const rules = rulesBody();
    const notes = [];

    for (const id of agents) {
        const a = AGENTS[id];
        log(`\n[${a.label}]`);
        if (parts.includes('rules')) {
            fsx.write(a.rulesFile(), upsertBlock(readText(a.rulesFile()), MD_START, MD_END, rules));
        }
        if (parts.includes('skills')) {
            for (const name of skillNames()) {
                const linkPath = path.join(a.skillsDir(), name);
                if (lexists(linkPath) && !isOurLink(linkPath)) {
                    log(`跳过 ${linkPath}：已存在同名 skill，未覆盖`);
                    continue;
                }
                fsx.link(path.join(kit, 'skills', name), linkPath);
            }
        }
        if (parts.includes('hooks')) {
            const files = hooksFiles(a);
            if (a.hooksFormat === 'toml') {
                fsx.write(a.hooksFile(), upsertBlock(readText(a.hooksFile()), TOML_START, TOML_END, tomlHookBlock(id)));
            } else {
                for (const file of files) {
                    const data = readJson(file);
                    const hooks = hooksMap(data);
                    stripOurHooks(hooks);
                    for (const [ev, groups] of Object.entries(hookEntries(id))) (hooks[ev] ??= []).push(...groups);
                    fsx.write(file, `${JSON.stringify(data, null, 2)}\n`);
                }
            }
            if (id === 'codex') notes.push('Codex 会跳过未审批的新 hook：请打开 Codex，在 hooks 审批提示中信任 agent-reins 的 4 个 hook');
            if (id === 'dsh') {
                const bridges = dshBridges();
                const hasRoot = bridges.some((b) => b.profile === '（根目录）');
                const mounted = (p) => hasRoot || bridges.some((b) => b.profile === p);
                const missing = dshProfiles().filter((p) => !mounted(p));
                const noPkg = dshProfiles().filter((p) => mounted(p) && !dshBridgePackage(p));
                if (!files.length) notes.push('dsh 没有任何 profile 挂载 hooks 插件桥（@deepseek-ai/dsh-hooks-claude-code），已跳过 dsh 的 hooks；规则和 skills 已安装');
                if (missing.length) notes.push(`dsh 的 ${missing.join('、')} profile 没有挂载 hooks 插件桥，这些 profile 中 hooks 不会执行；运行 agent-reins status 查看详情`);
                if (noPkg.length) notes.push(`dsh 的 ${noPkg.join('、')} profile 桥已挂载但插件包未安装，hooks 不会执行：desktop 请在 App 插件管理安装与 App 同版本的 @deepseek-ai/dsh-hooks-claude-code，其余 profile 用 dsh plugin --profile <name> add @deepseek-ai/dsh-hooks-claude-code@<与 dsh 运行时同版本>`);
            }
        }
        // 每完成一个 agent 就记录，中途失败时 uninstall 仍能清理已写入的部分
        if (!state.agents.includes(id)) state.agents.push(id);
        saveState();
    }

    if (parts.includes('gitignore')) {
        log('\n[全局 gitignore]');
        const file = gitIgnoreFile();
        const body = fs.readFileSync(path.join(PKG_ROOT, 'templates', 'gitignore_global'), 'utf8');
        fsx.write(file, upsertBlock(readText(file), IGNORE_START, IGNORE_END, body));
    }
    saveState();
    return notes;
}

/** @param agents 不传时卸载全部：state 中记录的，加上磁盘上仍有残留的 */
export function uninstall({ agents, dryRun = false, log = console.log }) {
    const fsx = new Fs(dryRun, log);
    const state = readState();
    const all = Object.keys(AGENTS).filter((id) => state.agents.includes(id) || hasLeftovers(id));
    const targets = agents || all;
    const remaining = all.filter((id) => !targets.includes(id));
    if (!targets.length) {
        log('没有已安装的 agent');
        return;
    }

    for (const id of targets) {
        const a = AGENTS[id];
        log(`\n[${a.label}]`);
        const rulesFile = a.rulesFile();
        if (readText(rulesFile).includes(MD_START)) fsx.write(rulesFile, removeBlock(readText(rulesFile), MD_START, MD_END));
        if (!remaining.some((o) => AGENTS[o].skillsDir() === a.skillsDir())) {
            for (const name of skillNames()) {
                const linkPath = path.join(a.skillsDir(), name);
                if (isOurLink(linkPath)) fsx.remove(linkPath);
            }
        }
        for (const file of cleanupFiles(a)) {
            if (a.hooksFormat === 'toml') {
                try {
                    const text = readText(file);
                    if (splitBlock(text, TOML_START, TOML_END)) fsx.write(file, removeBlock(text, TOML_START, TOML_END));
                } catch (e) {
                    log(`跳过 ${file}：${e.message}，请手动删除其中的 agent-reins 托管区块`);
                }
                continue;
            }
            const { count, error } = ourHooks(file);
            if (error && fs.existsSync(file)) log(`跳过 ${file}：${error}，请手动删除其中包含 agent-reins/hooks 的条目`);
            else if (count) {
                const data = readJson(file);
                stripOurHooks(hooksMap(data));
                if (data.hooks && !Object.keys(data.hooks).length) delete data.hooks;
                fsx.write(file, `${JSON.stringify(data, null, 2)}\n`);
            }
        }
    }

    // 仍有其他 agent 在使用（state 记录或磁盘残留）时，保留共享的安装目录和 gitignore
    if (remaining.length) {
        if (!dryRun) fsx.write(statePath(), `${JSON.stringify({ ...state, agents: remaining }, null, 2)}\n`);
        return;
    }
    const ignoreFile = gitIgnoreFile();
    if (readText(ignoreFile).includes(IGNORE_START)) {
        log('\n[全局 gitignore]');
        fsx.write(ignoreFile, removeBlock(readText(ignoreFile), IGNORE_START, IGNORE_END));
    }
    if (fs.existsSync(kitHome()) && path.resolve(kitHome()) !== PKG_ROOT) fsx.remove(kitHome());
    log('\n卸载完成。');
}

export function status() {
    const state = readState();
    const kitOk = fs.existsSync(path.join(kitHome(), 'hooks', 'guard-diff.mjs'));
    const names = skillNames();
    const rows = Object.entries(AGENTS).map(([id, a]) => {
        const results = hooksFiles(a).map((f) => ({ file: f, ...ourHooks(f, a.hooksFormat) }));
        const hooks = {
            count: results.reduce((n, r) => n + r.count, 0),
            found: results.flatMap((r) => r.found),
            error: results.filter((r) => r.error).map((r) => r.error).join('；') || undefined,
        };
        const row = {
            id,
            label: a.label,
            installed: state.agents.includes(id),
            rules: readText(a.rulesFile()).includes(MD_START),
            skills: names.filter((n) => isOurLink(path.join(a.skillsDir(), n))).length,
            totalSkills: names.length,
            hooks: hooks.count,
            hooksError: hooks.error,
        };
        if (id === 'dsh') {
            const bridges = dshBridges();
            const root = bridges.find((b) => b.profile === '（根目录）') || null;
            row.profiles = dshProfiles().map((p) => {
                const own = bridges.find((b) => b.profile === p) || null;
                return { profile: p, bridge: own || root, viaRoot: !own && !!root, pkg: dshBridgePackage(p) };
            });
            row.otherBridges = bridges.filter((b) => b.profile !== '（根目录）' && !dshProfiles().includes(b.profile));
        }
        if (id === 'codex' && hooks.count) row.untrusted = codexUntrusted(hooks.found);
        return row;
    });
    const nodePath = readText(path.join(kitHome(), 'node-path')).trim();
    return {
        version: state.version,
        kitHome: kitHome(),
        kitOk,
        nodeBin: nodePath || state.nodeBin,
        nodeOk: !nodePath || fs.existsSync(nodePath),
        overlay: fs.existsSync(overlayFile()) ? overlayFile() : null,
        gitignore: readText(gitIgnoreFile()).includes(IGNORE_START),
        gitignoreFile: gitIgnoreFile(),
        rows,
    };
}
