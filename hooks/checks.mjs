// 纯函数检查规则，hooks 与测试共用

// ---------- 危险命令 ----------

const SAFE_RM_TARGET = /^(\.\/)?(node_modules|dist|build|target|out|coverage|\.scratch|\.cache|\.gradle|__pycache__|\.pytest_cache|\.next|\.turbo)(\/.*)?$|^\/(private\/)?tmp\//;

const DANGER_RULES = [
    { label: 'git reset --hard（丢弃未提交改动）', re: /\bgit\s+reset\s+[^;&|]*--hard\b/ },
    { label: 'git clean -f（删除未跟踪文件）', re: /\bgit\s+clean\s+[^;&|]*-[a-zA-Z]*f/ },
    { label: 'git 强制推送', re: /\bgit\s+push\b[^;&|]*\s(--force\b|--force-with-lease\b|-f\b)/ },
    { label: 'git 删除分支 -D', re: /\bgit\s+branch\s+[^;&|]*-D\b/ },
    { label: '丢弃全部工作区改动', re: /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$|;)/ },
    { label: 'git stash drop/clear', re: /\bgit\s+stash\s+(drop|clear)\b/ },
    { label: 'SQL DROP', re: /\bdrop\s+(table|database|schema)\b/i },
    { label: 'SQL TRUNCATE', re: /\btruncate\s+table\b/i },
    { label: 'SQL DELETE 不带 WHERE', re: /\bdelete\s+from\s+[\w.`"]+\s*(;|"|'|$)/im },
    { label: '格式化磁盘', re: /\b(mkfs(\.\w+)?|diskutil\s+erase\w*)\b/ },
    { label: 'dd 写设备', re: /\bdd\s+[^;&|]*of=\/dev\// },
    { label: 'kubectl delete', re: /\bkubectl\s+[^;&|]*\bdelete\b/ },
    { label: 'terraform destroy', re: /\bterraform\s+destroy\b/ },
];

function rmRecursiveForce(cmd) {
    for (const seg of cmd.split(/;|&&|\|\||\|/)) {
        const m = seg.match(/(?:^|\s)(?:sudo\s+)?rm\s+(.*)$/);
        if (!m) continue;
        const args = m[1].trim().split(/\s+/);
        const flags = args.filter((a) => a.startsWith('-')).join(' ');
        const recursive = /-[a-zA-Z]*[rR]|--recursive/.test(flags);
        const force = /-[a-zA-Z]*f|--force/.test(flags);
        if (!recursive || !force) continue;
        const targets = args.filter((a) => !a.startsWith('-')).map((a) => a.replace(/^["']|["']$/g, ''));
        if (targets.length && targets.every((t) => SAFE_RM_TARGET.test(t))) continue;
        return `rm -rf ${targets.join(' ')}`.trim();
    }
    return null;
}

export function findDanger(cmd) {
    if (!cmd || typeof cmd !== 'string') return null;
    const rm = rmRecursiveForce(cmd);
    if (rm) return `递归强制删除：${rm}`;
    const hit = DANGER_RULES.find((r) => r.re.test(cmd));
    return hit ? hit.label : null;
}

export const RULE_FILE = /(^|[\/\\])(AGENTS|CLAUDE)(\.local)?\.md$|[\/\\]\.claude[\/\\]rules[\/\\]/;

// ---------- 会话改动检查 ----------

const DOC_FILE = /\.(md|mdx)$/i;
const ALWAYS_ALLOWED_DOC = /(^|\/)(README|AGENTS|CLAUDE|CHANGELOG|CONTRIBUTING|LICENSE)[^/]*$|^\.scratch\//i;
const ENV_SCAN_FILE = /\.(md|mdx|txt|rst)$|(^|\/)\.(claude|codex|agents|cursor|dsh)\/|\.cursorrules$/i;
const TEST_FILE = /(^|\/)(test|tests|__tests__|spec|specs)\/|[._-](test|spec)\.[a-z]+$|Tests?\.(java|kt|cs)$|(^|\/)test_[^/]*\.py$|_test\.(go|py)$/i;
const LOCK_FILE = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.lock)$/;

const ENV_FACT = [
    /(本机|本地机器|这台机器|当前机器|我们的机器|this machine|local machine|our (vps|server|machine)|\bvps\b|mac ?mini|macbook)[^\n]{0,40}(内存|memory|\bram\b|cpu|核|cores?|资源|resources?)/i,
    /(内存|memory|\bram\b|cpu|cores?)[^\n]{0,20}(本机|这台机器|当前机器|this machine|\bvps\b|mac ?mini)/i,
    /\b\d+\s?c\s?\d+\s?g\b/i,
    /(不能|无法|不要|禁止|cannot|can't|do not|don't)[^\n]{0,30}(运行|跑|启动|run)[^\n]{0,30}\d+\s?(MB|GB|M|G)\b/i,
];

const SKIP_MARKER = /@Disabled\b|@Ignore\b|\b(it|describe|test)\.skip\(|\bx(it|describe)\(|@pytest\.mark\.(skip|xfail)|\bt\.Skip\(|#\[ignore\]/;

/**
 * @param changes [{ path, code, added: [{ line, text }] }] 本会话内发生变化的文件
 * @param allowDocs 项目允许新增文档的路径前缀
 * @returns string[] 发现的问题
 */
export function reviewChanges(changes, allowDocs = []) {
    const findings = [];

    const newDocs = changes.filter((c) => (c.code === '??' || c.code[0] === 'A')
        && DOC_FILE.test(c.path)
        && !ALWAYS_ALLOWED_DOC.test(c.path)
        && !allowDocs.some((p) => c.path.startsWith(p)));
    if (newDocs.length) {
        findings.push(`新增了 ${newDocs.length} 个文档：${list(newDocs.map((c) => c.path))}。`
            + `规则是默认不新增文档；过程产物应放 .scratch/。若是用户要求的，向用户说明即可。`);
    }

    const facts = [];
    for (const c of changes) {
        if (!ENV_SCAN_FILE.test(c.path)) continue;
        for (const a of c.added) {
            if (ENV_FACT.some((re) => re.test(a.text))) facts.push(`${c.path}:${a.line} ${a.text.trim().slice(0, 80)}`);
        }
    }
    if (facts.length) {
        findings.push(`疑似把机器环境事实写进了项目文件：${list(facts)}。`
            + `环境信息由会话启动时实时提供，不应入库；请删除这些内容（不要改写成新的"当前状态"）。`);
    }

    const deletedTests = changes.filter((c) => c.code.includes('D') && TEST_FILE.test(c.path));
    if (deletedTests.length) {
        findings.push(`删除了测试文件：${list(deletedTests.map((c) => c.path))}。如果不是用户要求，请恢复。`);
    }
    const skips = [];
    for (const c of changes) {
        for (const a of c.added) {
            if (SKIP_MARKER.test(a.text)) skips.push(`${c.path}:${a.line}`);
        }
    }
    if (skips.length) {
        findings.push(`新增了跳过测试的标记：${list(skips)}。不得为了让测试通过而跳过测试。`);
    }

    let docLines = 0;
    let codeLines = 0;
    for (const c of changes) {
        if (LOCK_FILE.test(c.path)) continue;
        if (DOC_FILE.test(c.path)) docLines += c.added.length;
        else codeLines += c.added.length;
    }
    if (docLines >= 150 && docLines > 3 * Math.max(codeLines, 1)) {
        findings.push(`本次新增文档 ${docLines} 行、代码 ${codeLines} 行，文档明显多于代码。请删掉不必要的内容。`);
    }

    return findings;
}

function list(items) {
    const shown = items.slice(0, 8).join('；');
    return items.length > 8 ? `${shown}；等 ${items.length} 处` : shown;
}
