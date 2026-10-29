# 开发日志（Journal）

> Append-only 会话日志，借鉴 DeepSeek Harness 的会话记录思路：每会话一条，记录目标、完成、发现、下一步——新会话读最后几条即可接续工作，排错不靠事后拼凑。
> 只追加，不改写旧条目。

---

## 2026-10-29 · 会话 1：仓库初始化 + 文档体系

- **目标**：按 PLAN.md 建 git 仓库；参考 DeepSeek Harness 思路搭文档体系；项目内安装 ponytail skill。
- **完成**：
  - `git init`（main 分支），`.gitignore`（node_modules / .env / .vercel / eval 输出等）入库
  - 文档体系：`AGENTS.md`、`docs/architecture.md`、`docs/decisions.md`（D001–D009）、本文件、`docs/CHANGELOG.md`、README 占位
  - ponytail skill ×6（ponytail / review / audit / debt / gain / help）复制到 `.zcode/skills/`，随仓库版本化（D009）
- **发现 / 坑**：
  - ZCode 插件只能装在用户级，项目内共享走 workspace skills 目录——这是 D009 的由来
  - git 提交身份是主机自动生成的（`liuyong@liuyongs-Mac-mini.local`），待用户确认是否改为真实邮箱
- **下一步**：PLAN Day 1——`npm init` + Vercel AI SDK 接 GLM 端点，本地 hardcode diff 跑通「diff 文本 → 结构化审查意见」核心链路
