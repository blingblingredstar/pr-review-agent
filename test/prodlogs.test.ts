import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateRuns, mergeLedger, parseLogLine, summarize } from "../src/prodlogs.ts";

// fixture 取自真实生产日志（2026-11-04 #52/#53 三笔 run 的形态），字段与 vercel logs --json 一致
const L = (timestamp: string, requestId: string, message: string, level = "info") =>
  JSON.stringify({ type: "log", data: { timestamp, requestId, level, message, deploymentId: "dpl_x", environment: "production" } });

test("parseLogLine：非 JSON / 无 data / 缺字段容错返回 null", () => {
  assert.equal(parseLogLine("not json"), null);
  assert.equal(parseLogLine(JSON.stringify({ type: "summary" })), null);
  assert.equal(parseLogLine(JSON.stringify({ data: { timestamp: "t", requestId: "r" } })), null);
});

test("parseLogLine：dashboard 扁平形态（epoch 毫秒时间戳、无 data 包装）兼容", () => {
  const line = parseLogLine(
    JSON.stringify({ id: "01X", requestId: "req-d", timestamp: 1793814737107, level: "info", message: "[router] tokens: in 5865 / out 417", deploymentId: "dpl_1", environment: "production" }),
  );
  assert.ok(line);
  assert.equal(line.requestId, "req-d");
  assert.equal(line.timestamp, new Date(1793814737107).toISOString());
});

test("aggregateRuns：按 requestId 聚合，worker 行解析 PR/SHA/outcome，token 三路提取", () => {
  const rid = "req-1";
  const runs = aggregateRuns(
    [
      L("2026-11-04T17:46:00Z", rid, "[task] 无关联 issue（closing keywords 未命中），不注入任务块"),
      L("2026-11-04T17:46:05Z", rid, "[router] tokens: in 5828 / out 359"),
      L("2026-11-04T17:46:20Z", rid, "[tools] probe tokens: in 43253 / out 522 / total 43775"),
      L("2026-11-04T17:46:25Z", rid, '[tools] step 1: search "runReviewRouter" (10 files / 18 matches)'),
      L("2026-11-04T17:46:26Z", rid, "[tools] step 2: read src/router.ts (5470 chars)"),
      L("2026-11-04T17:47:00Z", rid, "[reviewDiff] tokens（两段合计）: in 89812 / out 1602 / total 91414"),
      L("2026-11-04T17:47:10Z", rid, "[worker] blingblingredstar/pr-review-agent#53@aa692ea 完成：0 条行内（进线程可闭环），1 条降级进 body"),
    ].map(parseLogLine),
  );
  const run = runs[rid]!;
  assert.equal(run.pr, 53);
  assert.equal(run.runKey, "#53@aa692ea");
  assert.equal(run.headSha, "aa692ea");
  assert.deepEqual(run.outcome, { inline: 0, degraded: 1 });
  assert.deepEqual(run.routerTokens, { in: 5828, out: 359 });
  assert.deepEqual(run.probeTokens, { in: 43253, out: 522 });
  assert.deepEqual(run.reviewTokens, { in: 89812, out: 1602, total: 91414 });
  assert.equal(run.toolCalls.length, 2);
  assert.equal(run.toolCalls[0]!.kind, "search");
  assert.equal(run.durationMs, 70_000);
  assert.equal(run.timeout, false);
  assert.equal(run.task, "无关联 issue（closing keywords 未命中），不注入任务块");
});

test("aggregateRuns：warn 进 warnings、超时行打标、截断/上下文提取", () => {
  const runs = aggregateRuns(
    [
      L("2026-11-04T18:00:00Z", "req-2", "[github] REQUEST_CHANGES 被拒（422 自家 PR 或行号非法），回退 COMMENT", "warn"),
      L("2026-11-04T18:00:05Z", "req-2", "[truncateDiff] 预算 300000 字符：50 个文件块保留 44 个、省略 6 个"),
      L("2026-11-04T18:00:06Z", "req-2", "[context] 上下文注入：触及 50 个文件 / 快照 292 个文件 / 99982 字符（预算 100000）"),
    ].map(parseLogLine),
  );
  const run = runs["req-2"]!;
  assert.equal(run.warnings.length, 1);
  assert.equal(run.truncation, "预算 300000 字符：50 个文件块保留 44 个、省略 6 个");
  assert.match(run.context!, /触及 50 个文件/);
});

test("aggregateRuns：超时 run 打标（D011 路径）", () => {
  const runs = aggregateRuns(
    [L("2026-11-04T19:00:00Z", "req-3", "[worker] x/y#9@abcdef0 完成：0 条行内，0 条降级"), L("2026-11-04T19:00:01Z", "req-3", "[github] 🤖 pr-review-agent 审查超时：LLM 端点 270s 未返回，本次跳过。")].map(parseLogLine),
  );
  assert.equal(runs["req-3"]!.timeout, true);
});

test("mergeLedger：requestId 合并、新记录覆盖旧记录、fetchedAt 更新", () => {
  const a = aggregateRuns([parseLogLine(L("2026-11-04T17:00:00Z", "r1", "[router] tokens: in 1 / out 1"))!]!);
  const b = aggregateRuns([
    parseLogLine(L("2026-11-04T17:00:00Z", "r1", "[router] tokens: in 1 / out 1"))!,
    parseLogLine(L("2026-11-04T17:00:05Z", "r1", "[reviewDiff] tokens: in 100 / out 5"))!,
    parseLogLine(L("2026-11-04T17:01:00Z", "r2", "[worker] x/y#1@abc 完成：0 条行内，0 条降级"))!,
  ])!;
  const merged = mergeLedger({ fetchedAt: "old", runs: a }, b, "new");
  assert.equal(merged.fetchedAt, "new");
  assert.equal(Object.keys(merged.runs).length, 2);
  assert.equal(merged.runs["r1"]!.reviewTokens!.in, 100, "同 requestId 新记录覆盖");
});

test("summarize：机械出口含 run 数/完成数/超时/工具 run 数", () => {
  const b = aggregateRuns([
    parseLogLine(L("2026-11-04T17:00:00Z", "r1", "[worker] x/y#7@aaa0000 主评审预算 200000ms"))!,
    parseLogLine(L("2026-11-04T17:00:02Z", "r1", "[reviewDiff] tokens: in 100 / out 5"))!,
    parseLogLine(L("2026-11-04T17:00:05Z", "r1", '[tools] step 1: read src/a.ts (100 chars)'))!,
    parseLogLine(L("2026-11-04T17:01:00Z", "r2", "[worker] x/y#1@abc 完成：0 条行内，0 条降级"))!,
  ])!;
  const s = summarize(mergeLedger(null, b, "t"));
  assert.match(s, /审查 2 次（完成 1，超时 0）/);
  assert.match(s, /review in 100 \/ out 5/);
  assert.match(s, /带工具调用审查 1 次/);
});

test("summarize：prepare 段（runKey=null）不计入审查数、单列未归组（自审 major 口径）", () => {
  const b = aggregateRuns([
    parseLogLine(L("2026-11-04T17:00:00Z", "prep", "[task] 无关联 issue（closing keywords 未命中），不注入任务块"))!,
    parseLogLine(L("2026-11-04T17:00:01Z", "prep", "[context] 上下文注入：触及 3 个文件 / 快照 244 个文件 / 50582 字符（预算 100000）"))!,
    parseLogLine(L("2026-11-04T17:00:09Z", "rev", "[worker] x/y#1@abc 主评审预算 250000ms"))!,
    parseLogLine(L("2026-11-04T17:00:30Z", "rev", "[reviewDiff] tokens: in 20000 / out 500"))!,
    parseLogLine(L("2026-11-04T17:00:40Z", "pub", "[worker] x/y#1@abc 完成：0 条行内，0 条降级"))!,
  ])!;
  const s = summarize(mergeLedger(null, b, "t"));
  assert.match(s, /审查 1 次（完成 1，超时 0）/, "rev+pub 同 #1@abc 归组为 1 次审查，prepare 段不独立计数");
  assert.match(s, /未归组段 1/, "prepare 段单列不消失");
  assert.match(s, /review in 20000 \/ out 500/, "token 统计不丢");
});

test("summarize：意见落点三计数进指标——folded/派生覆盖（#65 闸门 2，#89 口径）", () => {
  const b = aggregateRuns([
    parseLogLine(L("2026-11-06T17:00:00Z", "r1", "[worker] x/y#7@aaa0000 主评审预算 200000ms"))!,
    parseLogLine(L("2026-11-06T17:00:05Z", "r1", "[worker] x/y#7@aaa0000 完成：2 条行内（进线程可闭环），1 条降级进 body"))!,
    parseLogLine(L("2026-11-06T17:01:00Z", "r2", "[worker] x/y#1@bbb1111 完成：0 条行内，1 条降级进 body"))!,
  ])!;
  // r1 的 outcome 换成 GitHub 派生值（#89：日志完成行不带 folded，只有派生口径能补齐）
  b["r1"]!.outcome = { inline: 2, degraded: 1, folded: 3, source: "github" };
  const s = summarize(mergeLedger(null, b, "t"));
  // r1（派生：2/1/3）+ r2（日志：0/1，folded/source 缺省）= 行内 2 / 降级 2 / 折叠 3，派生 1 run
  assert.match(s, /意见落点：行内 2 \/ 降级 2 \/ 折叠 3（#89 派生口径 1 run）/);
});

test("mergeLedger：字段级合并——跨窗口的同一 requestId 不丢已捕获字段（自审 major 口径）", () => {
  // 第一次抓到 review 段（tokens + tools），第二次同 requestId 只剩 publish 段（outcome），
  // 整记录覆盖会丢 tokens/toolCalls——字段级合并必须保留
  const first = aggregateRuns([
    parseLogLine(L("2026-11-04T17:00:00Z", "r1", "[worker] x/y#1@abc 主评审预算 250000ms"))!,
    parseLogLine(L("2026-11-04T17:00:30Z", "r1", "[reviewDiff] tokens: in 20000 / out 500"))!,
    parseLogLine(L("2026-11-04T17:00:31Z", "r1", '[tools] step 1: read src/a.ts (100 chars)'))!,
  ])!;
  const second = aggregateRuns([
    parseLogLine(L("2026-11-04T17:00:40Z", "r1", "[worker] x/y#1@abc 完成：0 条行内，0 条降级"))!,
  ])!;
  const merged = mergeLedger({ fetchedAt: "t0", runs: first }, second, "t1");
  const run = merged.runs["r1"]!;
  assert.deepEqual(run.reviewTokens, { in: 20000, out: 500 }, "整记录覆盖会丢 tokens");
  assert.equal(run.toolCalls.length, 1, "整记录覆盖会丢 toolCalls");
  assert.deepEqual(run.outcome, { inline: 0, degraded: 0 }, "新捕获的 outcome 落位");
  assert.equal(run.durationMs, 40_000, "时间窗取并集");
});
