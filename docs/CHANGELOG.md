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

### Fixed（Day 3 · PR #3 自审闭环）

- webhook 畸形 payload（owner/repo/number/sha 缺失）入口 200 忽略 + 日志，不再以空值调用 GitHub API
- `LLM_TIMEOUT_MS` 非数字/非正数告警并回退默认；`.env` 已有 `WEBHOOK_SECRET` 键时清理全部同名键再写入
- `api/webhook.ts`：非 POST 405（带 `Allow: POST`）、body 超 25MB 官方上限 413（先送达再断开）

### Added（Day 3 · D013 意见闭环机制）

- `.github/workflows/review-threads.yml`：未 resolve 的 review 线程 → check 红灯（PR 事件 + review 提交触发）
- `npm run resolve:threads -- owner/repo#N [--yes]`：列摘要、确认后批量 resolve 并主动重跑 check 闭合绿门

### Added（Day 3 · PR 标签体系）

- bot 回帖后自动打 `has-blocker` / `has-major` 标签（minor/nit 不打）；开 PR 按标题前缀打类型标签，历史 PR 已补

### Fixed（Day 3 · 邮件治理）

- review-threads 红灯从 workflow 失败改写 commit status——设计内的「有未决意见」不再触发 GitHub 失败邮件（PR #4 曾炸出 27 封）；workflow 只在 status 写入失败（异常）时失败

### Added（Day 4-5 · eval 集）

- `evals/` 从零建立：20 个自包含 diff 用例（10 明确 bug + 10 关联问题）+ `score.ts` 确定性打分（D014：file + 行 ±3 + mustMention 任一关键词）+ `run.ts` 跑分入口
- `npm run eval`：一条命令跑完 20 用例输出打分表（recall / precision / 逐条命中），结果落盘 `evals/runs/` 供 Day 6 对比
- 用例结构校验进单测（hunk 行数、期望行落点），手写 diff 的行号错误进不了主干

### Added（eval 集混入真实来源 + resolve 流程改进）

- eval 用例 20 → 29：新增 7 个 `real` 用例（fastify/axios/koa 的真实 fix diff 反转 + vscode 真实配对，ground truth 来自人类修复、独立于用例构造）+ 2 个 `dogfood` 回归用例（本仓库历史真实意见）；跑分按 source 分组，能力评估 = synthetic + real，dogfood 单列（D015）
- `resolve:threads` 支持选择性闭环：`--only <id>` 指定线程、`--reply <id>=文本` resolve 前先回复留痕；流程约定改为「处理一条闭环一条」（AGENTS.md）

### Fixed（降级意见逃出闭环，D016）

- PR #8 合并后发现 review body 里两条 minor 漏处理：422 降级是「全有全无」，body 意见无线程、闭环机制对它不可见。改为逐条预定位——行号在 diff 内的照常行内发（进线程可闭环），只有真定位不了的列 body 并注明
- 顺带修复同批自审意见：`resolve:threads` 参数解析消费式隔离（回复文本含 "--yes" 不再被误当开关）、eval summary JSON 落盘三级 source 分组指标（`groups`），AGENTS.md 补「拉意见须同时看 review body 降级列表」

### Added（合并闸门双层强化，D017）

- bot 有意见时以 `REQUEST_CHANGES` 提交 review——GitHub 原生禁用合并按钮（无需 branch protection），修复重审无意见后自动解除；审查进行中写 `pr-review` status（pending/success/failure），补上「review 尚未发布」的合并窗口期
- `diffCoveredLines` 修幻影行号（hunk 头行数计数，尾部空串伪影不再多记一行——它会让行内发帖 422 回落全量降级）；`/dev/null` 精确匹配；完成日志分列行内/降级条数
- `resolve:threads --yes` 收尾后检测「最新 head SHA 尚无 review 提交」提示复审在途（PR #9 竞态教训）

### Added（diff 截断，D018）

- `truncateDiff`：超大 diff 按 `DIFF_MAX_CHARS`（默认 300_000 字符）整文件块预算丢弃——小文件优先贪心保留、原顺序字节级重组、被丢弃文件附 `[diff 截断] 省略 path (+a/-b)` 行告知模型；`reviewDiff` 构造 prompt 前单点生效（webhook / eval / 本地脚本共用）
- PLAN §三 关键工程细节全部落地；规格见 `docs/plans/diff-truncation.md`，单测 45 例

### Added（Day 6 · prompt 迭代与对比报告，D019）

- prompt 定稿 v2（执行语义追踪 / diff 内副本扫描 / 评论缺陷指向性）：三轮微平均 recall 92.6%→96.3%、precision 81.9%→94.2%，意见数 -18%；对比报告 `evals/report.md`（验收标准 #3）
- eval run 元数据带 prompt 指纹（同 prompt 多轮与改版 run 机械可分）；`evals/compare.ts` 多轮聚合对比工具 + 单测
- v3 迭代负结果在案：放宽「需 diff 外确认」照报 → precision 92.5%→84.7%、双指标劣于 v2，回退；张力结论（指向性 vs 外调 recall）留下批迭代
- 范围拍板：上下文增强与 synchronize 增量审查延后 v2 路线（D019）

### Added（Day 7 · README 与收尾）

- README 完整版：架构图、六项关键工程决策（异步/幂等/截断/超时降级/预定位/合并闸门）、快速开始、eval 摘要、v2 路线图（验收标准 #4）
- 社交总结帖草稿 `docs/social-post-draft.md`（发布动作留用户）；PLAN 全部 checkbox 勾选完成，一句话描述更新为 29 用例

### Added（转 public 准备）

- 根目录 MIT LICENSE（此前无许可证，public 后默认「保留所有权利」与 README 教人复用矛盾）
- `.agents/skills/README.md`：第三方 skill 来源与许可归属（ponytail 系与 mattpocock 系均为 MIT，原始 LICENSE 文本存 `licenses/`），AGENTS.md 加指引
- git 身份切换为 GitHub noreply 邮箱（`43870278+blingblingredstar@users.noreply.github.com`）——历史提交的 QQ 邮箱保持原样（重写会使 14 个 PR 的评论线程与 SHA 脱钩，不值），今后提交不再暴露 QQ 邮箱
