// 三个 agent 的全局目录约定
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const home = () => os.homedir();
const expand = (p) => p.replace(/^~(?=$|[\/\\])/, home());
export const agentsHome = () => path.join(home(), '.agents');
export const kitHome = () => path.join(agentsHome(), 'agent-reins');
export const overlayFile = () => path.join(agentsHome(), 'agent-reins.local.md');
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude');
const codexHome = () => process.env.CODEX_HOME || path.join(home(), '.codex');
const dshHome = () => process.env.DSH_HOME || path.join(home(), '.dsh');

// dsh 每个 profile（desktop、tui、web）各自加载插件；hooks 由 cordis 插件桥执行。
// 返回每个 patch 文件里挂载的桥，以及它读取的 configPath（相对路径按会话目录解析，属于项目级，记为 null）
export function dshBridges() {
    const candidates = [{ profile: '（根目录）', file: path.join(dshHome(), 'cordis.patch.yml') }];
    try {
        for (const p of fs.readdirSync(path.join(dshHome(), 'profiles'))) {
            candidates.push({ profile: p, file: path.join(dshHome(), 'profiles', p, 'cordis.patch.yml') });
        }
    } catch {
        // 没有 profiles 目录
    }
    const bridges = [];
    for (const c of candidates) {
        let text;
        try {
            text = fs.readFileSync(c.file, 'utf8');
        } catch {
            continue;
        }
        for (const m of text.matchAll(/dsh-hooks-(claude-code|codex)[\s\S]*?configPath:\s*["']?([^"'\n]+)["']?/g)) {
            const configPath = expand(m[2].trim());
            bridges.push({ ...c, plugin: `@deepseek-ai/dsh-hooks-${m[1]}`, configPath: path.isAbsolute(configPath) ? configPath : null });
        }
    }
    return bridges;
}

export const dshProfiles = () => {
    try {
        return fs.readdirSync(path.join(dshHome(), 'profiles')).filter((p) => fs.existsSync(path.join(dshHome(), 'profiles', p, 'package.json')));
    } catch {
        return [];
    }
};

// 只有 claude-code 方言的桥能识别 agent-reins 写入的 Claude 格式 hooks
export const dshHooksFiles = () => [...new Set(dshBridges().filter((b) => b.plugin.endsWith('claude-code') && b.configPath).map((b) => b.configPath))];

export const AGENTS = {
    claude: {
        label: 'Claude Code',
        bin: 'claude',
        home: claudeHome,
        rulesFile: () => path.join(claudeHome(), 'CLAUDE.md'),
        skillsDir: () => path.join(claudeHome(), 'skills'),
        hooksFile: () => path.join(claudeHome(), 'settings.json'),
        toolMatcher: 'Bash|Edit|Write|MultiEdit',
    },
    codex: {
        label: 'Codex',
        bin: 'codex',
        home: codexHome,
        rulesFile: () => path.join(codexHome(), 'AGENTS.md'),
        skillsDir: () => path.join(agentsHome(), 'skills'),
        hooksFile: () => path.join(codexHome(), 'hooks.json'),
        configToml: () => path.join(codexHome(), 'config.toml'),
    },
    dsh: {
        label: 'DeepSeek Harness',
        bin: 'dsh',
        home: dshHome,
        rulesFile: () => path.join(dshHome(), 'AGENTS.md'),
        skillsDir: () => path.join(agentsHome(), 'skills'),
        hooksFiles: dshHooksFiles,
        // 卸载时额外检查默认位置，清理旧版本写入的条目
        cleanupHooksFiles: () => [...new Set([...dshHooksFiles(), path.join(dshHome(), 'hooks.json')])],
    },
};

export const AGENT_IDS = Object.keys(AGENTS);

function onPath(bin) {
    try {
        execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

export function detect(id) {
    return fs.existsSync(AGENTS[id].home()) || onPath(AGENTS[id].bin);
}

export function gitIgnoreFile() {
    try {
        const v = execFileSync('git', ['config', '--global', '--get', 'core.excludesFile'], { encoding: 'utf8' }).trim();
        if (v) return expand(v);
    } catch {
        // 未配置时 git 默认读取 XDG 位置
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(home(), '.config'), 'git', 'ignore');
}
