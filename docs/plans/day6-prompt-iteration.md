# 规格：Day 6 — prompt 迭代与 eval 对比报告（PR B）

> 状态：已完成（2026-10-30，PR #13）。9 轮 run 落盘、`evals/report.md` 产出、compare.ts + 单测齐备；结论与数据见 `evals/report.md` 与 decisions.md D019。对应 PLAN 执行步骤 Day 6、验收标准 #3（eval 报告能展示至少一轮 prompt 改进 → 指标提升）。

## 目标

改 2-3 轮 prompt，多轮均值对比，产出 `evals/report.md`；prompt 文件最终停留在最优版本。

## 方法

- **多轮均值**：单轮 precision 波动 65-91%（会话 15/16 结论），每个 prompt 版本跑 3 轮 `npm run eval`，指标取跨轮微平均（Σhits/Σexpect、Σtp/Σcomments，与 run.ts 口径一致）。
- **可追溯**（D006）：run 元数据加 `promptHash`（prompt 内容 sha256 前 12 位）——历史上 run 只记模型名，同 prompt 多轮无法与改版后的 run 机械区分。
- **对比工具**：`evals/compare.ts`（`aggregateRuns` 纯函数 + 打印壳）按 promptHash 分组输出组指标与逐用例命中矩阵，报告数据从它出，不手工抄表。

## 迭代靶子（journal 会话 15-19 的稳定短板）

1. **语义执行类误判**（real-02 getter 求值两次，两晚连续 miss）：模型按表面含义读代码，不追执行语义。
2. **重复逻辑漂移**（linked-08 三轮中两轮 0 意见、linked-04 precision 0.33）：改一处不扫 diff 内副本。
3. **precision 降噪**（跨轮 65-91%）：无缺陷指向性的偏好意见稀释精确率。

## 迭代方案（每版只动规则区，量出数据再定下一版）

- **v2**：加三条针对性规则——①执行语义追踪（getter/副作用/短路）；②改动处扫 diff 内副本与同类调用点；③评论须指向可指认缺陷，同问题只报一次。
- **v3**：按 v2 数据回调——若 recall 掉则放松 ③ 的强度，若某靶子仍 miss 则换表述再压一次。

## 范围决策（本规格拍板，进 decisions.md D019）

- **上下文增强延后 v2**：拉相关文件/搜引用改输入契约，需另设计 eval 与用例集，不与 prompt 迭代混在一期。
- **synchronize 维持全量重审**：增量审查列 PLAN §七 路线，无新证据前不动。
- **多模型对比跳过**：无第二家端点 key；README 路线图保留。

## 验收

- 3 版本 × 3 轮 run 落盘入库（runs/ 是报告证据，历来入库）；`evals/report.md` 含方法、组指标表、逐用例矩阵、结论与局限。
- `npm run eval` 回归可跑；单测覆盖 aggregateRuns；typecheck / test 绿。
