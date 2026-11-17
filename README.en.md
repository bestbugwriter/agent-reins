# agent-reins

Make coding agents write fewer docs, stay in scope, keep changes consistent, and never fake completion. One command installs the same global rules, Skills, and Hooks into Claude Code, Codex, DeepSeek Harness, Qoder, and Kimi Code.

[中文 README](README.md)

## Install & usage

```bash
npm install -g agent-reins         # global install
agent-reins install                # interactively pick agents to wire up
agent-reins status                 # per-agent rules / skills / hooks status
agent-reins uninstall -a codex     # uninstall a single agent
```

Prefer not to install globally? Use npx: `npx agent-reins install -a claude,qoder`.

Common options:

- `-a, --agent`: comma-separated targets (`claude,codex,dsh,qoder,kimi`). Omit for interactive selection; in non-interactive terminals all detected agents are installed.
- `--skip`: parts to skip (`rules,skills,hooks,gitignore`), e.g. `--skip hooks`.
- `--dry-run`: print what would happen without writing any file.

Changes take effect in **new sessions**. Codex additionally requires hook approval in its UI; dsh requires the plugin bridge (see below). Re-installing is idempotent; uninstall removes only what agent-reins wrote.

## What gets installed

| Part | Claude Code | Codex | DeepSeek Harness | Qoder | Kimi Code |
|---|---|---|---|---|---|
| Rules `rules/AGENTS.md` | managed block in `~/.claude/CLAUDE.md` | managed block in `~/.codex/AGENTS.md` | managed block in `~/.dsh/AGENTS.md` | managed block in `~/.qoder/AGENTS.md` | managed block in `~/.kimi-code/AGENTS.md` |
| Skills `skills/*` | symlinks in `~/.claude/skills/` | symlinks in `~/.agents/skills/` | symlinks in `~/.agents/skills/` (shared with Codex) | same (Qoder reads this directory too) | same (official Kimi scan directory) |
| Hooks `hooks/*` | `~/.claude/settings.json` | `~/.codex/hooks.json` | files read by each profile's plugin bridge | `~/.qoder/settings.json` | managed `[[hooks]]` block in `~/.kimi-code/config.toml` |
| Global gitignore | `.scratch/`, `.agent-handoff.md`, `CLAUDE.local.md`, `AGENTS.local.md`, written to `core.excludesFile` | same | same | same | same |

Files are copied to `~/.agents/agent-reins/` first; agent directories only receive managed blocks, symlinks, and hook entries. Installer behavior:

- Preflights every target config before writing; if any is corrupt, nothing is written at all.
- Re-installs are idempotent; the first modification of a file backs it up as `*.agent-reins.bak`.
- Existing skills with the same name are never overwritten.
- Uninstall removes only agent-reins content; shared directories survive while other agents still use them.

**Personal preferences**: put them in `~/.agents/agent-reins.local.md` (e.g. "reply in Chinese"); they are merged into the rules block on re-install. The package itself stays generic.

## Per-agent post-install steps

- **Codex**: new or changed hooks are skipped until approved. Open Codex and trust agent-reins' 4 hooks in the approval prompt. `agent-reins status` shows how many are still unapproved.
- **DeepSeek Harness**: each dsh profile (desktop, tui, web) loads plugins separately. Hooks run through the official bridge `@deepseek-ai/dsh-hooks-claude-code`; the installer only writes hooks into files read by profiles that **have the bridge mounted**. Without a bridge, hooks are skipped and `status` reports per-profile detail.
  - Desktop plugins can only be installed inside the App (`dsh plugin --profile desktop` explains that the profile is managed by the Electron app). Install `@deepseek-ai/dsh-hooks-claude-code` at the App's version via plugin management, and point `configPath` at a dedicated file (e.g. `~/.dsh/agent-reins-hooks.json`) — do not share `~/.dsh/hooks.json` with other tools, or their hooks get activated too. Then re-run `agent-reins install -a dsh` and restart the App (the bridge reads config only at startup).
  - A mounted bridge is not a running bridge: open a new dsh session and confirm the machine-environment info appears in context.
- **Qoder**: hook protocol is Claude Code-compatible; new sessions pick everything up with no extra approval.
- **Kimi Code**: hooks live in a managed block in `config.toml`, coexisting with your existing `[[hooks]]`, no approval needed. Kimi hooks support deny but not ask, so dangerous commands are denied outright (you can run them yourself after confirming); instruction-file edit interception is disabled and left to the rules. Kimi's built-in `dangerous_command_guard` and `[[permission.rules]]` remain active — keep them as a complement.

## Hooks

| hook | when | what it does |
|---|---|---|
| `session-start` | session start (Kimi also registers PostCompact) | reports live CPU / memory / disk info (never persisted); records the workspace baseline and baseline commit; re-states rule highlights after compaction |
| `guard-tool` | before tool execution | dangerous commands require confirmation (Codex and Kimi cannot ask, so they deny); in Claude Code, dsh, and Qoder, editing AGENTS.md / CLAUDE.md / rules requires confirmation — including shell redirects, `tee`, and `sed -i` |
| `track-test` | after tool execution | records test commands run in this session (runs only, not pass/fail) for guard-diff to cross-check |
| `guard-diff` | before stopping | checks only files changed **in this session** (including commits made during it); each distinct finding set is raised once |

What `guard-diff` checks:

- **Doc count**: new docs; doc count/line budgets in flow directories (e.g. `openspec/`); docs vastly outnumbering code.
- **Environment facts**: machine capacity or configuration (e.g. a build box's core count and memory size) written into docs or agent config.
- **Tests**: deleted tests, added skip markers; logic changed without touching any test; logic changed with no test-run record in the session.
- **Consistency**: deleted/renamed functions, variables, or config keys still referenced elsewhere (docs, comments, call sites); `File.java#symbol` anchors in docs that no longer exist; docs referencing deleted files.

At session start the HEAD commit and a workspace snapshot form the baseline: commits made during the session count as session changes; pre-existing uncommitted content committed unchanged does not; if a branch switch makes the baseline a non-ancestor of HEAD, the baseline is rebuilt to avoid cross-branch false positives.

Dangerous-command detection expands `bash -c`, `eval`, `$()`, and multi-line scripts, and catches pipes into a bare shell (`curl … | sh`). It is a safety net, not a sandbox: indirect execution such as `python -c` or script files cannot be enumerated. The real defense remains each agent's own permission settings and sandbox.

### Project config `.agent-reins.json` (optional)

```json
{
  "allowDocs": ["docs/adr/"],
  "docBudget": { "files": 5, "lines": 200 },
  "docRatio": { "minLines": 50, "factor": 3 }
}
```

- `allowDocs`: path prefixes where new docs are allowed. `openspec/` is added automatically when the directory exists at the repo root.
- `docBudget`: per-session caps on new doc files in allowed directories and on added doc lines.
- `docRatio`: warns when added doc lines reach `minLines` and exceed `factor` times added code lines.

Malformed config is reported in the warning and checks continue with defaults. The legacy name `.agent-tidy.json` is still read (new name wins).

## Skills

| skill | when to use |
|---|---|
| `change-impact` | changed behavior, signatures, config keys, interfaces, or data shapes; or guard-diff flagged consistency issues |
| `pick-dependency` | before implementing a component yourself |
| `ui-verify` | before calling frontend work "done" |
| `session-handoff` | when continuing in a new session |
| `doc-audit` | cleaning stale docs, dead links, doc/code contradictions |

## Upgrading from agent-tidy

Uninstall with the old version first (`npx agent-tidy uninstall`, or `node bin/agent-tidy.mjs uninstall` in the old repo), rename `~/.agents/agent-tidy.local.md` to `agent-reins.local.md`, then install the new version. Old backups `*.agent-tidy.bak` are untouched.

## Development

```bash
npm test
```

Tests run in a temporary HOME and clear `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `DSH_HOME`, and `KIMI_CODE_HOME`, because those variables take precedence over HOME. Clear them in manual experiments too, or you will write into real config directories.