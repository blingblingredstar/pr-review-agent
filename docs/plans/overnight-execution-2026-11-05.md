# 夜间批量三号执行计划（2026-11-05 夜）

> 承接会话 38：用户睡前指令「能做的都做一下，先做 log 收集（免费版 log 只留 1 小时），根据 log 看实际执行效果，有问题记录、能改就改；实现计划归档，不需要审批，按推荐顺序来」。本文件 = 今晚 Step 固化 + 红线继承 + 回退预案，照 #39 先例。

## Step 固化（推荐顺序 C→D→B→A，用户追加：D 提到最前）

- **Step 1（PR-1，docs）**：本计划归档（本文件）。
- **Step 2（PR-2，feat，最急）**：Vercel 生产 log 采集——`scripts/fetch-prod-usage.ts`（Logs API → 解析 `[worker]/[reviewDiff]/[router]/[tools]/[task]/[github]` 行 → 按 requestId 聚合 → `evals/prod-runs/` 台账 JSON）。动机：免费版 log 滚动窗仅 ~1 小时，生产 run 数据在蒸发；同时把 Step 4 门槛（≥10 run）变成机械可测。随行：首份台账快照入库 + 从 log 读生产效果（已见三笔 glm-5.3@low 全绿，#53 两笔见 journal）。
- **Step 3（PR-3，feat）**：`LLM_MAX_OUTPUT_TOKENS` 成本护栏——透传 `generateText` maxOutputTokens；未设置 = 不传（字节级不变）。解锁依据：memory「maxOutputTokens 有数据再议」的数据今天到位（thinking 档单例 output 至 21,786、DeepSeek thinking 默认 64K 输出上限）。
- **Step 4（PR-4，fix）**：D018 新建文件缺口——大新建文件整块静默丢弃（含单文件超预算全空审）改 hunk 级降级。约束：新建文件全为 + 行，hunk 头自带新文件行号起点 → 行号锚点原则不破；预算确定性与截断说明行语义保留；既有 D018 测试语义不变（改动只影响「新建文件整块丢弃」分支）。
- **Step 5（PR-5，feat，旗舰）**：D032 增量审查实现（spec `docs/plans/incremental-review.md`，#43 留档）。动工前提的变化：原触发 = Step 4 数据门槛（5/10 未到）；D033 切换使配额 3× → 增量的成本价值同比放大，成本理由本身成立，用户今晚点名「能做的都做」。实现要点全按 spec：base 推导（listReviews `sha:` 标记 ∩ 当前 commits）、dedupe 键 (PR, 已审 SHA 集合) 推导式、标记 `sha:<head> base:<base>`、block 继承回退全量、增量 diff 走 compare API + `fileToDiffBlock`、发布层门槛（blocker/major 行内必报、minor/nit 折叠 body details、REQUEST_CHANGES 收窄为「有 blocker/major」）。任何一层失败回退全量（spec 原文）。evals 直调 reviewDiff 零接触 → 能力组 promptHash 红线天然不动。
- **Step 6（随 eval 完成插入）**：DeepSeek 三档对照报告——`evals/report.md` 新段 + run 归档（chore）+ journal 增补（含生产三笔首证：search_files 首次生产抓真问题、D017 自家 PR 边界再现、glm-5.3@low 生产 token 形态）。
- **Step 7（收尾）**：journal 会话条目 + memory 更新；如 Step 4 采集脚本跑通，附台账读数。

## 红线继承（自 #39 全夜红线 + 今日新增）

1. **严格串行零并行**：每 PR 从 `origin/main` 新建分支、精确 add、双硬闸门（`pr-review` + `review-threads`）绿后合并、合并后 `git pull` 再开下一个。
2. **bot 意见逐条闭环**：行内线程走 resolve:threads；降级意见（无线程）PR 留痕 + commit 记录；`--yes` 前先读最新 review。
3. **能力组红线**：所有代码改动不得触碰 `prompts/review.md` / prompt 构造路径——今晚全部改动都在编排层/发布层/采集层，evals 直调 reviewDiff 的输入路径零接触（构造保证）；合并前抽查 promptHash 不变。
4. **单测纪律**：每个 PR typecheck + 全量单测绿（当前基线 182）；计数变化在 CHANGELOG 记录。
5. **不试调 fixture**：eval miss 是 prompt 迭代靶子不是 fixture 缺陷（D024/D031 纪律）。
6. **正在跑的 eval 共树纪律**：DeepSeek low/high 两路 eval 正从本工作树运行——今晚所有分支不得改动 `prompts/**`（避免运行中的 eval 在 run 中途读到变化的 prompt）；evals/runs 新落盘文件为 untracked，checkout 不影响。
7. **沙箱/环境坑**（继承 #39-#45 + 今日）：GitHub API 用 curl + python3 构造 JSON；SSH push 间歇超时重试即可；长 eval 日志不接 `| tail`。
8. **D 编号**：今晚新决策从 D034 起顺排；会话号延续 38（同一会话未断）。

## 回退预案

- 任一 Step 实现「完成但 eval/单测无法回绿」→ 回退该分支、journal 记负结果、不影响后续 Step（步骤间无代码依赖，仅 Step 4 依赖 Step 2 的台账读数做验证）。
- Step 5 若实现中途发现 spec 与现实冲突（如 compare API base 时点 diff 缺失之外的硬阻塞）→ 按 spec 的「任何一层失败回退全量」原则先落可运行子集，残余记 open question，不为赶夜硬塞。
- 生产发现（Step 2 台账/日志）如显示 glm-5.3@low 有预算级异常（超时/烧穿）→ 立即记录，不擅动生产 env（切换/回滚是用户决策），journal 显著标记。
