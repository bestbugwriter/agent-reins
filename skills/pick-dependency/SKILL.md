---
name: pick-dependency
description: 需要新增一个功能组件、库、模块或工具时使用（HTTP 客户端、解析器、UI 组件、调度、缓存等），在自己动手实现之前，先找成熟、主流、仍在维护、兼容当前项目的开源方案并给出结论。
---

# 选型：先找现成的，再决定是否自己写

## 1. 写清需求和约束（2～4 行）
- 要解决的具体问题和必须具备的能力。
- 项目运行时约束：先读构建文件确认语言版本（例如 `build.gradle` 的 JDK 版本、`package.json` 的 engines、`pyproject.toml`）、框架版本和许可证要求。

## 2. 按顺序检索
1. 当前仓库：是否已有实现或已引入的依赖可以直接用（用 CodeGraph 或 grep）。
2. 包仓库：Maven Central、npm、PyPI、crates.io 等。
3. GitHub 搜索同类项目。
4. 用 Context7 或官方文档确认 API 是否满足需求。

## 3. 用数据核实维护状态，不凭印象
每个候选至少核实以下几项，并写明数据来源：
- 最新版本和发布日期（例如 `npm view <pkg> time --json`、`https://search.maven.org`、`https://deps.dev`）。
- 最近一次提交、stars、open issues（例如 `gh api repos/<owner>/<repo> --jq '.pushed_at,.stargazers_count,.open_issues_count'`）。
- 许可证；与项目运行时是否兼容（例如是否要求 JDK 17+）。

## 4. 输出对比表和结论
| 候选 | 最新版本/日期 | 最近提交 | Stars | 许可证 | 兼容性 | 备注 |
|---|---|---|---|---|---|---|

最后一行必须是：

`结论: Adopt | Extend | Compose | Build — <包名或"自研"> — <一句话证据>`

- **Adopt**：直接使用。**Extend**：薄封装。**Compose**：组合 2～3 个库。**Build**：自己实现。
- 选 **Build** 时必须说明每个候选为什么不行，并**等用户确认后再写代码**。
- 有合适的候选，只是不兼容（例如需要更高的 JDK），要直接告诉用户，由用户决定升级还是自研，不要悄悄自己写。

## 禁止
- 没有检索就开始写。
- 只凭训练记忆判断某个库"已停止维护"或"不存在"。
- 为了一个小功能引入很大的依赖，却不说明代价。
