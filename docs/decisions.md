# 决策记录（Decision Log）

> Append-only。每条决策一个编号，定稿后不改写——推翻旧决策时新增一条并标注取代关系。
> 格式参考 ADR（Architecture Decision Record）：背景 → 决策 → 备选 → 后果。
>
> 2026-10-29 去噪：决策记录只保留关键技术决策（有真实备选、且结论难以从仓库本身看出的）。
> 原 D011 并入 D002、原 D010 并入 D007；原 D009/D012/D013（skills 选装与目录）不立条——
> 相关约定移入 AGENTS.md 工程约定，动作与过程记录见 CHANGELOG 与 journal。

---

## D001 — 运行时选 TypeScript + Node 22

- **状态**：已接受（2026-10-29）
- **背景**：独立项目起步，需在有限时间内交付。
- **决策**：TypeScript（strict）+ Node 22。
- **备选**：Python——生态同样成熟，但与 Vercel AI SDK、Vercel 部署链路的衔接不如 TS 直接。
- **后果**：与 Vercel AI SDK、Vercel 部署链路零摩擦。

## D002 — LLM 接入用 Vercel AI SDK + OpenAI 兼容端点，不绑定厂商

- **状态**：已接受（2026-10-29，原 D002/D011 合并）
- **背景**：Vercel AI SDK 是 TypeScript 生态最主流的 LLM 接入框架。主流 LLM 均提供 OpenAI 兼容 API，文档与代码写死具体厂商会缩小适用面，也与多模型对比路线（PLAN §七）冲突。
- **决策**：AI SDK 的 OpenAI provider 指向 OpenAI 兼容端点，配置抽象为 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`；GLM 为当前实例，仅出现在决策记录与配置备注里。
- **备选**：
  - Cursor Agent SDK——绑定 Cursor 订阅，排除；
  - Claude Agent SDK——无 key，排除。
- **后果**：换模型 / 接第二家模型只改环境变量，同一 eval 集可直接做对比。

## D003 — 审查输出用 `generateObject` 结构化输出

- **状态**：已接受（2026-10-29）
- **背景**：下游要逐条回帖、逐条打分，自由文本不可执行。
- **决策**：AI SDK `generateObject` 强约束 `{ comments: [{file, line, severity, body}] }`。
- **后果**：eval 打分变成结构化字段比对，而不是文本猜测；「为什么结构化输出」这个设计问题有了具体答案：下游可执行、可打分。

## D004 — 先 200 再异步 + commit SHA 幂等去重

- **状态**：已接受（2026-10-29）
- **背景**：LLM 审查耗时可能超过 GitHub webhook 超时窗口，超时会触发 GitHub 重试，重试导致重复评论。
- **决策**：webhook handler 立即返回 200，实际审查放 `waitUntil` 后台执行；以 `(repo, commit SHA)` 为键去重，重试到达直接跳过。
- **备选**：同步处理 + 背景重试降级——超时语义仍不可控，且 Vercel 函数有硬超时。
- **后果**：`src/dedupe.ts` 成为独立模块；去重状态初始用 Vercel KV 或内存 Map（部署形态定稿时决策）。

## D005 — 部署 Vercel Hobby

- **状态**：已接受（2026-10-29）
- **背景**：无状态 webhook 服务，不想维护云服务器。
- **决策**：Vercel Hobby（免费、非商用，100 万次调用/月）。
- **后果**：`waitUntil` 生命周期受 Vercel 约束；去重不能依赖本地内存持久化（与 D004 联动）。

## D006 — 项目组织走 agent-as-code 范式

- **状态**：已接受（2026-10-29）
- **背景**：参考 Cursor Agent SDK 范式。
- **决策**：Markdown 放提示词（`prompts/*.md`）、TS 函数定义工具、独立 `evals/` 目录。
- **后果**：prompt 可 diff、可版本化、可在 eval 报告里引用具体版本。

## D007 — 开发过程采用 harness 式文档体系

- **状态**：已接受（2026-10-29）
- **背景**：借鉴 DeepSeek Harness「Agent = Model + Harness」思路——用仓库内文档而非记忆在会话间传递上下文；改动可回放。
- **决策**：建 `AGENTS.md`（工作规则）+ `docs/architecture.md`（架构）+ `docs/decisions.md`（决策，append-only）+ `docs/journal.md`（会话日志，append-only）+ `docs/CHANGELOG.md`（变更）；文档随代码同 commit 提交。阶段性计划与 specs 统一归档 `docs/plans/`（原 D010 并入）。
- **后果**：任何新会话读四个文件即可恢复上下文；代价是每次改动多写几行文档，换来完整可追溯的过程记录。

## D008 — GitHub 身份：PAT

- **状态**：已接受（2026-10-29，Day 2 实测定稿）
- **背景**：回帖身份与权限粒度取决于用 GitHub App 还是 PAT。
- **决策**：用 PAT（环境变量 `GITHUB_TOKEN`）。零新建配置（开发机 keychain 已有 repo scope PAT），私有仓库拉 diff / 回帖直连可用；评论以个人账号名义发出。GitHub App（身份独立、权限收敛）留到多仓产品化阶段，届时新增决策取代本条。
- **备选**：GitHub App——更像产品，但需注册 App、私钥 JWT 签名、安装授权，一周交付期内成本不成比例。
- **后果**：回帖显示为个人账号；token 权限为 PAT 全量 scope，不做细粒度收敛。

## D009 — 结构化输出用 `generateText` + `Output.object`，兼容端点显式走 chat/completions

- **状态**：已接受（2026-10-29）
- **背景**：`ai` v7 将 `generateObject` 标记废弃，官方方向是 `generateText` + output specification。实测中另发现 `@ai-sdk/openai` v4 默认调用 OpenAI 新 Responses API（`/responses`），OpenAI 兼容端点（如 GLM）只实现 `/chat/completions`，默认形态直接 404。
- **决策**：`reviewDiff` 用 `generateText` + `Output.object({ schema })` 取 `result.output`；provider 调用一律 `llm.chat(model)` 显式指定 Chat Completions 形态。取代 D003 的实现机制——D003「结构化输出 + schema 契约」的决策本身不变。
- **后果**：消除每次运行的废弃警告，跟进 SDK 演进方向；接任何 OpenAI 兼容端点的代码约定固化为 `.chat()`。

## D010 — 幂等去重用「查 GitHub 已有 review」而非外部存储

- **状态**：已接受（2026-10-29；关闭 D004 遗留的去重载体决策点）
- **背景**：D004 留白去重状态载体（Vercel KV 或内存 Map），部署形态定稿时决策。Vercel serverless 实例内存不跨请求可靠（D005），KV 则引入外部服务。
- **决策**：review body 内嵌 `<!-- pr-review-agent sha:<head SHA> -->` 标记，处理事件前 `listReviews` 查同 SHA 标记，命中即跳过。
- **备选**：
  - Vercel KV（Upstash Redis）——防并发更严格，但多一个外部服务、环境变量与免费额度管理；
  - 内存 Map——Hobby 多实例下基本失效。
- **后果**：零新基建、天然跨实例持久；代价是每次事件多一个只读 API 调用。并发窗口内（同 SHA 两 delivery 同时在途）仍可能双发，概率极低，接受。超时通知走 issue comment 不带标记——同 SHA 重投仍可重试。

## D011 — LLM 硬超时 + 超时评论降级

- **状态**：已接受（2026-10-29）
- **背景**：实测端点延迟极不稳定（5s～2min+，journal 会话 9）。Vercel Hobby 函数上限 300s（Fluid compute 默认开启；「10s 默认/60s 上限」为 Fluid 之前的过时数据）。
- **决策**：`reviewDiff` 加 `AbortSignal.timeout(LLM_TIMEOUT_MS)`，默认 270s（留 30s 给拉 diff + 回帖）；超时后发一条 issue comment 告知并提示重试。
- **备选**：
  - 静默跳过只记日志——失败对 PR 作者不可见；
  - 更短超时——大部分审查会失败。
- **后果**：失败可观测；超时不写 review 标记，同 SHA 重投 webhook 可重试。延迟波动属模型层问题，若频繁超时在 Day 6 多模型对比时处理。

## D012 — thinking 模型延迟治理：`LLM_EXTRA_BODY` 端点扩展点，关 thinking 而非异步化

- **状态**：已接受（2026-10-29，Day 3 首次全链路实测触发）
- **背景**：当前模型（glm-4.6）为 thinking 模型，单次审查 2～5 分钟起步，Day 3 首次真跑 270s 必然超时（journal 会话 10）。webhook 层已是先 200 再异步，「等待」只受 Vercel 函数 300s 硬上限约束——继续加大超时无出路。
- **决策**：加通用请求扩展点 `LLM_EXTRA_BODY`（JSON，合并进 chat/completions 请求体，显式配置优先），GLM 用 `{"thinking":{"type":"disabled"}}` 请求级关闭 thinking；超时 + 重投兜底保留。「必须长 thinking」时的真正异步化（QStash 外部队列 / Vercel Workflows，突破 300s）列为 v2 候选。
- **备选**：
  - 外部队列异步化（QStash + worker）——解决重试语义但不突破单次调用 300s 上限，且引入外部服务，与 D010 零基建取向相悖；
  - 直接换非 thinking 小模型——等价于改 `LLM_MODEL`，与本法不互斥，但质量对比交给 Day 6 eval 拿数据。
- **后果**：单次审查延迟回落到 300s 内；thinking 开关成为配置项，eval 可量化其对质量的影响（正是 eval 集的用途）。`LLM_EXTRA_BODY` 同时是任何端点私有参数的通用入口，不绑定厂商。

## D013 — 合并前意见闭环：Actions check 软约束，public 后升级 branch protection

- **状态**：已接受（2026-10-29，PR #2 意见未处理即合并的教训）
- **背景**：GitHub 唯一能硬性阻止合并的机制是 branch protection（Require conversation resolution / required checks），但该能力在 private 仓库需 Team/Enterprise 付费计划，免费计划仅 public 仓库可用。
- **决策**：`.github/workflows/review-threads.yml`——GraphQL 查 `reviewThreads`，存在未 resolve 线程即 fail 的 check（PR 事件与 review 提交时重跑），作为每次 PR 可见的软约束；`npm run resolve:threads -- owner/repo#N` 作为合并仪式收尾。仓库转 public 后启用 branch protection 硬闸门取代本条软约束。
- **备选**：
  - 付费计划解锁 branch protection——单人项目成本不成比例；
  - 纯 AGENTS.md 约定——PR #2 已证明会被跳过。
- **后果**：check 红灯技术上仍可合并，但未决意见在每次 PR 上显式暴露；合并流程多一步 resolve，换来闭环可核查。

## D014 — eval 集：手写自包含 diff 用例 + 确定性规则打分

- **状态**：已接受（2026-10-29，Day 4-5）
- **背景**：PLAN 验收标准要求 `npm run eval` 一条命令跑 20 用例出打分表，且 Day 6 改 prompt 需要前后可比的数据。真实开源 PR 抓取不可控（diff 噪音大、期望发现无法精确标注），打分若靠 LLM judge 则引入偏差与成本。
- **决策**：
  - 20 个手写自包含 unified diff 用例（10 个明确 bug + 10 个「应主动发现的关联问题」），每用例一个 TS 文件，`evals/cases/` 目录 readdir 动态加载；
  - 期望意见形如 `{ file（可给候选数组）, line（可 null 表示文件级）, mustMention[] }`；命中 = 文件命中 + 行号 ±3 容差 + body 含任一关键词（大小写不敏感）；
  - 指标：recall（期望意见命中率）+ precision（agent 意见中命中期望的比例，micro 平均）；severity 不进判定、只做报告展示；
  - 结果每次落盘 `evals/runs/<时间戳>-<模型>.{json,md}`，Day 6 改 prompt 前后取两份 run 对比出 report。
- **备选**：
  - 抓真实开源 PR——期望发现要人工逆向标注，且 diff 无法复制到 CI 稳定复现；
  - LLM judge 语义打分——每次跑分多一层模型成本与波动，20 用例规模下确定性规则足够判定；
  - 精确匹配（行号无容差 / body 全文比对）——把措辞差异误判为未命中，recall 虚低。
- **后果**：用例正确性（hunk 行数、期望行落点）由 `test/eval-cases.test.ts` 结构校验兜底，手写行号错误进不了主干；关键词弱匹配的判定误差用多候选 mustMention 缓解，残余误差对「同一 prompt 前后对比」是系统性的，不影响趋势结论；agent 发现 diff 中未标注的真问题会被计成 FP，写用例时保持 diff 干净即可。

## D015 — eval 集混入真实仓库用例，手写集降级为教学组

- **状态**：已接受（2026-10-29）
- **背景**：20 个手写用例全部由 LLM 生成（与被测对象同源），bug 是「教科书式」的局部模式且 diff 干净无噪音，95% recall 里有一部分是用例偏简单贡献的——不能当真实能力的估计（用户质疑成立）。
- **决策**：用例加 `source` 三级分组——
  - `real`（能力评估主依据）：从真实仓库的 bug fix PR 构造。主力手法 = **修复 diff 反转**（把人类 fix 的 +/- 对调，agent 看到的就是「真实代码、真实 bug 被引入」的 diff，修复内容是独立于构造者的 ground truth）；辅以真实配对（vscode#330629 引入 → #343670 修复）。
  - `dogfood`（回归集）：本仓库历史 PR 的真实自审意见转用例。agent 考过的原题，recall 必然虚高，只防 prompt 改坏退化，不计入能力评估。
  - `synthetic`（手写教学组）：原 20 个用例，保留用于定位能力短板（分 bug/linked 两类）。
  - 跑分报告按组输出 recall/precision，能力评估 = synthetic + real，dogfood 单列。
- **备选**：
  - 微软 CodeReviewer 数据集（9.7K 真实 diff+评论）——引入数据管道依赖，英文评论转中文关键词匹配又是一层失真；
  - 全量真实配对（引入 PR + 修复 PR 都从 git 历史配对）——fix 小 ≠ 引入小，人工配对命中率低（实测 5 个候选只成了 1 个），且配出的 bug 往往需要领域知识才能从 diff 推断。
- **后果**：规模 20 → 29（20 synthetic + 7 real + 2 dogfood）；diff 来源标注在每个用例 description 里可追溯；反转构造透明（测试文件 hunk 丢弃、源码 hunk 原样反转、hunk 头行数对调），结构校验测试继续兜底。

## D016 — 行内评论逐条预定位，降级意见只留真定位不了的

- **状态**：已接受（2026-10-30，PR #8 两条降级意见漏处理触发）
- **背景**：PR #8 合并后发现 review summary body 里还有两条未处理 minor——Day 2 的 422 降级是「全有全无」：任一意见行号不在 diff 内，全部意见写进 body。body 意见没有线程，`resolve:threads` 查不到、`review-threads` check 不管，整个意见闭环对降级路径是盲的（PR #1 自审 nit「降级粒度太粗」的兑现）。
- **决策**：`postReview` 发 review 前按 diff 覆盖行号逐条预定位（`diffCoveredLines` 纯函数解析 hunk 新侧行号）：可定位的行内发（进线程、可回复可 resolve），只有真定位不了的（模型报幻觉文件/行号）列进 summary body 并注明无法闭环；422 整体降级保留为兜底。流程约定同步：拉意见必须同时看行内线程与 review body 降级列表。
- **备选**：
  - 维持全量降级 + 人工核对——PR #8 已证明会漏；
  - 降级意见逐条发 issue comment——同样无线程，只是换个地方盲。
- **后果**：行内意见占比最大化，闭环覆盖随之最大化；残余盲区收敛到「模型定位本身错误」的意见——这类意见质量存疑，人工核对后修 prompt（Day 6 靶子）比机械闭环更有价值。
