# 生产 run 台账（prod-runs）

`ledger.json` = Vercel runtime log 解析出的生产审查台账，按 requestId 聚合、`runKey`（`#PR@sha`）归组同一次审查的多段请求（worker 阶段机 prepare/review/publish 各自独立调用）。

## 采集

```bash
npm run prodlogs                       # 拉最近 30m（CLI 默认窗），合并进 ledger.json
npm run prodlogs -- --seed <jsonl>     # 追加 dashboard 导出的 JSONL（窗口外历史）
npm run prodlogs -- --seed <jsonl> --seed-only   # 纯导入不实时拉取（端点不可达时）
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

## 裁定台账（rulings.jsonl）

`rulings.jsonl` = 本仓真实 PR 上 bot 意见的人工裁定台账（#140），JSONL 一行一裁定，由 `resolve:threads` 的 `--verdict` 落账、`--backfill` 列出已 resolve 线程供人工贴标后回填。用途：生产侧 precision 读数与 #73 reflect 的真实 FP 分布数据源。

行 schema（纯本地文件，随会话收尾按台账惯例 commit）：

```jsonc
{
  "ts": "2026-11-12T00:00:00.000Z",   // 裁定落账时间
  "repo": "owner/repo",
  "pr": 26,
  "threadCommentId": 4445269633,      // 线程首条（原意见）评论 databaseId——稳定幂等键；--only/--reply 用的末条 id 会随后续回复漂移，不做键（PR #144 bot major）
  "verdict": "fixed",                 // fixed=修复 | wontfix=回应不修 | false-positive=核实误报
  "reason": "一行理由",                // 裁定时的 --reply 原文；回填时引用线程内既有回复原文（verbatim，不做语义解析）
  "severity": "minor",                // 原意见 body 的 **[sev]** 前缀；非 bot 意见为 null
  "confidence": null,                 // GitHub 评论不渲染 confidence（发布层不渲染，D035/#100 口径），消费时从 RunRecord findings join
  "file": "evals/run.ts",             // 原意见定位（GitHub 评论自带 path/line）
  "line": 151,
  "permalink": "https://github.com/…", // 回复（或原意见）URL，可回放
  "source": "backfill"                // ruling=裁定即时落账 | backfill=历史回填
}
```

- 幂等：同 `(repo, pr, threadCommentId)` 已落账则跳过（回填重跑、resolve 重试安全）；append 逻辑纯函数（`appendRuling`）单测覆盖。
- 消费闸门：样本 ≥30 条前只积累不出读数；首个读数 = 按 severity × confidence 的生产 FP 率表，落 journal 并与 eval 侧 FP 分布对比。不是 reinforcement——数据不自动改 prompt，回流仍是人工 prompt 批次 + eval 红线。
