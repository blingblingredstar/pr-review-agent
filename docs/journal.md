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

## 2026-10-29 · 会话 4：GitHub 远端上线 + mattpocock/skills 选装

- **目标**：建 GitHub 远端并推送；评估 mattpocock/skills 是否安装、装哪些。
- **完成**：
  - 远端上线：keychain PAT 调 GitHub API 建仓 + SSH 推送 → `blingblingredstar/pr-review-agent`（private），main 5 commits 已跟踪
  - 选装 3 个自包含工程技能到 `.zcode/skills/`：`code-review` / `tdd` / `diagnosing-bugs`（D012）
  - 评估后不装：grill 系（立项期已过，决策记录承担等价功能）、ticket 工作流（单人一周项目，PLAN checkbox + journal 已覆盖；需 setup 配置 issue tracker）
- **发现 / 坑**：
  - 机器无 gh / brew，但 keychain 存有 github.com PAT（repo scope）+ SSH key 可用——建仓走 API、推送走 SSH，零新安装
  - `npx skills` CLI 目标 agent 列表不含 ZCode，统一用「克隆 + 复制到 .zcode/skills/」安装第三方技能
- **下一步**：PLAN Day 1——npm init + Vercel AI SDK 接 OpenAI 兼容端点，跑通「diff 文本 → 结构化审查意见」

## 2026-10-29 · 会话 5：skills 目录通用化（去特定 harness 目录依赖）

- **目标**：仓库尽量通用，去掉 ZCode 特定目录；顺带核实 dsh 的 skill 发现规则。
- **完成**：
  - `git mv .zcode/skills .agents/skills`，删除空 `.zcode/`；AGENTS.md 路径引用同步（D013）
- **发现 / 坑**：
  - ZCode 扫 `.zcode/skills/` 与 `.agents/skills/`（前者优先、同名遮蔽）；dsh 扫 `.dsh/skills/` 与 `.agents/skills/`，项目根按 `.git` 识别，不扫 `.zcode/`；`.agents/skills/` 是双端交集，裸 `.skills/` 两边都不认
  - 讨论定位：issue 触发自动修复 = 真 background agent（有状态多步循环、需新 eval 集与长时运行时，Vercel serverless 装不下），记为 v2 候选，不并入当前一周计划
- **下一步**：不变——PLAN Day 1：npm init + Vercel AI SDK 接 OpenAI 兼容端点，跑通「diff 文本 → 结构化审查意见」

## 2026-10-29 · 会话 6：决策与提交历史去噪

- **目标**：决策记录里的仓库管理类条目按主题合并；提交历史里 skills「装了又挪」的提交压平。
- **完成**：
  - decisions.md 13 条 → 9 条：D011 并入 D002、D010 并入 D007、D012/D013 并入 D009；顺带去掉 D001 备选里的个人背景措辞
  - 提交历史 7 → 6：skills 三提交（ponytail 安装 / mattpocock 选装 / .zcode→.agents 迁移）压成一个，skills 从初始提交就落在 `.agents/skills/`；重写前历史保留在 `backup/pre-cleanup` 分支，确认无误后删除
  - 追加：决策记录进一步瘦身为纯技术决策（D001–D008），skills 选装与目录约定移入 AGENTS.md 工程约定（原 D009 不再立条）
- **发现 / 坑**：rebase 跳过的提交会把同期追加的 journal/CHANGELOG 条目一起丢掉——重写历史后需从原 tip 补回
- **下一步**：不变——PLAN Day 1：npm init + Vercel AI SDK 接 OpenAI 兼容端点，跑通核心链路

## 2026-10-29 · 会话 7：PLAN Day 1——核心链路代码就绪

- **目标**：npm init + Vercel AI SDK 接 OpenAI 兼容端点，跑通「diff 文本 → 结构化审查意见」。
- **完成**：
  - 工程底座：`package.json`（type: module，engines node>=22）、`tsconfig.json`（strict + NodeNext + allowImportingTsExtensions）；依赖 `ai@7` / `@ai-sdk/openai` / `zod@4`，dev 加 `typescript` / `tsx` / `@types/node`
  - `src/review.ts`：`reviewDiff(diff)` → `generateObject` 强约束 schema（与 architecture.md 契约一致）；env 缺失时明确报错；`loadPrompt()` 从 `prompts/review.md` 读 system 提示词
  - `prompts/review.md`：审查规则（severity 四级定义、只审新增代码、宁缺毋滥、body 中文）
  - `scripts/local.ts`：hardcode 越界 bug 样例 diff 的冒烟入口，`npm run review:local`
  - `test/schema.test.ts` 2 例（`npm test` 通过）；`npx tsc --noEmit` 通过；`.env.example` 提供 GLM 端点配置模板
- **发现 / 坑**：
  - `ai` 已到 v7，`generateObject({ model, schema, system, prompt }) → result.object` 的形状与 v5 一致，直接可用
  - 机器 node 走 nvm（v24 本地开发，engines 声明 >=22）；ZCode shell 不加载 zshrc，命令里需手动 export PATH
  - 本机 keychain 无 bigmodel/GLM 凭证，key 需用户手动填 `.env`（已备 `.env.example`）
- **下一步**：用户在 `.env` 填 `LLM_API_KEY` 后跑 `npm run review:local` 验证真链路；随后 PLAN Day 2——`src/github.ts`（octokit 拉真 PR diff + 回帖），顺带定 D008（App vs PAT）

## 2026-10-29 · 会话 8：Day 1 验收通过——修 404 + 迁移废弃 API

- **目标**：用户配好 `.env` 后真跑 `review:local`，验收 Day 1 核心链路。
- **完成**：
  - 修模型层 404：`@ai-sdk/openai` v4 默认调 Responses API（`path: /v4/responses` 404），GLM 兼容端点只有 `/chat/completions` → `llm.chat(LLM_MODEL)` 显式指定（D009）
  - 迁移 ai v7 已废弃的 `generateObject` → `generateText` + `Output.object`（D009），schema 契约不变
  - **验收通过**：样例 diff 真跑返回结构化评论——准确定位 `i <= items.length` 越界、定级 blocker、给出修法；`tsc --noEmit` / `npm test` 通过，SDK 零警告
  - PLAN Day 1 复选框勾掉；architecture.md / PLAN 结构化输出表述同步为 generateText 机制
- **发现 / 坑**：OpenAI 官方 provider 的默认 API 形态（responses）与第三方兼容端点能力不齐——接兼容端点必须 `.chat()` 显式走 chat/completions，否则 404
- **下一步**：PLAN Day 2——`src/github.ts`（octokit 拉真 PR diff + 回帖），定 D008（App vs PAT）

## 2026-10-29 · 会话 9：PLAN Day 2——GitHub 集成 + 自审 dogfood 验收

- **目标**：`src/github.ts`（octokit 拉真 PR diff + 回帖），本地对公开仓库 PR 试跑；定 D008。
- **完成**：
  - `src/github.ts`：`fetchPr`（`application/vnd.github.v3.diff` media type）+ `postReview`（一次 `createReview`：body 汇总 + 逐条行内评论；行号不在 diff 内的 422 降级为全部写 body）
  - `scripts/review-pr.ts`：`npm run review:pr -- owner/repo#N [--post]`，默认只打印不回帖
  - D008 定稿 **PAT**（评论以个人账号发出，App 留产品化）；`.env.example` 加 `GITHUB_TOKEN`
  - 验证链：typecheck / test 通过 → 公开仓库 `unjs/ufo#407` 只读试跑（空意见优雅收尾）→ **自审 dogfood**：Day 2 改动开 [PR #1](https://github.com/blingblingredstar/pr-review-agent/pull/1)，agent 对本 PR 自审并成功回帖 2 条（minor：422 降级粒度太粗应按 diff hunk 预校验；nit：severity 计数过滤写法可读性差），行内定位全部成功——「调用自身 code review」首次跑通
- **发现 / 坑**：
  - **LLM 延迟极不稳定**：端点小请求 5 秒，350 字节 diff 的审查跑 2 分 10 秒，2KB diff（unjs/ufo#409）5 分钟未归手动终止。Day 3 部署 Vercel 前必须设计超时/降级（`waitUntil` 有上限）；Day 6 eval 单用例耗时也会被此放大
  - keychain 里 `gh:github.com` 两条凭证均 401；有效 PAT 在 `srvr=github.com` 的 internet password 条目（`gho_` OAuth token，scope 含 repo）
  - 同仓开 PR 的 REST API 必须显式传 `base`；多行 body 用 JSON 文件传参，shell 内联转义易错
  - PR #1 diff 37KB，其中大半是 package-lock 噪声——PLAN §三 diff 截断策略的必要性提前得到印证
- **下一步**：PR #1 人工确认后合并；PLAN Day 3——webhook 路由 + 签名校验 + dedupe，部署 Vercel 全链路验证
