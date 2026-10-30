# PR Review Agent

基于大模型的 GitHub PR 审查 Agent：webhook 接收 PR 事件 → 拉取 diff → LLM 分层审查（结构化输出）→ 调 GitHub API 回帖。LLM 走 OpenAI 兼容端点（可插拔），附 29 用例 eval 集与 prompt 迭代对比报告。

## 效果

- 真实仓库开 PR 后 **20 秒级**返回结构化 review（含 severity 分级，定位到文件行号）
- bot 有意见以 `REQUEST_CHANGES` 提交（原生禁用合并按钮），意见全部 resolve 后重审自动解除
- eval 集 29 用例（synthetic 20 / real 7 / dogfood 2），prompt 迭代一轮：**recall 92.6% → 96.3%，precision 81.9% → 94.2%**（详见 [evals/report.md](./evals/report.md)）

## 架构

```
GitHub PR 事件 (pull_request: opened/synchronize)
      │ webhook (HMAC-SHA256 签名校验, secret 校验失败丢弃)
      ▼
Vercel API route ──立即返回 200，waitUntil 异步处理──┐
      ▼                                            │
拉取 PR diff (GitHub API)                          │
      ▼                                            │
LLM 审查（OpenAI 兼容端点）：generateText + Output   │
      → { comments: [{file, line, severity, body}] }│
      ▼                                            │
GitHub API 回帖（逐条行内 PR review comment）◄──────┘
```

## 关键工程决策

**先 200 再异步。** LLM 审查耗时不可控（数秒到数分钟），超过 GitHub webhook 超时窗口会触发重试、导致重复评论。HTTP 层立即返回 200，实际审查放 `waitUntil` 后台执行（Vercel 函数上限 300s）。

**幂等去重不建外部存储。** 以 review body 内嵌的 `(repo, commit SHA)` 标记为键，处理事件前查 PR 已有 review——同 SHA 已审直接跳过。零新基建、天然跨实例持久，代价是每次事件多一个只读 API 调用。

**触发白名单可配置。** `REVIEW_TRIGGER_USERS` 逗号分隔名单限定哪些 PR 作者触发审查（未设置 = 所有人，`*` 全放行，大小写不敏感）；判定在调度前用 webhook payload 自带字段完成，名单外作者的 PR 零 API、零 LLM token（D021）。

**diff 截断按整文件块丢弃。** 总长超 `DIFF_MAX_CHARS`（默认 300k 字符）时以 `diff --git` 行切块，截断前先生成物过滤（D020）：lock/生成物名单（各语言 lock 文件、`node_modules/` 等目录与顶层 `dist/`/`build/` 生成目录、`*.min.js`/`*.map` 等后缀）、`@generated` 文件头、长行占优（压缩/混淆产物的结构信号）三层识别，命中的块不占预算、省略行标注「生成物」；其余按块大小升序贪心保留，保留块字节级重组，被丢弃文件附省略行告知模型非全量（新建文件额外标注，提示审查盲区）。不切 hunk（破坏行号定位）、不分子调用（成本延迟翻倍）。

**超时降级而非静默失败。** `AbortSignal.timeout(LLM_TIMEOUT_MS)`（默认 270s）硬超时，超时发 issue comment 告知并提示重推重试；超时不写去重标记，同 SHA 重投可重试。

**行内评论逐条预定位。** 发 review 前按 diff 覆盖行号逐条判定：可定位的行内发（进线程、可回复可 resolve），真定位不了的（模型幻觉行号）列进 summary body 注明——意见闭环机制只认线程，任何不落线程的意见都会漏。

**合并闸门双层强化。** bot 有意见 → `REQUEST_CHANGES`（GitHub 原生禁合并按钮，重审无意见自动解除）；审查生命周期写 `pr-review` commit status（pending/success/failure），补上「review 尚未发布」的窗口期。未 resolve 线程另有 `review-threads` check 红灯。

## 快速开始

```bash
npm install
cp .env.example .env   # 填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / GITHUB_TOKEN
npm test               # 63 例单测
npm run review:local   # hardcode 样例 diff 冒烟
npm run review:pr -- owner/repo#N [--post]   # 真实 PR 试跑（默认只打印）
npm run eval           # 29 用例打分表，结果落盘 evals/runs/
npm run setup:webhook -- owner/repo <url>    # 一键创建 webhook（secret 自动生成）
npm run resolve:threads -- owner/repo#N [--yes]   # 合并前意见闭环
```

部署：Vercel（Hobby 免费档即可），事件订阅 `pull_request`（opened / synchronize）。完整步骤（环境变量、webhook 配置、安全模型、排障分层）见 [docs/deployment.md](./docs/deployment.md)。

环境变量：`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`（OpenAI 兼容端点，换模型只改配置）、`GITHUB_TOKEN`（PAT，拉 diff + 回帖）、`WEBHOOK_SECRET`（验签）、`LLM_TIMEOUT_MS`（默认 270000）、`LLM_EXTRA_BODY`（端点扩展参数 JSON，如 GLM 关 thinking）、`DIFF_MAX_CHARS`（diff 截断预算，默认 300000）、`REVIEW_TRIGGER_USERS`（触发白名单，逗号分隔 GitHub 用户名，未设置 = 所有人）。

## eval

- **用例**（`evals/cases/`，自包含 diff）：synthetic 20 手写教学（10 bug + 10 关联问题）、real 7 真实仓库 fix 反转/配对（ground truth 来自人类修复）、dogfood 2 本仓库历史意见回归集
- **打分**（确定性规则，无 LLM judge）：命中 = file + 行 ±3 + body 含 mustMention 任一关键词；指标 recall / precision（micro），能力评估 = synthetic + real，dogfood 单列
- **迭代**：run 元数据带 prompt 内容指纹，`node --import tsx evals/compare.ts evals/runs/<run>.json ...` 按版本聚合出组指标与逐用例短板矩阵；对比报告见 [evals/report.md](./evals/report.md)

## 路线图（v2 候选）

- 上下文增强（拉相关文件/搜引用喂 prompt——当前只看 diff，diff 外引用靠 hunk 上下文覆盖）
- 增量审查（synchronize 只审新 commit）与按 severity 分层的报告门槛细化
- 多模型对比（同一 eval 集跑第二家端点）
- 必须长 thinking 时真正异步化（QStash / Vercel Workflows 突破 300s）
- 多仓产品化：GitHub App 身份（权限收敛）；branch protection 硬闸门已启用（`review-threads` / `pr-review` required check + 会话必须 resolve）

## 文档导航

| 文档 | 内容 |
|---|---|
| [docs/plans/PLAN.md](./docs/plans/PLAN.md) | 项目定位、技术选型、执行计划（交接文档） |
| [docs/architecture.md](./docs/architecture.md) | 架构：组件、数据流、输出 schema、环境变量 |
| [docs/deployment.md](./docs/deployment.md) | 部署指南：五步上线路径、安全模型、排障分层 |
| [docs/decisions.md](./docs/decisions.md) | 技术决策记录（append-only，D001–D021） |
| [evals/report.md](./evals/report.md) | prompt 迭代对比报告（方法/数据/局限） |
| [docs/journal.md](./docs/journal.md) | 开发日志（append-only） |
| [docs/CHANGELOG.md](./docs/CHANGELOG.md) | 变更记录 |
| [AGENTS.md](./AGENTS.md) | Agent 在本仓库的工作规则（harness 约定） |
