# PR Review Agent

基于 GLM 的 GitHub PR 审查 Agent：webhook 接收 PR 事件 → 拉取 diff → LLM 分层审查（结构化输出）→ 调 GitHub API 回帖；附 20 用例 eval 集与 prompt 迭代对比报告。

> **README 最后写**——当前是占位。完整架构图与 eval 报告摘要将在项目收尾（PLAN Day 7）补全。

## 文档导航

| 文档 | 内容 |
|---|---|
| [docs/plans/PLAN.md](./docs/plans/PLAN.md) | 项目定位、技术选型、执行计划（交接文档） |
| [AGENTS.md](./AGENTS.md) | Agent 在本仓库的工作规则 |
| [docs/architecture.md](./docs/architecture.md) | 架构：组件、数据流、输出 schema |
| [docs/decisions.md](./docs/decisions.md) | 技术决策记录（append-only） |
| [docs/journal.md](./docs/journal.md) | 开发日志（append-only） |
| [docs/CHANGELOG.md](./docs/CHANGELOG.md) | 变更记录 |

## 状态

🚧 开发中（PLAN Day 1 待开始）。
