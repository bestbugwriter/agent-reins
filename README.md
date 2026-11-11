# agent-tidy

让 coding agent 少写文档、不越界、不谎报完成。一条命令把同一套全局规则、Skills 和 Hooks 安装到 Claude Code、Codex 和 DeepSeek Harness。

```bash
npx agent-tidy install            # 交互选择 agent
npx agent-tidy install -a claude,codex --dry-run
npx agent-tidy status
npx agent-tidy uninstall -a codex
```

## 安装了什么

| 部分 | 内容 | Claude Code | Codex | DeepSeek Harness |
|---|---|---|---|---|
| 规则 | `rules/AGENTS.md` | `~/.claude/CLAUDE.md` 托管区块 | `~/.codex/AGENTS.md` 托管区块 | `~/.dsh/AGENTS.md` 托管区块 |
| Skills | `skills/*` | 软链到 `~/.claude/skills/` | 软链到 `~/.agents/skills/` | 软链到 `~/.agents/skills/` |
| Hooks | `hooks/*.mjs` | `~/.claude/settings.json` | `~/.codex/hooks.json` | `~/.dsh/hooks.json`（需要 `dsh-hooks-plugin`） |
| gitignore | `.scratch/`、`.agent-handoff.md`、`*.local.md` | 全局 `core.excludesFile` | 同左 | 同左 |

文件先复制到 `~/.agents/agent-tidy/`，各 agent 目录只放托管区块、软链和 hook 条目。重复安装是幂等的；修改前会备份为 `*.agent-tidy.bak`；同名的已有 skill 不会被覆盖；卸载只移除 agent-tidy 自己写入的内容。

## Hooks

- `session-start`：实时输出本机 CPU、内存、磁盘信息（不落盘），并记录会话开始时的工作区基线；会话压缩后重申规则要点。
- `guard-tool`：遇到 `rm -rf`、`reset --hard`、强推、`DROP`/`DELETE` 等危险命令时要求确认（Codex 不支持询问，改为拒绝）；修改 AGENTS.md、CLAUDE.md 时要求确认。
- `guard-diff`：结束时只检查**本会话**改动的文件，包括新增文档、写进文档的环境事实、删除测试或加 skip、文档远多于代码。同一组问题只提醒一次。

项目可以在根目录放 `.agent-tidy.json` 声明允许新增文档的路径：`{ "allowDocs": ["openspec/", "docs/adr/"] }`。

## 开发

```bash
npm test
```
