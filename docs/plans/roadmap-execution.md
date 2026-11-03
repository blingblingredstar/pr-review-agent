# 路线图执行计划（step-by-step）

> 来源：会话 34（2026-11-03），会话 35 增补 D031（Step 3）。依据 README §路线图 7 项 + D029/D031 spec + D030 拆分决策。
> 性质：**执行排序与步骤细化**——各项的价值优先级与边界仍以 README 路线图为准，本文件回答「先做哪个、一步步怎么走、每步怎么验收」。
> 状态：随 PR 滚动更新（完成一个 Step 划掉一个，偏差在 journal 记录原因）。

## 总原则（每个 Step 都适用）

1. **严格串行**：一个 PR 全流程闭环（bot 自审 → 意见逐条闭环 → `review-threads` + `pr-review` 双绿 → 合并）再开下一个。
2. **spec 先行留档**：新形态项（增量审查等）先写 spec 到 `docs/plans/`（不审批、只留档，夜间批量会话 31 的既定模式）再动代码。
3. **eval 红线**：能力组 promptHash + 逐用例输入 tokens 与基线逐位一致（参数路径构造保证）；injection 组独立口径单独报告。
4. **文档随行**：decisions / CHANGELOG / architecture / journal 与对应代码同一个 commit；main 禁止直推，一切走 PR。
5. **生产观测也是交付物**：上了生产的功能，其 `[router]` / `[task]` 等日志行的回收属于该 Step 的收尾，不算可选。

## 执行总览

执行序 ≠ 优先级序，理由见表后说明。

| Step | 内容 | 对应路线图项 | 触发条件 | 状态 |
|---|---|---|---|---|
| 1 | review.ts 机械拆分（D030） | —（D029 先行件） | 本计划合并后即可动工 | 已完成（PR #40） |
| 2 | 任务上下文注入（D029） | 第 3 项 | Step 1 合并 | 已完成（PR #41） |
| 3 | 代码搜索工具 search_files（D031）+ repo fixture eval 组 | 第 4 项 | Step 2 合并 | 待做 |
| 4 | 生产数据积累 + 消融对照 | 第 2 项 | Step 2 上线后开始积累；对照分析等数据门槛 | 等待/并行 |
| 5 | 对抗性关联 fixture 扩充（5 例） | 第 1 项 | Step 2 合并后的**专注会话**（D015 教训：赶工出低质 fixture 污染 eval 集） | 待做 |
| 6 | 增量审查 + 报告门槛细化 | 第 5 项 | Step 4/5 收尾后 | 待做 |
| 7 | 多模型对比 | 第 6 项 | 机会型：拿到第二家端点 key 随时可插队（纯 eval 侧，不动生产） | 待做 |
| 8 | 多仓产品化 | 第 7 项 | 前述全部稳定 + 出现多仓真实需求 | 远期 |

**排序说明**（为什么不按 README 顺序做）：

- D029（第 3 项）先于 fixture（第 1 项）：① spec 已合并、就绪度最高；② D030 拆分绑定其动工；③ 生产 `[task]` 日志越早开始积累，消融对照（数据门槛项）越早解锁。
- D031（第 4 项）紧随 D029：① 挂点是现成的（D027 两段协议 + Step 1 拆分后的干净基线）；② 它解锁的两类能力（漏改第三层盲区、词法 DRY）是单仓价值，原挂多仓 = 无限期搁置；③ repo fixture eval 组独立于既有 35 例，不与 fixture 扩充（Step 5）争专注会话——两组考的能力面不同（diff 外检索 vs diff 内关联）。
- 消融对照（第 2 项）是数据门槛项，现在无事可做，只能靠 Step 2 上线后的真实 run 积累——列为「等待/并行」，不占串行槽位。
- 多模型对比不依赖任何前序，拿到 key 即可插队；保持串行纪律的前提下选最近的空档做。

## Step 1：review.ts 机械拆分（D030，refactor PR）

全部为行为字节级不变的搬移，详见 decisions.md D030。

1. 新建 `src/diff.ts`：迁入 `pathVariants` / `unquoteGitPath` / `diffHeaderPath` / `diffTouchedPaths` / `diffCoveredLines` / `diffMaxChars` / `isNoisePath` / `truncateDiff`；调用方改 import：`src/context.ts`（`diffTouchedPaths`）、`src/github.ts`（`diffCoveredLines` / `pathVariants`）、`src/review.ts` 自身。
2. 新建 `src/router.ts`：迁入 `reviewPlanSchema` / `ReviewPlan` / `buildPlanBlock` / `diffSkeleton` / `decisionModel` / `ROUTER_TIMEOUT_MS` / `loadRouterPrompt` / `runReviewRouter`（`src/worker.ts` 的 router 编排引用改 import）。
3. `buildReviewPrompt(diff, context?, plan?)` → `buildReviewPrompt(diff, opts?: { context?, plan? })`：输出字节级不变（D029 的 `taskContext` 届时落进同一 opts，不再加位置参数）。
4. 测试归位：`test/review.test.ts` 中纯 diff 用例迁 `test/diff.test.ts`、router 用例迁 `test/router.test.ts`（用例文本不动，只换 import 与被测模块路径）。
5. **验收闸门**：`npm test` 137 全绿 + `npm run eval`——promptHash `d399f9d4ed17` 不变、逐用例输入 tokens 与 2026-11-02 基线逐位一致（合计 23,376）；两条命令的输出贴进 PR 描述留证。
6. 文档随行：architecture.md 组件表补 `diff.ts` / `router.ts` 两行；CHANGELOG 记 Changed（模块拆分）；journal。
7. PR（`refactor:` 前缀 + `refactor` 标签）→ bot 自审 → 意见闭环 → 双闸门 → 合并。

## Step 2：任务上下文注入（D029，feat PR）

Spec 见 `docs/plans/ticket-context-injection.md`（已合并），本节只列执行序：

1. `parseLinkedIssues(body)`：closing keywords 官方集（大小写不敏感）+ `#N` 数字校验 + 同仓去重保序。
2. `src/github.ts` 增 `fetchIssue`（逐个拉取、5s 硬上限、best-effort）。
3. `buildTaskContext(title, issues[], budget)`：任务块构造（威胁模型重申行内置）+ `TASK_CONTEXT_MAX_CHARS`（默认 4000、`0` 关闭、非法回退，既有同型）。
4. worker 编排：prepare 阶段用已有 meta（title/body）解析关联 → 拉取 → `taskContext` 随信封新可选字段（null 传递）→ review 阶段注入 `reviewDiff({ taskContext })` → `buildReviewPrompt` 组装：任务块置顶（context/计划块之前），diff 仍末尾。
5. `[task]` 日志行：关联 issue 数 / 字符数 / 截断与否 / 失败原因。
6. 测试：spec §三清单（解析、预算、best-effort 链、块构造字节级、信封传递、编排注入、`reviewDiff` 两形态）+ **inj-07** canary（task 向量经 `opts.taskContext` 显式注入，injection 组独立口径）。
7. **验收闸门**：`npm test` + `npm run eval`——能力组逐位一致不变；injection 组 +1 单独报告拦截率。
8. 文档随行：.env.example / architecture / decisions（D029 状态改已实现）/ CHANGELOG / README 环境变量表 + journal。
9. PR（`feat:` + `feat` 标签）→ 全流程闭环 → 合并。
10. 生产收尾：默认值生效无需 redeploy 配置；下一个自带 `Closes #N` 的 PR（本仓库惯用语式）即 dogfood，回收 `[task]` 日志。

## Step 3：代码搜索工具 search_files（D031，feat PR）

Spec 见 `docs/plans/search-files.md`（已合并），本节只列执行序：

1. `searchFiles(query)`：快照 entries 内存 grep（匹配文件路径 + 匹配行，每文件截断、总量预算封顶，超出附说明行），挂 `makeSnapshot` 底座（`src/context.ts`）。
2. D027 两段协议扩展：第一段 `readRequests` 扩为工具请求（search 与 read 并列声明，best-effort 解析失败降级同型），第二段把搜索结果拼进 prompt 前段、复用同一 schema 出结果；search→read 链式（搜到文件再读全文）是否需要多轮声明留实现期定，不预设。
3. 行为指令进 `prompts/review-tools.md`（`review.md` 一字不动）：diff 中被删除/改名的导出符号 → 搜残留引用；新增实现 → 搜既有词法相似；查询词从 diff 派生（符号名、字面量、注释术语）。
4. `FILE_TOOL_MAX_STEPS` 语义扩为工具步（search 与 read 共享计步），kill switch 语义不变，默认 2 起步生产观察。
5. eval：`EvalCase` 增可选 `repo` 字段 + 独立 source 组（先不进能力口径）+ `expectClean` FP 对照 + 锚点原则「锚 diff 内、证据指向 diff 外」（spec §三清单，6-8 例起步，含诱饵文件）。
6. 测试：search 内存 grep（匹配 / 截断 / 路径校验同 reader）、两段协议 searchRequests 解析与降级、预算计步、prompt 组装块字节级。
7. **验收闸门**：`npm test` + `npm run eval`——既有 35 例裸路径 promptHash + 逐用例 tokens 逐位一致（repo 字段不触碰既有用例输入，红线由构造保证）；repo 组单独口径首轮基线落 `evals/report.md`。
8. 文档随行：.env.example（预算语义变更注明）/ architecture / decisions（D031 状态改已实现）/ CHANGELOG / README + journal。
9. PR（`feat:` 前缀 + `feat` 标签）→ 全流程闭环 → 合并。
10. 生产收尾：dogfood PR 回收 `[tools]` 日志中 search 的实际使用率与命中质量；`[search]` tokens 单独落日志（消融数据出口同型）。

## Step 4：生产数据积累 + 消融对照（等待/并行，不占串行槽）

1. 观测节奏：每合并约 5 个 PR 回收一次 Vercel 日志中的 `[router] tokens` / `[task]` 行（数量、in/out tokens、失败率）。
2. **数据门槛（暂定，届时按方差修订）**：≥10 个带 `[router]` 的真实 run，且 diff 规模分布覆盖大小两端。
3. 门槛达成后设计对照口径：README 现述「用 compare.ts 对比有/无评审计划的质量差异」——生产 run 无 eval 分数，具体对照指标（意见采纳率 / 沉默率 / 严重度分布 / 人工裁定）**等数据形态明确后再定**，此处不过度预设。
4. 产出：消融表进 `evals/report.md` 或独立文档 + 一条 decision（含「计划无增量则关 `DECISION_MODEL`」的退出判据）。

## Step 5：对抗性关联 fixture 扩充（第 1 项，专注会话）

1. 选源纪律（D015 方法论）：真实仓库的 fix commit 反转 / 配对构造，**不手写想当然用例**。
2. 主题定向：「表面是优化、实际引了坑」——重构 / 性能优化引入的关联缺陷，5 例。
3. 命中率在 `evals/report.md` 单列口径（关联命中 = file + 行 ±3 + 关键词，既有打分口径沿用）。
4. **验收闸门**：新用例过 `test/eval-cases.test.ts` 结构校验；跑一轮完整 eval 确认既有 35 例不受扰（能力组基线仍是逐位一致——用例新增不触碰既有用例的输入）。
5. PR（`test:` 前缀 + `test` 标签）→ 全流程闭环。

## Step 6：增量审查 + 报告门槛细化（第 5 项，spec 先行）

1. **先写 spec**（`docs/plans/incremental-review.md`，不审批只留档），关键设计点至少回答：
   - base 选择：上次已审 SHA 从哪取（review 内嵌标记已存 SHA，D010 语义扩展）；
   - dedupe 键扩展：head SHA 单键 → （PR, 已审 SHA 集合）；
   - 与 D019（synchronize 维持全量）的衔接：本项即当年延后的 v2 形态，spec 里显式引用翻案；
   - 报告门槛：按严重级别细化（blocker/major 必报，minor/nit 是否汇总/折叠）。
2. 实现 + 测试 + eval 回归（synchronize 路径变化，**能力组用例不含增量形态则 promptHash 仍须不变**——用例侧零接触，红线同型）。
3. PR（`feat:`）→ 全流程闭环 → 生产 dogfood（本仓库自己推多 commit 的 PR 即实验场）。

## Step 7：多模型对比（第 6 项，机会型插队）

1. 前置：第二家 OpenAI 兼容端点的 key（用户侧动作；`.env` 不入库，跑分时环境变量覆盖 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`）。
2. 实现核对项：run 落盘元数据是否已记录模型名（未记则 run.ts 补一行），保证 compare.ts 聚合时按模型分组不混淆。
3. 同一 eval 集完整跑一轮 → 落盘 run → `compare.ts` 聚合出双模型对比表（recall / precision / tokens / 拦截率）。
4. 产出：对比报告进 `evals/report.md`；若差距显著，一条 decision 记录主备模型策略。

## Step 8：多仓产品化（第 7 项，远期里程碑）

触发条件：出现第二个真实仓库的接入需求。届时拆子项：

- GitHub App 身份替代 PAT（权限收敛，README §凭证的既定 TODO）
- 多租户上下文隔离（per-repo 配置：白名单 / 预算 / 开关）
- ~~`search_files`~~ 已提前至 Step 3（D031——两类单仓能力缺口，排期修订理由见 spec §一；embedding 否决不动）
- 外部工单源（Jira/Linear）随多租户一起评估（D029 非目标的既定归宿）
- 增量审查若 Step 6 未做或做得不彻底，在此一并补

## 与既有决策的衔接

- D019（synchronize 全量）→ Step 6 显式翻案（当年列 v2 路线，即此）。
- D022（证据片段字段已否决）→ 任何 Step 不得顺手复活；重启候选形态（旁路观测）若做，另立 decision。
- D023 非目标（不做向量检索）→ `search_files` 经 D031 提前至 Step 3（修订会话 33 挂多仓的排期面，理由见 spec §一）；embedding 否决不动，不重议。
- D028（消融表等生产数据）→ Step 4 兑现其 spec 边界里的「另立」。
- D029（任务注入）→ Step 2 实现，其「第二阶段双联用例」不在本计划内（等 dogfood 证明增量后另立）。
