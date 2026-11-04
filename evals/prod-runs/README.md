# 生产 run 台账（prod-runs）

`ledger.json` = Vercel runtime log 解析出的生产审查台账，按 requestId 聚合、`runKey`（`#PR@sha`）归组同一次审查的多段请求（worker 阶段机 prepare/review/publish 各自独立调用）。

## 采集

```bash
npm run prodlogs                       # 拉最近 30m（CLI 默认窗），合并进 ledger.json
npm run prodlogs -- --seed <jsonl>     # 追加 dashboard 导出的 JSONL（窗口外历史）
```

- **Hobby 保留期 ~30 分钟**：`--since 1h` 会报 "outside the available retention"。想不丢数据就勤跑——台账按 requestId 合并，重复执行安全，跑得越勤台账越全。
- 解析/聚合/合并逻辑在 `src/prodlogs.ts`（纯函数，`test/prodlogs.test.ts` 覆盖）；台账为只读采集，零 LLM 调用。
- 台账入库 git：这是 Step 4 门槛（≥10 run）与成本/行为观测的机械出口，替代手贴 dashboard 截图。

## 口径

- **审查次数** = distinct `runKey`（不是 requestId）；**完成** = 该 runKey 任意段出现「完成：N 条行内，M 条降级」行。
- **prepare 段不计数**：只有 `[task]`/`[context]`/`[snapshot]` 行的 requestId 没有 `[worker]` 行（日志本身不携带 pr/sha、与审查段无 requestId 关联），`runKey=null` 在汇总中单列为「未归组段」——不算审查次数，防 Step 4 门槛虚增。
- `reviewTokens` = `[reviewDiff] tokens`（两段合计或单段，SDK 返回值）；`routerTokens` = D028 路由段；`probeTokens` = 工具循环第一段。token 数据全部落在带 `[worker]` 行的段上（prepare 段无 token 输出），排除不丢数。
- `timeout=true` = 命中超时路径（D011 优雅跳过 / postTimeoutNotice）。
- 2026-11-04 前的历史 run（#51 两笔等）只有 dashboard 截图，未入机器台账（数字在 journal 会话 38）。
