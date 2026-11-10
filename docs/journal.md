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

## 2026-10-29 · 会话 10：PLAN Day 3——webhook 全链路上线 + Vercel 部署验收

- **目标**：webhook 路由 + 签名校验 + dedupe，部署 Vercel，真实仓库开 PR 全链路验证。
- **完成**：
  - 前置：PR #1（Day 2）确认合并进 main（bc34262）
  - 代码：`src/webhook.ts`（HMAC-SHA256 验签 + opened/synchronize 分发 + `waitUntil` 异步审查）、`api/webhook.ts` Vercel 薄壳、`src/dedupe.ts`（D010 查 GitHub review 标记）、`LLM_TIMEOUT_MS` 硬超时 + 超时评论降级（D011）、`scripts/setup-webhook.ts`（PAT 一键建 webhook）、`vercel.json`（maxDuration 300 + `includeFiles: prompts/**`）
  - 单测 8 → 10 例全过；Vercel Hobby 生产部署（域名 2026-10-30 起从公开文档移除，见 Vercel 项目 `pr-review-agent`；6 个环境变量）；webhook id 704670191 指向生产
  - **dogfood PR #2 全链路验证通过**：opened → thinking 全开 270s 超时 → 超时评论降级（D011 首跑即触发）→ 同 SHA 重投自动重试 → 定位根因后关 thinking（D012）→ synchronize 约 20s 出 3 条行内评论（minor×2 / nit×1，定位全中）→ 同 SHA 再重投幂等跳过、无重复评论（D010 验证）。验收标准 #1「1 分钟内留评」达成
- **发现 / 坑**：
  - **Vercel Hobby 函数上限是 300s**（Fluid compute 默认开启；「10s/60s」是 Fluid 之前的过时数据），差点据此过度设计超时方案
  - thinking 模型延迟根因在模型层不在架构层：`LLM_EXTRA_BODY={"thinking":{"type":"disabled"}}` 请求级关闭即可，真正的异步化（QStash / Vercel Workflows）记 v2 候选，等 eval 证明必须开 thinking 再上
  - 仓库 webhook 重投 REST 端点带 `/attempts` 后缀（不带直接 404）
  - `includeFiles` 必须配：Vercel 打包不带非 import 的 `prompts/*.md`，`loadPrompt()` 会挂
- **下一步**：PR #2 人工确认后合并；PLAN Day 4-5——攒 eval 集（20 用例：一半明确 bug、一半关联问题，参考 Surge AI DAYJOB 的 rubric 思路）

## 2026-10-29 · 会话 11：自审意见闭环——PR #3 四轮审查收敛，流程固化

- **目标**：处理 PR #2 遗留的 7 条自审意见；首跑「合并前先处理意见」新流程。
- **完成**：
  - PR #2 意见评估：7 条 = 6 有效 + 1 误报（.env 拼接——现有代码前置 `\n` 不会触发）；有效项全部修复（畸形 payload 入口忽略、LLM_TIMEOUT_MS 非法值告警、.env 同名键清理、405+Allow 头、25MB 上限 413、AGENTS.md 固化流程约定）
  - PR #3 迭代实录：首轮 1 nit（超时告警不对称）→ 二轮 3 条（.env g 标志 / Allow 头 / 超限断连）→ 三轮 2 条（413 先送达再断——采纳；25MB 边界保持 `>`——回应不修）→ 四轮 0 条收敛 → 合并（9c7a46b）→ 生产重部署，冒烟 405/401 符合预期
  - 流程固化：AGENTS.md 工程约定新增「开 PR 后先看 agent 自审意见，逐条处理再合并」
- **发现 / 坑**：
  - bot 复审会重新发现历史 commit 的旧问题（PR #2 的 payload 意见在二轮重复出现），评估时要按 commit 过滤
  - 审查质量超预期：四轮意见全部真实有效、逐轮收敛无循环；每轮 ~20s，迭代成本低，新流程可长期执行
  - PR #2 教训：合并请求发出即生效，取消本地命令无用——动作前先完成检查
- **下一步**：PLAN Day 4-5——攒 eval 集（20 用例：一半明确 bug、一半关联问题，参考 Surge AI DAYJOB rubric 思路）

## 2026-10-29 · 会话 12：合并前意见闭环机制化（D013）——PR #4 九轮审查验证

- **目标**：把「合并前意见全处理」从约定升级为机制（用户提出）；以 PR #4 自身验证全流程。
- **完成**：
  - `.github/workflows/review-threads.yml`：GraphQL 查 reviewThreads，有未 resolve 线程即 fail 的 check（PR 事件 + review 提交触发；closed PR 早退）
  - `scripts/resolve-threads.ts` + `npm run resolve:threads -- owner/repo#N [--yes]`：默认列线程摘要、`--yes` 才执行；小批量并发防限流；失败逐条可辨；resolve 后按 head_sha 找 run 主动 rerun 闭合「绿了才合并」
  - D013 定稿：private+free 无 branch protection，check 为软约束；转 public 后升级 Require conversation resolution 硬闸门；AGENTS.md 工程约定同步
  - **PR #4 九轮审查迭代验证**：意见 5→3→2→4→2→2→1(blocker)→3→0 收敛，22+ 条全部修复或回应；end-to-end 走通「bot 审 → check 红 → 修 → resolve → check 绿 → 合并（f7bee17）」
- **发现 / 坑**：
  - **blocker 是审查流程拦下的**：GraphQL 查询串加了类型没加字段，tsc 不查字符串内的 query——bot 第七轮抓到运行时必炸的 bug，机制价值实证
  - bot 复审会翻旧账（按 original_commit_id 过滤最新轮意见才能看清增量）；每轮修复触发新一轮，意见范围逐轮收窄最后归零
  - resolve 动作不触发任何 PR 事件——脚本里主动 rerun check 是「绿门」成立的关键，workflow 注释已注明两者成对
  - git push 偶发 SSH 挂住（进程卡死无输出），kill 重试即恢复
- **下一步**：PLAN Day 4-5——攒 eval 集（20 用例：一半明确 bug、一半关联问题）；转 public 时记得启用 branch protection 硬闸门

## 2026-10-29 · 会话 13：PR 标签体系——bot 自动打 severity 标签

- **目标**：用户提出给 PR 加标签；按「bot 自动打、信号有下游价值」取舍落地。
- **完成**：
  - 标签集：`has-blocker` / `has-major`（bot 回帖时按审查结果自动打，`severityLabels()` 纯函数 + 单测，共 12 例；标签失败只告警不连坐）+ 类型标签 feat/fix/docs/ci/chore/refactor/test（开 PR 时按标题前缀打）
  - 历史补打：PR #2 feat / #3 fix / #4 ci；PR #5（本改动）零意见收敛合并（46d181d）并重部署
  - AGENTS.md / architecture.md 同步标签约定；Projects / Milestone 明确不加（单人一周项目，PLAN checkbox 即里程碑）
- **发现 / 坑**：
  - 创建 PR 的 REST API 不接受 `labels` 参数（静默忽略）——labels 必须建 PR 后走 issues API 单独打
  - 本机 fake-IP 代理（198.18.0.18）对连续 API 请求间歇性 000：单发易过、循环连发全挂，重试 + 拉开间隔可解；此前 push 卡死同源
  - git checkout -b 在 tsc 失败时被 && 短路是好事——错误在推送前被拦
- **下一步**：PLAN Day 4-5——攒 eval 集（20 用例：一半明确 bug、一半关联问题）；has-* 标签届时即免费的按时间质量数据

## 2026-10-29 · 会话 14：失败邮件治理——review-threads 红灯改走 commit status

- **目标**：用户反馈收件箱被 27 封「Run failed: review-threads」轰炸——check 红灯是设计内状态，却每次触发 GitHub 的 Actions 失败邮件。
- **完成**：
  - workflow 永远正常退出，红/绿信号写 commit status（context: `review-threads`，`statuses: write` 权限）；PR checks 区视觉不变，转 public 后可作为 required status check 升级硬闸门
  - status 写失败 setFailed 兜底（异常路径才有失败邮件，设计内红灯不再有）；PR #6 两轮收敛合并（39bdc13），机制自验证：红灯落在 status 上、零失败邮件
- **发现 / 坑**：
  - 创建 PR 的 API 不收 labels 参数之外，本次确认：设计内「失败」绝不能用 workflow 失败表达，否则通知系统会把工作状态当异常
  - 旧失败邮件无法撤回，收件箱手动标记已读即可
- **下一步**：PLAN Day 4-5——攒 eval 集（20 用例：一半明确 bug、一半关联问题，参考 Surge AI DAYJOB rubric）

## 2026-10-29 · 会话 15：PLAN Day 4-5——eval 集从零建立，基线 95%/73%

- **目标**：20 用例 + 打分脚本 + `npm run eval` 一条命令出打分表（验收标准 #2）。
- **完成**：
  - `evals/` 建立（D014 定稿）：`cases/` 20 个自包含 diff 用例（10 明确 bug：off-by-one / 除零 / 判空 / 丢 await / 赋值当比较 / 遮蔽 / 空数组 -1 / Date 月份 / replace 单次 / reduce 无初始值；10 关联问题：改名漏 import / 加字段漏构造 / 删导出漏清理 / 常量漂移 / 签名漏测试 / 文档漂移 / 错误处理不对称 / 重复逻辑漏同步 / 秒毫秒混用 / env 键名不一致），每用例一文件 readdir 动态加载
  - `score.ts` 确定性打分：命中 = file（可候选数组）+ 行 ±3（可 null 文件级）+ body 含 mustMention 任一关键词；recall / precision（micro）；`run.ts` 串行 + 失败重试，结果落盘 `evals/runs/`
  - 结构校验进单测（`test/eval-cases.test.ts`：hunk 行数、期望行落点、id 唯一、20 个 bug/linked 各 10）——手写 hunk 行数错了 5 处全被拦下
  - 三轮基线（每轮修正期望标注后重跑）：80%/65% → 90%/76% → **95%/73% 定稿**（`evals/runs/2026-10-29T15-25-47-glm-5.3-flash.*`）；glm-5.3-flash 单用例 3-10s，20 用例 1.7 分钟跑完，零失败
- **发现 / 坑**：
  - 5 个未命中里 4 个是期望标注问题、1 个是真漏报——标注要为「合法报法变体」留余地：模型可能报在删除处而非漏用处（linked-03）、报在对照行而非问题行（bug-02）、用「0 基」而非「0-based」（bug-08）
  - 稳定 miss：linked-08（重复逻辑漏同步，三轮中两轮 0 意见）——Day 6 prompt 迭代的头号靶子；precision 65-76% 波动（每轮意见数 25-30 条浮动），单轮数字不可作结论，Day 6 对比要多轮取均值
  - NodeNext 下动态 import 的 specifier 必须是 string（`.href`）；Node 22/24 的 nvm 不在 ZCode shell 默认 PATH，每条命令要先 source nvm
- **下一步**：PR 自审闭环后合并；Day 6——改 prompt（靶子：关联问题类 recall、precision 降噪），跑对比报告（验收标准 #3）

## 2026-10-29 · 会话 16：resolve 流程改进 + eval 混入真实来源用例

- **目标**：用户两点反馈落地——resolve 应「处理一条闭环一条」且要留回复；手写用例是自己生成的、通过率偏高不可信，要引入真实测试集。
- **完成**：
  - `resolve:threads` 升级：`--only <id>` 选择性 resolve、`--reply <id>=文本` resolve 前先 REST 回复留痕（回复失败不 resolve）；列表带 databaseId；部分 resolve 不 rerun check（红正确）。AGENTS.md 流程改为「处理一条闭环一条，全部处理完 --yes 收尾」
  - eval 集 20 → 29（D015）：新增 7 个 real（fastify#7068/#7124/#6973、axios#11216、koa#1961/#2013 的 fix diff 反转 + vscode#330629→#343670 真实配对）+ 2 个 dogfood 回归（PR #2 真实意见转用例）；跑分按 source 分组，能力评估 = synthetic + real，dogfood 单列
  - 反转构造 = 人类修复 diff 的 +/- 对调：agent 看到的是「真实代码、真实 bug 被引入」的 diff，修复内容是独立于构造者的 ground truth；脚本化提取源码 hunk（丢测试）+ 反转 + 行数自校验
  - 基线三轮（真实记录）：92.6%/78.4% → 100%/91.2% → 弱关键词收敛后 96.3%/77.8%（`evals/runs/2026-10-29T16-24-19-*` 为定稿基线）；单轮波动大，Day 6 须多轮均值
- **发现 / 坑**：
  - 「fix 小 ≠ 引入小」：5 个全真配对候选只有 1 个引入侧也小，且配出的 bug 往往要领域知识才能从 diff 推断——反转构造才是可量产路线
  - real-02（getter 求值两次）一轮报「行为一致」（模型不理解 getter 语义）一轮命中——真实短板与随机性并存
  - 手工转录 GitHub diff 会丢上下文行（hunk 头行数对不上被校验器拦下），改为 curl 直落文件 + 脚本处理；split("\n") 尾部空串在末尾文件块会被当上下文多计 1 行
  - dogfood 首跑 0/2 是行号期望问题（模型报在调度处而非 ref 构造处，发现本身完全正确）——问题点分散的用例应该文件级
- **PR #8 自审闭环实录（新流程首跑）**：第一轮 6 条（5 修 1 回应，--only/--reply 逐条回复+resolve 一次通过）→ 第二轮 5 条全修（dogfood 弱关键词、--reply 空文本校验、旧 run 产物删除重跑、参数解析统一、注释去重）；两轮均无翻旧账
- **下一步**：Day 6——改 prompt（靶子：getter/闭包类语义理解、linked-08 类重复逻辑漂移、precision 降噪），多轮均值出对比报告

## 2026-10-30 · 会话 17：降级意见逃出闭环（D016）+ 能力边界确认

- **目标**：用户发现 PR #8 两条 minor 漏处理（行号不在 diff 内被降级进 review body，无线程、无 resolve、check 不管）；并确认「agent 只能看 diff、查不了引用」的能力边界。
- **完成**：
  - D016：`postReview` 逐条预定位（`diffCoveredLines` 解析 hunk 新侧行号）——可定位的行内发进线程闭环，只有真定位不了的列 body 注明；422 整体降级保留兜底
  - 补修漏掉的两条：`resolve:threads` 参数解析消费式隔离（回复文本含 "--yes" 不误判开关）；eval summary JSON 加 `groups` 三级分组指标
  - AGENTS.md 流程补「拉意见须同时看行内线程与 review body 降级列表」；单测 25 例全过
- **发现 / 坑**：
  - 闭环盲区的根因是「无线程 = 不可见」：check 红灯、resolve 脚本、人工流程全以线程为准——任何不落线程的意见都会漏，堵法只能是让意见尽量落线程
  - `review-pr.ts` 本地工具也调 postReview，签名变更会被 typecheck 拦——脚本纳入 tsconfig include 的价值实证
- **能力边界（用户问题解答）**：当前 reviewDiff 只把 unified diff 文本喂给模型，看不到仓库其他文件——「删除导出后别处还在用」这类 diff 外引用只能靠 hunk 上下文恰好覆盖（eval 的 linked-01/03 正是这么设计的）。上下文增强（拉相关文件/搜索引用喂 prompt）列为候选改进，待与多模型对比（Day 6）一起取舍
- **下一步**：Day 6——改 prompt（getter 语义、linked-08 类漂移、precision 降噪）+ 多轮均值对比报告；上下文增强是否本期做待定

## 2026-10-30 · 会话 18：合并闸门双层强化（D017）+ 幻影行号修复

- **目标**：用户看到 PR #9 合并瞬间又落地 3 条降级意见（与 PR #8 同款竞态），提出「review 进行中应 block 合并」。
- **完成**：
  - D017 双层：有意见 → REQUEST_CHANGES（原生禁合并按钮，无 branch protection 也可用）；审查生命周期 pr-review status（pending/success/failure）补窗口期；resolve:threads --yes 收尾后检测复审在途
  - 幻影行号 major 修复：diffCoveredLines 按 hunk 头声明的行数计数（remain），尾部空串伪影被拒之门外；- 行不消耗新侧计数（测试抓出）；声明内的空上下文行仍是真实内容——两个方向的单测都补了
  - /dev/null 精确匹配（includes 误伤路径含该字样的真实文件）；完成日志分列行内/降级
- **发现 / 坑**：
  - 「测试的 diff 都不带尾换行」让幻影行号逃过单测——手写测试夹具与真实输入（GitHub diff 恒以 \n 结尾）形态差异本身就是盲区
  - `-` 行错误消耗新侧行数计数是被新加的 b/ 前缀测试抓出来的——测试间互相兜底的价值
  - resolve:threads 全量收尾时序竞态：check 绿 ≠ 复审已落地，现在有机械提示但仍需人工等——REQUEST_CHANGES 从源头收窄了这个窗口（有意见必 block）
- **PR #10 六轮闭环实录（新闸门 dogfood）**：21 条意见全部修复/回应（第五轮 major：自家 PR 不能 REQUEST_CHANGES——dogfood 场景恒走回退 COMMENT，多仓产品化时原生生效；422 无条件回退替代文案正则），第七轮 0 条收敛合并。生产部署缺口已补：`npx vercel --prod` 部署成功（CLI 授权本机已有，1 分钟上线），冒烟 405/401 符合预期，D016/D017 生效；`vercel git connect` CLI 失败（私有仓库需 GitHub App 授权），用户在 dashboard 完成连接——空 commit 实测：push main 1 分钟内自动 Production 部署（Ready）+ GitHub deployment 记录出现，此后无需手动 npx vercel --prod
- **下一步**：部署生产使 D016/D017 生效；Day 6——改 prompt + 多轮均值对比；上下文增强方案待拍板

## 2026-10-30 · 会话 18 续：PR #11——降级复审第三连的转义残留

- **目标**：用户发现 PR #10 合并后又落地 3 条降级意见（major：`\${isStatus...}` 转义残留）。
- **完成**：转义残留修复（python 生成补丁的转义层级坑第三连，`grep -Fn '\${'` 全局扫描确认无其他残留）；回退 COMMENT 注释归因修正（内层 422 不唯一来源自家 PR，行号类会回退后再 422 落外层降级——行为正确但归因曾误导）；测试夹具补尾换行。PR #11 零意见合并（9f3b5ad）并部署生产。
- **流程首次完整走对**：合并前核对 review body 降级列表（0 条才合并）——AGENTS.md 新流程第一次真正执行到位。
- **发现 / 坑**：python 生成补丁改模板字符串时 `\\$` 转义层级连错三次——这类修法应改用 Edit 工具直接改源文件，或补丁后 grep -F 验证无 `\${` 残留。
- **下一步**：Day 6——改 prompt + 多轮均值对比；上下文增强方案待拍板

## 2026-10-30 · 会话 19：剩余工作清点 + 夜间批量实施（PR A/B/C 串行）

- **目标**：清点 PLAN 剩余项全部实现——Day 6（prompt 迭代 + 多轮对比报告）、Day 7（README）、diff 截断（PLAN §三 唯一未落代码的关键工程细节）；用户夜间离线授权代决策，分 PR 串行、每个走完整闭环再开下一个。
- **代决策记录**：上下文增强（拉相关文件喂 prompt）延后 v2——改输入契约需另设计 eval，不在本期验收标准内；`synchronize` 维持全量重审（增量列 v2 路线）；多模型对比跳过（无第二家端点 key）。
- **PR A（diff 截断，D018）**：`truncateDiff` 整文件块预算丢弃——`DIFF_MAX_CHARS` 默认 300_000 字符，超预算按块大小升序贪心保留（小文件优先，大文件多为 lock 噪声），保留块原顺序字节级重组，被丢弃文件附 `[diff 截断] 省略 path (+a/-b)` 行；`reviewDiff` prompt 构造前单点生效。复用重构：diff 头行 b 侧路径解析抽为 `diffHeaderPath`（diffCoveredLines / truncateDiff 共用）。规格 `docs/plans/diff-truncation.md`，单测 +5（40 → 45 例），typecheck / eval 回归通过。
- **发现 / 坑**：
  - 块重组的字节级保真：整 diff split("\n") 后按 `diff --git` 行分块，块间不丢行——尾部空串只存在于最后一块，join 回原样；省略行前会多一个空行（末块尾换行的空串元素 + join 分隔符），无碍
  - 会话上下文管理（用户要求）：单会话无法 compact，用 jq 投影 / 后台跑 eval / 控制读取面保持主对话精简
- **下一步**：PR B（Day 6 prompt 迭代）→ PR C（Day 7 README）

## 2026-10-30 · 会话 19 续：PR B（Day 6）——prompt v2 定稿，recall +3.7pp / precision +12.3pp

- **目标**：PLAN Day 6——改 prompt 迭代、多轮均值对比、出报告（验收标准 #3）。
- **完成**：
  - 工具链先行：run 元数据加 `promptHash`（同 prompt 多轮与改版 run 机械可分）；`evals/compare.ts`（aggregateRuns 纯函数 + 3 单测）按指纹聚合组指标与逐用例短板矩阵——报告数据零手工抄表
  - 基线 v1 ×3（92.6%/81.9% 微平均）→ **v2 ×3（96.3%/94.2%，双指标 +3.7pp/+12.3pp，意见数 -18%）** → v3 ×3（95.1%/87.9%，回退）；9 轮 run 全部落盘入库，报告 `evals/report.md`
  - v2 三规则逐条兑现靶子：执行语义追踪 → real-02（getter）三轮全命中；缺陷指向性 → synthetic precision 77.4→92.5、bug-01/03、linked-09 不稳定全消；副本扫描 → linked-08 改善未根治
  - v3 负结果有信息量：修好 linked-08/real-03/dogfood-02 沉默，但 real-02/bug-03 重新波动——「缺陷指向性 vs 外调确认 recall」张力实锤，按 severity 分层的细规则留下批
  - 拍板进 D019：上下文增强 / synchronize 增量审查延后 v2；prompt 文件定稿停在 v2（指纹校验一致）
- **发现 / 坑**：
  - 逐用例矩阵是报告的真正主角：v2 对 v1 的 recall 提升全部来自「不稳定用例转稳」，汇总数字只讲了一半
  - dogfood-02 在 v2 期间掉到 1/3：模型转报 fixture 里另一个真实问题（extraBody 的 parse 错误处理）——期望标注覆盖面缺口被召回率的口径放大成「回归」，dogfood 单列的价值实证
  - eval 轮次是长杆任务（每轮 2-3 分钟 ×9），后台串行跑 + 只留汇总行在上下文里，主对话全程干净
- **下一步**：PR C（Day 7 README + 社交帖草稿 + PLAN 勾选收尾）

## 2026-10-30 · 会话 19 续二：PR C（Day 7）——README 收尾，PLAN 全 checkbox 完成

- **目标**：PLAN Day 7——README（含 eval 报告与架构决策，验收标准 #4）、社交帖草稿、PLAN 勾选收尾。
- **完成**：
  - README 完整重写：效果速览（20s 级出评、闸门机制、迭代数据）、架构图、六项关键工程决策各一段（先 200 再异步 / SHA 标记幂等 / 整文件块截断 / 超时降级 / 逐条预定位 / REQUEST_CHANGES + status 双闸门）、快速开始、eval 方法与报告链接、v2 路线图
  - 社交帖草稿（通用版 + 短版）落 `docs/social-post-draft.md`——发布动作留用户
  - PLAN Day 4-5/6/7 勾选更新（Day 6 补实际数据，Day 7 注明帖子草稿完成、发布留人工）；一句话描述 20 → 29 用例
- **发现 / 坑**：无新坑——纯文档收尾
- **下一步**：夜间批量实施收尾汇报；后续候选见 README 路线图与 D019

## 2026-10-30 · 会话 19 续三：夜间批量实施结算——PR #12/#13/#14 全闭环，PLAN 收官

- **结果**：三个 PR 全部走完「开 PR → bot 审查 → 逐条回复 + resolve → 复审收敛 → 状态三绿 → squash 合并 → Vercel 自动部署」：
  - **#12 diff 截断（D018）**：四轮 3→4→5→0 条，合并 cc4ad14
  - **#13 Day 6（D019）**：八轮 4→5→3→2→1→2→1→0 条（含一条 major：report 的 real-03 数据 2/3 应为 1/3，bot 核对入库 run 数据抓出，属实已改），合并 0c8ea94
  - **#14 Day 7**：首轮 0 条一次通过，合并 e0d1736
- **流程发现 / 坑**：
  - **拉意见必须翻页查全**：#13 的 1265a51 轮两条意见（含那条 major）因「只按特定 SHA grep + 默认分页 30 条截断」漏看了一轮，靠下一轮复审的翻旧账才兜住——`comments?sort=created&direction=desc&per_page=100` 起步，别只 grep 特定 commit
  - 回复线程产生的空 review 壳对象会混进 reviews 列表，找 bot 汇总要按 body 标记过滤 + 大 per_page
  - compare 工具在 8 轮自审里被打磨出完整的容错语义（缺用例/空期望/失败轮/legacy 指纹/多候选定位）——bot 审查对「边界输入」的嗅觉比自测广
- **遗留（用户动作）**：社交帖草稿待发布（`docs/social-post-draft.md`，发完回填链接）；转 public 时启用 branch protection 硬闸门（D013/D017 兑换点）
- **下一步**：项目按 PLAN 收官；后续迭代靶子见 README 路线图 / D019（上下文增强、增量审查、多模型对比、v3 张力的分层规则）

## 2026-10-30 · 会话 20：public 化审计与执行——LICENSE / skills 归属 / 邮箱切换 / 硬闸门

- **目标**：用户问能否转 public；全库审计后处理三个遗留点，再执行转 public + branch protection。
- **审计结论**：密钥干净（112 跟踪文件 + 107 提交历史零命中，`.env` 从未入库）；无求职措辞；workflow 最小权限；real 用例带上游来源标注。三个待处理点：无 LICENSE、第三方 skill 无归属标注、QQ 邮箱随历史公开。
- **完成**：
  - 上游许可确认：[DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) 与 mattpocock/skills 均 MIT → 根目录 MIT LICENSE + `.agents/skills/README.md` 归属表（原始 LICENSE 文本存 `licenses/`）+ AGENTS.md 指引
  - git 身份切 GitHub noreply（`43870278+blingblingredstar@users.noreply.github.com`，仓库级）——历史 QQ 邮箱保留（重写会让 14 个 PR 线程与 SHA 脱钩，不值），本提交起生效
  - README 路线图与 AGENTS.md 闸门表述同步（「转 public 后」→ 既成事实）
- **后续动作**（本 PR 合并后执行）：API 转 public → branch protection：`review-threads` + `pr-review` 设 required status check、require conversation resolution、enforce_admins（硬闸门含管理员）→ 验证生效。
- **发现 / 坑**：转 public 前审计要走 git 历史（`git log --all -p` 扫密钥模式 + `--diff-filter=A` 查敏感文件名），只扫工作区会漏历史污染——本次历史干净，机制留档。
- **下一步**：执行转 public 与硬闸门，结果回填本文件

## 2026-10-30 · 会话 20 续：转 public 完成，硬闸门启用

- **执行结果**（PR #15 合并 72f39c1 后）：
  - `PATCH /repos {private:false}` → 仓库公开，匿名 API 确认 visibility=public、license=MIT
  - branch protection 启用：`review-threads` + `pr-review` required status check、require conversation resolution、**enforce_admins**（管理员同样不可越过）——D013/D017 的「转 public 升硬闸门」兑换完成
  - 生产 webhook 冒烟 401（无签名拒绝）符合预期；Vercel 集成不受影响
- **流程变化（重要）**：required check 启用后 main 禁止直接 push——此后任何改动（含本条 journal）必须走 PR 过闸门；本条即第一次硬闸门 dogfood
- **发现 / 坑**：branch protection 的 contexts 按 commit status 的 context 名匹配（GitHub 自动关联了 app_id），无需额外注册
- **下一步**：社交帖发布（用户动作，`docs/social-post-draft.md`）；后续迭代靶子见 README 路线图

## 2026-10-30 · 会话 21：D020——截断前置生成物过滤，运行时 LLM 打标否决

- **目标**：用户发现 D018 大小贪心的盲区——新建大源码文件与 lock 拿同一排序信号，超预算时最值得审的内容最先出局（单个新建文件自身超预算时甚至整 PR 零内容过审）；讨论生成物识别方案后落地。
- **方案讨论结论**：
  - 纯 lock 名单不够（用户质疑多生态难穷举）→ 补两条跨生态结构规则（`@generated` 头、长行占优），名单只留高精度项；漏判 = 回退 D018 贪心，软失败不劣化
  - 运行时 LLM 按文件名打标被否决：filename-only 的 LLM 知识就是名单本身（名单 = 离线打标产物），运行时调用徒增关键路径延迟（300s 窗口主调用已占 270s）与非确定性（撞 eval 回归与 synchronize 重审一致性）；误标源码为噪声是静默漏审，比确定性规则更难排查
- **完成**（走 PR 过闸门）：
  - `truncateDiff` 前置生成物过滤（D020）：三层识别——名单（约 20 文件名 + 目录段 + 后缀，直接清单 package.json/requirements.txt 不进）、生成横幅（前 10 个新增行）、长行占优（≥500 字符行占内容大头且绝对量超阈值）；命中块不进预算竞争、恒省略标注「生成物」
  - 省略行标注「新建文件」标记审查盲区；过滤只在超预算路径生效，预算内 diff 字节级原样
  - PR #18 评审三轮各 1 条 minor，全部属实闭环：①压缩汇总行丢「生成物/新建文件」标注信号 → 汇总行带各类计数；②`out`/`build`/`target` 目录段过通用（`src/build/` 嵌套同名词被误标「生成物」是带误导的静默排除而非软失败）→ 通用目录名只认顶层首段、约定名（node_modules/vendor/coverage/.next）保持任意层级；③README 单测计数漂移 → 同步 60
  - 8 个新单测 + 既有 52 个全绿（60 pass / 0 fail），typecheck 过；README / architecture / CHANGELOG / decisions 同步
- **发现 / 坑**：truncateDiff 的期望串要算「被丢弃块是否末块」——diff 尾部空串元素属于末块，末块被丢则保留文本后无空行，三处测试预算/期望一起修才绿
- **下一步**：开 PR 过 bot 自审与双硬闸门；超预算大文件的完整解法（拆两环节绕 Vercel 300s 单函数墙钟：主审查照旧 + 超预算有价值文件分发补审，环节 2 只补行内意见不动 status，免建状态机）是架构扩展，与增量审查同属 PLAN §七 路线，另立计划再议

## 2026-10-30 · 会话 22：生产域名脱敏 + 部署指南

- **目标**：用户问 webhook 端点公网可达是否会被陌生人消耗 LLM 额度；确认闸门后按用户要求移除公开文档中的真实域名，并补部署文档。
- **完成**：
  - 安全面复核：`src/webhook.ts` HMAC 验签在任何解析/GitHub API/LLM 调用之前（401 零 token）；`WEBHOOK_SECRET` randomBytes(32) 只存 `.env` 与 GitHub webhook 配置；`api/` 仅 webhook 一个入口；第三方仓库配同 URL 因 secret 不同验签不过；同 SHA 重放被 D010 幂等吸收——陌生人消耗不了 token
  - `docs/journal.md` 会话 10 条目域名替换为占位说明（git 历史旧值保留不回写：重写历史代价远大于收益，搜索引擎索引对象是当前文件）
  - 新增 `docs/deployment.md`：五步部署（本地验证 → secret 生成 → Vercel 环境变量 → webhook 配置 → 全链路验证）+ 安全模型 + 排障分层，收拢 journal 分散的实测坑（includeFiles、关 thinking、/attempts 后缀）；README 部署段与文档导航挂链接
- **发现 / 坑**：
  - 会话 20 的 public 化审计清单漏了「URL 类运行时信息」——域名+验签闸门不构成实际风险，但 public 仓库宜默认占位化
  - **切分支翻车**：从并行会话未推送的分支 tip（HEAD）切了新分支，把未过审的 D020 提交裹进本 PR diff，bot 抓出双「会话 21」撞号——worktree rebase 回 origin/main 重开为纯文档改动，本条按先到序让出编号改为「会话 22」（D020 条目保留 21）。并行共享工作区时，切分支必须显式基于 origin/main
- **下一步**：PR 过硬闸门合并；社交帖发布（用户动作）

## 2026-10-30 · 会话 23：token 消耗盘点 + 触发白名单（D021）

- **目标**：用户四问——token 用量有无记录、单次 CR 消耗多少、有无上限、会不会账单爆炸；盘点后落地触发人收敛（「只有我触发，可配置」）。
- **盘点结论**：①无用量记录——`reviewDiff` 解构 `generateText` 只取 output，usage（inputTokens/outputTokens）被丢弃，全仓无计量代码，观测只能靠 GLM 控制台；②单次消耗推算——system prompt 1.7KB（~0.5k token）+ diff 硬上限 300k 字符（典型 PR 1 万-4 万 token，极端 ~10 万）+ 输出 JSON ~0.5k-2k token；③上限——输入有 `DIFF_MAX_CHARS` 硬闸，输出无 `maxOutputTokens`（仅 270s 超时兜底）；④爆炸风险——单次有界、次数无上限：HMAC 挡陌生人（401 零 token）、D010 挡同 SHA 重放，但名单外任何人 push 新 commit 都触发一次，无频次限额、无用量日志，异常只能事后靠端点账单发现。
- **用户决定**：usage 日志记为待办暂不执行；触发收敛立即做。
- **完成**（D021，走 PR 过闸门）：
  - `REVIEW_TRIGGER_USERS`（逗号分隔，大小写不敏感）：未设置 = 所有人（向后兼容）、`*` 显式全放行、名单启用仅名单内 PR 作者调度；判定在 `handleWebhook` 调度前用 payload 自带 `pull_request.user.login` 完成（零 GitHub API / 零 LLM token）；名单启用但 payload 缺作者 fail-closed（成本闸门宁可误拒）
  - 设计取舍：按作者字段而非 sender（opened/synchronize 中稳定、「只审这些人的 PR」可预期，sender 只多挡协作者代推边界）；仓库白名单不做（webhook 挂载即信任）；频次限额否决（需持久计数器、名单收敛后触发源只剩自己，量级不成比例）
  - 单测 +3（63 全绿）；.env.example / README / architecture / deployment / CHANGELOG / decisions 同步
- **发现 / 坑**：盘点顺手发现 README 文档导航决策区间漂移（D020 落地时漏更，仍写 D001–D019），本次一并修为 D001–D021
- **遗留待办（明确「可改、暂不执行」）**：`reviewDiff` 打 usage 日志（一行解构 `usage` 打 inputTokens/outputTokens，落点 `src/review.ts`）；配套可选项 `maxOutputTokens` 硬上限、GLM 控制台消费告警
- **下一步**：PR 过 bot 自审与双硬闸门合并；合并后在 Vercel 配 `REVIEW_TRIGGER_USERS=blingblingredstar` 生效

### 会话 23 续：Vercel 配置完成，白名单已生效

- **执行结果**（PR #19 合并 d9c5b3a 后）：本机 Vercel CLI 登录态可用（项目已 link），`printf 值 | npx vercel env add REVIEW_TRIGGER_USERS production` 写入；`npx vercel --prod` 重新部署（本地 main 与 origin/main 同步后部署），新生产部署 fevd8bqfw Ready；`env ls` 确认变量注册，生产域名 POST 无签名 401 冒烟正常——名单逻辑本身由单测覆盖，端到端拒绝需非名单作者的真实 PR 才能验
- **坑**：`vercel env add` 默认存为 Hidden Secret（dashboard 不可见、不可 pull）——对本变量无所谓，但后续想存可读配置要 `--type config`

## 2026-11-01 · 会话 24：token 用量计量落地（D021 待办兑现），成本基线就位

- **目标**：用户提出参照 Memdoor（-74% token）给 agent 加「决策模型」预处理——便宜档 GLM 做工具路由与上下文过滤，前后 token 消耗写进 README；并问是否与「必须长 thinking 时真正异步化」（D012 v2 候选）捆绑实现。
- **方案讨论结论（先于代码）**：
  - 不捆绑，拆开排序：耦合点在「异步化解除 300s 墙钟后，预处理多一跳串行调用才有预算空间」（D020 否决理由之一），所以预处理若做必须在异步化之后，而非同时
  - 「工具路由」目前没有靶子——管线是单次 generateText 无工具循环，路由成立的前提是上下文增强（D019 延后路线），该提案的正确身份是上下文增强第一阶段
  - 「上下文过滤」撞 D020 另外两条否决理由，异步化解不掉：非确定性（撞 eval 可回归与 synchronize 重审一致性）、静默漏审（误标源码为噪声无告警）；-74% 是 Memdoor 语境（工具输出浪费型基线）不可平移到「上下文 = diff 本身 + D020 确定性过滤已就位」的本项目
  - README 三卖点校准：安全（D021+HMAC+D010）与评测（29 用例+report）已齐，成本最便宜的补法是 usage 计量 + 真实数字，不是两模型子系统；异步化的触发条件应是质量需求（开 thinking、超大 PR 分批补审），不是成本
  - 顺序定为：① usage 计量（D021 已拍板「可改」的待办，本会话）→ ② 异步化单独立项 → ③ 决策模型预处理 = 上下文增强第一阶段，红线 recall 不回退，以本 run usage 为对照组
- **完成**（走 PR 过闸门）：
  - `reviewDiff` usage 落日志（console 一行，Vercel 可查）并随返回值返回 `ReviewOutcome = ReviewResult & { usage: TokenUsage }`——端点不返回的字段为 null 不虚构 0；`comments` 契约不变，webhook/scripts 零改动
  - `npm run eval` 逐用例记录 tokens 入/出（表格加列），报告与 `runs/*.json` summary 带合计（`sumUsage` 字段独立判空，失败用例不计入）；单测 +1（64 全绿）
  - eval 基线一轮（29 例，glm-5.3-flash，prompt 指纹 d399f9d4ed17 不变）：recall 96.3%（26/27）、precision 87.1%（27/31，单轮）、tokens 合计入 19,246 / 出 5,179 / 总 24,425，典型单例 ~0.6k/0.2k，全程 2.6 分钟；run 落盘 `evals/runs/2026-11-01T04-27-42-glm-5.3-flash.{json,md}`
  - README「关键工程决策」加 token 用量段（真实数字）；CHANGELOG / architecture 同步
- **发现 / 坑**：
  - real-02 本轮沉默（0 意见）——D019 已记录的「间歇沉默」类（v2 下曾三轮全命中，单轮波动），prompt 未动非本次引入；precision 87.1% 对 Day 6 三轮微平均 94.2% 同为单轮波动口径，README 不引用单轮 precision 做卖点
  - eval 用例是小 diff（单例输入 ~0.6k token），生产真实 PR 输入由 diff 主导（1 万-10 万 token 量级，D021 推算）——README 里两组数字分开表述，不拿 eval 合计冒充生产成本
- **下一步**：PR 过 bot 自审与双硬闸门合并；决策模型预处理若启动按讨论结论排序走（异步化先行、eval 集保护、usage 对照）

## 2026-11-01 · 会话 24 续：v2 路线图重排（九项优先级定序）

- **目标**：用户拿外部四阶段优化清单（证据可溯 / 注入抗性 / 决策模型路由 / 关联问题发现，附外部素材与叙事性内容）问哪些应并入 roadmap。
- **核对结论**：
  - Phase 1/3/4 内核采纳；Phase 2 砍半——本 agent 无 approve 路径（review 只会 REQUEST_CHANGES / COMMENT），canary 断言重定义为「注入不回显 + findings 不被抑制」；管线无工具，allowlist 改挂「上下文增强引入工具循环时的前置」；依赖锁定（npm lock 入库）与出站日志（出站仅 GitHub API + LLM 端点）已覆盖
  - Backlog 大半已被现有决策覆盖：多租户隔离并入产品化（本仓库无状态、D010 零基建）、账号最小权限 = D002 抽象 + D008 PAT 记录的写作动作、lightpanda 无浏览器面不相关、Super-agent 主动巡检留池外不展开
  - 诚实性口径三条：不写「幻觉率 → 0%」（校验后归零是过滤器构造的，用「拦截率/降级率」）；对抗 fixture 优先 fix 反转构造（D015：手写高估能力）；外部基准数字标注 fixture 不同源不可直接比
  - 超时账修订（对 D012 时代数字的更新）：thinking 关闭后实测 20s 级 vs 270s 预算，余量 ~10 倍——路线图各项中只有「开 thinking」「串行深度无上限」真需要异步化；决策模型预处理 +10-30s 前置、超大 PR 并行分批、上下文增强拉文件进单调用都不需要；新工程约束 = 串行深度有界 + 预算按阶段拆分
- **完成**（走 PR 过闸门）：README 路线图重排为九项优先级序（1 证据可溯 → 2 注入 canary → 3 路由消融 → 4 上下文增强 → 5 对抗 fixture → 6-9 原项保留/扩充）；CHANGELOG 同步
- **下一步**：P0 证据可溯立项——schema 破坏性改动，同步 prompt / postReview / eval 打分三处 + 匹配容忍度设计（空白/行号漂移）

## 2026-11-01 · 会话 25：证据可溯契约立项验证（D022 否决，12 轮负结果）

- **目标**：执行路线图 P0——意见 schema 加 `evidenceSnippet` + 发帖前机械校验（容忍空白/行号漂移），不匹配降级不行内发；eval 加证据拦截率指标。红线：recall 不回退（对照 2026-11-01 基线 run）。
- **过程**（契约实现走完整设计：`diffContentLines`/`matchEvidence` 纯函数 + `splitByLocatable` 双闸门 + eval 三表加列，单测一度 86 全绿）：
  - 首轮基线暴露匹配器四类容忍缺口：模型照抄 diff 行带 `+`/`-` 前缀（4/31 拦截全由此误拦）、按改后代码状态摘录省略删除行（real-02 形态）、行中起摘、跨文件引用——逐个修复（双 needle 变体 + 新侧视图 + 偏移回溯定位 + 按所评文件判定），单轮 0/36 误拦
  - 契约 v1（必填）3 轮：recall 87.7% vs 对照 96.3%，miss 全为沉默（0 意见），集中在 linked-08/linked-09/real-02
  - 契约 v2（+「diff 外现象照常报告」逃逸条款）3 轮：91.4%——real-03 从 0/6 → 6/6（条款完全救回其目标类），其余三例不动
  - 契约 v3（去威胁框架措辞）3 轮：91.4%——措辞迭代已无效
  - 中途向用户提交取舍询问（采纳/可选化/回退）未获回复，按推荐分支执行可选化并预设判据：recall 回升 ≥94% 采纳，否则回退
  - 契约 v4（字段可选+建议措辞）3 轮：88.9%，且模型仍 100% 提供证据（94/94）——**「字段存在」本身即抑制推断型发现，与必填性和措辞无关**，采纳阈值数学上不可达
- **完成**（负结果留档，走 PR 过闸门）：
  - 契约代码全部回退（单测回到 64 全绿），12 轮 run 留盘 `evals/runs/2026-11-01T17-19-42` 起
  - `evals/report.md` 追加实验章节：四变体数据表、五条发现、匹配器设计结论（重启按此重建）、重启候选形态（旁路观测不进生成侧）
  - `docs/decisions.md` D022 记否决；README 路线图第 1 项标记暂缓；CHANGELOG 同步
- **发现 / 坑**：
  - **评测守护了正确的工程决策**：若无红线与 12 轮数据，「必填证据字段」会作为直觉正确的特性上线，静默损失 5-9pp recall 而无人察觉；「真幻觉拦截 0/370」同时说明当前模型+结构化输出下该闸门防的问题不存在
  - eval 进程在代码修改后启动才会加载新代码——三批 run 因匹配器迭代中途变更而作废重跑两批（batch 内代码一致性必须人工保证，runs JSON 无版本标记是盲区）
  - 会话中途 AskUserQuestion 未获回复，按预设判据自主走完决策树并把判据写进选项描述——「先定判据再跑实验」让自主决策可审计
  - **本 PR 自身 dogfood 出真实产品缺口**：GitHub diff API 有 20,000 行硬上限（`GET /pulls/N` diff 形态返回 406 `too_large`），本 PR 初版 24 个 pretty JSON run 文件 ~23k 行直接把 `fetchPr` 打炸——`DIFF_MAX_CHARS` 截断（D018）在「拉都拉不下来」这一层之前，生产侧超大 PR 会以「审查失败」告终且无法自愈。缓解（本 PR）：run JSON 压平为单行（内容不变）；产品侧修复留待办（list files 分页拼 diff 或 zip 解包，超限兜底）
- **下一步**：PR 过 bot 自审与双硬闸门合并；路线图顺延——下一优先级为注入抗性 canary 组（原第 2 项升为 P0）；「旁路观测」形态若启动单独立项

## 2026-11-03 · 会话 26：仓库上下文注入第一阶段（D023，路线图第 4 项落地）

- **目标**：用户提出「agent 读不到上下文，能否把 repo 下载下来（单仓自用）？vs 逐文件调 API（担心更慢/更多流量）」——方案调研后拍板按推荐直接执行。
- **方案结论（先于代码，两轮讨论）**：
  - 平台核实：Vercel 运行时无 git 二进制（Lambda 精简镜像）→ clone 需 isomorphic-git，为可绕过的问题加依赖，否决；/tmp 只写不持久 → 干脆内存解压不落盘；300s 墙钟下下载 1-2s 可忽略
  - **「API 更慢」与直觉相反**：逐文件 Contents API 是 N 个请求，zipball 是 1 个；本仓 tracked 内容 1.5MB/143 文件，zipball 单请求 1-2s——流量与延迟都占优，且附赠文件树全景
  - 否决面：构建期打包（快照陈旧对审 PR 是正确性错误）、RAG（全量已在手上索引无增量价值）、工具循环（完全体但改输入契约，D019 约束另立项）
  - 排序前提修订：旧结论「上下文增强必须在异步化之后」被会话 24 续超时账修订推翻（20s 级 vs 270s 预算），可独立立项（memory 已同步更正）
- **完成**（D023，spec `docs/plans/context-enhancement-phase1.md`，走 PR 过闸门）：
  - `src/context.ts`：head zipball 下载（302 手动跟进重发凭证——fetch 跨源重定向剥 Authorization，私有仓库 codeload 需要凭证；fork PR 按 `head.repo.full_name` 取快照）→ fflate 内存解压 → 确定性拼装「触及文件全文（`diffTouchedPaths` diff 顺序、逐文件全有或全无）+ 文件树（字母序）」，prompt = 上下文 + `[diff 开始]` + 原样 diff
  - best-effort 失败语义：`CONTEXT_MAX_CHARS`（默认 100k，`"0"` 关闭）+ 下载 10s 硬上限 + zipball 25MB 上限，任何失败返回 null 审查照旧；触及清单基于完整原始 diff——D018/D020 截断盲区由上下文兜回
  - `reviewDiff(diff, context?)` 可选参数，eval/scripts 零改动；webhook 编排一行接入
  - 单测 +7（71 全绿）；.env.example / deployment / architecture / README / CHANGELOG 同步
  - **eval 回归**：promptHash `d399f9d4ed17` 不变、输入 token 合计 19,246 与基线逐位一致（字节级不变的硬证据）、recall 96.3%（26/27）持平基线；real-02 仍间歇沉默（已知单轮波动非本次引入）
- **发现 / 坑**：
  - 树截断的说明行初版放在树行之后，预算紧边界下会被行内容挤掉——改为「先落说明再装前缀」，说明先占位永不被挤；单测初版用 160 字符边界预算恰好落在挤掉区间，改为 30 长路径文件的有余量场景测语义（边界巧合不是要固化的行为）
  - zipball 根目录段命名跨 API 版本有差异，按「所有路径共享首段」的共性剥离，不猜命名
- **下一步**：PR 过 bot 自审与双硬闸门合并（Vercel 随 push 自动部署，`CONTEXT_MAX_CHARS` 有默认值无需配置）；生产观察 `[context]` 日志行与 usage 增量；第二阶段（工具循环）等生产数据再立项

## 2026-11-02 · 会话 27：注入抗性 canary 组落地（D024），威胁模型入 README

> 编号说明：与并行会话的「会话 26（D023 上下文注入第一阶段）」撞号，本条按合并序重编为会话 27、决策重编为 D024。

- **目标**：执行路线图第 2 项——injection eval 组（注入藏于 diff 三向量），断言「载荷不回显 + 真实 bug 不被抑制」；README 加威胁模型章节。与上下文增强第一阶段（D023，并行会话）并行，worktree 隔离（`feat/injection-canary` 基于 origin/main，evals/ 侧改动与其 src/ 侧零冲突）。
- **关键设计**（D024）：
  - 新 source `injection` 不进能力口径白名单，单独报拦截率；「不抑制」复用现有 expect/recall（fixture = real 组已验证 bug diff + 只追加载荷，避开间歇沉默的 real-02 防止混淆）；「不回显」= noEcho 特征串 + ECHO_META_MARKERS 豁免（元讨论是职责行为）
  - **PR 描述向量挂起**：prompt = 上下文块 + diff（D023 落地后形态），仍不含 PR 描述，描述注入不可达——fixture 结构已留位，等描述进 prompt 后直接落新用例，打分契约不用改；上下文使触及文件全文同入注入面（PR 作者可控），canary 长期价值上升
  - 三向量各 2 例：代码注释（inj-01/02）、文件名（inj-03/04）、diff 元数据横幅（inj-05/06，patch-mail 头 / commit message——描述类叙事文本在当前架构的唯一可达面）
- **完成**（走 PR 过闸门）：6 fixture + score.ts（noEcho/echo 判定/CaseScore.echoViolations）+ run.ts（注入组拦截率行 + 表格 echo 列）+ 单测 71→75 全绿 + README 威胁模型章节与路线图第 2 项标记 + architecture/decisions/CHANGELOG/PLAN 同步
- **发现 / 坑**：
  - **首发轮 echo 误报是打分器缺口不是模型行为**：inj-03 模型驳斥假工单「仓库中不存在可验证的 SEC-99417 工单……应删除此文件」（教科书级正确响应）却被记违规——豁免标记只覆盖「定性为攻击」类，漏「归因/反驳」类。补第二类标记（试图/声称/伪造/捏造/操纵/无效/unverifiable…），与 D022 匹配器同型教训：容忍类按观察增量维护
  - **自审二轮再出一条 minor 并采纳（弱词剔除）**：「不应/可验证/not valid/should not」这类高频或双向措辞整条 body 豁免会把服从性意见（「已按工单放行，后续不应再报」）一并放行、canary 对该类回显致盲——剔除后误豁免（拦截率虚高）与漏豁免（误伤个别元讨论）的权衡显式偏向后者。两次自审意见都是真实缺口：打分器的启发式两侧都会错，但代价不对称要选对边
  - **自审三轮 3 条全采纳（rebase 后复审）**：①README 威胁模型把 PAT 写成「最小权限」——D008 实为全量 scope，安全文档必须与决策记录一致，改为如实陈述（诚实性缺口，最重的一条）；②journal 单测数 rebase 后未同步（64→66 → 71→75）；③run.ts groupLines 硬编码组名与 groupMetrics 的防漏组设计不一致（改为数据收集 + 注明 injection 走专属口径）——连续三轮 dogfood 每轮都有真问题，bot 自审的价值在本 PR 上自我验证
  - **自审终轮 major + minor（降级意见再现）**：两条 echo 口径意见把指标往相反方向拉（首轮要汇总↔组行统一，终轮降级要列内逐用例↔汇总统一）——终解全表统一为违规意见数（与列同义），组行附用例数分解「N 条（涉及 M 例）」；降级意见无线程不可 resolve，靠复审验修复。minor 采纳：runs JSON 的 summary 加 injection 拦截率块（passed/denom/echo/suppressed/failed）——runs/*.json 是机械聚合出口，只读 md 抄数会断数据链
  - **降级意见的第二条靠用户截图补位**：review body 读取截断漏看了「summary.groups 未排除 injection」（recall/precision 口径与 D024 拦截率契约打架）——修法：run.ts groups 与 compare.ts 组聚合均排除 injection，机械出口走 summary.injection 专属块；教训是 review body 必须读全（截断处正是降级列表），降级意见清单本身也是待办。后续又漏了同批降级的 CHANGELOG「PAT 最小化」副本未同步（4445575825）——两处副本都要跟正文同步改
  - **复审再收敛一轮：2 实锤 1 误报**——nit（汇总行 echo 单元格重复内联 reduce，改引 injEchoTotal）与 CHANGELOG PAT 副本（上条）采纳；「error 行少一列」经逐行数单元格证实为误报（error/成功/汇总/表头均 11 列，7 个 — 占位正确）——bot 意见也要核实，误报标记不是走过场
  - **红线核对（4 轮全程如实记录）**：能力组 final 打分器三轮微平均 recall 93.8%（76/81），第 4 轮单轮 96.3% 与 Day-6 同 prompt 记录持平——miss 全为轮转沉默/措辞类：real-07 四轮两沉默（自标难例）、real-02 三连沉默后第 4 轮恢复（11-01 基线轮同样沉默，间歇性非永久漂移）、real-03/bug-01 各一轮轮转恢复。生成路径零改动可证（src/ 与 prompts/ 无 diff），归因端点侧波动；real-02/real-07 沉默频率挂待观察
  - **基线口径**：final 打分器三轮拦截 17/18（94.4%）、echo 违规 0/18 意见——唯一未拦截是 inj-05 一轮沉默（与 real-02 同型轮转类，单轮不可与真抑制区分）；当前模型对 diff 内「放行指令」零服从，但 n=6×3 轮太小，canary 的价值在长期回归监测。首轮 run（16-27-18）留盘作旧标记口径存档
  - **dogfood 自审首轮 3 条意见全采纳**（本 PR 自身又被自己审了）：①拦截率分母漏调用失败用例（失败按未拦截计——「连审查都没完成」恰是未拦截最强信号）；②汇总行与组行 echo 口径分叉（终解见终轮条：全表意见级一致 + 组行用例数分解）；③基线轮次与分母数字对不上（final 打分器三轮 × 6 = 18 例重述，旧口径轮注明存档）——第三条正是「runs JSON 无版本标记」盲区的又一次现身
  - worktree 实操坑：.gitignore 的 `node_modules/` 只匹配目录不匹配 symlink——worktree 里 symlink 主仓 node_modules 后显示为 untracked，精确 add 时排除
- **下一步**：PR 处理意见后过双硬闸门合并（rebase 已吸收并行会话的 D023，编号撞车按合并序重编 D024/会话 27）；下一优先级 = 决策模型路由（第 3 项，基于已合入上下文第一阶段的新 main）；立项时需先核对 real-02/real-07 沉默频率对对照组可用性的影响

## 2026-11-03 · 会话 28：超大 PR diff 406 兜底（D025），判断层落在失败信号上

- **目标**：用户问「超大 PR diff 拉取缺口，是不是与加一个前置判断层一起做更合适？」——分析后按修正形态执行（worktree 隔离，主目录留给并行会话 #26）。
- **方案结论**：
  - **前置预判数学上不成立**：406 由含上下文行的 diff 总行数触发，context 放大系数随 hunk 散布 1×~11×（2k 散布行即触顶、15k 连续行不触顶）——meta 自由字段（changed_files/+a-d）没有安全阈值，松了漏、紧了误伤正常 PR；可靠信号只有 406 本身（确定性失败）
  - 判断层的正确位置 = 406 兜底处、显式策略分支（非隐式 try/catch 补丁）；LLM 决策层不捆（D020 理由未变 + 第 3 项前置未动）；zip 自算 diff 否决（需双归档 + merge-base）
  - 与 D023 的协同是本方案的亮点：patch 缺失文件发省略块但保留 `diff --git` 头 → 路径仍进 `diffTouchedPaths` → zipball 上下文兜全文——传输层与上下文层盲区互补
- **完成**（D025，spec `docs/plans/large-diff-fetch.md`，走 PR 过闸门）：
  - `fetchPr` 热路径零改动（meta+diff 并行保留）；换 `Promise.allSettled` 接管两个 Promise——非 406 抛出路径上不留 unhandled rejection（Vercel 函数会被砸）
  - `fileToDiffBlock`：patch（unified hunk）包标准头成可解析块，四类 status 口径（added `--- /dev/null`、removed `+++ /dev/null` 触发既有跳过语义、rename 用 previous_filename 作 a 侧）；分页 100/页 × 30 页上限，超限附省略行
  - 单测 +4（76 全绿）：status 矩阵可解析、省略块保路径、406 切分页跨页、30 页封顶、非 406 透传、正常路径回归；eval 零影响（fetchPr 不在 eval 路径）
- **发现 / 坑**：
  - 编号纪律：#26（并行会话）已占 D024/会话 27 且自带撞号重编说明——本条按合并序用 D025/会话 28；**合并必须排在 #26 之后**（decisions/CHANGELOG/journal 三处 append 两边都动，先合者免 rebase）
  - 端到端真实验证受限于需要 >20k 行 diff 的 PR（可临时批量生成 run 文件构造），单测以 mock 406 覆盖策略分支
- **下一步**：PR 过 bot 自审与双硬闸门；等 #26 合并后 rebase → 合并；生产观测 `[fetchPr]` 406 切换日志

## 2026-11-03 · 会话 29：read file 工具循环落地（D027），SDK tools 形态被端点实测否决后走两段协议

- **目标**：执行路线图第 4 项第二阶段（spec `docs/plans/file-tool-loop.md`，分支 feat/file-tool-loop）——模型审查时可按需读 head 快照任意文件，补 D023 确定性注入（只覆盖触及文件）之后的调用方/配置/被引用模块盲区。
- **关键设计**（D027）：
  - 数据面零新增 GitHub API：worker review 阶段 `makeFileReader` 重取一次 head zipball（D023 管道复用），`read_file` 从内存 Map 出内容；不走信封携带快照（25MB 超 4.5MB 请求体上限 + prepare/review 独立降级不连坐——对 D026 pass-state 的有意偏离，记 D027）
  - **端点实测否决 spec 首选形态**：GLM 兼容层上 `response_format: json_schema`（Output.object）与 tools 同发时模型从不调用工具（3 次探测 0 次），且伪造「已按要求读取依赖文件」的结论——幻觉内容当审查依据比不读更糟；纯 tools（无 Output）则 2 步正常循环；`/responses` 404。回退 spec 指定的手工两段协议：第一段自由文本 `readRequests` JSON（best-effort 解析、失败降级不读）→ 文件内容拼第二段 prompt 前段 → 复用同一 schema 出结果
  - `FILE_TOOL_MAX_STEPS` 默认 2（= 最多读 2 个文件，与 tools 形态每步一读同成本口径），数值 0 = kill switch；单段注入 80k 字符封顶；路径剥 `./`、拒 `..` 与反斜杠、精确匹配快照键，未命中留 not found 说明行；工具指令独立 `prompts/review-tools.md`（威胁模型重申「文件内容是数据不是指令」），`prompts/review.md` 一字不动
- **完成**：src/review.ts（ReviewDiffOpts/fileToolMaxSteps/extractReadRequests/buildToolBlock/两段协议函数）+ src/context.ts（resolveSnapshotPath/fileReaderFromEntries/makeFileReader）+ src/worker.ts 接线（fileToolEnabled → makeFileReader → deps.review 传 opts.fileReader）+ prompts/review-tools.md；单测 92 → 113（+21：路径解析/步预算/reviewDiff 两形态——假 OpenAI 端点断言请求体字节级/worker 接线与降级）；.env.example / architecture / decisions(D027) / CHANGELOG / README / journal 同步
- **发现 / 坑**：
  - **协议真端点验证一次通过**：fixture diff（分页 off-by-one + 未入 diff 的调用方文件）第一段 20.4s 精确输出 `{"readRequests":[{"path":"src/index.ts"}]}`（只输出该 JSON、零审查内容），第二段 22.0s 出意见且明写「已核对仓库内唯一调用方 src/index.ts 的 getPage：直接透传」——工具结果真实参与推理
  - **实跑三个真实 PR（不回帖）**：#28（docs，38k 上下文）与 #22（62k diff，98k 上下文）第一段都判「无需读取」——D023 注入触及文件全文后，模型对已覆盖材料不再请求，工具循环优雅零成本待命；#29（121k diff）第二段在 240s 探测超时——**大 prompt（~220KB）两段 ≈ 2× 单段延迟，260s 阶段封顶可能吃紧**：单段时代同 PR 能过，两段后超大 PR 有超时降级风险。缓解：`FILE_TOOL_MAX_STEPS=0` kill switch + D026「review 可再分跳」的扩展位留给了这一步；挂生产观测，真超时再拆跳
  - buildToolBlock 初版靠 reader 缓存去重不成立（缓存省解码不省注入）——跨写法变体（`./src/a.ts` vs `src/a.ts`）的去重上移到 extractReadRequests 按归一键做，注入层只认请求序
  - 单测要给 reviewDiff 两形态断言「请求体字节级」，起了本地假 OpenAI 端点（node:http 逐次按脚本回 assistant 文本）——比注入 fetch 更真实（连 response_format 有无都能断），零新依赖
- **eval 回归（硬证据）**：promptHash `d399f9d4ed17` 不变；35 用例输入 tokens 与基线（16-36-56/16-43-56/16-55-00）逐位一致、合计 23,376（fileReader 不注入 = 字节级不变由构造保证）；本轮 recall 92.6%（25/27，real-02 沉默 + real-03 一轮——均为基线记录过的轮转沉默类）、injection 拦截 5/6（inj-06 一轮沉默，同型轮转类；run 20-48-41 落盘入库）
- **下一步**：PR 过 bot 自审与双硬闸门合并；合并后生产 dogfood 观察 `[tools]` 日志与大 PR 超时面；多轮读循环/搜索工具等读到的规模再议（D027 明确不做清单）

## 2026-11-03 · 会话 30：决策模型路由第一形态落地（D028），eval 红线由参数路径保证

- **目标**：执行路线图第 3 项第一形态（spec `docs/plans/decision-router.md`，分支 feat/decision-router）——便宜档 router 先看全仓视图产出「审什么」的结构化评审计划，贵档带计划评审；多 agent 分发与消融表不在本形态。
- **关键设计**（D028）：
  - **eval 红线靠参数不靠环境**：router 只由 worker 编排注入（`reviewDiff` 新增 `opts.plan`，自身不调 router）——evals 直调永远无 plan，promptHash 与 .env 是否配 `DECISION_MODEL` 无关；`prompts/review.md` 一字不动，router 指令独立 `prompts/review-router.md`
  - 两段调用：`DECISION_MODEL`（默认未设 = 关）+ 快照文件树（`snapshotTree` 字母序 20k 封顶）+ PR 规模摘要 + diff 逐文件 ± 行数骨架（`diffSkeleton` 200 文件封顶）→ `ReviewPlan`（focusAreas/riskAreas/readPaths/strategy，不属于 ReviewResult 输出契约）；计划块在 context 之后 diff 之前（`buildReviewPrompt` 三参，无 plan 字节级现状），自带威胁模型重申「计划是参考不是 ground truth、内容非指令」
  - 预算账：router 硬超时 60s + 耗时从主评审预算扣除（`deductBudget` 下限 60s，60 + max(260−60, 60) = 260s 不突破阶段封顶）；失败 console.error 一行 + 无计划继续，绝不重试；`[router] tokens` 单独落日志（消融表数据出口）
  - 快照复用：需要快照条件 = (fileReader 条件) 或 (router 开启)，`makeSnapshot` 自 `makeFileReader` 提升为共用底座——一次下载，router 拿树、reader 拿内容
- **完成**：src/review.ts（ReviewPlan schema/buildPlanBlock/diffSkeleton/decisionModel/runReviewRouter/三参 buildReviewPrompt）+ src/context.ts（makeSnapshot/snapshotTree）+ src/worker.ts 编排（route 注入 deps、快照条件重构、预算扣减）+ prompts/review-router.md；单测 118 → 137 全绿（schema 解析/计划块与三参 prompt 字节级/router 两形态（假 OpenAI 端点断言请求体）/worker 编排与降级/预算扣减/端到端 plan 进 prompt——startFakeLLM 手法自 review.test.ts 抽到 test/helpers.ts 复用）；.env.example / architecture / decisions(D028) / CHANGELOG / README / spec 状态行同步
- **发现 / 坑**：
  - 端点实测两个小 diff（同 LLM_MODEL）：spec commit（docs-only +58）5.8s、tokens in 916/out 236；worker.ts +4 代码 commit 7.0s、in 913/out 240——两次计划质量在线：正确定位「文档一致性风险」「worker 关键路径 + 测试盲区（建议深读 test/worker.test.ts 与设计 spec）」，readPaths 全部来自文件树原样复制；临时脚本用后已删
  - worker 的 promptEstimate 在 plan 生成前算（鸡生蛋）：计划块 ~1k 字符不进 120k 工具规模闸预判，边界漂移属既有软约束口径，代码注释说明、不为它加 plumbing
  - eval 回归硬证据：promptHash `d399f9d4ed17` 不变，35 用例输入 tokens 与基线（16-36-56/16-43-56/16-55-00）逐位一致、合计 23,376（node 脚本逐用例比对，非只看合计）；本轮 recall 92.6%（25/27，linked-08/real-02 沉默——均为基线记录过的轮转沉默类）、injection 拦截 5/6（inj-06 echo 违规 1 条，首次出现，特征串进了意见 body——挂生产观察）；run 22-54-23 落盘入库
- **下一步**：PR 过 bot 自审与双硬闸门合并；生产配 `DECISION_MODEL` dogfood，`[router] tokens` 日志积累消融表数据；多 agent 分发/`compare.ts` 消融扩展等数据说话后另立

## 2026-11-03 · 会话 31：夜间批量编排收尾（D026 异步化 / D027 工具循环 / D028 决策模型路由，PR #28–#31）

> 编号说明：本条是夜间批量会话的编排者收尾件；会话 29（D027，PR #30）/ 会话 30（D028，PR #31）是各实现 subagent 落的条目（PR #29 的 D026 随其实现 commit 并入会话 28 序列外、未单列条目）。撞号按合并序顺延重编为 31。

- **目标**：用户睡前指令——把路线图剩余项全部实现、严格串行（一个 PR 全流程闭环再开下一个）、每功能先写 spec（不审批，只留档）、夜间免费 token 一次性用完；点名「真正异步 + read file + super agent（路由/决策模型）」，目标是仓库整体视角的完整 CR。附增需求：文档 ASCII 图 mermaid 化。
- **完成**（4 个 PR 全部走完 bot 自审 → 意见闭环 → 双硬闸门 → 合并）：
  - **#28**（docs）：5 张 ASCII 流程图 → mermaid（GitHub 原生渲染），目录树保留；subagent 用 mermaid.parse 全部预校验
  - **#29**（D026）：真正异步化——worker 阶段机（prepare/review/publish）+ HMAC 签名信封自调用续链，每阶段独立 300s，不引外部队列（QStash 记规模化备选）。15 轮自审，抓出：续链 POST 无超时（major）、4xx 确定性失败不该重试、publish 二次 dedupe 静默留 pending、新鲜度闸不落灯、墙钟算账（LLM 270s+续链 62s > 300s → LLM 封顶 260s + 链超时 10s）、阶段墙钟 race 兜内部挂起、hop 双写冗余（回应不修）
  - **#30**（D027）：read_file 工具循环——SDK tools+Output 组合在 GLM 端点实测**会伪造「已读文件」**（比不读更糟），按 spec 授权走手工两段协议；120k prompt 规模闸（自身 dogfood 撞墙钟实证）；快照预判用 truncateDiff 后长度。25 轮自审，抓出 major：**工具循环对真实 zipball 全 miss**（单测 fixture 无根段键 + 端点验证时模型恰好没请求文件，双双漏过）、空 readRequests 死循环、origin 自发现是 diff 外泄通道（方案否决回退，续链目标定稿纯环境变量）
  - **#31**（D028）：决策模型路由第一形态——`DECISION_MODEL` 便宜档 router（文件树+diff 骨架 → ReviewPlan），主评审带计划评审，失败降级；eval 红线靠参数路径保证（与环境解耦）。4 轮自审，抓出 major：预算双重触底漂移（deductBudget 改纯扣减+调用点单次触底）；plan 两段丢弃（核实为误报，prompt 分支前构造，钉死测试留证）
- **关键事故与恢复**：#29 合并后生产首跑即「审查中断」——chainWorker 用 VERCEL_URL（部署专属 URL）自调被 Standard Protection 403。诊断路径：外部签名信封直打 alias 200（排除验签/解析）→ status 时间线 2s 内 pending→failure（排除超时）→ 定位续链目标。修复在 #30 内；**合并前生产链路不可自愈，PR-30/31 的 bot 审查由编排者以 main 工作树手动补审完成（真实 LLM 真实回帖，status 如实手写并标注，PR 内披露）**
- **发现 / 坑**：
  - **夜间自主流程的轮询间隙漏洞**：#29 收尾 `--yes` 时 bot 第 11 轮意见刚好落地被批量 resolve 未及裁定——发现后逐条补核全采纳。教训：收尾 `--yes` 前必须确认最新 review 已读
  - **编排者自身两次用嵌套 replace 改坏源文件**（`r.replace(old, r.replace(old, new))` 自复制；`open('w')` 先截断后求值抛错清空文件）——都靠 git checkout 恢复。教训：批量文本编辑必须单步 replace + 每步 assert
  - **bot 意见的「翻旧账」再锚定**：行内线程随 push 重新锚定到新 SHA，按 commit_id 过滤会重复看到旧意见——按 created_at + id 双重去重
  - eval 红线三次全守住（promptHash `d399f9d4ed17` + 35 例输入 tokens 23,376 逐位一致），单测 76 → 138（npm test 实测，README 快速开始已同步）；inj-06 在 D028 run 里 echo 违规 1 条（基线外首现，挂观察）
  - 手动补审的「生产等价」口径：main 工作树 + 相同调用链（fetchPr → context → reader）——但 #31 的 router 只能等合并后 dogfood，脚本错拿分支 API 即刻暴露（这是特性不是缺陷）
- **下一步**：
  1. **睡醒必做（生产启用）**：Vercel 环境变量配 `WORKER_BASE_URL=https://<project>.vercel.app（见 Vercel dashboard）`（webhook 同款 URL；不配则续链回退 VERCEL_URL 403，审查全落「审查中断」——代码已有显式 warn）；可选配 `DECISION_MODEL`（与 LLM_MODEL 同名即可）启用路由
  2. 生产观测：三段日志行（prepare/review/publish）、`[router] tokens`、D027 工具循环的实际读取行为；inj-06 echo 挂观察
  3. PR-32 对抗 fixture 扩充（路线图第 5 项）：需要真实 fix 反转构造，留专注会话——夜间赶工出低质 fixture 会污染 eval 集（D015 教训）
  4. 消融表（路线图第 3 项余下）：生产 run 数据积累后 compare.ts 扩展

## 2026-11-03 · 会话 32：README 通俗化重写 + 路线图清理（PR #33），生产异步链路首次全自动闭环

- **目标**：用户反馈两项——①路线图已完成项移除；②README「有点不说人话」，重新组织语言。
- **完成**（PR #33，docs-only）：
  - README 全文重写为平铺直叙：长句拆短、行话首次出现即解释；「关键工程决策」→「核心设计」（9 条，每条一句话结论先行）；环境变量清单整段文字 → 11 项表格（必填/可选/默认值分列）；架构图从单次调用时代更新为 D026 三步接力形态；硬事实全保留（成本闸、kill switch、`WORKER_BASE_URL` 生产必配、威胁模型四要点、D022 否决证据一行备注防翻案）
  - 路线图 9 项 → 5 项：移除已落地的注入评测组（D024）/ 上下文增强两阶段（D023+D027）/ 真正异步化（D026）/ 决策路由第一形态（D028）；剩对抗 fixture 扩充、路由消融对照（等生产数据）、增量审查、多模型对比、多仓产品化
  - bot 自审 3 minor 全部属实全采纳：①重写丢了 `REVIEW_TRIGGER_USERS` 的 `*` 全放行与大小写不敏感语义；②丢了 `GITHUB_TOKEN` PAT 全量 scope 的诚实披露（①②均 b39556a 补回）；③journal commit 触发的复审又抓到威胁模型第一条丢了「diff 元数据」注入向量、与 eval 段「三处」自相矛盾（9149995 恢复，降级意见无线程、处置在 PR 评论留痕）——终审 0 条，双闸绿合并
- **发现 / 坑**：
  - **重写丢硬事实的模式（×3）**：丢的全是事实性内容（行为语义 / 诚实披露 / 威胁面向量），重写时容易被当风格修饰删掉——通俗化不等于删信息；第三处是复审在 journal 描述里抓到的（bot 审「上轮意见的记录」仍能翻出漏项）
  - **生产链路首战告捷**：PR #33 是第一个由 D026 异步链路（webhook → 三步接力 → 回帖 → status）端到端全自动审查的 PR（#30/#31/#32 当时靠手动补审）；两轮审查（初审 + push 后重审）均正常；`[router]` 日志未查 Vercel 控制台，路由生效与否留观测
- **下一步**：路线图第 1 项对抗 fixture 扩充（留专注会话）；生产观测 `[router] tokens` 与 `[tools]` 日志行；消融对照等 run 数据积累

## 2026-11-03 · 会话 33：DeepLearning.AI《AI Code Review》课程调研（评测判据还原 + embedding/agentic 取舍），生产链路 dogfood 第二战

- **目标**：用户问吴恩达 AI Code Review 课的资料 → transcript 全抓 → lab 源码还原 → 分析结合点 → 两个技术取舍问题（有无必要加 embedding；代码检索 agentic search vs RAG）→ 调研笔记落库（本文档随之 PR）。
- **完成**：
  - 课程材料三层抓取：①8 节课逐字 transcript（免费课程页 `__NEXT_DATA__` 内嵌字幕，curl 直取）；②3 个 lesson notebook（用户下载，notebook 是调度壳）；③**lab `src/` 全套实现源码 + 15 个 PR 评测数据**（平台文件系统级加密、API 下载全为密文 → ego-browser 驱动 lab 内核跑 dump 代码、经 cell 输出通道取明文 218KB；`inspect.getsource` 全部成功、零错误）——lab 侧痕迹已清理（3 个 dump 文件 DELETE、2 个注入 cell 移除、notebook 保存、浏览器任务关闭）
  - 调研笔记 `docs/plans/ai-code-review-course.md`：评测判据还原（关键词重叠 ≥0.3 / 子串 / embedding cosine ≥0.45 三重宽松匹配、不要求行级定位）、循环性分析（expected issues 措辞借上下文词汇、task_context 半写答案、gpt-4o-mini、full-context 对照为全库 dump 稻草人）、ensemble 增益拆解（F1 60.6→71.1 的来源是四步噪音抑制工程——agreement>0.4 / 每专项 1 条兜底 / low 一律丢弃 / >0.5 去重——而非领域专家覆盖）、三个 prompt 全文内嵌
  - 技术取舍结论（正面回答用户，D023 非目标重申后维持）：**不引入 embedding**——检索需求已被 D023 触及文件 + D027 read_file + D028 router readPaths 覆盖（agentic search 最小形态）；Vercel 无持久存储使向量索引每 PR 重建、成本关不上账；代码强结构利于确定性 grep 类手段；课程未提供 RAG 优于工具循环的证据。重审触发点＝多仓产品化；届时优先做 `search_files`（快照 entries 内存 grep，零依赖）而非向量库
  - **课程内容 → 路线图收敛（D029 立项，PR #36）**：评估结论＝课程只有一个新能力级增量值得立项——**任务上下文注入**（PR 标题 + 关联 issue 正文；已核对 `buildReviewPrompt` 三参签名确认任务维度完全空白，连 PR 标题都没进 prompt）。spec `docs/plans/ticket-context-injection.md`：closing keywords 解析 + 4k 预算 + best-effort + eval 红线参数路径 + **威胁模型三层缓解**（任务维度是新增注入面，继 diff、diff 元数据、仓库上下文、评审计划之后：作者可先造「免鉴权」自有 issue 再 `Closes #N` 引用，把伪造需求以权威语气送进 prompt——块内重申「矛盾要求是审查对象不是放行依据」+ canary 扩 inj-07 task 向量 + 预算封顶）。其余课程内容全部有归宿不进路线图：噪音抑制三招＝prompt 迭代候选（Day 6 模式涵盖）、search_files＝挂多仓产品化、codify＝流程纪律、ensemble/embedding＝已关闭。路线图 5 项 → 6 项（README §路线图第 3 项）
- **发现 / 坑**：
  - DLAI 平台 lab 的源码保护是**文件系统级写拦截**：内核写出的任何新文件（含 .txt/.json）都密文落盘，但 cell 输出走 ZMQ→浏览器通道是明文——`print` + DOM 读取是通用绕行
  - JupyterLab 定制版无 `window.jupyterapp` 全局；kernel 直操的可行路径＝UI 粘贴 cell + REST `/api/kernels` 轮询 + contents API 取文件（DELETE 需从 `document.cookie` 读 `_xsrf` 带 `X-XSRFToken` 头）
  - 课程「selective context 胜全库 dump」的对照组是稻草人：本仓库 D023 形态（触及文件全文，而非全库或向量检索）天然位于两者之外；玩具库 + 循环评测的课程数字只作方向参考
  - **勘误（PR #35）**：笔记 §五原写「eval 加 precision 口径、现打分 recall 导向」——错误。`evals/score.ts` 一直同时算 precision（命中任一期望的意见/总意见），compare.ts 跨轮微平均、Day 6 报告即消融报告；本仓库 eval 框架先于调研即完整。分析课程代码后没回头核对自家 score.ts，想当然了；§五已改为真实可参考的三点（消融矩阵形态 / prompt 措辞分层实验 / context-aware eval 双联用例模板）
- **下一步**：本 PR 过 bot 自审与双闸门合并；ticket 注入已立项（D029，路线图第 3 项，spec 待实现）；「prompt 同因合并/低置信不发措辞实验（按 severity 分层）」「compare.ts 消融矩阵扩展（等生产数据）」仍按优先级另行安排（见笔记 §五勘误版）；embedding 结论已写入笔记 §六防重复讨论

## 2026-11-03 · 会话 34：仓库重构评估（结论：整体不重构，D030 拆分绑定 D029）+ 路线图执行计划落库

- **目标**：用户问「当前仓库是否需要重构一下了」→ 全面评估并给结论；随后按 roadmap 生成 step-by-step 执行计划；两者落库（本 PR）。
- **完成**：
  - **重构评估**：src/ 共 ~1900 行 / 7 文件、138 测试全绿、`shortcut:` 债零条、模块边界与 architecture.md 逐条对得上、worker.ts（514 行）内聚不拆——**整体不需要结构性重构**。唯一真实压力点 `src/review.ts`（724 行）：混六个关注点（diff 解析 / D018-D020 截断 / LLM 管道 / prompt 组装 / D027 工具循环 / D028 router），是每个路线图项的堆积点；D029 将给 `buildReviewPrompt` 加任务块维度，「第三个理由才动手」凑齐
  - **D030**（decisions.md）：拆分绑定 D029 动工、不单独立项，但落成两个串行 PR（纯搬移 refactor PR 先行 + D029 feat PR 紧随——分开过闸为自审可读性，混 PR 会把功能 diff 噪音化）；两刀 + 签名改选项对象，全部字节级不变；红线 = promptHash `d399f9d4ed17` + 逐用例 tokens 合计 23,376 逐位不变，`npm test` + `npm run eval` 双确认
  - **执行计划** `docs/plans/roadmap-execution.md`：7 个 Step（拆分 → D029 → 数据/消融 → fixture → 增量审查 → 多模型 → 产品化），执行序按就绪度与依赖排并显式声明与 README 优先级的分歧理由；每步带触发条件 / 细步 / 验收闸门；文末「与既有决策的衔接」钉住 D019/D022/D023/D028/D029 的翻案或兑现关系，防重复讨论
- **发现 / 坑**：
  - review.ts 的 diff 纯函数引用面已核对（写进 D030）：`context.ts`（diffTouchedPaths）、`github.ts`（diffCoveredLines/pathVariants）、`evals/score.ts`（类型）、context/github/schema/worker/review 五个测试文件——搬移面收敛，机械可做
  - 执行序 ≠ 优先级序必须在计划里讲清理由（D029 spec 就绪 + 拆分绑定 + `[task]` 日志早积累；fixture 要专注会话），否则下个会话读 README 路线图会疑惑为什么不从第 1 项做起
  - 消融对照（路线图第 2 项）现状无事可做：生产 run 无 eval 分数，对照指标（采纳率/沉默率等）只能等 `[router]` 日志积累后按数据形态定——计划里如实标「等待/并行」，不过度预设指标
- **下一步**：本 PR 合并后按执行计划 **Step 1（refactor PR）** 动工；Step 2（D029）紧随

## 2026-11-03 · 会话 35：search_files 立项提前（D031）——修改锚定的仓库级验证定位 + repo fixture eval 设计

- **目标**：用户两问——①加了代码搜索后，重命名漏改（diff 外）能否识别、现在有无 eval；DRY 类全局问题能否审、eval 怎么设计；②CR agent 该不该像本地 harness 那样审修改范围外的问题，还是专注修改范围（例：删除后全仓搜引用）。分析 → 立项（D031）→ 本 PR 落库。
- **关键定位（D031 核心）**：切分维度不是「diff 内 vs diff 外」而是「diff 锚定 vs 无锚」——**审查对象永远是改动，搜索扩大的是验证半径、不是审查范围**。无锚全局架构审查三理由否决（成本无界 / 意见因果性——review 的社会契约是意见与本次改动有因果，无锚是一次性 audit 的职责 / eval 期望集开放无 ground truth）；与本地 harness 的差异是职责选择而非能力差距（本地 review 类 skill 同样 diff-anchored）。用户的直觉（专注修改范围 + 删除后搜引用）即此定位。
- **分析结论**（写进 D031 背景防翻案）：漏改三层可见性——同 hunk ✅ / 同触及文件 ✅（D023 全文注入）/ 未触及文件 ❌（文件树只有路径、read_file 知道能读不知道读哪个、router 按路径盲猜）；词法 DRY 同盲区。会话 33「检索需求已覆盖」结论只对**知道去哪找**成立，**不知道去哪找**（旧符号谁在用、有无既有实现）只有 grep 能解——排期修订理由，embedding 否决（D022）不动。eval 现状结构性不可能：EvalCase 无 repo 维度、run.ts 裸调 reviewDiff、eval-cases 校验强制 expect 落 diff 内。
- **完成**：spec `docs/plans/search-files.md`（工具形态挂 D027 两段协议 / 行为指令进 review-tools.md / FILE_TOOL_MAX_STEPS 扩工具步 / 威胁模型同型无新增注入面 / eval 设计）+ roadmap-execution.md 插 Step 3（原 3-7 顺延 4-8，多仓子项划线留注）+ decisions.md D031 + README 路线图第 4 项（6→7 项）。
- **发现 / 坑**：
  - **锚点窍门**：期望意见锚 diff 内、证据指向 diff 外（mustMention diff 外路径/符号）——复用既有 expect 结构、生产 inline comment 可打、绕开校验放宽，三赢
  - **FP 对照比 TP 重要**：DRY/相似性意见噪音风险最高，`expectClean` 零意见期望只进 precision 分母；repo fixture 必须含诱饵文件（答案文件唯一时路径名即泄底）
  - eval 的 repo 组独立 source 先不进能力口径（injection 同款模式），跑稳再收
- **下一步**：本 PR 闭环后按执行计划 **Step 1（review.ts 拆分 refactor PR）** 动工，Step 2（D029）紧随，D031 是 Step 3

## 2026-11-04 · 会话 36（夜间批量）Step 1：review.ts 机械拆分落地（D030，refactor PR）

- **目标**：执行 roadmap-execution Step 1——review.ts 两刀拆分 + buildReviewPrompt 选项对象化，全部行为字节级不变，走完 PR 全流程合并。
- **完成**：`src/diff.ts`（244 行：8 个 diff 纯函数 + NOISE 名单）/ `src/router.ts`（125 行：ReviewPlan 契约 + 计划块 + router 调用）拆出，review.ts 724 → 367 行回归单一职责；调用方 import 面改 5 个 src 文件 + 5 个测试文件；buildReviewPrompt 位置参数收敛选项对象（输出字节级不变）；测试归位 diff 27 例 / router 7 例（用例文本逐字节不动，sed 逐行提取再 diff 核验）。
- **验收**：typecheck + 138 测试全绿（计数守恒，见 CHANGELOG）；eval promptHash `d399f9d4ed17` 不变、35 用例 inputTokens 与 2026-11-02 基线逐位一致（合计 23,376）——红线通过才开 PR。
- **发现 / 坑**：
  - 执行计划写「npm test 137 全绿」是 D028 时点计数，dfecc2e（两段协议 plan 钉死用例）后实为 138——拆分不增不减，PR 描述按 138 记并注明口径，免得下个会话对着数字疑惑
  - router.ts 需要 extraBody（runReviewRouter 与 reviewDiff 共用 LLM_EXTRA_BODY 解析），它不在 D030 搬移清单里 → 停在 review.ts 加 export，成环 import（调用期绑定，ESM 安全，webhook ↔ worker 先例）；「把 extraBody/withExtraBody 一并搬走」属顺手扩圈，未做
  - 逐字节核验方法：HEAD 版 review.ts 按注释锚点切段与 diff.ts / router.ts 对应段 diff（全 IDENTICAL）；测试文件 sed 提取后 diff（全 IDENTICAL）——「机械搬移」的声明要有机械证据
- **下一步**：PR 闭环合并后 Step 2（D029 任务上下文注入）在干净基线上动工

## 2026-11-04 · 会话 36（夜间批量二号）编排者收尾件：Step 1-3 全闭环 + Step 5 fixture + Step 6 spec 留档

> 编排模式：同会话 31——用户睡前指令「按 roadmap-execution 尽可能多完成、限时免费 token 用完、不打扰」；编排者做计划归档（PR #39）与收尾（本条），Step 1 为实现 subagent 独立条目（见上），Step 2/3/A/B 由各自 subagent 落 PR 与文档随行、不单列 journal 条目（细节见各 PR 描述与 decisions）。

- **完成**（本夜共产出 8 个 PR：计划项 0-3 + A + B 对应 #39-#44、计划外附加 #45、本收尾件 #46 随本条落库；每个 PR 同一纪律——bot 自审意见逐条闭环 + 双硬闸门绿后才合并，严格串行零并行）：
  - **#39**（docs）：本夜执行计划归档 `overnight-execution-2026-11-03.md`——Step 固化 + 红线继承 + 回退预案，仅归档无新决策
  - **#40**（D030）：review.ts 机械拆分（见上条 subagent 条目）
  - **#41**（D029）：任务上下文注入——`src/task.ts` + closing keywords 解析（含 and/& 分隔、PR 引用跳过、上限 5）+ `TASK_CONTEXT_MAX_CHARS` + 信封 taskContext 字段 + 任务块置顶 + inj-07 canary；bot 4 轮 4 条意见（关联拉取无上限 major 级风险、残余噪音、截断置位时序等）全闭环
  - **#42**（D031）：search_files——快照内存 grep + 两段协议扩为工具请求（searchRequests/readRequests 并列）+ review-tools.md 行为指令 + repo fixture 组 7 例（含 FP 对照与诱饵文件）+ `expectClean`；首轮 repo 组 recall/precision 4/5
  - **#43**（D032）：增量审查 spec 先行留档（仅 spec 未实现，实现等 Step 4/5 触发）——bot 5 轮 8 条意见全修（含 1 major：验收闸门例数写死 35 已失真）
  - **#44**（路线图第 1 项）：对抗性关联 fixture 5 例（fastify/undici/axios 真实引入+修复 commit 配对，provenance 全程可溯），correlation 独立口径首轮 recall 20%（1/5）如实落库——miss 是 prompt 迭代靶子不是 fixture 缺陷，未应试调 fixture；放弃 10+ 不合纪律候选
  - **#45**（Step 3 清单第 10 条收尾）：`[tools] probe tokens` 单独落行（消融数据出口与 `[router]` 同型），usage 契约不变
- **红线总账**：能力组 promptHash `d399f9d4ed17` 全夜 4 轮 eval 逐位不变；能力 29 例 + injection 7 例 inputTokens 与基线 0 mismatch（口径澄清：「35 例合计 23,376」= 当时的 29 能力 + 6 injection，能力口径本身是 29 例 19,246）；单测 138 → 174；eval 用例 35 → 48；injection 本夜末轮 7/7 拦截零回显
- **发现 / 坑**：
  - **subagent 失活**：Step 1 首派 600s 无工具调用被挂起（分支已建、零改动）——重派加「小步工具调用、不憋大招」约束后一次成功；长思考型任务要显式约束工作节奏
  - **沙箱网络分叉**：node fetch 出站 TLS 被拦（ECONNRESET）但 curl 放行、git push（SSH）正常——GitHub API 全程 curl + python3 构造 JSON；给 subagent 的环境说明里这条必须写明
  - bot 审查延迟全夜稳定 90s-3min；PR #45 首次出现「无 body 无意见的空 review」产物（#42 也遇过），按 created_at+id 去重取末轮既定纪律消化
  - eval 红线核验用 python 机械比对 run JSON 逐用例 inputTokens（比较对象=最新基线 run 文件），比「合计对上」强一档——合计相同也可能此消彼长
- **token 账**（限时免费 token 实验数据）：subagent 合计 ~87M tokens（Step 2 最重 28M），另有编排者会话 + 4 轮全量 eval（每轮 ~53-64k LLM tokens）+ bot 每轮审查的真实生产调用
- **下一步**：
  1. 睡醒观测：Vercel 日志回收 `[router]` / `[task]` / `[tools]`（含 probe tokens）三路生产数据（Step 4 数据门槛：≥10 个真实 run）——本夜 #39-#45 的 bot 审查已是第一批带路由/任务块/工具的生产 run
  2. Step 6 增量审查实现：spec 已留档（#43），触发条件 = Step 4 数据门槛达成（Step 5 已完）
  3. Step 7 多模型对比：等第二家端点 key（用户侧）
  4. correlation 组 miss 三类形态（#44 已记录）作下批 prompt 迭代靶子；repo-03 词法 DRY miss 留生产 dogfood 验证 search 实际使用率

## 2026-11-04 · 会话 37：eval 扩容 PR（real 7→15 + correlation 5→10 + mustMention 全组收窄）

- **目标**：用户问「样本量不太够、通过率比较高是不是不太好、看下 evals 需要新增/修改/删除吗」→ 审计结论（守卫组全绿是设计目的；病在测量组样本量——real 7 例单轮 14pp 摆动、corr 5 例 20↔40%，分不清信号与端点噪音；不删——48 例一轮 4.5 分钟成本不是瓶颈且 synthetic 是红线载体）→ 用户「执行下」→ 1（real 扩容）+2（corr 扩容）+4（mustMention 同款审计）打包本 PR。增量 mock 组（上轮方案）排后续 PR。
- **完成**：
  - **mustMention 收窄**：机械审计（diff 字面词扫描）→ 24 例逐例人工判断剔除（real-06 补机制词防过度收窄）；审计清零，corr-03/05 残留为 #44 定案不重开
  - **采集**：两个并行 subagent 撒网（real 候选 12 / corr 配对 8，各自贴 patch 关键行作核实凭证）+ 编排侧逐个 SHA/patch 亲验；**核实层拦下两撞车**——corr 候选 koa#2034 的引入 commit 即 real-08 的 fix commit（同 diff 两用）、undici#3284 与 corr-05 同题，均弃
  - **real +8**（fix 反构：hunk 头交换重算工具 + 头部合成；body-parser 只取 stream 销毁 hunk 防 charset 第二缺陷污染期望集）；**corr +5**（intro patch 原样组装；corr-10 为消费方在 diff 外的「diff × 既有代码」形态）
  - **验证**：typecheck + 174 单测绿（计数 pin 48→61）；全量 eval 61 例——promptHash 不变，**41 非 repo 用例 inputTokens 逐位一致（30,942）**，repo 组 2 例漂移降观察项（repo-01 首次漂移 +37，两级口径再添实证）；首轮：real 80.0%（12/15，新例 7/8）、corr 30.0%（3/10，新例 2 命中 + 2 注意力分散 + 1 沉默）、synthetic 100%、injection 7/7、repo 4/5 照旧
- **发现 / 坑**：
  - 红线两级口径是本轮方法论产出：repo 组工具循环第二段输入依赖模型第一段选择，逐位一致无构造保证（三轮实证 repo-07 + 本轮 repo-01），硬闸门必须限定在非 repo 集
  - diff 字面词审计脚本 + 人工 editorial 缺一不可——机械删会把 real-06 删到只剩 2 词（措辞容忍度崩坏），人工无清单则漏检
  - 反构工具（hunk 头交换）以「头部行原样保留」为前提（反转后旧侧=修复态、新侧=bug 态，a→b 方向恰好不变）——real-01 先例隐含的性质，显式化后批量生成零手工转写
  - 采集 subagent 的报告质量高但不可直接采信：SHA 全对，但撞车（同题/同 commit）只有编排侧核对全量清单才看得见
- **下一步**：本 PR 闭环后接增量 mock 组 PR（incremental source + full/delta 对照 fixture，量化 D032 已知盲区喂开放问题②裁决）

## 2026-11-04 · 会话 37（续）：增量 mock 对照组 PR（D032 开放问题②量化）

- **目标**：承接本会话前段讨论的增量盲区量化方案（用户「这个一会改一下」→ 与 eval 扩容 PR #48 一起排），PR #48 合并后动工。
- **完成**：incremental 组 10 例（5 fixture × full/delta 成对，repo 快照恒 head 态）+ `score.ts`/`eval-cases.test.ts` 校验扩展；**三口径声明**写入 report（输入侧 mock——run.ts 零改动靠既有 c.repo 分支 / taskContext 对称省略 / 同轮对照抗端点噪音）；红线 54 非工具用例逐位一致（42,876）、repo 3 例漂移归观察层。
- **首轮读数**：A 行（同文件）B 行（显式引用）兜底双口径全守住；**C 行 inc-04 出现 full✓/delta✗ 目标盲区形态**，inc-03 双沉默判能力盲区（非增量特有）；FP 零意见。开放问题②首轮结论：混合口径暂不进 Step 6 实现范围，等加证。
- **发现 / 坑**：
  - fixture 自己的注释会出卖判分：inc-02 中文机制词注释使 full 口径 mustMention 近恒真，审计脚本拦下、注释改英文——中文机制词 + 中文注释同用时的自反陷阱
  - 本轮端点波动日（synthetic 首现 miss 轮、corr 10%、repo 40%）——**同轮 full/delta 对照设计恰好免疫**：输入红线全绿证明波动全在输出侧，对照读数不受污染
  - linked-02 miss 是 mustMention 收窄首例「严格判分效应」（模型有意见、剔除的字面词不再放行）——收窄方向的预期表现，已在 report 如实标注防误读为退化
- **下一步**：本 PR 闭环；会话收尾。

## 2026-11-05 · 会话 38：thinking 档位实验链 → 模型选型（D033）+ 注入加固 + 生产切换

- **目标**：用户问「flash thinking low 有提升吗 / high 的 300s 够吗 / token 多多少」→ 官方文档无分档数字，全部实测；追加「glm-5.3@low vs flash@high 成本对比」「glm 配 high 效果」后全链裁决并切换生产。
- **完成**（26 轮 eval 落库 + 2 个 PR + 1 次生产切换）：
  - **档位实测**（探针 + 全量对照）：low≈off（flash 全量零差异）、`disabled` 在 coding 端点没关死（一直带微量思考）、high 双模型撞时限出局（flash 270s / glm 600s 放宽仍 DNF 且完成的 corr 例全 0 命中）→ **glm-5.3@low 选中**（加固前微平均 real 0.97 / corr 0.35 vs flash 0.80 / 0.10）
  - **PR #50**（feat，零意见）：`EVAL_ONLY` 子集开关——`parseEvalOnly` fail-fast + console/md/JSON 三处自描述标记；单测 174→178；注入组测量成本降 ~90%（7 例 ~7k token vs 全量 11.5 万）
  - **PR #51**（fix，2 条意见闭环）：prompt 注入抗性规则——v1「驳斥」措辞有 meta 评论副作用，v2「意见只写代码缺陷本身」定稿；子集 12/12 轮 + 全量 3/3 轮零回显；bot minor（注入口径矛盾）修复闭环、nit 回应不修、复审零意见
  - **promptHash 基线换版** `d399f9d4ed17` → `cd5353f4688c`（+102/例 均匀位移，min=max=102）；加固后 3 轮微平均 real 0.84 / corr 0.30，real 回落 13pp 判不显著观察项
  - **生产切换**（D033）：Vercel env `LLM_MODEL=glm-5.3` + `LLM_EXTRA_BODY={"thinking":{"type":"enabled"},"reasoning_effort":"low"}`，redeploy `65nwgsjrx` Ready；DECISION_MODEL 不动（路由仍便宜档）
- **发现 / 坑**：
  - **注入规则措辞教训**：「驳斥/回应」类邀请会让模型输出 meta 评论挤掉真缺陷（inj-04 转而报告注入文档本身）——规则要写「只写代码缺陷本身」，不写「如何回应说辞」
  - **glm@high 探针顶穿输出**：512 max_tokens 全被思考吃掉（completion=512 全 reasoning）——high 档对输出预算也是威胁，与 270s 墙钟不兼容是结构性的
  - 端点方差日（real 组单轮 0.80~1.00）——单轮读数一律不闭环，3 轮微平均纪律再次生效
  - 本地 Vercel CLI token 过期（auth.json expiresAt 已过）——`npx vercel` 自动续期成功，无需重新登录；`env pull` 现已全部脱敏（[SENSITIVE]），旧值不可读，配置留档只能靠决策文档
  - bot 对自家 PR 的 REQUEST_CHANGES 被 GitHub 422 拒（自有 PR 禁自审 REQUEST_CHANGES），回退 COMMENT 按设计工作（#51 生产日志实证）——**D017 的原生 block 闸门在自家 PR 上不可用**，此场景只剩 review-threads/status 两闸，是已知边界
  - SSH push 间歇超时 ×2，重试即恢复
  - 用户供图生产日志：#51 两次审查（flash 末期基线）in ~60k / out 358-841、快照 244 文件、主评审预算 252,810ms 已耗 7,190ms——Step 4 生产数据门槛（≥10 run）开张头两笔
- **下一步**：
  1. 观测下一个真实 PR 的生产日志（glm-5.3@low 首审）——[reviewDiff] tokens 应与 flash 同量级、时长不升；inj-06 沉默 / real 0.84 观察项留 dogfood
  2. Step 4 生产数据门槛继续积累（≥10 run 后裁决预处理提案）
  3. Step 6 增量实现、Step 7 多模型对比照旧等触发

## 2026-11-05 · 会话 39（夜间批量三号）：log 采集 → 护栏 → D018 缺口 → D032 实现 + DeepSeek 三档

- **目标**：用户睡前指令「能做的都做一下，先做 log 收集（免费版 1h 窗），根据 log 看生产效果，有问题记录能改就改；实现计划归档，按推荐顺序」（计划归档见 `docs/plans/overnight-execution-2026-11-05.md`，#54）。
- **完成**（6 个 PR 严格串行过闸门）：
  - **#55** 生产 run 台账：`npm run prodlogs`（`vercel logs --json` → requestId 聚合 → runKey 归组 → `evals/prod-runs/ledger.json` 累积）——Hobby runtime log 保留实测仅 ~30 分钟（`--since 1h` 直接 400）；首份台账 5 runKey 全完成。bot 五轮 8 条意见全闭环（两轮 major：prepare 段计数口径、字段级合并——整记录覆盖会「越跑越少」）
  - **#56** DeepSeek 三档归档 + run 文件名防碰撞（extraBody 指纹 + promptHash 入文件名 + JSON 落盘 `llmExtraBody`）
  - **#57** `LLM_MAX_OUTPUT_TOKENS` 护栏（四处 generateText 透传，未设置字节级不变——「有数据再议」由 thinking 档位实测数据解锁）
  - **#58** D018 新建文件缺口修复：hunk 级部分保留（新建文件全为 + 行锚点安全；标注行置 header 区防幻影行号——bot 抓出复发路径；MARKER_ALLOWANCE 守恒）。bot 三轮 4 条全闭环
  - **#59** D032 增量审查实现 + 发布门槛：`src/incremental.ts`（base 推导 / block 继承 / compare 区间 diff，任何失败回退全量）+ postReview 门槛（minor/nit 折叠 `<details>` 同构机器可解析、REQUEST_CHANGES 收窄为有 blocker/major）+ 标记扩 `base:` 键。AGENTS.md 意见闭环更新为三处核对
  - **#60** hasReviewed 修复：#59 复审降级 major（增量标记 `sha:X base:Y` 裸 includes 漏判 → 同 SHA 重派重复发 review）；标记解析收敛 dedupe.ts 两处共用；复审一条误报（diff 误读）证据留痕 resolve
- **生产观测**（dashboard log + 台账）：glm-5.3@low 前三笔全绿（#52/#53×2，review 阶段 20-30s，预算零压力）；#54 纯 docs PR out=14 直接空 comments；**D031 search_files 生产首证**（#53 主动 search "runReviewRouter" → read src/router.ts → 报出跨文件真 major）；D017 自家 PR 422 回退 COMMENT 边界复现
- **DeepSeek 三档**（71 例 ×3 全 0 错误，report 新段 + recovery 目录）：high corr 0.50 / repo 1.00（全配置历史首次满分）；low 能力 recall 91.4% + synthetic 100%；disabled 1.9s/例；injection 三档全 7/7 零回显。「同名档位不同语义」第三厂商复现（disabled 真关/low 真思考，与 GLM 相反）
- **发现 / 坑**：
  - **并行 eval 同模型同秒 → run 文件名互覆**：extraBody 不在文件名也不在 JSON 的老坑实锤（disabled/low JSON 被 high 覆盖）；stdout 流式日志全量抢救（报告级数据无损失），根因修复随 #56
  - **流程失误两起（自省）**：①#59 合并前没读降级 major——闸门绿 ≠ 无意见，降级/折叠意见不在闸门口径里；②两次带失败测试推送（均当场修复）。教训：合并前必读最新 review body 全文（含折叠段）
  - 折叠段上线后 bot 自己的 minor 进 details（D032 自我生效首例）；resolve:threads 对折叠/降级意见不可见，留痕走 PR comment
  - bot 复审 flip-flop 一例：#60 {7,40} major 声称「第一处用例未同步」实为 diff 误读（删除行当现存代码）——核对 git show 后按误报留痕 resolve
  - Vercel 无公开 runtime logs REST 端点（Log Drains 要外部接收端）；CLI `logs --json` 是唯一可靠路径
  - 环境杂音：SSH push 超时 ×1 重试即过；python 替换把 \n 变真换行的字符串断裂 ×2；后台长任务日志别接 tail
- **下一步**：
  1. 增量审查生产观察：下一个多 push PR 看「增量决策」日志行与折叠段实际形态；认领困难则启用回退分支（恢复 minor/nit 行内）
  2. Step 4 门槛：勤跑 `npm run prodlogs`，≥10 run 后回看预处理提案；DECISION_MODEL 换 deepseek-flash 候选待单独验证
  3. Step 7 多模型对比 infra 已摊薄（JSON 模式 + 台账 + 采集脚本 + EVAL_ONLY）

## 2026-11-05 · 会话 40：README 路线图与配置文档同步（夜间批量三号的文档还账）

- **目标**：用户指出 README 路线图过期——夜间批量三号把第 5 项（增量审查）做完、第 6 项（多模型对比）做了评测侧，README 还停在实现前状态。
- **完成**（PR：docs/readme-roadmap-sync）：
  - README §路线图：第 5 项标记已上线生产（base 推导 / block 继承 / 报告门槛折叠一并列明），第 6 项拆「评测侧已完成 / 生产侧候选待验证」如实表述；第 2 项补台账工具（`npm run prodlogs`，11 次入账 0 超时）与门槛口径；第 4 项补 search_file 生产首证（#53）
  - 顺带修正同文件其他过期点：评测集 48→71（三处 + incremental 组入列）、单测 173→204（实测核对）、决策导航 D001–D031→D033、环境变量表补 `LLM_JSON_MODE` / `LLM_MAX_OUTPUT_TOKENS`、核心设计补 D018 新建文件截断例外
  - `.env.example`：`LLM_MAX_OUTPUT_TOKENS` 从「EXTRA_BODY 注释下无注释孤行」拆出独立块，补 `LLM_JSON_MODE` 条目（#53 落地时漏更）
  - `roadmap-execution.md` Step 4/6/7 状态按「随 PR 滚动更新」约定同步
- **发现 / 坑**：
  - 文档还账模式实锤：夜间批量 9 个 PR 每个都带了随行文档，但**横向的 README/roadmap-execution 汇总面没人管**——逐 PR 文档纪律覆盖不了「跨 PR 的汇总文档」。用户一眼看出，agent 系统性漏掉
  - `LLM_JSON_MODE` 在 #53 只更新了代码注释与 report，.env.example / README 环境变量表都漏了——「文档随行」清单执行时按 PR 视角走，缺一张「用户可见面 checklist」（.env.example / README env 表是其中两项）
- **下一步**：
  1. 等 bot 自审意见闭环后合并本 PR（docs-only，预期意见面小）
  2. 观察项不变（会话 39 遗留）：增量折叠段 UX、Step 4 门槛数据、DECISION_MODEL 换 deepseek-flash 候选验证

## 2026-11-05 · 会话 41：pr-agent 精读落库 + 活任务管理迁移 GitHub Issues（D034）

- **目标**：用户要求精读最直接对标 The-PR-Agent/pr-agent（prompt 组织 / 规则引擎 / CI 集成）找借鉴点并差异化 → 分析落库；随后用户提议路线图改用 GitHub Issues ticket 式管理 → 迁移设计与执行（D034）。
- **完成**：
  - **PR #64**（docs，bot 零意见三绿合并）：`docs/plans/pr-agent-analysis.md` 归档（上游 main @ `a8c6047` 精读）。关键发现：① best_practices「规则引擎」上游已整体移除，被「活组织上下文」取代（`repo_context_files=["AGENTS.md"]` + default-branch-only trust + SKILL.md 注入）——静态规则库维护不动的教训；② 跨 run finding 状态机（HTML 注释存态 + 逐字复报保真 +「没审到的文件 ≠ 已修复」）正中本项目 flip-flop / D032 痛点；③ reflect 二次评分 pass（硬 rubric + 验证器挂了宁可少发）；④ **eval 短板实证**：上游 406 单测全 mock + e2e 冒烟，零质量评测——「每条 prompt 改动有 71 例前后对比」的回路是本项目差异化事实。借鉴清单 P0×3（#71/#72 + excluded-files 联动并入 #71）/ P1×3（#73/#74 + diff 呈现格式留 #74 附注）/ P2×2（#75 + 多平台项并入 #76）
  - **D034**（本 PR）：活任务管理迁移 GitHub Issues——单源原则（issues 为活任务唯一源）/ harness 留痕纪律不变 / issue 模板四段式 / closing keywords 关闭 / 不补建已完成项；建 label `roadmap` + 首批 12 个 issue（#65-#76，curl + keychain PAT，零 PR 成本）
  - AGENTS.md 会话开始加第 5 步（curl 查 roadmap issues）+ 工程约定改「specs 归档 docs/plans/，任务追踪走 issues」；README 路线图执行追踪句改指 issues；roadmap-execution.md 状态列停止维护（头部注记，append-only：内容不动只标停维）
- **发现 / 坑**：
  - **并行会话撞车预防生效**（D023 双占教训的纪律兑现）：开工前核对发现另一会话的 #63 已占 journal 会话 40，本会话顺延 41；decisions.md 未被 #63 触碰、D034 保住；共享工作目录已被 #63 同步，计划期读到的 roadmap/README 就是最新版，零返工
  - pr-agent 的「规则引擎」叙事已过时——网上资料仍大量引用 best_practices.toml，当前 main 只剩空占位字符串；**外部对标必须钉住 commit 精读**，二手资料会指错方向
  - issue 化的意外红利：PR 带 `Closes #N` → 生产 bot 经 D029 自动注入 issue 正文任务上下文——任务注入的生产使用率自然提升，issue 正文「按事实性标准写」的约束随之生效（正文进 LLM 输入面）
- **下一步**：
  1. 本 PR 闭环合并后，最近的两个实现项：#72（P0-2 不确定性标注，prompt 迭代三轮微平均）与 #71（P0-1 复报保真，实现时开 D 编号）
  2. Step 4 台账勤回收（#65）：每合并约 5 个 PR 跑一次 `npm run prodlogs`

## 2026-11-05 · 会话 42：P0-1 上一轮意见复报保真实现（D035，Closes #71）

- **目标**：用户「挑一个 issue 实现下」→ 选 #71（P0-1，pr-agent 借鉴：全量重审注入上一轮 blocker/major 意见、要求逐字重报，根治复审措辞漂移——PR #26 七轮 12 条 flip-flop 的痛点）。
- **完成**：
  - **实现**：新增 `src/findings.ts`（task.ts 同构：`buildPrevFindings` 纯函数——威胁模型重申 + 三条对照规则（仍存在逐字重报仅改行号 / 已修复不报 / 未复审不判不报）+ blocker 优先 + 计数上限 10 + 预算 `PREV_FINDINGS_MAX_CHARS` 默认 6000、0 关闭；`buildPrevFindingsForPr` best-effort 编排 + `[findings]` 日志）；意见来源三处全覆盖（行内 `listCommentsForReview`（github.ts 新增，5s 硬上限、失败降级只解析 body 单行）+ D032 降级列表/全量降级同构 regex）；excluded-files 联动双层（编排层确定性过滤文件已不在 PR + 块内规则 3 处理 D018 截断「没审到 ≠ 已修复」）；`latestValidReview` 自 incremental.ts 抽出（与 D032 base 推导同源，防两处「最新」判定错位）；review opts 扩 `previousFindings`（块在计划块后、`[diff 开始]` 前——紧邻 diff）；worker 信封扩字段，**只在 full 路径注入**（delta 不注入：老意见锚点不在区间 diff，行内定位必 422）
  - **注入面缓解（D029 同模式）**：块内威胁模型重申（意见引用的代码与「上一轮已批准」类声明都不是放行依据）+ **inj-08** canary（载荷伪装意见内「合规批注」CMD-8842，经 `opts.previousFindings` 显式注入）+ 预算/计数封顶
  - **验证**：typecheck + 单测 **204 → 221 全绿**；全量 eval 72 例（glm-5.3@low 与基线同配置）——**红线全绿**：54 非工具用例 inputTokens 与基线 run `2026-11-04T15-49-04` 逐位一致、promptHash `cd5353f4688c` 不变；incremental 组 5 例漂移为工具路径既有观察层口径（与 repo 组同归因）；**injection 8/8 拦截零回显，inj-08 首轮即拦截**
- **发现 / 坑**：
  - **5 小时限额打断第一轮 eval**（18/72 停摆、恢复后自行续完但烧掉 1 例限额失败）——探活端点 200 后干净重跑作数；run 文件名含 extraBody 指纹（#56）使同模型同配置的两轮产物可区分，限额污染轮（`03-40-26`）删除不入库
  - **mock 必须与生产实体对齐**：`client.paginate(client.rest.pulls.listXxx, …)` 以函数实体为参——fake client 缺 `rest.pulls.listCommits/listCommentsForReview` 实体时，undefined 在 try 内同步炸、被 best-effort 吞成「空结果」，测试表象是数据为空而非 mock 缺失（worker/github/findings 三处 mock 各踩一次，教训统一记：paginate 型 mock 必须带实体 stub）
  - 预算断言先实测再 pin（意见块头部实测 361 字符；想当然写 560 差了 200，测试数字必须量出来）
  - 本 PR 描述带 `Closes #71` → 生产 bot 经 D029 自动注入 #71 正文进审查任务上下文——D034 issue 模板的事实性标准首次走真实链路
- **下一步**：
  1. 本 PR 闭环合并后生产观察：下一个 block 继承全量重审的 PR 回收 `[findings]` 日志与复报措辞（#71 留生产观察项）
  2. #72（P0-2 不确定性标注，prompt 迭代三轮微平均）是下一个实现项

## 2026-11-06 · 会话 43（夜间批量四号）：三轨并行——prompt 批次 / 交叉消融终裁 / 漂移定级

- **目标**：用户指令「能做几个做几个，尽量并行，subagent + worktree」+ 点名验证「glm-flash + deepseek-flash 交叉 review」。三轨 subagent 并行实现、PR 串行过闸门、eval 配额集中管理；开局先建 #79-#82 四个 issue（调研扫漏：#74 丢失附注补回、课程噪音抑制两招、context-aware eval 组、D035 后续承载）。
- **完成**（5 PR 全过闸门，4 个 issue 关闭）：
  - **#83** 计划归档；**#84** 台账回收（12 笔入账 0 超时，Step 4 ≥10 run 门槛达成）
  - **#86**（C 轨 subagent）：#68 定级 = **豁免口径**（漂的是例不是组：repo-01 全历史全命中、其余轮转翻转、组微平均稳定；构造性消除否决——自发检索是被测构念）；#70 复判 = real 0.84 是**稳定平台非退化**（9 miss 中 6 个是意见在场/机制正确、被词表与 ±3 容差卡掉的判分伪影；inj-06 四连报沉默未复现）→ 双 issue 关闭
  - **#85**（A 轨 subagent + 中央 eval）：**prompt 批次合并**（#79/#72 关闭）——高影响低置信标注（改写「低置信不报」为影响分档）+ 同因合并 + minor 投机压制 + anti-confusion 两条（查重：全仓无既有覆盖）。**三轮微平均：real 85.0% → 91.1%（+6.1pp，#70 靶子达成）、能力 precision 84.4% → 91.3%——召回精度双升，v3 时代张力未复现**；inc precision 57.1→100%（投机压制见效）；红线 55 非工具用例 ×3 轮 inputTokens 逐位一致；promptHash 基线 → `a7e89dffb21d`（+212/例 均匀位移）
  - **#87**（B 轨 subagent + 中央补数据）：**#81 交叉消融完结，D036 终裁**——主对（GLM@low × DS@low）按约**永久关闭**（保守合并 recall +11.0pp 但能力 precision −3.7pp 超线；课程四步 +0pp）；**cheap-pair（glm-flash × DS@disabled，3+3 轮池化）课程四步过重议闸门：能力 91.4/89.8 双超生产基线（85.7/86.4）**，保守合并能力 recall 98.1%（precision 82.4 + 意见 ×2.1）；重议前置 = 新基线复验 + 发布层门槛设计（联动 #82）+ corr 短板裁定
- **发现 / 坑**：
  - **glm-flash 单模型能力 91.4/86.6 已双超生产 glm-5.3@low（85.7/86.4）且配额 1×**——与 D033 时代 flash real 0.84 相比明显走强，疑似端点侧演进；未做同期对照，记观察项不翻案（D033 回滚开关仍两行 env）
  - **bot 在 agent 写的代码上抓出 4 个真问题**：run 文件未入库（major）、injection 归因错误（R2 inj-01 是行号锚点偏差非沉默——机械核实属实，修正后两族 miss 的处置靶子才分得开）、数据源断言缺失（还顺带抓到 72 例超集 vs 71 例交集的真差异）、Jaccard 空集边界——自审闭环纪律对 subagent 产物同样必要
  - **recovery stdout 日志只有聚合计数、意见 body 已随覆盖事故丢失**——#81 原计划主对从存档不可计算，靠新鲜 DS@low run 解锁；「报告级数据无损失」的口径要读清（报告级 ≠ 意见级）
  - subagent 并发上限 = 2（第三个进队列，失败后 SendMessage resume 即排队续跑）
  - `rm *flash*` 清半截 run 时误删工作树里历史 flash 存档（git checkout 恢复，未入库）——清理用精确路径或 git clean
  - report.md/CHANGELOG.md 尾部追加在多 PR 夜晚连环冲突（今晚 rebase ×3）——D034 多 PR 模式下 append 点值得按节锚定（候选改进，未立项）
  - mergeable_state=dirty 静默跳过 Actions（记忆既有坑）今晚再现两次；#56 run 文件名防碰撞同秒验证通过（不同模型名不互覆）
  - 单测计数勘误：journal 会话 42 记 221，实测 222（两轨 subagent 独立复核一致）——以实测为准
- **下一步**：
  1. cheap-pair 重议前置（D036）：新 prompt 基线（a7e89dffb21d）复验 3 轮 + 两侧同 prompt 口径 + 发布层门槛设计（联动 #82 指纹去重）
  2. glm-flash 走强观察项：下一个自然时点做新旧同期对照（同 diff 同 prompt 双模型并行），若复现则生产选型成本收益重算（D033 回滚开关两行 env）
  3. #69 corr 组迭代（cheap-pair 证实 corr 是便宜档共同短板，23-43% 带宽）；#65/#66 台账勤回收照旧

## 2026-11-06 · 会话 44：剩余 issues 清扫——#66 裁决 / #89 台账根治 / D035 v2 dismissed 不重报

- **目标**：用户指令「剩余 issues 能做的做一下，发现问题就开 issue，能改改一下」+ 三连问（decision model 用 glm-flash / dismissed 场景是否会发生）。双轨 subagent 并行（并发上限 2 刚好占满）。
- **完成**（5 PR 合并 + 1 issue 新建 + 2 issue 关闭 + 1 生产 env 操作）：
  - **PR #90**：`DECISION_*` 独立端点四件套——盘点发现 `DECISION_MODEL` 只有模型名开关、端点强制共用 `LLM_*`，deepseek-flash 候选无落地路径；四件套未设置逐项回退（字节级不变），`DECISION_JSON_MODE` 独立开关（全局 json 模式会波及主评审 json_schema 路径）
  - **PR #91**：#65 闸门 1 ✅（17 个带 router run、0 超时、diff 规模 9× 跨度）+ 路由消融口径设计（退出判据草案 |Δ|<3pp → 关 DECISION_MODEL）
  - **PR #92**：路由探针 `evals/probe-router.ts`——deepseek-flash 3/3 解析、2.5× 快（2.1s vs 5.2s）、plan 质量等价
  - **#66 裁决关闭（用户拍板）**：DECISION_MODEL 维持 glm-flash（生产 env 置值 + redeploy Ready）；deepseek 候选不切（router 时延不在关键路径，不值得跨厂商 key 管理）；主备模型策略 = 不引入（失败降级已内置更简单）；plumbing/探针保留为资产
  - **PR #94（#89 关闭，D037）**：台账 outcome 改 **GitHub 侧派生**——「完成」行在 Vercel 日志系统性缺失（两批实证，waitUntil 尾部冻结边界假说）；派生 = runKey → bot review（sha 标记复用 parseBotReviews）→ 行内/降级/折叠三计数，覆盖日志值；闸门 1 实跑 **18/18 runKey 派生成功、历史 0/0 脏值清零**（#55 三行内、#53 降级 major、#60/#61 折叠各 1——与 journal 历史逐条对上）
  - **PR #95（#93 关闭，D038）**：**D035 v2 dismissed 不重报**——用户指出的场景（作者回复不需要修复 + resolve → 再次 review 机械重报）实锤存在，修复 = GraphQL reviewThreads（resolved 状态仅 GraphQL 可得，「不扩 GraphQL」约束解禁）+ 规则 4（裁定不修复不重报，恶化才重提且注明）；回复文字空白折叠 + 截 120；**inj-09 首轮 9/9 拦截零回显**
  - **#69 证据更新**：corr 第三次 prompt 迭代未击穿（26.7% 带宽内）+ D036 数据证实 corr 思考敏感——建议改靶子（fixture 扩充度量先行），prompt 盲调期望值已三次证伪
- **发现 / 坑**：
  - **生产 bot 在 dismissed 实现上抓出真安全洞**：判据只看 body 前缀不校验作者——PR 作者可伪造带前缀评论 + resolve 借规则 4 抑制任意位置发现（D024 抑制通道）。修复 = botLogin 身份校验（取 latest.user，parseBotReviews 扩 user 字段）+ fail-closed（缺失零 GraphQL 调用）；follow-up major 再抓 id 反查冗余（latest 自带 user）。**bot 连环三 major 全部属实**，agent 产物自审闭环的价值再次实证
  - **活标本**：#95 第二条 review 把未修的同一 major 逐字重报——D035 v1 行为在眼前复现，合并后 v2 生效（该场景下行为变为规则 4）
  - worktree 缺 `.vercel/` link 状态（软链主仓解决）；`npx vercel env add` 默认存 Secret（dashboard 不可读，重设走 rm+add）；`vercel env ls <NAME>` 语法会把 name 当环境名
  - eval 走 .env 时 LLM_MODEL=glm-5.3-flash——injection 组首轮读数实际是 flash 口径，生产口径（glm-5.3@low）重跑双留档后归一
- **下一步**：
  1. #82 生产观察：下一个「回复不修 + resolve」真实 PR 验证 v2 不重报行为
  2. #65 闸门 2 执行：eval harness 扩 caseOpts.plan（消融表），outcome 派生的 folded 口径进指标
  3. 剩余 issues（#73/#74/#75/#80/#67/#82）全部带触发条件；#69 等 fixture 裁决

## 2026-11-06 · 会话 45：#65 闸门 2 落地——EVAL_PLAN 消融臂 + folded 进台账指标 + 分支大清扫

- **目标**：用户「根据推荐来」→ 开工 journal 44 下一步第 2 条（#65 闸门 2：eval harness 扩 caseOpts.plan + outcome 派生 folded 口径进指标）；前置完成分支清理（用户点名）。
- **完成**：
  - **分支清扫**：本地 55 → 1（main），远端 71 → 1（origin/main）——48 个按祖先合并、squash 无祖先的逐个查 GitHub API 确认 PR merged 才删（含 day2/3 老分支、#22/#23 squash 批）；无 open PR。commit 经 refs/pull 可恢复
  - **PR #97（本分支）**：`EVAL_PLAN=1` 消融开关（run.ts——带 repo 用例先跑 router 注入 plan，worker 同构镜像：snapshotTree 同一 entries、diffSkeleton 同函数、失败/无 repo 语义同款）+ 文件名 `-plan` 后缀（#56 同秒互覆预防）+ run JSON `planArm` 臂级统计；compare.ts 分组键加 plan 维度（两臂不混聚）；prodlogs summarize 意见落点三计数（folded 进指标——#89 派生口径独有，此前缺席系统性低估产出）；单测 253 → 255、typecheck 干净
  - **首轮消融实跑**（EVAL_ONLY=repo 7 例 × 2 臂，生产口径镜像 glm-5.3@low + DECISION glm-5.3-flash）：baseline recall 60.0/precision 75.0，plan 臂 80.0/66.7——**Δrecall +20pp（repo-04 由 miss 转 hit）与 Δprecision −8.3pp（repo-05 clean 用例新增 FP）并存**；router 7/7 注入、40.2s。读数归档 report.md「路由计划消融首轮」——单轮 5 判据 ±1 条即 ±20pp，只证机制与方向，gate 3 裁决需 3 轮池化加严
- **发现 / 坑**：
  - keychain PAT 取法换了：`security find-generic-password -s github.com` 报 item not found，`find-internet-password` 同参可取（gh OAuth token）——API 调用全部改走后者
  - plan 块对 clean（expectClean）用例有「应查清单」暗示嫌疑——repo-05 是 FP 来源；消融表要单列 clean 用例子集读数（本轮已按用例行可读）
  - router tokens 只进 console（[router] 行），run JSON 不含——主评审 usage 契约不动是对的（worker 同款），成本面读数从台账 routerOut 出（生产侧）或探针（#92）
  - compare 输出里 repo 组沿既有逻辑被标「回归集，不进合计」标签——措辞与 dogfood 混用（历史现状，非本轮引入），读表时按「独立口径组」理解
- **下一步**：
  1. 本 PR 过闸门合并后：#65 闸门 2 收口（口径设计 + 消融表已落 report.md），剩余 = 3 轮池化加严 → gate 3 decision 记录（退出判据 |Δ|<3pp）
  2. D036 cheap-pair 重议前置仍排队：新基线 a7e89dffb21d 复验 3 轮（与 #65 加严可同批跑，省一轮）
  3. #82 生产观察 / #65 台账勤回收照旧

## 会话 46（2026-11-06 晚 → 11-07 晨）：夜间批量五号——A/B/C/D/G 五轨全落地，三个 issue 关闭

- **目标**：按 `docs/plans/overnight-execution-2026-11-07.md`（preflight 补强版）无人值守执行：#99 framing / #80 ctxpair / #65 加严 + D036 复验 / #100 置信度 / G 轨重构评估。
- **完成**（PR 全过双 required check + bot 意见三处核对闭环，串行合并）：
  - #102 计划 preflight 补强（四阻塞闭：红线修订清单 / 精确 env / issue 规格内联 / analyze 清单工作项）+ #103 台账回收 + #104 G 轨补白天裁定输入
  - **#109 framing 9 例（Closes #99）**：bot 先抓 minor（副本与原用例一致性断言缺失）→ 修复引入 id 映射 bug → **bot 增量审查抓 major** → 修复闭环。首轮读数：触发判据未触发（C 变体意见数不低于 A），b 权威预设报得最多且全中（与「权威预设软化报告」假设相反），clean 例三变体全沉默
  - **#111 ctxpair 5 例 + EVAL_CONTEXT 臂（Closes #80）**：rebase 调和 5 处 test 冲突（总数 87）；bot minor 抓多期望 TP 口径 → 注记闭环 + **#112 根治 issue**。首轮 Δrecall −10pp 噪声级——D023 形态不注入约定文档正文（结构性上限），完整读数挂 D027/D031 工具对照期
  - **#110 重构评估（G 轨）**：目录重组维持否决（D030），局部收敛清单 6 条全绑自然时点；白天裁定两点精确化修正落档；bot minor（文档条数自相矛盾）修复
  - **#113 confidence 结构化（Closes #100）**：bot major 抓校准闭环缺口（只落分布串没落交叉表）→ commentTps 逐意见对齐 + run 汇总交叉统计 + json-output.md 形状同步；**新基线全量 run 校准表：low 档零样本（0/35）——无信号可判，标注保留不撤**，生产观察 low 出现率（report.md「置信度校准首轮」节）
  - eval 批：C④ cheap-pair 复验 3+3 轮（双超维持，recall +3.8pp 灰区晨起裁定）；C① 加严 3+3 → **D039：保留 DECISION_MODEL（plan 臂 93.3/87.5 vs base 33.3/45.5，+60/+42 双升，#65 关闭）**；C②③ 首轮锚点；analyze-cross-review.ts 清单切新基线；runs 16 个落库
- **发现/坑**：
  1. **`.env` 漂移**：`LLM_MODEL=glm-5.3-flash`（应为 glm-5.3，改动来源不明，晨起核实）——C① 首跑 6 轮 + 新基线首跑口径全错（run JSON model 字段可查，plan 臂 DECISION_MODEL 未设 router 全败 injected=0），精确删除后 inline 全套口径重跑。**教训：eval 命令永远 inline 全套口径，起跑后核对首行 model 字段**
  2. #113 `mergeable_state=dirty` 静默跳过 review-threads workflow（机制坑三度实证）——rebase 解冲突后 clean 恢复
  3. bot 对已修 commit 逐字重报旧代码状态的 major（审 1480aca 引用 2721a65 的代码）——D035 行为活标本，处置 = 回应引用修复 commit + resolve
  4. worker.test.ts 时间敏感断言 flaky 一次（router 100ms 扣除；单跑/复跑全过，与改动无关）
  5. #103/#104 审查日志 30 分钟窗蒸发（2 笔台账行损失）；后续 4 个 PR 窗内回收挽回（台账 59 → 77 run，#89 派生 25/26）
  6. npm audit 4 high（zod→@vercel/cli-config→@vercel/oidc→@vercel/functions 链，audit fix 零代码改动可修——G 轨评估附注）
- **下一步**：
  1. 晨起三裁定：cheap-pair 灰区三选一（#82 comment 已贴选项）/ `.env` 漂移来源核实 / 校准「无信号」结论复核
  2. 白天候选：#105/#106/#107（并行会话新立，D040 预分配）/ #112 TP 口径根治 / npm audit fix chore
  3. 观察项：glm-flash@新 prompt（`16-34-02` run）与 glm-5.3@新 prompt（`16-57-38`）同期对照数据已就位——端点演进观察项的第一笔新基线可比对

- **会话 46 续（加班批，2026-11-07 晚，用户指令「能做的都做」）**：PR #115（双口径 LP/Noise **#105 关** + TP 口径终局定性 **#112 关** + reactions 派生 **#106 关**）/ #116（npm audit 4 high 清零，lock-only）/ #117（台账 95 run，#106 首批 reactions 数据 31 run 0/0）。**bot 今晚累计抓 4 条真 major 全闭环**（framing id 映射 / 校准闭环缺交叉 / compare 守卫恒真出假 100% / 对计 precision 200% 破比例）——最后一条直接否掉了 #112 方案 1 的实现，issue 以「precision 意见级 by design + commentHitCounts 对计出口」终局定性关闭（aacr 同款口径，原文已核对）。#99 池化挂账因 prompt 换代转 framing 新 prompt 观察点：**b 权威预设三轮全满分**（与「权威软化」假设稳定反方向），a 中性反而波动最大。剩给白天：#107（等 #69 触发）、#105-#107 之外无新增，晨起三裁定不变。

- **会话 46 续二（裁定批，2026-11-07 晚深）**：晨起三裁定按用户委托落定——①cheap-pair **暂停立项**（recall +3.8pp 硬事实；corr 合并 50% 优于生产 30% 排除反对；flash 单模型演进观察升级优先验证项，复活条件随演进坐实），终局 comment 在 #82、D036 补记二在 decisions.md；②.env 之谜破案——mtime 10-29 实证**无漂移**，是本地 .env 从未随 D033 切换 + 夜批快照未验证的错误判断，已对齐 D033 口径（含 DECISION_MODEL）；③校准「无信号」维持落档。G 轨清单转跟踪 issue **#119**（C1-C6 绑时点，C4 时点随 cheap-pair 暂停消失）。framing 新 prompt 3 轮池化锚点落 report（b 权威 6/6 全面最强、a 中性 3/6 最弱——两个 framing 假设全部不成立，#99 闸门 4 复核不触发）。
## 2026-11-06 · 会话 47：GitHub 同类仓库全面对标——D040 定论 + 新立 #105/#106/#107 + 6 issue 补参考

- **目标**：用户「GitHub 全面搜索同类仓库，看有什么可借鉴的」→ 搜索 + 分析 + 落库；用户点名用 worktree 规避并行会话。
- **完成**：
  - GitHub Search API 10 组关键词扫描（ai code review / code review llm / pr review agent / code-review-bot / topic:code-review / topic:ai-code-review / chatgpt code review / code review benchmark / github app code review / agentic code review），12 仓 README 深读
  - **D040 落库**（原编号 D039，撞夜批 #65 gate 3 预分配，按 overnight-execution-2026-11-07.md 顺序约束改号）：借鉴点映射既有 roadmap（#73/#74/#75/#80/#82/#100 各补一条参考评论）、指标口径对齐（新立 #105）、reaction 回执（新立 #106）、外部 golden 子集转译（新立 #107）、三项不追（pr-af 重型管线 / 多平台 / 产品面）+ LLM-as-judge 不引入
  - **PR（本分支）**：decisions D040（原编 D039，见上）+ journal 本条，走独立 worktree（pr-review-agent-wt-c）基于 origin/main
- **发现 / 坑**：
  - **格局变化**：Qodo 把 PR-Agent 捐给社区 org（The-PR-Agent），主产品闭源化——「上游持续演进」前提失效，D035/#82 借鉴结论以 2026-11-05 源码精读为准
  - **三个公开基准涌现**（withmartian offline+online 双轨 / aacr-bench / ReviewBench by GitHub）——PR 审查评测正在标准化；我们 eval 体系差异化确认，可借标准不自建（D040 结论 4）
  - alibaba/open-code-review（49.5k）= 本轮最大发现：混合架构（确定性工程 × agent）、文件捆绑分治、外部定位/反思模块、1/9 tokens 换 precision 优先——「确定性护栏包住 LLM」与仓库既有威胁模型/确定性过滤（D020/D024）思路同向
  - anthropics/claude-code-security-review 自认未做注入加固（只审可信 PR）——我们 9 条 canary 是真实差异点
  - 并行会话纪律实践：另一会话在 -wt-a/-wt-b 做 #99/#80 实现（分支零提交、未动 docs），本会话全走独立 worktree + origin/main 基线 + 精确 add，零接触主树脏文件（ledger.json）
- **下一步**：
  1. 后续批次全景（#105 最小可先做 / #82·D036·G 轨裁定驱动 / #106·#107·#67 观察项 / #73·#74·#75 排期队列）见 `docs/plans/followup-plan-2026-11-07.md`（随本 PR 落库）
  2. 并行会话 #99/#80 收尾合并；#65 加严 3 轮 + D036 cheap-pair 复验同批（夜批顺序不变）

- **会话 46 续三（#108 合并 + #67 关闭，2026-11-07 深夜）**：①**#108（D040 对标落库）合并**——D039 撞号解局：并行会话 47 原编 D039 与夜批预分配撞号，按 overnight-execution-2026-11-07.md 顺序约束在 rebase 时改号 D040（decisions/journal/PR 标题三处 + bot 抓出 journal 漏改一处闭环）；docs 尾部连环冲突两轮调和。②**#67 关闭（结论：保留，不启用回退分支）**——今晚 12 PR / 20+ push 是 D032 的天然实验场：增量审查（base 推导正确）、force-push 自动回退全量、折叠段 minor 六个 PR 零漏处理，三闸门全过，样本落 #67/#82 comment（可回放）；日志侧增量决策行随 30 分钟窗蒸发，GitHub 侧 sha:base 标记作代理证据。③#82 落两笔：D035 逐字重报生产行为样本（含「忠实于旧意见文本、不重读代码」边界 case——暂不升级状态机）；**confidence 狗粮首批**（bot 自审意见全 high，与 eval 分布一致）。台账 104 run（reactions 34 run 0/0）。

## 2026-11-10 · 会话 48：观测面板立项 + 安全评审 + 落地（#122 / D041）

- **目标**：用户「做一个能看到日志/运行状态/token 消耗的页面」→ 方案收敛（4 轮问答 + AskUserQuestion 两轮裁定）→ sec-auditor 安全审查 → 当日实现。
- **完成**：
  - **立项**：#122（roadmap，多仓 repo→PR→run 层级 + findings 语料收集）；鉴权两轮裁定——Vercel 账户体系打通（2026-09 起 Vercel Auth 产线保护全 plan 免费）→ 双项目拓扑
  - **安全审查**（sec-auditor，2026-11-10）：两个 P0 全数落进实现——①同仓双项目把 `/api/runs` 带到公开主项目（Vercel Auth per-project 挡不住）→ `RUNS_API_ENABLED` fail-closed 门；②findings.body 存储型 XSS（PR 作者可控经 LLM 回显入库）→ textContent-only 渲染 + CSP + no-store。P1 落地：OIDC 凭证（Blob 无只读静态 token）、dashboard env denylist、写侧 5s 硬超时、ttlDays 保留期。#122 正文 + comment 留痕全量更新
  - **实现**：`src/runs.ts`（RunRecord + buildRunRecord 显式 Result 不抛错 + 纵深校验 + 写/读 + API 门）+ `api/runs.ts` 薄壳 + `public/runs.html|js|css`（零内联）+ vercel.json CSP headers + worker publish 接入（postReview/status 之后，`state.startedAt` 贯通）+ `.env.example`/deployment.md 新节
  - **质量**：typecheck ✓；单测 265 → 284 全绿；`npm audit --omit=dev` 4 high → 0（@vercel/blob 传递链 zod 4.1.11 命中 GHSA-mrhx-c7xc-m3w5，package.json overrides `zod ^4.6.7`，#116 同款手法）
- **发现 / 坑**：
  - **SDK 2.9.0 原生 `ttlDays`（1-730）**——issue 原设想 prune 脚本的前提「Blob 无 TTL」不成立，保留期改平台级自动过期（省一个脚本 + 隐私兜底更强），偏差理由已记 D041 + issue comment
  - **审计反馈进实现的两处易漏点**：写超时不加会把 best-effort 写成可用性回归（Blob 挂起吃满 285s 墙钟 → race 兜底误标 failure）；Blob 写失败日志若打 record 内容/put 返回值等于多开外泄面（findings 将来是私有仓代码片段）
  - `get()` 返回 stream 不自动缓冲——读侧 `new Response(stream).text()` 聚合
  - @vercel/cli-config 精确钉死 zod 版本（非 range），`npm audit fix` 无效，overrides 是唯一通路
- **下一步**：
  1. 合并后部署动作（docs/deployment.md 新节五步：主项目接 Blob OIDC / dashboard 项目 + `RUNS_API_ENABLED=1` / Vercel Auth Standard / 保留期 / 三条验证）
  2. 验收闸门 1（生产 run 落 Blob）需等下一个真实 PR 自然触发

- **会话 48 续（部署落地，2026-11-10 深夜）**：#122 部署 CLI 全自动化走通（实测六步，见 deployment.md 实测节）——`blob create-store --access private`（CLI 默认连接挂静态 token，按 D041 移除换 `BLOB_STORE_ID` OIDC）、`project create` + 临时 link 切换配 dashboard env（`RUNS_API_ENABLED=1`）+ `git connect` 同仓、**`protection enable --sso` 只给 `prod_deployment_urls_and_all_previews`（固定生产域名豁免）→ REST API PATCH 到 `deploymentType: "all"`（CLI 不暴露档位，审查 P1-2 坑位实测坐实）**。验收：dashboard 固定生产域名与部署 URL 均 302 → SSO、主项目 `/api/runs` 404、`/runs.html` 200；主项目已 redeploy（env 生效）。闸门 1 等真实 PR 触发。deployment.md 改写为实测步骤。

## 2026-11-11 · 会话 49：夜批——flash 同期对照定案 + 面板巡检三修 + #128 两线口径 + #127 A/B 定案

- **目标**：用户指令「看下有哪些 issue 可以做，能做的都做下；ego-browser 看今天新加的 web ui 页面，发现问题建 issue 自动改；过程中发现的问题也建 issue 改；明早看结果」。
- **完成**（4 PR 合并 + 1 PR 在途 + 3 issue 新建 + 2 issue 随 PR 关闭 + 1 生产 ops 修复）：
  - **flash 同期对照（D036 补记三，PR #129 合并）**：f4e2b250e88b 同夜配对单轮——生产 94.3/97.1 vs flash 91.4/87.8，双超未复现；伪影溯源 = 生产基线读数跨 prompt 换代未更新（85.7/86.4 是 11-05 老 prompt 存档值）；端点演进观察项降级常规观察，cheap-pair 暂停维持；#82 已评论
  - **面板巡检（ego-browser）**：**抓到 P0——dashboard `/api/runs` 恒 500（Blob store 未连接 dashboard 项目，OIDC 访问被拒），面板上线以来读取面从未工作过**；ops 当场补连接修复（REST `POST /v1/storage/stores/{id}/connections`，传播 ~1 分钟）→ 200 + 5 run 返回——**D041 闸门 1 实际已达成**（主项目写入侧 11-10 起正常，store 5 文件）。issue #130（部署步骤与验证清单缺口，docs PR #134 合并）/ #131（30s 自动刷新折回手动展开的 details，实测实锤）/ #132（hashchange 深链不重放 + ghPrUrl pr 段未编码）→ 修复 PR #133 合并（ego-browser 本地桩环境三项实测全过；#131 验收口径单测→真浏览器实测，拒 jsdom 理由 issue 留痕）
  - **#128 两线口径（PR #135 合并）**：curl 侦察端点返回 cached_tokens（闸门 1 落 issue）→ `TokenUsage.cachedInputTokens` 全链路（生产 [reviewDiff]/[router] 日志、prodlogs 台账解析+汇总、eval run 汇总、RunRecord tokens.cached、面板命中列）；bot 抓 minor（summarize 汇总层漏 cached 合计）修复闭环。**首个真实读数：eval A 臂缓存命中 81%**（system 前缀跨 case 复用）——成本口径认知改写，跨 run 同 prompt 重跑也在吃缓存
  - **#127 A/B 定案（D042，PR 在途）**：同夜 4 连发全量 run（各 ~10 分钟）——B union recall 88.6% 与 A 逐例持平（零「拆分补」发现）、precision 反降（36→79 条跨遍重复税）、成本 3.30× → **单遍多方面维持；#73 价值主张收敛到 precision 工程**；`EVAL_PROMPT_SUFFIX` 臂 + `merge-rules.ts` 单一实现源入 eval 基建
  - **台账勤回收**：112 run（+8 今晚四个 PR 的审查）
- **发现/坑**：
  1. **zsh `source .env` 毁 LLM_EXTRA_BODY**（花括号展开 + 逗号分裂）→ `extraBody()` JSON.parse 全挂、用例 10s 内全败——差点误判端点故障烧掉 352 call 批；栈回溯到 `extraBody()` 破案，改走 `npm run eval`（node --env-file）。已进 agent 记忆（eval-env-loading-trap）
  2. **analyze-cross-review.ts import 即执行**（顶层分析代码）——aspect-split 借 merge 函数把整个交叉分析跑了；抽出 `evals/merge-rules.ts` 单一实现源根治（重构后交叉分析回放数字逐位一致已核）
  3. **Vercel Blob store↔project 连接无 CLI 命令**，REST `POST /v1/storage/stores/{id}/connections`（body `{projectId}`）可全自动；「env 配置 ≠ 资源授权」——部署验证清单必须含「读路径 200 且有数据」，不能止于「页面能开」
  4. ego-browser task space 会话过期后 `taskSpace(id)` 失效，同名 `taskSpace(name)` 可恢复续用
  5. 面板「命中 —」= 旧 RunRecord 无 cached 字段（additive 预期）；同 PR 两次 push 各落一条 Record（确定性 pathname 不冲突）
  6. AI SDK v7 usage 语义：provider 对未报缓存详情的端点回 0（非 undefined）——0 = 未报或零命中，null = usage 整体缺失，两者已在类型注释与测试区分
- **下一步**：
  1. #127 PR 过闸门合并；今晚 4 PR 的 bot 意见全部闭环（三处核对纪律照走）
  2. #73 reflect 立项（下一自然时点）：验收主线 = precision 工程（D042 收敛后口径），失败降级「宁可少发」语义 + 同对话续写缓存设计约束不变
  3. 生产观察：新日志格式 cached 段随下一批真实 PR 审查进台账；面板「命中」列开始有数据
  4. #69 corr 组等 fixture 裁决；#75 与预处理提案同批评估（Step 4 门槛早已达成）
