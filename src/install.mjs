// install / uninstall / status 的实现。所有写操作经过 Fs，以支持 --dry-run
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENTS, kitHome, gitIgnoreFile } from './agents.mjs';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;

const MD_START = '<!-- agent-tidy:start（由 agent-tidy 管理，重新安装会覆盖此区块）-->';
const MD_END = '<!-- agent-tidy:end -->';
const IGNORE_START = '# >>> agent-tidy >>>';
const IGNORE_END = '# <<< agent-tidy <<<';
const HOOK_MARK = `agent-tidy${path.sep}hooks${path.sep}`;
const KIT_PARTS = ['rules', 'skills', 'hooks', 'templates'];
export const PARTS = ['rules', 'skills', 'hooks', 'gitignore'];

class Fs {
    constructor(dryRun, log) {
        this.dryRun = dryRun;
        this.log = log;
        this.backedUp = new Set();
    }

    write(file, content) {
        const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        if (old === content) return;
        this.log(`${old === null ? '创建' : '更新'} ${file}`);
        if (this.dryRun) return;
        if (old !== null && !this.backedUp.has(file)) {
            fs.copyFileSync(file, `${file}.agent-tidy.bak`);
            this.backedUp.add(file);
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }

    link(target, linkPath) {
        this.log(`链接 ${linkPath} -> ${target}`);
        if (this.dryRun) return;
        fs.mkdirSync(path.dirname(linkPath), { recursive: true });
        if (isOurLink(linkPath)) fs.unlinkSync(linkPath);
        fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
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

const readText = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

function readJson(f) {
    const text = readText(f).trim();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new Error(`${f} 不是合法 JSON，为避免覆盖已停止：${e.message}`);
    }
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
    return split ? join(split[0], block, split[1]) : join(text, block);
}

export function removeBlock(text, start, end) {
    const split = splitBlock(text, start, end);
    return split ? join(split[0], split[1]) : text;
}

const lexists = (p) => {
    try {
        fs.lstatSync(p);
        return true;
    } catch {
        return false;
    }
};

function hookEntries(id, nodeBin) {
    const cmd = (script) => `"${nodeBin}" "${path.join(kitHome(), 'hooks', script)}" --agent ${id}`;
    const group = (script, timeout, matcher) => ({
        ...(matcher ? { matcher } : {}),
        hooks: [{ type: 'command', command: cmd(script), timeout }],
    });
    return {
        SessionStart: [group('session-start.mjs', 10)],
        PreToolUse: [group('guard-tool.mjs', 10, AGENTS[id].toolMatcher)],
        Stop: [group('guard-diff.mjs', 30)],
    };
}

function stripOurHooks(hooks) {
    for (const [ev, groups] of Object.entries(hooks)) {
        if (!Array.isArray(groups)) continue;
        const kept = groups
            .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !String(h.command || '').includes(HOOK_MARK)) }))
            .filter((g) => g.hooks.length);
        if (kept.length) hooks[ev] = kept;
        else delete hooks[ev];
    }
}

function countOurHooks(file, wrapped) {
    if (!fs.existsSync(file)) return 0;
    const data = readJson(file);
    const hooks = (wrapped ? data.hooks : data) || {};
    return Object.values(hooks).filter(Array.isArray).flat()
        .flatMap((g) => g.hooks || [])
        .filter((h) => String(h.command || '').includes(HOOK_MARK)).length;
}

function skillNames() {
    return fs.readdirSync(path.join(PKG_ROOT, 'skills')).filter((n) => fs.existsSync(path.join(PKG_ROOT, 'skills', n, 'SKILL.md')));
}

const statePath = () => path.join(kitHome(), 'state.json');

export function readState() {
    try {
        return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    } catch {
        return { agents: [] };
    }
}

export function install({ agents, parts = PARTS, dryRun = false, log = console.log }) {
    const fsx = new Fs(dryRun, log);
    const kit = kitHome();
    const state = readState();
    fsx.copyKit();
    const rules = fs.readFileSync(path.join(PKG_ROOT, 'rules', 'AGENTS.md'), 'utf8');
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
            const file = a.hooksFile();
            const data = readJson(file);
            const hooks = a.hooksWrapped ? (data.hooks ??= {}) : data;
            stripOurHooks(hooks);
            for (const [ev, groups] of Object.entries(hookEntries(id, process.execPath))) {
                (hooks[ev] ??= []).push(...groups);
            }
            fsx.write(file, `${JSON.stringify(data, null, 2)}\n`);
            if (a.note) notes.push(a.note);
        }
    }

    if (parts.includes('gitignore')) {
        log('\n[全局 gitignore]');
        const file = gitIgnoreFile();
        const body = fs.readFileSync(path.join(PKG_ROOT, 'templates', 'gitignore_global'), 'utf8');
        fsx.write(file, upsertBlock(readText(file), IGNORE_START, IGNORE_END, body));
    }

    const next = { version: VERSION, nodeBin: process.execPath, agents: [...new Set([...state.agents, ...agents])] };
    if (!dryRun) fsx.write(statePath(), `${JSON.stringify(next, null, 2)}\n`);
    return notes;
}

export function uninstall({ agents, dryRun = false, log = console.log }) {
    const fsx = new Fs(dryRun, log);
    const state = readState();
    const remaining = state.agents.filter((id) => !agents.includes(id));

    for (const id of agents) {
        const a = AGENTS[id];
        log(`\n[${a.label}]`);
        const rulesFile = a.rulesFile();
        if (readText(rulesFile).includes(MD_START)) {
            fsx.write(rulesFile, removeBlock(readText(rulesFile), MD_START, MD_END));
        }
        const sharedByOthers = remaining.some((o) => AGENTS[o].skillsDir() === a.skillsDir());
        if (!sharedByOthers) {
            for (const name of skillNames()) {
                const linkPath = path.join(a.skillsDir(), name);
                if (isOurLink(linkPath)) fsx.remove(linkPath);
            }
        }
        const file = a.hooksFile();
        if (countOurHooks(file, a.hooksWrapped)) {
            const data = readJson(file);
            const hooks = a.hooksWrapped ? data.hooks : data;
            stripOurHooks(hooks);
            if (a.hooksWrapped && !Object.keys(hooks).length) delete data.hooks;
            fsx.write(file, `${JSON.stringify(data, null, 2)}\n`);
        }
    }

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
}

export function status() {
    const state = readState();
    const total = skillNames().length;
    const rows = Object.entries(AGENTS).map(([id, a]) => ({
        id,
        label: a.label,
        installed: state.agents.includes(id),
        rules: readText(a.rulesFile()).includes(MD_START),
        skills: skillNames().filter((n) => isOurLink(path.join(a.skillsDir(), n))).length,
        totalSkills: total,
        hooks: countOurHooks(a.hooksFile(), a.hooksWrapped),
        note: a.note,
    }));
    return {
        version: state.version,
        kitHome: kitHome(),
        nodeBin: state.nodeBin,
        nodeOk: !state.nodeBin || fs.existsSync(state.nodeBin),
        gitignore: readText(gitIgnoreFile()).includes(IGNORE_START),
        gitignoreFile: gitIgnoreFile(),
        rows,
    };
}
