# 夜间批量五号执行计划（2026-11-06 晚 → 11-07 晨，会话 46）

> 用户指令：「能做的都做下，排到后面今天做完」。上午已完成：PR #97（#65 闸门 2 机制——`EVAL_PLAN` 消融臂 + folded 进台账指标 + 首轮读数落 report.md）、PR #98（AGENTS.md keychain 命令修正）、issues #99（framing 对照组）/ #100（置信度结构化）新建。
> 模式沿用夜间批量四号：多轨并行实现 + PR 严格串行过闸门 + eval 配额中央管理。

## 开工状态快照（2026-11-06 中午）

- main @ `a5dffa2`；**promptHash 基线 `a7e89dffb21d`**（勿在 C 轨完成前动 prompt）；单测 255
- 生产口径 env（#65 两臂已验证可跑）：`LLM_MODEL=glm-5.3` + `LLM_EXTRA_BODY='{"thinking":{"type":"enabled"},"reasoning_effort":"low"}'` + `DECISION_MODEL=glm-5.3-flash`；plan 臂加 `EVAL_PLAN=1`
- DeepSeek 侧配置从 `evals/runs/` 存档 run JSON 的 `llmBaseUrl` / `llmExtraBody` 取（`LLM_JSON_MODE=1` 必带），勿凭记忆写
- ⚠️ PR #97/#98 的生产日志已蒸发（中午回收被取消，30 分钟窗）——损失 2 笔零意见 run 的台账行；**今晚开工第一步先 `npm run prodlogs`**（当天若有新合并 PR），之后每合 2-3 个 PR 回收一次

## 轨道划分

| 轨 | Issue | 内容 | 形态 |
|---|---|---|---|
| A | #99 | framing 对照组 fixture：3 对用例（复用 repo 组 fixture 的 diff/repo，只换 `taskContext`——A 中性 / B 权威预设「已过人工初审」/ C 轻视性「小清理请快速过」），source 组名 `framing`，独立口径不进能力白名单（照 repo/incremental 先例） | subagent 实现（worktree）→ 单测（eval-cases.test.ts 形态校验同款）→ PR |
| B | #80 | context-aware 双联用例组：**先读 issue #80 正文**按其设计（同 diff ± context 成对，度量 D023 注入增益） | subagent 实现（worktree）→ PR |
| C | （中央 eval 批） | ① #65 加严：3 轮 × 2 臂 `EVAL_ONLY=repo`（子集很便宜，~1 分钟/臂）→ compare 池化表；② #99 首轮 `EVAL_ONLY=framing` ×1；③ #80 首轮 `EVAL_ONLY=<新组>` ×1；④ D036 cheap-pair 复验：glm-flash 全量 ×3 + DS@disabled 全量 ×3（**长尾 ~2h，先起后台**） | 中央串行跑 + 后台长尾 |
| D | #100 | 置信度结构化：schema 加 optional `confidence` + prompts/review.md 一行 + score.ts 记录 + 校准表——**实现可先行（分支），合并与首轮 run 严格排在 C 轨全部基线 run 落库之后**（换 promptHash 基线） | subagent 或中央实现 → 最后合 |
| E | （分析收口） | #65 gate 3 decision 草案（退出判据 \|Δ\|<3pp → 关 DECISION_MODEL，读数用 C① 池化表）；D036 复验读数（cheap-pair 是否维持双超 + corr 裁定）；#99/#80 报告节 + runs 入库；发布层门槛设计稿（联动 #82 双指纹去重）贴 #82 comment | 中央 |
| F | （例行） | 台账回收（30 分钟窗！）；今晚 PR 流若出现「bot 提 blocker/major → fix push」→ `[findings]` 复报样本 + 增量决策行贴 #82/#67 comment；journal 会话 46（最后一个合并 PR 携带）；CHANGELOG | 中央 |

## 预分配（并行撞号预防）

- **D039** = #65 gate 3 decision（若今晚出）（E 轨独占写入权）；D036 复验读数**不新开 D 编号**（补记 D036 后续）
- 会话号 46；journal 末条 = 会话 45（已核对）

## 合并顺序与闸门

严格串行：**A → B → C（eval 批全部落库）→ D → E/F 文档 PR**。每个 PR：bot 自审三处核对（行内线程 / body 降级列表 / minor-nit 折叠段）→ 逐条闭环留痕 → 双 required check 绿 → 合并。

机制坑（四号夜实证，见 journal 43）：`mergeable_state=dirty` 静默跳过 Actions（先合 main 解冲突再等灯）；report.md/CHANGELOG.md 尾部追加连环冲突（逐个 rebase）；subagent 并发上限 2；清理 run 用精确路径（`rm *flash*` 误删教训）；同秒互覆已由文件名三段指纹 + `-plan` 后缀防住。

## 中央负责（subagent 不碰）

PR 创建/合并、issue 操作（#65 gate 3 出 decision 才 `Closes #65`；#80 完成即 `Closes #80`；#99/#100 按各自验收闸门）、eval 运行与配额、D039/D036 终稿、journal 会话 46、晨起总结。

## 降级预案

- 配额不足：保 C①（#65 加严，最便宜且解锁 #75 排期）→ C②③（新组首轮）→ C④ 砍为单轮或挪明晚（cheap-pair 复验不急，D036 前置三件套里它只占一件）
- A/B 轨实现受阻 → 放弃该轨其余照常（「能做几个做几个」）
- #99 首轮若 C 变体（轻视性 framing）意见数显著低于 A（≥30%）→ follow-up 开 issue 议 prompt 侧 framing 免疫，不当晚做
- D 轨若 C④ 拖过午夜 → D 转次日白天合并（它的校准表只需 1 个新基线 run，随时可补）

## 晨起收口清单

1. 全部 PR 合并、双 check 绿、分支清理（本地/远端）
2. `npm run prodlogs` 末次回收 + 台账 PR（chore）
3. journal 会话 46 + CHANGELOG 落库
4. issue 状态核对：#65（gate 3 后关）/ #80（关）/ #99 / #100 / #82 / #67 comment 留痕齐
5. 下一步候选写 journal「下一步」（自然时点：glm-flash 同期对照观察项、#73 排期解锁评估）
