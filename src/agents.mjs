// 三个 agent 的全局目录约定
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const home = () => os.homedir();
const expand = (p) => p.replace(/^~(?=$|[\/\\])/, home());
export const agentsHome = () => path.join(home(), '.agents');
export const kitHome = () => path.join(agentsHome(), 'agent-tidy');
export const overlayFile = () => path.join(agentsHome(), 'agent-tidy.local.md');
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude');
const codexHome = () => process.env.CODEX_HOME || path.join(home(), '.codex');
const dshHome = () => process.env.DSH_HOME || path.join(home(), '.dsh');

// dsh 的 hooks 由 cordis 插件桥执行；找到桥的挂载配置，并以它读取的 configPath 为准
export function dshBridge() {
    for (const name of ['cordis.patch.yml', 'cordis.yml']) {
        const file = path.join(dshHome(), name);
        let text;
        try {
            text = fs.readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        const m = text.match(/dsh-hooks-(claude-code|codex)[\s\S]*?configPath:\s*["']?([^"'\n]+)["']?/);
        if (!m) continue;
        const configPath = expand(m[2].trim());
        // 相对路径按会话工作目录解析，是项目级配置，全局安装仍写默认位置
        return { file, plugin: `@deepseek-ai/dsh-hooks-${m[1]}`, configPath: path.isAbsolute(configPath) ? configPath : null };
    }
    return null;
}

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
        hooksFile: () => dshBridge()?.configPath || path.join(dshHome(), 'hooks.json'),
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
