# 仓库重构评估（2026-11-07）

> G 轨产出（会话 46，spec 见 `overnight-execution-2026-11-07.md`）。只读分析，不动生产代码。行号以本评估时点 main（33da1e8）为准，后续漂移以符号名为准。

## 结论：1 + 2 混合——目录不动（白天裁定维持），局部收敛清单立项候选

**不需要整体重构，也不需要目录重组**；需要一张小规模局部收敛清单（下文 5 条候选），且每条都绑定自然时点、不单独立项赶工。依据：

- src/ 全仓 3411 行 / 14 个模块，平均 244 行，模块边界与 architecture.md 组件表逐条对得上；每模块有对应测试（test/ 5171 行，模块级覆盖无空白，仅 paths.ts 10 行无独立测试文件、由 context.test 间接覆盖）。
- 变更热点与规模不匹配：近 30 天 top3 变更文件（review.ts 50 次 / worker.ts 38 / github.ts 27）恰好是承担新功能入口的三个模块，热点集中说明「改动有自然落点」，不存在「改哪都要全仓动」的结构性问题。
- 白天裁定（会话 46，architect 双路独立评审一致，输入见 overnight-execution-2026-11-07.md G 轨节）：**domain→service→adaptor 目录重组否决、D030 维持**——分层已以模块为单位存在（github/context/review = adaptor；diff/dedupe/incremental 及各 `*ForPr` 纯函数 = domain；worker = service）。本次证据复核（模块地图 + 依赖方向表，下文清单 1/3）与该裁定一致，无推翻性新证据。
- 全仓两个 import 环（webhook↔worker、review↔router）均文档化有意设计：review↔router 在 architecture.md:26 明示「成环 import（调用期绑定，ESM 语义安全）」；webhook↔worker 源于信封复用 webhook 的 HMAC 验签（architecture.md:23「信封（stage/hop/ref/issuedAt/state）复用 webhook 的 HMAC-SHA256 验签」），环是复用验签的机械后果，拆环需要复制验签逻辑或引入第三个模块，两向都比环差。

### 白天裁定三压力点证据复核（行号重定位后全部成立）

1. **bot review 产物 wire format 无 owner**：写侧 github.ts 四处同一条行格式 `- \`file:line\` **[severity]** body`——:183（行内 comment body 前缀）、:194（折叠段 minorish 逐条行）、:204（降级列表 degraded 逐条行）、:250（超时通知 reply 摘要）；读侧手抄两组同构 regex——findings.ts:40 `SEVERITY_PREFIX_RE` + :50 `DEGRADED_LINE_RE`、prod-runs-derived.ts:45 `FOLDED_LINE_RE`（:43 注释自认「与 findings.ts DEGRADED_LINE_RE 同构，severity 分支换成 minor/nit」——同构靠人肉维持）。正面样板 = dedupe.ts:17 `MARKER_RE`：sha 标记的「家」，写读共用单点，PR #59 复审 major 事故（hasReviewed 裸 includes 漏判增量标记）后收敛的形态。
2. **github.ts 混两职**：344 行中 API client（getOctokit/fetchPr/fileToDiffBlock/assembleDiffViaFiles/isStatus）与发布策略（summaryBody :120-133、severityLabels :136、splitByLocatable :148、postReview :169-266 的 body 组装与门槛判定）各占约半，发布策略约 100 行。发布层演进（门槛/折叠段/标签规则）每次都要打开 API 封装文件。
3. **worker.ts 589 行**（全仓最大）：阶段机（prepare/review/publish 三阶段 + 信封三闸 + 续链），架构叙事里的「一台机器」（D030 备选条目原文）。非 god module——589 行全部服务阶段机一个职责，三阶段在单一 `runStage`（:186）内按 `envelope.stage` 分派为三个连续分支块（prepare :195± / review :270± / publish :350±），分支边界即拆分线（G 轨输入的「拆 runPrepare/runReview/runPublish」指提取目标形态，现状函数尚未按段命名）。

## 证据表

### 清单 1：src/ 模块地图

行数 `wc -l`（2026-11-07 main），依赖方向为「← 被谁 import / → import 谁」：

| 模块 | 行数 | 职责（一行） | 被谁 import | import 谁 |
|---|---|---|---|---|
| worker.ts | **589** | 阶段机：信封三闸 + prepare/review/publish + 续链 | webhook.ts | webhook, github, dedupe, incremental, findings, context, task, review, router |
| review.ts | **521** | prompt 组装 + LLM 调用 + 工具循环 | router.ts, worker.ts | paths, diff, router, context（type） |
| github.ts | 344 | API client + 发布策略（见压力点②） | task, findings, incremental, dedupe（type）, webhook（type）, worker | review（type）, diff, dedupe |
| findings.ts | 357 | 上一轮意见复报（wire format 读侧 + GraphQL 独立查询） | worker, prod-runs-derived | diff, dedupe, github |
| context.ts | 344 | zipball 快照 + 上下文块 + search_file + 文件树 | worker | diff, paths |
| diff.ts | 298 | diff 解析纯函数 + 截断策略 | findings, context, github, router, review, worker（+evals/score.ts） | —（纯叶子） |
| prodlogs.ts | 240 | 生产日志解析 | prod-runs-derived | — |
| prod-runs-derived.ts | 174 | 生产 run 派生指标（wire format 读侧之二） | （scripts/evals 侧） | dedupe, findings, prodlogs |
| task.ts | 157 | 任务上下文：closing keywords → issue 正文块 | worker | github |
| router.ts | 148 | 决策路由（D028） | worker, review | diff, review |
| webhook.ts | 101 | 验签 + 事件分发 + 发 prepare 信封 | worker | github（type）, worker |
| incremental.ts | 75 | 增量决策：base 推导 / block 继承 / 区间 diff | worker | github, dedupe |
| dedupe.ts | 53 | sha 标记单点（写读共用解析） | worker, incremental, findings, github, prod-runs-derived | github（type） |
| paths.ts | 10 | 路径归一 | context, review | — |

- **>400 行单列**：worker.ts 589、review.ts 521。review.ts 521 行 vs D030 预估「~300 行量级」——偏差来自 D027/D031 工具循环块构造（buildToolBlock :368 与两段协议），仍是「审查编排 + LLM 调用」单一职责，非失控。
- 依赖方向无越层：diff/paths 是纯叶子（零依赖）；dedupe 只依赖 github 类型；全部「domain 纯函数」不被 adaptor 反向依赖，唯一例外 github→review 是 type-only（ReviewComment/ReviewResult 契约类型挂 review.ts，类型依赖不构成运行时耦合）。

### 清单 2：变更热点（近 30 天，2026-10-07 起）

`git log --since=2026-10-07 --name-only --pretty=format: -- src/` 频次（commit 触碰次数）：

| 文件 | 次数 | 测试覆盖形态 |
|---|---|---|
| review.ts | 50 | review.test.ts 765 行 / 35 test（含字节级红线） |
| worker.ts | 38 | worker.test.ts 1191 行 / 43 test（全仓最大测试） |
| github.ts | 27 | github.test.ts 238 行 |
| webhook.ts | 12 | webhook.test.ts 179 行 |
| context.ts | 10 | context.test.ts 350 行 / 18 test |
| prodlogs.ts | 5 | prodlogs.test.ts |
| dedupe.ts | 5 | 无独立文件——worker/incremental 测试间接覆盖（53 行小模块） |
| router.ts | 4 | router.test.ts 216 行 |
| findings.ts | 4 | findings.test.ts 459 行 / 23 test |
| diff.ts | 4 | diff.test.ts 379 行 / 32 test |

- 热点 = 功能入口三模块（review/worker/github 占近 30 天 src 变更的 66%），且热点文件测试同步增厚（review.test 765、worker.test 1191）——改动与护栏同频，没有「高频改动 + 无测试」的风险象限。
- task.ts（3 次）/ incremental.ts（3 次）/ prod-runs-derived.ts（2 次）低频，同构收敛的急迫性排序靠后。

### 清单 3：重复与耦合

**三胞胎同构度**（task.ts / findings.ts / context.ts「纯函数块构造 + best-effort 编排」）——五层结构逐层同构：

| 结构层 | task.ts | findings.ts | context.ts |
|---|---|---|---|
| 预算函数（env，0 关闭，非法回退默认） | `taskContextMaxChars` :10 | `prevFindingsMaxChars` :16 | `contextMaxChars` :11 |
| 块头常量（含威胁模型重申） | `TASK_HEADER` :53 | buildPrevFindings 内 header :117 | `CONTEXT_HEADER` :118 |
| 纯函数 builder（input, budget) → {text, truncated} | `buildTaskContext` :64 | `buildPrevFindings` :101 | `buildContextText` :124 |
| 装箱 + 截断说明行 | append 装箱 :69-75 + 说明行占位 | 预算全有或全无 + `MAX_PREV_FINDINGS` 计数 | append 装箱 + 超预算说明行 :152± |
| 码元安全截断 + 两轮收敛 | :86-99（注释自认「与 buildToolBlock 同款」） | —（全有或全无，无截断） | —（说明行简化版） |
| best-effort 编排（catch → null + `[tag]` 日志） | `buildTaskContextForPr` :118（5s 超时） | `buildPrevFindingsForPr` :308 | `buildRepoContext` :321（10s 超时） |

- 判读：**模式重复 3-4 处、每处 <100 行，但领域语义差异真实**（findings 有 dismissed 分段与三对照规则、task 有 closing keywords 前置解析、context 有 zipball 底座）。抽公共基类（budget gate + 装箱 + 截断收敛 + ForPr 包装器四件套）可省约 150 行，代价是引入参数化抽象层、牺牲各块威胁模型措辞与日志口径的直读性——**暂不抽**（lazy 原则）。触发条件：第 5 个「块构造」家族成员出现时再议（当前家族：task / context / findings / review.ts buildToolBlock，后者已与 task 共享「码元安全截断 + 两轮收敛」且 task.ts:86 注释互相引用——最接近可共享的一对，若要抽先抽这一刀）。
- **循环依赖风险点核对**：两环均文档化（见结论节）；github→review 为 type-only；findings.ts:190 `REVIEW_THREADS_QUERY` 是 github.ts 之外的第二个 GitHub 访问点（GraphQL，D035「REST 单面不扩」口径的既定特例），有文档理由不迁 github.ts（迁了会把 GraphQL 响应类型与 findings 领域逻辑搅进 API 层）。无未文档化的环。

### 清单 4：evals/ harness 复杂度

- **env 开关面（grep process.env evals/）**：臂开关 2 个——`EVAL_ONLY`（run.ts:94，parseEvalOnly 带组名校验）、`EVAL_PLAN`（run.ts:99，`=== "1"`）；probe 参数 2 个——`PROBE_LABEL`/`PROBE_N`（probe-router.ts:14-15）；其余是 LLM 端点变量（LLM_MODEL/LLM_BASE_URL/LLM_EXTRA_BODY，run.ts:253/:275-276）。`EVAL_CONTEXT` 为今晚 B 轨待加（overnight plan :81「EVAL_PLAN 镜像模式」），本评估时点代码里尚无——加完后臂开关共 3 个，形态一致（`=== "1"` 布尔臂 + console/md/JSON 三处子集标记），**不散**。
- **analyze 脚本硬编码清单**：analyze-cross-review.ts 646 行，run 文件清单 5 组常量硬编码——:298 `GLM_FILES`（3 个）、:299 `DS_HIGH_FILE`、:301 `DS_LOW_FRESH_FILE`、:303 `GLM_FLASH_FILES`（3 个）、:308 `DS_DISABLED_FILES`（3 个），共 11 个带时间戳文件名；另有 :240 `GROUPS` 7 组名列表（与 score.ts sourceOf 有漂移风险）。E 轨已列「清单更新工作项」——每批新 run 都要手改脚本。
- **该不该收敛成显式配置**：利——新 run 批不改 TS、实验清单可对照归档；弊——该脚本自述是**离线一次性消融工具**（文件头注释：「回放：node --import tsx evals/analyze-cross-review.ts（只读 evals/ 存档……确定性可重放）」），实验元数据（promptHash、混杂因素、「幸存文件经 token 总量核对」的取证说明）写在常量旁注释里是最可读的归档形态；为一次性工具引入 JSON 配置层 = 多一套 schema + 加载代码 + 注释和配置两处维护。**判读：不收敛**。保持「复制常量块 + 改注释」的现行模式即可，E 轨的清单更新工作项按原计划走；若 run 批次增速超过「每月一批」，再考虑 CLI 参数传文件名（半小时量级的小改，不值得提前做）。

### 清单 5：test/ 形态——eval-cases.test.ts 计数断言脆性

- 脆性实证：总数断言 `assert.equal(cases.length, 73)`（:85）+ id 去重断言复用 73（:87）+ **测试标题里也写了「73 个」**（:83）——每加一个用例必改 3 处；分组计数断言 9 条（:89-97：synthetic 20 / bug 10 / linked 10 / real 15 / dogfood 2 / injection 9 / repo 7 / correlation 10 / incremental 10）；增量组 full/delta 成对 base 名单硬编码 5 个（:101-103）。今晚 A/B 轨加用例就各改一轮（overnight plan :35「82 → 87」），一周内同文件已三改。
- **最脆断言 top 3**：
  1. :83 标题 + :85/:87 总数 73——改断言漏改标题无任何护栏（红灯只看断言，标题静默过期）；
  2. :89-97 分组计数 9 条字面量——每组加用例必改对应行，改错数字的失败信息还得人肉对数；
  3. :101-103 inc base 名单——新 incremental 组必改，漏改则新组的成对性检查静默缺失（不报错，保护消失）。
- **更韧形态辨析**：彻底派生（计数自 loadCases 目录扫描推出）会与被测物同源而失去保护力——总数断言的真实保护目标是「loadCases 静默漏载 / 用例文件被误删」。可行中间形态：总数改从文件系统事实派生（`evals/cases/` 下排除 index.ts 的 .ts 文件数 vs loadCases().length，loader 漏载即不等），加用例零改动且保住保护力；分组计数改成「≥N 下限」断言（组规模骤降报警、加用例免改），或保留字面量——组规模是 eval 可比性口径（EVAL_ONLY 按组过滤、跨 run 对比按组），字面量有护栏价值。**判读：值得做的是「总数派生化 + 标题去数字化」一刀（约 10 行改动）；分组计数保留下限式改造随下次加组顺手做；绝对不做的形态是删掉计数断言只靠结构校验**（:104-149 的结构断言拦不住「整组被误删」）。

### 清单 6：docs 体系负担

- **append-only 体量**：journal.md 786 行 / decisions.md 464 行 / CHANGELOG.md 386 行，三大件合计 1636 行（docs/*.md 全部 1857 行）；docs/plans/ 另有 1522 行归档。按最近三条 journal 条目 16-22 行计，journal.md 在当前节奏下还能撑数月才到「翻不动」量级（约 1500 行），**暂不需要切月归档**。
- **每 PR 双文档执行成本**：近 30 天 330 个 commit 中 97 个触碰 journal/CHANGELOG（29%）；每条 3-6 行、机械成本约 5 分钟/PR，真实成本是「文档随代码同 commit」纪律的记忆负担——但这由 AGENTS.md 明文 + bot 自审兜着，30 天无断档。双文档各有受众（journal = 会话恢复上下文，CHANGELOG = 用户可见变化），合并会互相污染受众，**维持双轨**。
- **真实负担是漂移而非体量**：architecture.md 组件表「48 个自包含用例」vs 实际 73（test/eval-cases.test.ts:85 断言）——架构文档的用例计数已落后两轮（35→48→73 的两跳都没跟上）。「随代码演进」条款对不变量有效、对高频变化的数字必然漂移。教训落档：**文档只写组口径不写计数**（既有实例：decisions.md D031/D032 写组形态不写总数，无漂移）。

### 清单 7：依赖健康

- **依赖数**：生产 6 个（ai ^7.0.156、@ai-sdk/openai ^4.0.104、@vercel/functions ^3.10.4、fflate ^0.8.3、octokit ^5.0.5、zod ^4.6.7），开发 3 个（typescript ^7.0.2、tsx ^4.23.15、@types/node ^26.6.6）。极轻面，无框架锁定。
- **npm audit 概览**：4 high / 0 critical / 0 moderate / 0 low，全部来自同一条链——zod <4.6.6（GHSA-mrhx-c7xc-m3w5，DoS，CWE-770，CVSS 7.5）→ @vercel/cli-config → @vercel/oidc → 直接依赖 @vercel/functions（3.6.2-3.10.5）。注意直接依赖 zod ^4.6.7 本身已达标，漏洞在其内嵌旧版。四条 `fixAvailable: true`，`npm audit fix`（升 @vercel/functions）一处修复，零代码改动。
- **已知重依赖升级面**：ai SDK 是唯一 major 敏感户（7.x 迭代快，major 升级历来动 generateText/Output 用法），但调用点单点集中在 review.ts（+router.ts 两处 generateText），升级面可控；fflate 仅 context.ts 解压单用途；octokit 5 稳定。依赖面是优势不是负担。

## 候选清单（局部收敛，全部绑定自然时点、不单独立项）

优先级 = 收益/成本比 × 时点远近：

| # | 候选 | 优先级 | 预估收益 | 自然时点 |
|---|---|---|---|---|
| C1 | **wire format 单点化**：行格式（severity 前缀/降级单行/折叠段行）写侧 4 处（github.ts:183/:194/:204/:250）与读侧 2 组 regex（findings.ts:40/:50、prod-runs-derived.ts:45）收敛到单一 owner（如 `src/wire-format.ts`，与 dedupe.ts 同型「格式之家」） | **P1** | 消除读侧手抄（prod-runs-derived.ts:43 注释已自认同构靠人肉）；格式演进单点改动，不再「改一处忘三处」 | **#82（publish 侧双指纹去重）动工时**——那是第 4 个 wire format consumer（要读写评论体），正是 G 轨预判的收敛窗口；届时先立 wire-format 单点、再做指纹去重 |
| C2 | **github.ts 发布策略拆出**：summaryBody/severityLabels/splitByLocatable + postReview 的 body 组装（约 100-150 行）与 API client 分家 | **P2** | github.ts 回归「API 封装」单一职责；发布层演进不再打开 API 文件；与 C1 同一刀面（拆的时候格式块顺势归位） | 绑定 C1 同一 PR；沿用 D030 先例——纯搬移 PR 先行、功能 PR 紧随，diff 可审性优先 |
| C3 | **eval-cases.test.ts 计数去脆**：总数断言改文件系统派生 + 标题去数字化；分组计数改 ≥N 下限式（口径护栏保留） | **P2** | A/B 及未来加用例零断言改动；消除「漏改标题」静默死角；约 10-20 行改动 | 下个加用例的 PR 顺手做（B 轨合并后）；不与用例内容改动混 PR |
| C4 | **worker.ts 拆段**：runStage 内 prepare/review/publish 三个分支块各自提取为独立函数（runPrepare/runReview/runPublish，G 轨输入命名的目标形态）后可各自搬移 | **P3** | 589 行回三个 <250 行文件，cheap-pair 等多评审形态改动落点更窄 | **cheap-pair 立项时**（G 轨输入预判维持）；非 god module、无独立触发理由，不提前 |
| C5 | **三胞胎抽公共块构造形态**（budget gate + 装箱 + 截断收敛 + ForPr 包装器） | **P3（观察项）** | 约 150 行重复消除；代价是抽象层伤害领域语义直读性 | 第 5 个「块构造」家族成员出现时再议；若动先抽 task↔review buildToolBlock 共享的「码元安全截断 + 两轮收敛」一对 |
| C6 | **architecture.md 用例计数去数字化**：「48 个自包含用例」改组口径不带计数 | **P3** | 消灭一处已知漂移源 | 下次架构文档被触碰时顺手改，不专开 PR |

依赖健康附注（不属重构候选）：`npm audit fix` 修复 @vercel/functions 链 4 high（零代码改动），建议随下个 chore PR 顺路做掉，不单独立项。

## 与白天裁定的关系

无冲突发现。清单 1（模块地图）与清单 3（依赖方向）的复核结果与裁定表述逐条吻合（分层以模块为单位成立、两环文档化、三压力点行号重定位后全部成立）；新增的评估维度（清单 2/4/5/6/7）没有产生指向目录重组或整体重构的证据——热点集中的模块恰好也是测试最厚的模块， harness 侧的脆性（清单 5）是断言写法问题而非结构问题。结论维持 1+2 混合，候选清单 6 条中 P1/P2 共 3 条，全部挂靠既有触发点，无需新开紧急工作。
