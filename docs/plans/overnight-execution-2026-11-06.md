# 夜间批量四号执行计划（2026-11-05 深夜 → 11-06 晨，会话 43）

> 用户指令（老样子）：「今天晚上能做几个做几个，尽量并行，可以用 subagent 和 worktree」；点名验证「glm flash + deepseek flash 交叉 review」。
> 模式沿用会话 39（夜间批量三号）：三轨并行实现 + PR 严格串行过闸门 + eval 配额集中管理。

## 轨道划分

| 轨 | Issue | 内容 | 形态 |
|---|---|---|---|
| A | #79（含 closes #72） | prompt 批次：不确定性标注主靶 + anti-confusion 两条（查重后）+ 噪音抑制两招，severity 分层设计 | subagent 实现（worktree prompt-batch）→ 中央 3 轮 eval → 基线换版 |
| B | #81 | 跨模型交叉 review 消融：存量数据（GLM-5.3@low ×3 JSON × DeepSeek@low stdout 恢复）离线合并打分 + 新鲜 cheap-pair（glm-flash + deepseek-flash，用户点名） | subagent 离线脚本（worktree ablation）→ 中央补 2 轮 run → D036 结论 |
| C | #68 + #70 | repo 组漂移规律定级（4 轮 cd5353f4688c run）+ real 0.84 复现判定 + inj-06 沉默持续性 | subagent 纯离线分析（worktree drift）→ journal 结论 |

## 预分配（并行撞号预防，D023 教训）

- **D036** = B 轨交叉消融结论（decision，B 轨独占写入权）；若结论为「数据不足」同样记 D036
- #68/#70 结论走 **journal 会话 43**（不占 D 编号）
- journal 会话 43 条目由**最后一个合并的 PR** 携带（避免多 PR 各写 journal 的冲突）
- 会话号 43；journal 末条 = 会话 42（已核对，无并行会话占用）

## eval 计划（中央执行，配额串行）

1. A 轨实现就绪后：glm-5.3@low 全量 72 例 ×3 轮（新 prompt 基线；#79 验收闸门：real recall 改善 / precision ≥ 94.2% 不回吐 / corr 不回退 / injection 8/8 零回显）
2. cheap-pair：glm-5.3-flash@disabled ×1 轮 + deepseek-flash@disabled ×1 轮（均在**新基线 prompt** 上，与 B 轨存量数据合并口径分开报告）
3. 5h 配额窗口打断协议（会话 42 先例）：逐轮落盘、探活后干净重跑当前轮、污染轮删除不入库

## 合并顺序与闸门

严格串行：B → C → A（A 的 eval 决定其最晚合并）。每个 PR：bot 自审三处核对（线程/降级/折叠）→ 全 resolve → 双 required check 绿 → 合并。文档随行同 commit。

## 中央负责（subagent 不碰）

PR 创建/合并、issue 操作（closing keywords 随 PR）、eval 运行（GLM 配额）、D036 终稿、journal 会话 43、晨起总结。

## 降级预案

- 某轨实现受阻 → 放弃该轨，其余照常（「能做几个做几个」）
- 配额不足 → 保 A 轨 3 轮（#79 钦定项），cheap-pair 降为单轮或挪明晚
- B 轨 stdout 解析失败 → 消融退化为「GLM-5.3@low × GLM-flash 新鲜 run」同源对照，DeepSeek 缺口记 D036
