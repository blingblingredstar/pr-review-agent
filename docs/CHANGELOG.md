# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### Added

- git 仓库初始化：`PLAN.md` 交接文档、`.gitignore`
- Harness 式文档体系（D007）：`AGENTS.md`、`docs/architecture.md`、`docs/decisions.md`、`docs/journal.md`、本文件
- ponytail skill 项目级安装：6 个 skill 复制到 `.zcode/skills/`，随仓库版本化（D009）

### Changed

- `PLAN.md` 迁移至 `docs/plans/PLAN.md`；后续阶段性计划/规格统一归档 `docs/plans/`（D010）
- 全部文档按真实项目定位修订表述
- 提交身份改为 `blingblingredstar <564447023@qq.com>`，既有提交作者已重写
- LLM 接入按 OpenAI 兼容端点抽象（`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`），文档与配置不绑定具体厂商；GLM 为当前实例（D011）

### Added（续）

- GitHub 远端：`blingblingredstar/pr-review-agent`（private），main 已推送并设跟踪
- 选装 mattpocock/skills 3 个工程技能：`code-review` / `tdd` / `diagnosing-bugs`（D012）

### Changed（续）

- skills 目录迁移：`.zcode/skills/` → `.agents/skills/`（git mv，删除空 `.zcode/`），去特定工具目录依赖，ZCode / dsh 双端原生识别（D013）
- 决策记录瘦身为纯技术决策（D001–D008）：skills 选装与目录约定移入 AGENTS.md 工程约定，原 D009/D012/D013 不再立条

### Added（Day 1）

- 核心链路「diff 文本 → 结构化审查意见」：`src/review.ts`（`generateText` + `Output.object` + zod schema，prompt 从 `prompts/review.md` 读取）、`prompts/review.md` 审查提示词
- `npm run review:local`：hardcode 样例 diff 的冒烟脚本（`scripts/local.ts`），需 `.env` 配好 `LLM_*` 三变量
- schema 单元测试（`npm test`）、`.env.example`；依赖：`ai` v7 / `@ai-sdk/openai` / `zod`，dev：`typescript` / `tsx` / `@types/node`

### Fixed（Day 1）

- OpenAI 兼容端点 404：`@ai-sdk/openai` v4 默认走 Responses API，兼容端点不支持 → `llm.chat()` 显式 chat/completions（D009）

### Changed（Day 1）

- 结构化输出从已废弃的 `generateObject` 迁移到 `generateText` + `Output.object`（D009），schema 契约不变

### Added（Day 2）

- `src/github.ts`：octokit 封装——`fetchPr` 拉真 PR diff（`application/vnd.github.v3.diff`）+ `postReview` 一次 `createReview` 回帖（body 汇总 + 逐条行内评论）；行号不在 diff 内的 422 降级为全部写入 body
- `npm run review:pr -- owner/repo#<N> [--post]`：真实 PR 全链路冒烟脚本，默认只打印，`--post` 才回帖
- 依赖：`octokit`；`.env.example` 增加 `GITHUB_TOKEN`

### Decided（Day 2）

- D008 定稿：回帖身份用 PAT（`GITHUB_TOKEN`），GitHub App 留产品化阶段

### Added（Day 3）

- webhook 全链路：`src/webhook.ts`（HMAC-SHA256 验签 + 事件分发 opened/synchronize + `waitUntil` 异步审查）、`api/webhook.ts` Vercel function 薄壳（`maxDuration: 300`）
- `src/dedupe.ts`：查 GitHub 已有 review 的内嵌 sha 标记实现幂等（D010）；review summary 标记嵌入 head SHA
- 超时降级（D011）：`reviewDiff` 硬超时 `LLM_TIMEOUT_MS`（默认 270s），超时发 issue comment 告知并可重投重试
- `LLM_EXTRA_BODY` 端点扩展点（D012）：JSON 合并进请求体，GLM 用 `{"thinking":{"type":"disabled"}}` 关 thinking 控延迟——真跑从 270s 超时降到 ~20s 出结果
- `npm run setup:webhook -- owner/repo <url>`：PAT 一键创建/更新 webhook（secret 自动生成写入 `.env`）
- 部署 Vercel Hobby 生产（`vercel.json`：maxDuration 300 + `includeFiles: prompts/**`），环境变量 6 个
- 单测扩到 10 例：验签、事件分发、dedupe 标记、请求体扩展合并；`.gitignore` 补 `.zcode/`

### Decided（Day 3）

- D010：幂等去重用「查 GitHub 已有 review」而非外部存储（Vercel KV / 内存 Map 备选否决）
- D011：LLM 硬超时 270s + 超时评论降级（Vercel Hobby 函数上限实为 300s，「60s」系 Fluid 之前过时数据）
- D012：thinking 模型延迟治理走请求级关 thinking（`LLM_EXTRA_BODY`），QStash/Workflows 异步化列为 v2 候选
