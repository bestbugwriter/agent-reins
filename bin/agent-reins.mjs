#!/usr/bin/env node
import readline from 'node:readline/promises';
import { AGENTS, AGENT_IDS, detect } from '../src/agents.mjs';
import { install, uninstall, status, PARTS, VERSION } from '../src/install.mjs';

const HELP = `agent-reins ${VERSION}
让 coding agent 少写文档、不越界、不谎报完成。

用法：
  agent-reins install   [-a claude,codex,dsh,qoder,kimi] [--skip hooks,...] [--dry-run]
  agent-reins uninstall [-a claude,codex,dsh,qoder,kimi] [--dry-run]
  agent-reins status

选项：
  -a, --agent   目标 agent，逗号分隔：${AGENT_IDS.join(', ')}；不填时交互选择
  --skip        跳过的部分：${PARTS.join(', ')}
  --dry-run     只打印将要执行的操作，不写文件
`;

function parse(argv) {
    const first = argv[0];
    const opts = { cmd: first === '-h' || first === '--help' ? 'help' : first, agents: null, skip: [], dryRun: false };
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
    console.log(`agent-reins ${s.version || '未安装'}   安装目录：${s.kitHome}`);
    for (const r of s.rows) {
        const mark = r.installed ? '●' : '○';
        const hooks = r.hooksError ? '⚠ 配置损坏' : String(r.hooks);
        console.log(`  ${mark} ${r.label.padEnd(17)} 规则 ${r.rules ? '✓' : '✗'}   skills ${r.skills}/${r.totalSkills}   hooks ${hooks}`);
        if (r.hooksError) console.log(`      ${r.hooksError}`);
        if (r.id === 'dsh' && r.installed) {
            for (const p of r.profiles) {
                const where = !p.bridge ? '未挂载 hooks 插件桥，hooks 不会执行'
                    : !p.pkg ? `${p.bridge.plugin} 已挂载（${p.viaRoot ? '根补丁' : 'profile 补丁'}）但插件包未安装，hooks 不会执行`
                        + (p.profile === 'desktop' ? '；请在 App 插件管理安装与 App 同版本' : '')
                    : `${p.bridge.plugin} → ${p.bridge.configPath || '项目级相对路径（全局 hooks 不适用）'}${p.viaRoot ? '（根补丁，全局生效）' : ''}`;
                console.log(`      profile ${p.profile.padEnd(8)} ${where}`);
            }
            for (const b of r.otherBridges) console.log(`      ${b.profile} ${b.file}：${b.plugin} → ${b.configPath || '相对路径'}`);
            if (r.hooks) console.log('      桥已挂载不等于在运行：新开 dsh 会话，确认上下文里出现了本机环境信息');
        }
        if (r.untrusted) console.log(`      ⚠ 有 ${r.untrusted} 个 hook 尚未在 Codex 中审批，审批前不会执行`);
    }
    console.log(`  全局 gitignore：${s.gitignore ? '✓' : '✗'}  ${s.gitignoreFile}`);
    console.log(`  个人偏好：${s.overlay || '无（可创建 ~/.agents/agent-reins.local.md 后重新 install）'}`);
    if (s.version && !s.kitOk) console.log(`  ⚠ 安装目录缺失或不完整，规则仍在但 skills/hooks 已失效，请重新运行 agent-reins install`);
    if (!s.nodeOk) console.log(`  ⚠ 安装时记录的 Node（${s.nodeBin}）已不存在，hooks 会自动改用 PATH 中的 node；建议重新运行 agent-reins install`);
}

async function main() {
    const opts = parse(process.argv.slice(2));
    if (!opts.cmd || opts.cmd === 'help') return console.log(HELP);

    if (opts.cmd === 'status') return printStatus();

    if (opts.cmd === 'install') {
        const detected = AGENT_IDS.filter(detect);
        let agents = opts.agents;
        if (!agents) agents = process.stdin.isTTY ? await chooseAgents(detected) : detected;
        if (!agents.length) throw new Error(`没有检测到任何 agent（${AGENT_IDS.join(' / ')}），请用 -a 指定`);
        const notes = install({ agents, parts: PARTS.filter((p) => !opts.skip.includes(p)), dryRun: opts.dryRun });
        console.log(opts.dryRun ? '\n（dry-run，未写入任何文件）' : '\n安装完成。新开会话后生效。运行 agent-reins status 查看状态。');
        for (const n of notes) console.log(`提示：${n}`);
        return;
    }

    if (opts.cmd === 'uninstall') {
        uninstall({ agents: opts.agents, dryRun: opts.dryRun });
        if (opts.dryRun) console.log('\n（dry-run，未写入任何文件）');
        return;
    }

    throw new Error(`未知命令：${opts.cmd}\n\n${HELP}`);
}

main().catch((e) => {
    console.error(`agent-reins: ${e.message}`);
    process.exit(1);
});
