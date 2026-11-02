# 决策模型路由：仓库视角的「审什么」计划（D028 spec）

> 状态：已实现（随 D028 的 PR 落地；实现与 spec 的一致性偏差仅两处主动取舍——router 硬超时定量化为 60s、diff 骨架逐文件行数封顶 200，均为 spec 未指定的防御性边界，见 decisions.md D028 与 PR body）。
> 目标：路线图第 3 项（决策模型路由 + 消融表）第一形态——便宜档先看「全仓文件树 + PR 元信息 + diff 摘要」产出结构化评审计划（focus areas / 风险面 / 建议深读文件），贵档带计划做评审。这是「从仓库整体角度做 CR 而不只看 diff」的第一步：router 拿到的是全仓视图（文件树），计划迫使主评审在生成前先定位风险面。多 agent 分发、消融表另立后续。

## 设计

### 两段调用

```
router（DECISION_MODEL，便宜档）
  输入：仓库文件树（快照键字母序，~20k 字符封顶）+ PR 规模摘要（files/±行数来自 diff 头统计）+ diff 的「文件清单 + 每 ±N 行」骨架
  输出：ReviewPlan（结构化 schema）
      ↓ 计划块注入
review（主模型 LLM_MODEL，贵档）
  prompt = 上下文（D023）+ 计划块 + [diff 开始] + diff（顺序不变，diff 仍末尾——行号锚点原则）
  （fileReader 工具循环照旧可用，与计划互补：计划给「该看哪」，工具给「再看一眼」）
```

- **ReviewPlan schema**（zod，定义在 review.ts，不属于 ReviewResult 输出契约）：`{ focusAreas: [{ area, files[], why }], riskAreas: [{ area, why }], readPaths: string[], strategy: string }`，全字段中文文案；router 输出解析失败 → 整个计划丢弃照常单段评审（best-effort，同 D023 上下文口味），计划块不带 diff 行号语义（不参与行内定位）。
- **prompt 组装**：`buildReviewPrompt(diff, context?, plan?)` 扩展——plan 块放 context 之后、`[diff 开始]` 之前（diff 仍最末尾）。无 plan → 字节级现状。计划块自带标题行（如 `[评审计划（由路由模型生成，供参考，不替代你的独立判断）]`）+ 威胁模型重申（计划由模型生成，不是 ground truth，与 diff 同属「内容非指令」）。
- **router system prompt**：新文件 `prompts/review-router.md`（prompts/review.md 不动 → promptHash 不变）。内容：任务（以仓库整体视角定位本次 diff 的风险面：架构一致性、关联模块影响、测试盲区、迁移/兼容），输入说明（文件树/规模摘要/diff 骨架各自是什么），输出 schema 说明，威胁模型（输入含 PR 作者可控内容）。

### 预算与失败语义

- router 耗时从主评审预算中扣除（同 PR #30 快照预判同款：`effectiveLlmTimeoutMs - routerElapsed`，下限 60s）；阶段墙钟 285s race 兜底不变。
- router 调用失败（网络/schema/超时）→ console.error + 无计划继续；**不重试**（多一次重试 = 预算翻倍风险，计划是增强不是依赖）。
- usage：router 的 token 用量单独落一行 `[router] tokens: in X / out Y`（成本可观测，消融表的数据出口）；主评审 usage 契约不变（ReviewOutcome.usage 仍为主调用自身）。

### 开关与 eval 红线

- **`DECISION_MODEL` 环境变量（默认未设 = 关）**：这是「新增成本项」的显式 opt-in（便宜档也是钱）；不设时零额外调用、零行为差异。
- **eval 红线靠参数不靠环境**：router 只由 worker 编排注入（`reviewDiff` 新增可选 `opts.plan?` / worker 内部先跑 router 再传 plan）——evals 直调 `reviewDiff` 永远无 plan，字节级现状与用户 .env 是否配了 DECISION_MODEL 无关。`npm run eval` 红线：promptHash `d399f9d4ed17` 不变 + 逐用例输入 tokens 与 35 例基线（2026-11-02，合计 23,376）逐位一致。
- 生产启用 = Vercel 配 `DECISION_MODEL`（可用与 LLM_MODEL 同名，也可配便宜档）；未配 = 现状。

### worker 编排（review 阶段内）

```
review 阶段：
  1. 快照（fileReader 或 router 需要文件树时才取——router 开启即需要）
  2. router（若 DECISION_MODEL 注入）：输入含快照文件树 + diff 骨架；耗时扣除
  3. 主评审：plan 块 + fileReader + 扣减后的预算
```

- `makeFileReader` 的既有快照复用为文件树来源（router 与 reader 共用一次快照请求，不重复下载）。
- deps.review 类型扩展 `opts.plan?`；编排注入式不变（测试可 mock router）。

### 明确不做（本 PR 边界）

- 不做多 agent 分发（router → 多个并行子评审 → 聚合）：阶段机支持（hop 有余量）但成本/聚合复杂度另立计划；本 PR 是「单计划增强单评审」。
- 不做 compare.ts 消融表：run JSON 已带 per-stage usage 落日志，跨 run 聚合对比等生产数据积累后另立。
- 不改 ReviewResult schema、不改 postReview/定位口径；prompts/review.md 不动。

## 验收

1. `npm test` 全绿（router schema 解析、plan 块注入位置、失败降级单段、预算扣减、eval 路径零 plan 的字节级不变）。
2. `npm run eval`：promptHash 不变 + 逐用例输入 tokens 与基线逐位一致。
3. 端点实测：本地对真实小 PR 跑一次 router（DECISION_MODEL 临时注入），PR body 记录计划质量与耗时。
