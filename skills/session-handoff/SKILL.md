---
name: session-handoff
description: 任务需要换到新会话继续时使用（上下文快满、压缩后表现变差、用户要求交接），或新会话开始时仓库根目录存在 .agent-handoff.md 时使用。
---

# 会话交接：单文件、覆盖写、用完删除

项目已有自己的恢复机制时（例如 Comet 的 `comet-state check --recover`），用项目的机制，不再另写交接文件。

没有时，交接文件固定为仓库根目录的 `.agent-handoff.md`（agent-tidy 已全局 gitignore，不会入库）。

## 写交接（旧会话）
1. 先把能提交的改动小步提交，commit message 写清楚做了什么。git 历史是最可靠的交接记录。
2. **覆盖写** `.agent-handoff.md`，不超过 40 行，只包含：

```markdown
# 交接 <日期>
目标：<一句话>
分支/最近提交：<branch> / <short sha>
已完成：
- ...
下一步（按顺序）：
1. ...
未决问题 / 需要用户决定：
- ...
关键位置：`路径#符号`（不贴代码）
```

3. 不写过程叙述、尝试经过、命令输出或日志。

## 接手（新会话）
1. 读 `.agent-handoff.md`，再运行 `git log --oneline -10` 和 `git status`。
2. 交接内容和代码现状冲突时，以代码和 git 为准，并告诉用户。
3. 任务全部完成后**删除** `.agent-handoff.md`。

## 禁止
- 生成带日期的多个交接文件，或在 docs/ 下累积交接记录。
- 把交接内容写进 AGENTS.md、CLAUDE.md 或任何入库文件。
