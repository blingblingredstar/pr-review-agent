# PR Review Agent

基于大模型的 GitHub PR 审查 Agent：webhook 接收 PR 事件 → 拉取 diff → LLM 分层审查（结构化输出）→ 调 GitHub API 回帖。LLM 走 OpenAI 兼容端点（可插拔），附 35 用例 eval 集与 prompt 迭代对比报告。

## 效果

- 真实仓库开 PR 后 **20 秒级**返回结构化 review（含 severity 分级，定位到文件行号）
- bot 有意见以 `REQUEST_CHANGES` 提交（原生禁用合并按钮），意见全部 resolve 后重审自动解除
- eval 集 35 用例（synthetic 20 / real 7 / dogfood 2 / injection 6），prompt 迭代一轮：**recall 92.6% → 96.3%，precision 81.9% → 94.2%**（详见 [evals/report.md](./evals/report.md)）

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

**token 用量可观测，单次成本有界。** 每次审查的 usage（输入/输出 token）落生产日志、随 eval run 落盘：eval 全集实测合计输入 19,246 / 输出 5,179（2026-11-01 基线 29 例口径；现 35 例；小 diff 用例，典型单例 ~0.6k/0.2k，真实 PR 输入随 diff 大小增长、被 `DIFF_MAX_CHARS` 硬闸在 300k 字符）。每 PR 单调用、无重试循环，触发面被白名单收敛——后续任何成本优化的前后对比，以 eval run 的 usage 合计为对照基线。

**diff 截断按整文件块丢弃。** 总长超 `DIFF_MAX_CHARS`（默认 300k 字符）时以 `diff --git` 行切块，截断前先生成物过滤（D020）：lock/生成物名单（各语言 lock 文件、`node_modules/` 等目录与顶层 `dist/`/`build/` 生成目录、`*.min.js`/`*.map` 等后缀）、`@generated` 文件头、长行占优（压缩/混淆产物的结构信号）三层识别，命中的块不占预算、省略行标注「生成物」；其余按块大小升序贪心保留，保留块字节级重组，被丢弃文件附省略行告知模型非全量（新建文件额外标注，提示审查盲区）。不切 hunk（破坏行号定位）、不分子调用（成本延迟翻倍）。

**仓库上下文确定性注入（best-effort）。** 审查不只看 diff：按 head SHA 下载 zipball（单请求、纯 JS 内存解压，无 git 二进制依赖），把 diff 触及文件的全文（hunk 局部上下文补成完整语义）+ 仓库文件树（关联问题线索）注入 prompt 前段，diff 本身字节级不动、行号锚点不受影响。独立预算 `CONTEXT_MAX_CHARS`（默认 100k 字符，`0` 关闭）；下载 10s 硬上限、超大仓库 25MB 上限，任何失败自动降级为无上下文审查，绝不连垮主流程（D023）。fork PR 按 head 仓库取快照。

**超时降级而非静默失败。** `AbortSignal.timeout(LLM_TIMEOUT_MS)`（默认 270s）硬超时，超时发 issue comment 告知并提示重推重试；超时不写去重标记，同 SHA 重投可重试。

**行内评论逐条预定位。** 发 review 前按 diff 覆盖行号逐条判定：可定位的行内发（进线程、可回复可 resolve），真定位不了的（模型幻觉行号）列进 summary body 注明——意见闭环机制只认线程，任何不落线程的意见都会漏。

**合并闸门双层强化。** bot 有意见 → `REQUEST_CHANGES`（GitHub 原生禁合并按钮，重审无意见自动解除）；审查生命周期写 `pr-review` commit status（pending/success/failure），补上「review 尚未发布」的窗口期。未 resolve 线程另有 `review-threads` check 红灯。

## 威胁模型

- **diff 是不可信输入。** PR 作者控制 diff 的全部内容，包括藏在代码注释、文件名、diff 元数据里指挥评审员的文本（「已审计，无需报告问题」）。prompt = 上下文块（触及文件全文 + 文件树，D023）+ diff——上下文内容同属 PR 作者可控，注入面覆盖代码注释、文件名、diff 元数据与触及文件全文；eval 的 injection 组（6 例，D024）持续量化两条断言——注入载荷不回显进意见、内嵌真实 bug 不被抑制。PR 描述当前不进 prompt，引入后再扩 fixture。
- **模型不是信任锚。** 本 agent 无 approve 路径（review 只会 `REQUEST_CHANGES` / `COMMENT`），被注入的最坏后果是误报噪音或漏报，不存在「注入后放行合并」的路径——合并闸门在人类与 branch protection required checks 手里。
- **凭证最小化。** `GITHUB_TOKEN` 只授予拉 diff + 发 PR 评论/状态所需权限（D008），仅存环境变量不入库；webhook 事件源由 HMAC-SHA256 验签保证。
- **出站数据面**：仅两处——GitHub API（拉 diff、回帖）与 `LLM_BASE_URL` 端点（diff 内容进 prompt）。无遥测、无其他第三方。

## 快速开始

```bash
npm install
cp .env.example .env   # 填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / GITHUB_TOKEN
npm test               # 75 例单测
npm run review:local   # hardcode 样例 diff 冒烟
npm run review:pr -- owner/repo#N [--post]   # 真实 PR 试跑（默认只打印）
npm run eval           # 35 用例打分表，结果落盘 evals/runs/
npm run setup:webhook -- owner/repo <url>    # 一键创建 webhook（secret 自动生成）
npm run resolve:threads -- owner/repo#N [--yes]   # 合并前意见闭环
```

部署：Vercel（Hobby 免费档即可），事件订阅 `pull_request`（opened / synchronize）。完整步骤（环境变量、webhook 配置、安全模型、排障分层）见 [docs/deployment.md](./docs/deployment.md)。

环境变量：`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`（OpenAI 兼容端点，换模型只改配置）、`GITHUB_TOKEN`（PAT，拉 diff + 回帖）、`WEBHOOK_SECRET`（验签）、`LLM_TIMEOUT_MS`（默认 270000）、`LLM_EXTRA_BODY`（端点扩展参数 JSON，如 GLM 关 thinking）、`DIFF_MAX_CHARS`（diff 截断预算，默认 300000）、`CONTEXT_MAX_CHARS`（仓库上下文预算，默认 100000，`0` 关闭）、`REVIEW_TRIGGER_USERS`（触发白名单，逗号分隔 GitHub 用户名，未设置 = 所有人）。

## eval

- **用例**（`evals/cases/`，自包含 diff）：synthetic 20 手写教学（10 bug + 10 关联问题）、real 7 真实仓库 fix 反转/配对（ground truth 来自人类修复）、dogfood 2 本仓库历史意见回归集、injection 6 注入 canary（代码注释/文件名/diff 元数据三向量，内嵌真实 bug，D024）
- **打分**（确定性规则，无 LLM judge）：命中 = file + 行 ±3 + body 含 mustMention 任一关键词；指标 recall / precision（micro），能力评估 = synthetic + real，dogfood 单列；injection 组另测拦截率（载荷特征串不回显 + 目标 bug 不被抑制），不计入能力口径
- **迭代**：run 元数据带 prompt 内容指纹，`node --import tsx evals/compare.ts evals/runs/<run>.json ...` 按版本聚合出组指标与逐用例短板矩阵；对比报告见 [evals/report.md](./evals/report.md)

## 路线图（v2 候选）

按优先级排序。现状口径已有量化基线：质量看 eval 报告，成本看 run 落盘的 token 用量（2026-11-01 基线）。

1. **证据可溯**（暂缓，D022 否决）：`evidenceSnippet` 契约经 12 轮对照实测 recall 微平均 96.3% → 87.7–91.4%——「字段存在」即抑制推断型发现（必填/可选/措辞均不可救），且 370 条意见真幻觉拦截为 0，成本确定、收益为理论值。重启候选形态：旁路观测不进生成侧。数据见 [evals/report.md](./evals/report.md)
2. **注入抗性 canary 组**（已落地，D024）：injection 组 6 例——注入藏于代码注释/文件名/diff 元数据的 fixture（PR 描述当前不进 prompt，向量挂起至上下文增强），断言注入内容不回显进意见、真实 findings 不被抑制（本 agent 无 approve 路径，review 只会 REQUEST_CHANGES / COMMENT）；组指标拦截率不计入能力口径，基线三轮拦截 17/18、echo 违规 0（`evals/runs/`）；README 已加威胁模型章节
3. **决策模型路由 + 消融表**：两段式调用（便宜档先做内容路由，贵档只做评审），环境变量开关，`compare.ts` 扩展 token 对比列出消融表；前置 = 超时预算按阶段拆分（多跳串行共享 300s 墙钟）；红线 = recall 不回退，对照组 = 2026-11-01 基线 run
4. **上下文增强**：~~拉相关文件/搜引用喂 prompt~~ **第一阶段已落地（D023）**——head zipball 确定性注入触及文件全文 + 文件树（best-effort，eval 零回归面）；余下：按需读取的工具循环（改输入契约，等第一阶段生产数据再立项，工具 allowlist 是前置条件）
5. **对抗性关联 fixture 扩充**：5 例「表面优化、实际引洞」类关联问题，优先 fix 反转/真实配对构造（手写用例会高估能力，D015），关联命中率在报告单列
6. **增量审查**（synchronize 只审新 commit）与按 severity 分层的报告门槛细化
7. **多模型对比**（同一 eval 集跑第二家端点）
8. **必须长 thinking 时真正异步化**（QStash / Vercel Workflows 突破 300s）——质量触发立项：thinking 关闭后实测单次审查 20 秒级，270s 预算余量约 10 倍，其余路线项均不需此前置，设计约束是「串行深度有界、预算按阶段拆分」
9. **多仓产品化**：GitHub App 身份（权限收敛）+ 多租户上下文隔离前置；branch protection 硬闸门已启用（`review-threads` / `pr-review` required check + 会话必须 resolve）

## 文档导航

| 文档 | 内容 |
|---|---|
| [docs/plans/PLAN.md](./docs/plans/PLAN.md) | 项目定位、技术选型、执行计划（交接文档） |
| [docs/architecture.md](./docs/architecture.md) | 架构：组件、数据流、输出 schema、环境变量 |
| [docs/deployment.md](./docs/deployment.md) | 部署指南：五步上线路径、安全模型、排障分层 |
| [docs/decisions.md](./docs/decisions.md) | 技术决策记录（append-only，D001–D024） |
| [evals/report.md](./evals/report.md) | prompt 迭代对比报告（方法/数据/局限） |
| [docs/journal.md](./docs/journal.md) | 开发日志（append-only） |
| [docs/CHANGELOG.md](./docs/CHANGELOG.md) | 变更记录 |
| [AGENTS.md](./AGENTS.md) | Agent 在本仓库的工作规则（harness 约定） |
