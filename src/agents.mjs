// 三个 agent 的全局目录约定
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const home = () => os.homedir();
export const agentsHome = () => path.join(home(), '.agents');
export const kitHome = () => path.join(agentsHome(), 'agent-tidy');
const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || path.join(home(), '.claude');
const codexHome = () => process.env.CODEX_HOME || path.join(home(), '.codex');
const dshHome = () => process.env.DSH_HOME || path.join(home(), '.dsh');

export const AGENTS = {
    claude: {
        label: 'Claude Code',
        bin: 'claude',
        home: claudeHome,
        rulesFile: () => path.join(claudeHome(), 'CLAUDE.md'),
        skillsDir: () => path.join(claudeHome(), 'skills'),
        hooksFile: () => path.join(claudeHome(), 'settings.json'),
        hooksWrapped: true,
        toolMatcher: 'Bash|Edit|Write|MultiEdit',
    },
    codex: {
        label: 'Codex',
        bin: 'codex',
        home: codexHome,
        rulesFile: () => path.join(codexHome(), 'AGENTS.md'),
        skillsDir: () => path.join(agentsHome(), 'skills'),
        hooksFile: () => path.join(codexHome(), 'hooks.json'),
        hooksWrapped: true,
    },
    dsh: {
        label: 'DeepSeek Harness',
        bin: 'dsh',
        home: dshHome,
        rulesFile: () => path.join(dshHome(), 'AGENTS.md'),
        skillsDir: () => path.join(agentsHome(), 'skills'),
        hooksFile: () => path.join(dshHome(), 'hooks.json'),
        hooksWrapped: false,
        note: 'dsh 的 hooks 需要插件才会生效：dsh plugin --profile web add dsh-hooks-plugin',
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
        if (v) return v.replace(/^~(?=$|[\/\\])/, home());
    } catch {
        // 未配置时 git 默认读取 XDG 位置
    }
    return path.join(process.env.XDG_CONFIG_HOME || path.join(home(), '.config'), 'git', 'ignore');
}
