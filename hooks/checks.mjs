// 会话改动检查（纯逻辑）。git 相关的查询由调用方通过 ctx 注入，便于测试

export const DOC_FILE = /\.(md|mdx)$/i;
const ALWAYS_ALLOWED_DOC = /(^|\/)(README|AGENTS|CLAUDE|CHANGELOG|CONTRIBUTING|LICENSE)[^/]*$|^\.scratch\//i;
const ENV_SCAN_FILE = /\.(md|mdx|txt|rst)$|(^|\/)\.(claude|codex|agents|cursor|dsh)\/|\.cursorrules$/i;
export const TEST_FILE = /(^|\/)(test|tests|__tests__|spec|specs)\/|[._-](test|spec)\.[a-z]+$|Tests?\.(java|kt|scala|cs)$|(^|\/)test_[^/]*\.py$|_test\.(go|py)$/i;
export const CODE_FILE = /\.(java|kt|kts|scala|groovy|go|py|js|mjs|cjs|ts|tsx|jsx|vue|svelte|rs|rb|php|cs|swift|c|cc|cpp|h|hpp|m|sh|sql)$/i;
// 工具生成的过程文件和锁文件不计入文档/代码行数
const NOT_COUNTED = /(^|\/)\.comet\/|\.(log|jsonl|manifest|lock)$|(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i;

export const DEFAULT_CONFIG = {
    allowDocs: [],
    docBudget: { files: 5, lines: 200 },
    docRatio: { minLines: 50, factor: 3 },
    testNudgeLines: 5,
};

const ENV_FACT = [
    /(本机|本地机器|这台机器|当前机器|我们的机器|this machine|local machine|our (vps|server|machine)|\bvps\b|mac ?mini|macbook)[^\n]{0,40}(内存|memory|\bram\b|cpu|核|cores?|资源|resources?)/i,
    /(内存|memory|\bram\b|cpu|cores?)[^\n]{0,20}(本机|这台机器|当前机器|this machine|\bvps\b|mac ?mini)/i,
    /\b\d+\s?c\s?\d+\s?g\b/i,
    /(不能|无法|不要|禁止|cannot|can't|do not|don't)[^\n]{0,30}(运行|跑|启动|run)[^\n]{0,30}\d+\s?(MB|GB|M|G)\b/i,
];

const SKIP_MARKER = /@Disabled\b|@Ignore\b|\b(it|describe|test)\.skip\(|\bx(it|describe)\(|@pytest\.mark\.(skip|xfail)|\bt\.Skip\(|#\[ignore\]/;

// 足够有辨识度、改名或删除后值得全仓搜索的标识符：驼峰、下划线连接，或三段以上的配置键
const IDENT = /\b[A-Za-z_][A-Za-z0-9_]{4,}\b/g;
const CONFIG_KEY = /\b[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*){2,}\b/g;
const IMPORT_LINE = /^\s*(import|package|from|require|using|#include|use)\b/;
const distinctive = (id) => /[a-z][A-Z]/.test(id) || /[A-Za-z0-9]_[A-Za-z0-9]/.test(id);

/** 校验并合并项目配置 .agent-reins.json；返回 { config, error } */
export function resolveConfig(raw, { hasOpenspec = false } = {}) {
    const config = structuredClone(DEFAULT_CONFIG);
    let error = null;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        if ('allowDocs' in raw) {
            if (Array.isArray(raw.allowDocs) && raw.allowDocs.every((p) => typeof p === 'string')) config.allowDocs = raw.allowDocs;
            else error = 'allowDocs 应为字符串数组';
        }
        for (const key of ['docBudget', 'docRatio']) {
            if (!(key in raw)) continue;
            const v = raw[key];
            if (v && typeof v === 'object' && Object.values(v).every((n) => typeof n === 'number' && n >= 0)) Object.assign(config[key], v);
            else error = `${key} 的值应为非负数字`;
        }
    } else if (raw !== undefined) {
        error = '顶层应为 JSON 对象';
    }
    if (hasOpenspec && !config.allowDocs.some((p) => 'openspec/'.startsWith(p) || p.startsWith('openspec/'))) {
        config.allowDocs.push('openspec/');
    }
    return { config, error };
}

/**
 * @param ctx.changes [{ path, code, from?, added: [{line,text}], removed: [{line,text}] }] 本会话内变化的文件
 * @param ctx.config resolveConfig 的结果
 * @param ctx.repoHasTests 仓库里是否已有测试文件
 * @param ctx.readFile(path) 当前文件内容，不存在时返回 null
 * @param ctx.refsTo(ids, excludePaths) 在已跟踪文件中查找标识符引用 → [{ id, file, line }]
 * @param ctx.docRefsTo(paths) 文档中出现这些路径（或文件名）的行 → [{ file, line, text }]
 * @returns string[] 发现的问题
 */
export function reviewChanges(ctx) {
    const { changes, config = DEFAULT_CONFIG } = ctx;
    const findings = [];
    const isNew = (c) => c.code === '??' || c.code[0] === 'A' || (c.code[0] === 'R' && !DOC_FILE.test(c.from || ''));
    const allowed = (p) => ALWAYS_ALLOWED_DOC.test(p) || config.allowDocs.some((a) => p.startsWith(a));
    const counted = changes.filter((c) => !NOT_COUNTED.test(c.path));

    // ---------- 文档数量 ----------
    const newDocs = changes.filter((c) => isNew(c) && DOC_FILE.test(c.path));
    const unexpected = newDocs.filter((c) => !allowed(c.path));
    if (unexpected.length) {
        findings.push(`新增了 ${unexpected.length} 个文档：${list(unexpected.map((c) => c.path))}。`
            + `默认不新增文档；过程产物放 .scratch/。若是用户要求的，向用户说明即可。`);
    }
    const flowDocs = newDocs.filter((c) => !ALWAYS_ALLOWED_DOC.test(c.path) && allowed(c.path));
    if (flowDocs.length > config.docBudget.files) {
        findings.push(`流程文档新增了 ${flowDocs.length} 个，超过上限 ${config.docBudget.files} 个：${list(flowDocs.map((c) => c.path))}。请合并或删减。`);
    }
    const docLines = counted.filter((c) => DOC_FILE.test(c.path) && !c.path.startsWith('.scratch/')).reduce((n, c) => n + c.added.length, 0);
    const codeLines = counted.filter((c) => !DOC_FILE.test(c.path)).reduce((n, c) => n + c.added.length, 0);
    if (docLines > config.docBudget.lines) {
        findings.push(`本次文档新增 ${docLines} 行，超过上限 ${config.docBudget.lines} 行。只保留从代码里看不出来的内容。`);
    } else if (docLines >= config.docRatio.minLines && docLines > config.docRatio.factor * Math.max(codeLines, 1)) {
        findings.push(`本次文档新增 ${docLines} 行、代码 ${codeLines} 行，文档明显多于代码。请删掉不必要的内容。`);
    }

    // ---------- 环境事实 ----------
    const facts = [];
    for (const c of changes) {
        if (!ENV_SCAN_FILE.test(c.path)) continue;
        for (const a of c.added) {
            if (ENV_FACT.some((re) => re.test(a.text))) facts.push(`${c.path}:${a.line} ${a.text.trim().slice(0, 80)}`);
        }
    }
    if (facts.length) {
        findings.push(`疑似把机器环境事实写进了项目文件：${list(facts)}。`
            + `环境信息应在需要时实时检测，不应入库；请删除这些内容（不要改写成新的"当前状态"）。`);
    }

    // ---------- 测试 ----------
    const deletedTests = changes.filter((c) => TEST_FILE.test(c.code[0] === 'R' ? c.from || '' : c.path)
        && (c.code.includes('D') || (c.code[0] === 'R' && !TEST_FILE.test(c.path))));
    if (deletedTests.length) {
        findings.push(`删除了测试文件：${list(deletedTests.map((c) => c.from || c.path))}。如果不是用户要求，请恢复。`);
    }
    const skips = [];
    for (const c of changes) {
        for (const a of c.added) if (SKIP_MARKER.test(a.text)) skips.push(`${c.path}:${a.line}`);
    }
    if (skips.length) findings.push(`新增了跳过测试的标记：${list(skips)}。不得为了让测试通过而跳过测试。`);

    const logic = counted.filter((c) => CODE_FILE.test(c.path) && !TEST_FILE.test(c.path));
    const logicLines = logic.reduce((n, c) => n + nonBlank(c.added) + nonBlank(c.removed), 0);
    const testsTouched = changes.some((c) => TEST_FILE.test(c.path) || TEST_FILE.test(c.from || ''));
    if (ctx.repoHasTests && !testsTouched && logicLines >= config.testNudgeLines) {
        findings.push(`改了 ${logicLines} 行逻辑代码（${list(logic.map((c) => c.path))}），但没有改动任何测试。`
            + `请确认受影响的用例是否需要新增、修改或删除；确实不需要时向用户说明理由。`);
    }

    // ---------- 一致性：删除/改名的标识符仍被引用 ----------
    const changedPaths = new Set(changes.map((c) => c.path));
    const goneIds = new Set();
    for (const c of changes) {
        if (!c.removed.length) continue;
        const current = c.code.includes('D') ? '' : ctx.readFile?.(c.path) ?? '';
        const added = new Set(c.added.flatMap((a) => identifiers(a.text)));
        for (const r of c.removed) {
            if (IMPORT_LINE.test(r.text)) continue;
            for (const id of identifiers(r.text)) {
                if (!added.has(id) && !containsWord(current, id)) goneIds.add(id);
            }
        }
    }
    if (goneIds.size && ctx.refsTo) {
        const refs = ctx.refsTo([...goneIds].slice(0, 30), [...changedPaths]);
        const byId = new Map();
        for (const r of refs) {
            if (!byId.has(r.id)) byId.set(r.id, []);
            byId.get(r.id).push(`${r.file}:${r.line}`);
        }
        if (byId.size) {
            const items = [...byId].map(([id, locs]) => `\`${id}\` → ${locs.slice(0, 3).join('、')}${locs.length > 3 ? ` 等 ${locs.length} 处` : ''}`);
            findings.push(`本次删除或改名的标识符仍出现在未改动的文件里，相关文档、注释或代码可能已过期：${list(items)}。`
                + `请同步更新；确认无关时向用户说明。`);
        }
    }

    // ---------- 一致性：文档里指向改动文件的锚点和路径 ----------
    const codeChanged = changes.filter((c) => !DOC_FILE.test(c.path) && !NOT_COUNTED.test(c.path));
    if (codeChanged.length && ctx.docRefsTo) {
        const broken = [];
        const deleted = new Set(codeChanged.filter((c) => c.code.includes('D')).map((c) => c.path));
        for (const c of changes.filter((x) => x.code[0] === 'R' && x.from)) deleted.add(c.from);
        const targets = [...new Set([...codeChanged.map((c) => c.path), ...deleted])];
        for (const ref of ctx.docRefsTo(targets)) {
            if (changedPaths.has(ref.file)) continue;
            for (const t of targets) {
                const base = t.split('/').pop();
                if (deleted.has(t) && (ref.text.includes(t) || new RegExp(`(^|[^\\w./-])${escape(base)}\\b`).test(ref.text))) {
                    broken.push(`${ref.file}:${ref.line} 引用了已删除或改名的 ${t}`);
                    continue;
                }
                for (const m of ref.text.matchAll(new RegExp(`(?:${escape(t)}|(?<![\\w/.-])${escape(base)})#([A-Za-z_][\\w]*)`, 'g'))) {
                    if (!containsWord(ctx.readFile?.(t) ?? '', m[1])) broken.push(`${ref.file}:${ref.line} 的锚点 ${base}#${m[1]} 已不存在`);
                }
            }
        }
        if (broken.length) findings.push(`文档引用与代码不一致：${list([...new Set(broken)])}。请更新这些文档。`);
    }

    return findings;
}

function identifiers(text) {
    const ids = (text.match(IDENT) || []).filter(distinctive);
    return [...ids, ...(text.match(CONFIG_KEY) || [])];
}

function containsWord(text, word) {
    return new RegExp(`(^|[^\\w.])${escape(word)}($|[^\\w])`).test(text);
}

function escape(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nonBlank(lines) {
    return lines.filter((l) => l.text.trim()).length;
}

function list(items) {
    const shown = items.slice(0, 8).join('；');
    return items.length > 8 ? `${shown}；等 ${items.length} 处` : shown;
}
