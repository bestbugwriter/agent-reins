# agent-reins

让 coding agent 少写文档、不越界、改动保持一致、不谎报完成。一条命令把同一套全局规则、Skills 和 Hooks 安装到 Claude Code、Codex 和 DeepSeek Harness。

```bash
npx agent-reins install            # 交互选择 agent
npx agent-reins install -a claude,codex --dry-run
npx agent-reins install -a dsh --skip hooks
npx agent-reins status
npx agent-reins uninstall -a codex
```

## 安装了什么

| 部分 | Claude Code | Codex | DeepSeek Harness |
|---|---|---|---|
| 规则 `rules/AGENTS.md` | `~/.claude/CLAUDE.md` 托管区块 | `~/.codex/AGENTS.md` 托管区块 | `~/.dsh/AGENTS.md` 托管区块 |
| Skills `skills/*` | 软链到 `~/.claude/skills/` | 软链到 `~/.agents/skills/` | 软链到 `~/.agents/skills/`（与 Codex 共用） |
| Hooks `hooks/*` | `~/.claude/settings.json` | `~/.codex/hooks.json` | 各 profile 插件桥读取的文件 |
| 全局 gitignore | `.scratch/`、`.agent-handoff.md`、`CLAUDE.local.md`、`AGENTS.local.md`，写入 `core.excludesFile` | 同左 | 同左 |

文件先复制到 `~/.agents/agent-reins/`，各 agent 目录里只放托管区块、软链和 hook 条目。安装器的行为：

- 写入前先预检所有目标配置，任何一个损坏就停止，不会只写一半。
- 重复安装是幂等的；第一次修改某个文件前备份为 `*.agent-reins.bak`。
- 同名的已有 skill 不覆盖。
- 卸载只移除 agent-reins 写入的内容；其他 agent 仍在使用时，保留共享目录。

**个人偏好**：写在 `~/.agents/agent-reins.local.md`（例如"用中文交流"），重新 install 后会合并进规则区块。包本身保持通用。

## 各 agent 安装后要做的事

- **Codex**：新增或修改的 hook 默认不执行。打开 Codex，按提示审批 agent-reins 的 3 个 hook。`agent-reins status` 会提示还有几个没审批。
- **DeepSeek Harness**：dsh 的每个 profile（desktop、tui、web）各自加载插件。hooks 由官方插件桥 `@deepseek-ai/dsh-hooks-claude-code` 执行，安装器只会把 hooks 写进**已挂载桥的 profile** 所读取的文件；没有挂载桥时跳过，`status` 会逐个 profile 显示情况。
  - 桌面版的插件只能在 App 里安装（`dsh plugin --profile desktop` 会提示 profile 由 Electron 应用管理）。在插件管理里安装与 App 同版本的 `@deepseek-ai/dsh-hooks-claude-code`，把 `configPath` 设为一个独立文件（例如 `~/.dsh/agent-reins-hooks.json`），不要和其他工具共用 `~/.dsh/hooks.json`，否则会一起激活其他工具的 hooks。然后重新运行 `agent-reins install -a dsh`，并重启 App（桥只在启动时读取配置）。
  - 桥已挂载不等于在运行：请新开一个 dsh 会话，确认上下文里出现了本机环境信息。

## Hooks

| hook | 时机 | 作用 |
|---|---|---|
| `session-start` | 会话开始 | 实时输出本机 CPU、内存、磁盘信息（不落盘）；记录工作区基线；会话压缩后重申规则要点 |
| `guard-tool` | 执行工具前 | 危险命令要求确认（Codex 不支持询问，改为拒绝）；在 Claude Code 和 dsh 中修改 AGENTS.md、CLAUDE.md、rules 前要求确认 |
| `guard-diff` | 结束前 | 只检查**本会话**改过的文件，同一组问题只提醒一次 |

`guard-diff` 检查的内容：

- **文档数量**：新增文档；流程目录（如 `openspec/`）里的文档数量和行数超过上限；文档行数远多于代码。
- **环境事实**：把"本机/VPS 只有 xx 内存"之类的内容写进了文档或 agent 配置。
- **测试**：删除测试、加 skip；改了逻辑代码却没有改任何测试。
- **一致性**：删除或改名的函数、变量、配置项仍出现在其他文件里（文档、注释、调用点）；文档里的 `File.java#symbol` 锚点已经不存在，或文档引用了已删除的文件。

危险命令检测会展开 `bash -c`、`eval`、`$()`、多行脚本，但它只是一张安全网，不是沙箱：`python -c`、执行脚本文件等间接方式无法穷举。真正的防线是 agent 自己的权限配置和沙箱。

### 项目配置 `.agent-reins.json`（可选）

```json
{
  "allowDocs": ["docs/adr/"],
  "docBudget": { "files": 5, "lines": 200 },
  "docRatio": { "minLines": 50, "factor": 3 }
}
```

- `allowDocs`：允许新增文档的路径前缀。项目根目录有 `openspec/` 时自动加入 `openspec/`。
- `docBudget`：一次会话里允许目录中新增文档的数量上限，以及文档新增行数的上限。
- `docRatio`：文档新增行数达到 `minLines`，并且超过代码行数的 `factor` 倍时提醒。

配置格式错误时会在提醒里指出，并按默认值继续检查。

## Skills

| skill | 何时使用 |
|---|---|
| `change-impact` | 改了行为、签名、配置项、接口或数据结构；或 guard-diff 提示一致性问题 |
| `pick-dependency` | 准备自己实现一个组件之前 |
| `ui-verify` | 前端改动准备说"完成"之前 |
| `session-handoff` | 需要换会话继续 |
| `doc-audit` | 清理过期文档、失效链接、文档与代码矛盾 |

## 开发

```bash
npm test
```

测试在临时 HOME 中运行，并会清掉 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`DSH_HOME` 这几个变量，因为它们的优先级高于 HOME。手工试验时也要清掉它们，否则会写到真实的配置目录。
