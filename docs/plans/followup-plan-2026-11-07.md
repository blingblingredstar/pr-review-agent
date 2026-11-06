# 后续批次计划：夜批五号之后（2026-11-07 白天起，会话 47）

> 前置 = `docs/plans/overnight-execution-2026-11-07.md`（会话 46 夜批）晨起收口清单完成。本文档 = 夜批完成后待办全景与批次排序（D040 对标定论的落地清单）。**触发条件驱动，不做无前置的提前实现。**

## 夜批完成后状态（预期基线）

| 项 | 预期 |
|---|---|
| 用例集 | 87 例（framing 9 + ctxpair 5 加入） |
| promptHash | #100 合并后换新基线（≠ `a7e89dffb21d`），此后全量 run 都在新基线 |
| #65 | gate 3 decision 落 D039：关 `DECISION_MODEL` 或保留（读数驱动） |
| D036 | cheap-pair 复验读数：维持双超 → 生产化重议启动；回落 → 暂停 |
| #82 | 发布层门槛设计稿 + corr 裁定选项 comment（晨起用户裁定） |
| G 轨 | `docs/plans/refactor-assessment-2026-11-07.md` + 结论三选一（晨起处理） |
| 台账 | prodlogs 末次回收 + chore PR |

## 批次排序

### 批 1：无前置，随时可做（零 LLM 配额）

- **#105 eval 报表双口径**（D040 结论 2）：score.ts 拆 content hit / located hit 两级 + Line Precision / Noise Rate 两列。纯报表派生，历史 run JSON 重放即可出表，不占 eval 配额、不碰 promptHash。DoD 见 issue。

### 批 2：裁定驱动（晨起/用户拍板后启动，按夜批产出逐项接）

1. **#82 发布层门槛**：设计稿裁定通过 → 立项实现（blocker/major 进线程、minor/nit 折叠、双指纹去重；对标参照已留 issue 评论：kodus Kody Issues / withmartian dedup groups）
2. **D036 生产化重议**：复验维持双超 + corr 裁定（用户，选项在 #82 comment）→ 三前置齐 → 重议裁决
3. **G 轨重构**：结论 = 局部重构清单 → 开 issue 列优先级；= 不需要 → journal 落档；= 整体重构 → issue + 计划文档
4. **#100 校准 follow-up**：强相关 → 开 follow-up issue 接 #73 路由；弱相关/无信号 → journal 落档

### 批 3：观察项触发（到点才做）

- **#106 reaction 回执**：#89 派生口径稳定（outcome source=github 全覆盖）后随手做
- **#107 外部 golden 转译**：#69 fixture 裁决后 / 下次 real 组扩容同批（不单独占跑）
- **#67 增量审查生产观察**：下个真实多 commit PR 自然观察
- **glm-flash 同期对照**：下个自然时点（D033 回滚开关两行 env 待命）

### 批 4：排期队列（带前置的既有 issue）

- **#73 reflect 二次评分**：前置 = #100 校准结论 + D036 终态（Step 7 收口）；形态参照 = anthropics 两段式 FP 过滤（评论已留）
- **#69 correlation 组**：改靶子（fixture 扩充度量先行——prompt 盲调已三次证伪）；与 #107 同批最省
- **#74 大 PR 分块**：等生产实证触发；形态参照 = alibaba 文件捆绑分治（评论已留）
- **#75 AGENTS.md 注入**：等 Step 4 门槛；最小形态参照 = vet guides.toml（评论已留）
- **#76 多仓产品化**：远期

## 顺序约束

- 本计划随 D040 docs PR 落库；**D040 PR 排在夜批 E/F 收尾 PR（journal 会话 46）之后合并**，避免 journal 会话号逆序
- D039 已让位给夜批预分配（#65 gate 3 decision，E 轨独占）；对标定论取 D040，issue #105/#106/#107 与参考评论同步改号
- #105 实现不依赖批 2 裁定；批 2 各项相互独立，裁定一个做一个
