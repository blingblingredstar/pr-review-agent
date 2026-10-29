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

## 2026-10-29 · 会话 2：仓库整理

- **目标**：提交身份改为 GitHub 账号 `blingblingredstar`；PLAN.md 归档 `docs/plans/`；文档表述按真实项目定位修订。
- **完成**：
  - 仓库级 git 身份 = `blingblingredstar <564447023@qq.com>`（filter-branch 重写既有 3 个提交的作者）
  - `PLAN.md` → `docs/plans/PLAN.md`（git mv 保留历史），AGENTS.md / README 路径引用同步（D010）
  - 按真实项目定位修订全部文档措辞：PLAN §一/§二/§七 及 D001/D002/D003；PLAN §七 改为「核心设计问答」；AGENTS.md 新增「对外表述按真实项目定位」约定
- **发现 / 坑**：改提交作者用 `git filter-branch --env-filter` 重写即可；仓库未推送远端，重写无副作用。
- **下一步**：不变——PLAN Day 1：npm init + Vercel AI SDK 接 GLM，跑通核心链路

## 2026-10-29 · 会话 3：LLM 接入抽象化（去厂商绑定）

- **目标**：GLM 的 API 本就是 OpenAI 兼容格式，文档与配置不应写死 GLM，按「OpenAI 兼容端点」抽象。
- **完成**：
  - 全部文档「GLM 审查」→「LLM 审查（OpenAI 兼容端点）」；README 一句话定位改为「基于大模型、LLM 可插拔」
  - 环境变量定名 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`（architecture.md 环境变量表）
  - 新增 D011；AGENTS.md 工程约定加「LLM 按端点抽象」、分层排障模型层去 GLM 字样
- **发现 / 坑**：GLM（open.bigmodel.cn）v4 接口即 OpenAI 兼容格式，AI SDK 用 `createOpenAI({ baseURL })` 直连；GLM 仅保留在决策记录与配置备注中作为当前实例
- **下一步**：PLAN Day 1——npm init + Vercel AI SDK 接 OpenAI 兼容端点（GLM key），跑通核心链路
