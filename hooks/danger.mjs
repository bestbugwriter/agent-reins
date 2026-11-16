// 危险命令识别：按引号切分语句和参数，递归展开 bash -c / eval / $() / 反引号，识别管道接裸 shell
// 只是兜底的安全网，不是沙箱：python -c、脚本文件等间接执行无法穷举

const SAFE_RM_TARGET = /^(\.\/)?(node_modules|dist|build|target|out|coverage|\.scratch|\.cache|\.gradle|__pycache__|\.pytest_cache|\.next|\.turbo)(\/.*)?$|^\/(private\/)?tmp\//;
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const PREFIXES = new Set(['sudo', 'command', 'exec', 'nohup', 'time', 'nice', 'xargs']);
const MAX_DEPTH = 4;

// 在引号外按换行、;、&&、||、| 切分；piped 标记紧跟在管道后的语句
function splitWithPipe(cmd) {
    const out = [];
    let cur = '';
    let quote = null;
    let piped = false;
    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];
        if (quote) {
            if (ch === '\\' && quote === '"') {
                cur += ch + (cmd[++i] ?? '');
                continue;
            }
            if (ch === quote) quote = null;
            cur += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            cur += ch;
        } else if (ch === '\\') {
            cur += ch + (cmd[++i] ?? '');
        } else if (ch === '\n' || ch === ';' || ch === '|' || (ch === '&' && cmd[i + 1] === '&')) {
            const isPipe = ch === '|' && cmd[i + 1] !== '|';
            if (ch === '&' || (ch === '|' && cmd[i + 1] === '|')) i++;
            out.push({ stmt: cur, piped });
            cur = '';
            piped = isPipe;
        } else {
            cur += ch;
        }
    }
    out.push({ stmt: cur, piped });
    return out.map((s) => ({ stmt: s.stmt.trim(), piped: s.piped })).filter((s) => s.stmt);
}

export function splitStatements(cmd) {
    return splitWithPipe(cmd).map((s) => s.stmt);
}

// 按空白切分参数，去掉引号
export function tokenize(stmt) {
    const tokens = [];
    let cur = '';
    let quote = null;
    let has = false;
    for (let i = 0; i < stmt.length; i++) {
        const ch = stmt[i];
        if (quote) {
            if (ch === quote) quote = null;
            else if (ch === '\\' && quote === '"' && i + 1 < stmt.length) cur += stmt[++i];
            else cur += ch;
        } else if (ch === '"' || ch === "'") {
            quote = ch;
            has = true;
        } else if (ch === '\\' && i + 1 < stmt.length) {
            cur += stmt[++i];
            has = true;
        } else if (/\s/.test(ch)) {
            if (has || cur) tokens.push(cur);
            cur = '';
            has = false;
        } else {
            cur += ch;
            has = true;
        }
    }
    if (has || cur) tokens.push(cur);
    return tokens;
}

// $(...) 与反引号中的子命令（支持嵌套括号）
function substitutions(stmt) {
    const subs = [];
    for (let i = 0; i < stmt.length; i++) {
        if (stmt[i] === '$' && stmt[i + 1] === '(') {
            let depth = 0;
            for (let j = i + 1; j < stmt.length; j++) {
                if (stmt[j] === '(') depth++;
                else if (stmt[j] === ')' && --depth === 0) {
                    subs.push(stmt.slice(i + 2, j));
                    i = j;
                    break;
                }
            }
        } else if (stmt[i] === '`') {
            const j = stmt.indexOf('`', i + 1);
            if (j > i) {
                subs.push(stmt.slice(i + 1, j));
                i = j;
            }
        }
    }
    return subs;
}

function shortFlags(tokens) {
    return tokens.filter((t) => /^-[a-zA-Z]+$/.test(t)).map((t) => t.slice(1)).join('');
}

function checkRm(args) {
    const end = args.indexOf('--');
    const opts = end < 0 ? args : args.slice(0, end);
    const short = shortFlags(opts);
    const recursive = /[rR]/.test(short) || opts.includes('--recursive');
    const force = short.includes('f') || opts.includes('--force');
    if (!recursive || !force) return null;
    const targets = end < 0 ? args.filter((a) => !a.startsWith('-')) : [...opts.filter((a) => !a.startsWith('-')), ...args.slice(end + 1)];
    const unsafe = targets.filter((t) => t.split('/').includes('..') || !SAFE_RM_TARGET.test(t));
    if (targets.length && !unsafe.length) return null;
    return `递归强制删除：rm -rf ${targets.join(' ')}`.trim();
}

function checkGit(args) {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) {
        i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[i]) ? 2 : 1;
    }
    const sub = args[i];
    const rest = args.slice(i + 1);
    const short = shortFlags(rest);
    switch (sub) {
        case 'reset':
            return rest.includes('--hard') ? 'git reset --hard（丢弃未提交改动）' : null;
        case 'clean': {
            const force = short.includes('f') || rest.includes('--force');
            const dry = short.includes('n') || rest.includes('--dry-run');
            return force && !dry ? 'git clean -f（删除未跟踪文件）' : null;
        }
        case 'push': {
            const flags = rest.some((a) => /^--(force|force-with-lease|force-if-includes|mirror|delete|prune)(=|$)/.test(a));
            const refs = rest.filter((a) => !a.startsWith('-')).slice(1);
            if (flags || /[fd]/.test(short) || refs.some((r) => r.startsWith('+') || r.startsWith(':'))) {
                return 'git 强制推送或删除远程分支';
            }
            return null;
        }
        case 'branch':
            return short.includes('D') || (short.includes('d') && (short.includes('f') || rest.includes('--force')))
                ? 'git 强制删除分支' : null;
        case 'checkout':
            return rest.includes('.') && !short.includes('b') ? '丢弃全部工作区改动（git checkout .）' : null;
        case 'restore':
            return rest.includes('.') && !(rest.includes('--staged') && !rest.includes('--worktree'))
                ? '丢弃全部工作区改动（git restore .）' : null;
        case 'stash':
            return ['drop', 'clear'].includes(rest[0]) ? `git stash ${rest[0]}` : null;
        default:
            return null;
    }
}

function checkTokens(tokens, depth) {
    let i = 0;
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || PREFIXES.has(tokens[i]))) i++;
    const name = (tokens[i] || '').split('/').pop();
    const args = tokens.slice(i + 1);
    if (SHELLS.has(name)) {
        const ci = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
        return ci >= 0 && args[ci + 1] ? scan(args[ci + 1], depth + 1) : null;
    }
    if (name === 'eval') return scan(args.join(' '), depth + 1);
    if (name === 'rm') return checkRm(args);
    if (name === 'git') return checkGit(args);
    if (/^mkfs(\.\w+)?$/.test(name) || (name === 'diskutil' && /^erase/i.test(args[0] || ''))) return '格式化磁盘';
    if (name === 'dd' && args.some((a) => a.startsWith('of=/dev/'))) return 'dd 写设备';
    if (name === 'kubectl' && args.includes('delete')) return 'kubectl delete';
    if (name === 'terraform' && (args.includes('destroy') || args.includes('-destroy'))) return 'terraform destroy';
    return null;
}

// 管道后的裸 shell（无脚本文件参数）：经典 curl … | sh；-c 交给 checkTokens 递归
function isBareShell(tokens) {
    let i = 0;
    while (i < tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]) || PREFIXES.has(tokens[i]))) i++;
    const name = (tokens[i] || '').split('/').pop();
    if (!SHELLS.has(name)) return false;
    const args = tokens.slice(i + 1);
    if (args.some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a))) return false;
    return !args.some((a) => !a.startsWith('-'));
}

function scan(cmd, depth) {
    if (depth > MAX_DEPTH) return null;
    for (const { stmt, piped } of splitWithPipe(cmd)) {
        for (const sub of substitutions(stmt)) {
            const hit = scan(sub, depth + 1);
            if (hit) return hit;
        }
        const tokens = tokenize(stmt);
        if (piped && isBareShell(tokens)) return '管道直接执行 shell（如 curl … | sh）';
        const hit = checkTokens(tokens, depth);
        if (hit) return hit;
    }
    return null;
}

// SQL 可能出现在任意引号里（mysql -e "..."），直接在原文上匹配
function checkSql(cmd) {
    if (/\bdrop\s+(table|database|schema)\b/i.test(cmd)) return 'SQL DROP';
    if (/\btruncate\s+table\b/i.test(cmd)) return 'SQL TRUNCATE';
    for (const m of cmd.matchAll(/\bdelete\s+from\s+[\w.`"]+([^;]*)/gi)) {
        if (!/\bwhere\b/i.test(m[1])) return 'SQL DELETE 不带 WHERE';
    }
    return null;
}

export function findDanger(cmd) {
    if (Array.isArray(cmd)) return checkTokens(cmd.map(String), 0) || checkSql(cmd.join(' ')); // argv 形式，拼接会丢失引号
    if (!cmd || typeof cmd !== 'string') return null;
    return scan(cmd, 0) || checkSql(cmd);
}

// 引号外的重定向目标（> / >>，排除 >& 描述符复制）；引号内的 ">> x" 不算
export function redirectTargets(cmd) {
    const targets = [];
    let quote = null;
    for (let i = 0; i < cmd.length; i++) {
        const ch = cmd[i];
        if (quote) {
            if (ch === '\\' && quote === '"') i++;
            else if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '\\') { i++; continue; }
        if (ch !== '>') continue;
        let j = i + 1;
        if (cmd[j] === '>') j++;
        if (cmd[j] === '&') continue;
        while (j < cmd.length && /\s/.test(cmd[j])) j++;
        let t = '';
        let q = null;
        while (j < cmd.length) {
            const c = cmd[j];
            if (q) {
                if (c === '\\' && q === '"') { t += cmd[j + 1] ?? ''; j += 2; continue; }
                if (c === q) { q = null; j++; continue; }
                t += c; j++; continue;
            }
            if (c === '"' || c === "'") { q = c; j++; continue; }
            if (/[\s|;&<>]/.test(c)) break;
            t += c; j++;
        }
        if (t) targets.push(t);
        i = j - 1;
    }
    return targets;
}

// shell 可能写文件的操作数：重定向目标 + tee 的文件参数 + sed -i 的最后一个操作数
export function shellWriteTargets(cmd) {
    const targets = redirectTargets(cmd);
    for (const stmt of splitStatements(cmd)) {
        const toks = tokenize(stmt);
        let i = 0;
        while (i < toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i]) || PREFIXES.has(toks[i]))) i++;
        const name = (toks[i] || '').split('/').pop();
        const args = toks.slice(i + 1);
        if (name === 'tee') targets.push(...args.filter((t) => !t.startsWith('-')));
        if (name === 'sed' && args.some((t) => /^-i/.test(t) || t === '--in-place')) {
            const last = args[args.length - 1];
            if (last && !last.startsWith('-')) targets.push(last);
        }
    }
    return targets;
}
