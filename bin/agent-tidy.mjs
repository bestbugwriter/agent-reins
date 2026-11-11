#!/usr/bin/env node
import readline from 'node:readline/promises';
import { AGENTS, AGENT_IDS, detect } from '../src/agents.mjs';
import { install, uninstall, status, readState, PARTS, VERSION } from '../src/install.mjs';

const HELP = `agent-tidy ${VERSION}
让 coding agent 少写文档、不越界、不谎报完成。

用法：
  agent-tidy install   [-a claude,codex,dsh] [--skip hooks,...] [--dry-run]
  agent-tidy uninstall [-a claude,codex,dsh] [--dry-run]
  agent-tidy status

选项：
  -a, --agent   目标 agent，逗号分隔：${AGENT_IDS.join(', ')}；不填时交互选择
  --skip        跳过的部分：${PARTS.join(', ')}
  --dry-run     只打印将要执行的操作，不写文件
`;

function parse(argv) {
    const opts = { cmd: argv[0], agents: null, skip: [], dryRun: false };
    for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-a' || a === '--agent') opts.agents = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
        else if (a === '--skip') opts.skip = argv[++i].split(',').map((s) => s.trim());
        else if (a === '--dry-run') opts.dryRun = true;
        else if (a === '-h' || a === '--help') opts.cmd = 'help';
        else throw new Error(`未知参数：${a}`);
    }
    for (const id of opts.agents || []) {
        if (!AGENTS[id]) throw new Error(`未知 agent：${id}（可选 ${AGENT_IDS.join(', ')}）`);
    }
    for (const p of opts.skip) {
        if (!PARTS.includes(p)) throw new Error(`未知部分：${p}（可选 ${PARTS.join(', ')}）`);
    }
    return opts;
}

async function chooseAgents(defaults) {
    console.log('选择要安装的 agent（输入编号，逗号分隔；直接回车选择已检测到的）：');
    AGENT_IDS.forEach((id, i) => {
        console.log(`  ${i + 1}. ${AGENTS[id].label}${detect(id) ? '（已检测到）' : ''}`);
    });
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('> ')).trim();
    rl.close();
    if (!answer) return defaults;
    return answer.split(',').map((s) => AGENT_IDS[Number(s.trim()) - 1]).filter(Boolean);
}

function printStatus() {
    const s = status();
    console.log(`agent-tidy ${s.version || '未安装'}   安装目录：${s.kitHome}`);
    for (const r of s.rows) {
        const mark = r.installed ? '●' : '○';
        console.log(`  ${mark} ${r.label.padEnd(17)} 规则 ${r.rules ? '✓' : '✗'}   skills ${r.skills}/${r.totalSkills}   hooks ${r.hooks}`);
    }
    console.log(`  全局 gitignore：${s.gitignore ? '✓' : '✗'}  ${s.gitignoreFile}`);
    if (!s.nodeOk) console.log(`  ⚠ hooks 使用的 Node 已不存在（${s.nodeBin}），请重新运行 agent-tidy install`);
    for (const r of s.rows) if (r.installed && r.hooks && r.note) console.log(`  提示：${r.note}`);
}

async function main() {
    const opts = parse(process.argv.slice(2));
    if (!opts.cmd || opts.cmd === 'help') return console.log(HELP);

    if (opts.cmd === 'status') return printStatus();

    if (opts.cmd === 'install') {
        const detected = AGENT_IDS.filter(detect);
        let agents = opts.agents;
        if (!agents) agents = process.stdin.isTTY ? await chooseAgents(detected) : detected;
        if (!agents.length) throw new Error('没有检测到 claude / codex / dsh，请用 -a 指定');
        const notes = install({ agents, parts: PARTS.filter((p) => !opts.skip.includes(p)), dryRun: opts.dryRun });
        console.log(opts.dryRun ? '\n（dry-run，未写入任何文件）' : '\n安装完成。新开会话后生效。运行 agent-tidy status 查看状态。');
        for (const n of notes) console.log(`提示：${n}`);
        return;
    }

    if (opts.cmd === 'uninstall') {
        const agents = opts.agents || readState().agents;
        if (!agents.length) return console.log('没有已安装的 agent');
        uninstall({ agents, dryRun: opts.dryRun });
        console.log(opts.dryRun ? '\n（dry-run，未写入任何文件）' : '\n卸载完成。');
        return;
    }

    throw new Error(`未知命令：${opts.cmd}\n\n${HELP}`);
}

main().catch((e) => {
    console.error(`agent-tidy: ${e.message}`);
    process.exit(1);
});
