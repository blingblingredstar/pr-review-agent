import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyDerivedOutcomes,
  deriveOutcomeForRuns,
  latestReviewForSha,
  parseFoldedLines,
  type DeriveGithubClient,
  type DerivedOutcome,
} from "../src/prod-runs-derived.ts";
import { aggregateRuns, mergeLedger, parseLogLine, type ProdRun } from "../src/prodlogs.ts";

// marker 与 body 形态照抄生产发射端：标记 = dedupe.reviewMarker（sha 全量 40 位，增量带 base）；
// 降级列表 = `- \`file:line\` **[severity]** 全文`；折叠段 = <details> 内同构单行（D032 github.ts postReview）
const MARKER = (sha: string, base?: string) =>
  base ? `<!-- pr-review-agent sha:${sha} base:${base} -->` : `<!-- pr-review-agent sha:${sha} -->`;

// 40 位全量 sha（台账侧日志行只带前 7 位 05c4473）
const FULL_SHA = "05c4473abcdef0123456789abcdef0123456789";

const BODY = (sha: string, base?: string) =>
  [
    "🤖 pr-review-agent 审查报告",
    MARKER(sha, base),
    "",
    "> 以下意见的行号不在 diff 内，无法行内定位（无法进入意见闭环线程），处理时请对照文件：",
    "- `src/a.ts:42` **[major]** 降级意见一",
    "",
    "<details>",
    "<summary>minor/nit ×2（不进线程闭环，处置口径见 AGENTS.md「意见闭环」）</summary>",
    "",
    "- `src/b.ts:7` **[minor]** 折叠意见一",
    "- `src/c.ts:9` **[nit]** 折叠意见二",
    "</details>",
  ].join("\n");

const L = (timestamp: string, requestId: string, message: string, level = "info") =>
  JSON.stringify({ type: "log", data: { timestamp, requestId, level, message, deploymentId: "dpl_x", environment: "production" } });

const run = (over: Partial<ProdRun>): ProdRun => ({
  startedAt: "2026-11-04T17:51:46.809Z",
  finishedAt: "2026-11-04T17:52:16.023Z",
  durationMs: 29214,
  pr: 87,
  headSha: "05c4473",
  runKey: null,
  routerTokens: null,
  probeTokens: null,
  reviewTokens: { in: 88512, out: 853, total: 89365 },
  toolRequests: null,
  toolCalls: [],
  task: null,
  context: null,
  truncation: null,
  warnings: [],
  outcome: null,
  timeout: false,
  deploymentId: "dpl_x",
  environment: "production",
  ...over,
});

// mock client：直填 DeriveGithubClient 结构，带调用计数（分组共享 / 不参与派生的断言用）。
// comments 值可为 Error（按 review id 定向注错——失败隔离断言用）
const mkClient = (
  reviews: { id: number; body: string; submitted_at?: string | null; reactions?: { "+1"?: number; "-1"?: number } }[] | Error,
  comments: Record<number, unknown[] | Error> = {},
): { client: DeriveGithubClient; calls: { listReviews: number; listComments: number; commentIds: number[] } } => {
  const calls = { listReviews: 0, listComments: 0, commentIds: [] as number[] };
  return {
    calls,
    client: {
      rest: {
        pulls: {
          listReviews: async () => {
            calls.listReviews++;
            if (reviews instanceof Error) throw reviews;
            return { data: reviews };
          },
          listCommentsForReview: async ({ review_id }) => {
            calls.listComments++;
            calls.commentIds.push(review_id);
            const c = comments[review_id];
            if (c instanceof Error) throw c;
            return { data: c ?? [] };
          },
        },
      },
    },
  };
};

test("parseFoldedLines：details 内 minor/nit 逐条计数，details 外与降级单行不计", () => {
  const body = [
    MARKER(FULL_SHA),
    "- `src/a.ts:42` **[major]** 降级（severity 分支排除）",
    "- `src/x.ts:1` **[minor]** details 外的 minor（不计数）",
    "",
    "<details>",
    "<summary>minor/nit ×2</summary>",
    "",
    "- `src/b.ts:7` **[minor]** 折叠一",
    "- `src/c.ts:9` **[nit]** 折叠二",
    "</details>",
  ].join("\n");
  assert.equal(parseFoldedLines(body), 2);
  assert.equal(parseFoldedLines("无折叠段 body"), 0);
});

test("latestReviewForSha：marker 全量 sha 与台账 7 位短 sha 前缀匹配；增量标记 base 后缀不挡匹配", () => {
  const reviews = [{ id: 1001, body: BODY(FULL_SHA, "aaaaaaa") }];
  const hit = latestReviewForSha(reviews, "05c4473");
  assert.ok(hit);
  assert.equal(hit.id, 1001);
  assert.equal(latestReviewForSha(reviews, "9999999"), null, "别的 sha 不匹配");
});

test("latestReviewForSha：同 sha 多条标记（重派/增量）取 submitted_at 最新", () => {
  const reviews = [
    { id: 2001, body: BODY(FULL_SHA), submitted_at: "2026-11-04T17:00:00Z" },
    { id: 2002, body: BODY(FULL_SHA), submitted_at: "2026-11-04T18:00:00Z" },
  ];
  const hit = latestReviewForSha(reviews, "05c4473");
  assert.ok(hit);
  assert.equal(hit.id, 2002, "取最新 submitted_at");
  assert.equal(latestReviewForSha([], "05c4473"), null, "无 review → null（outcome 不动）");
});

test("deriveOutcomeForRuns：命中 review → 派生三格 + source github（inline=comments 数、degraded=body 降级行、folded=折叠行）", async () => {
  const { client, calls } = mkClient([{ id: 1001, body: BODY(FULL_SHA) }], { 1001: [{ id: 1 }, { id: 2 }, { id: 3 }] });
  const derived = await deriveOutcomeForRuns([run({ runKey: "#87@05c4473" })], client, { delayMs: 0 });
  assert.deepEqual(derived.get("#87@05c4473"), { inline: 3, degraded: 1, folded: 2, source: "github", reactions: { plus: 0, minus: 0 } });
  assert.equal(calls.listReviews, 1);
  assert.deepEqual(calls.commentIds, [1001]);
});

test("deriveOutcomeForRuns：无匹配 review → 该 runKey 不进派生结果（outcome 保持日志值/null 不动）", async () => {
  const { client } = mkClient([{ id: 1001, body: BODY("9999999ffff0123456789abcdef0123456789") }], { 1001: [{ id: 1 }] });
  const derived = await deriveOutcomeForRuns([run({ runKey: "#87@05c4473", outcome: { inline: 0, degraded: 0 } })], client, { delayMs: 0 });
  assert.equal(derived.size, 0);
});

test("deriveOutcomeForRuns：0/0 脏值 run 命中真实意见 → 派生覆盖，apply 后带 folded/source", async () => {
  const { client } = mkClient([{ id: 1001, body: BODY(FULL_SHA) }], { 1001: [{ id: 1 }, { id: 2 }] });
  const runs = { "req-pub": run({ runKey: "#87@05c4473", outcome: { inline: 0, degraded: 0 } }) };
  const derived = await deriveOutcomeForRuns(Object.values(runs), client, { delayMs: 0 });
  const applied = applyDerivedOutcomes(runs, derived);
  assert.equal(applied, 1);
  const want = { inline: 2, degraded: 1, folded: 2, source: "github" };
  assert.deepEqual(runs["req-pub"]!.outcome, want);
});

test("deriveOutcomeForRuns：listReviews 失败（网络/权限）→ 保留日志值不覆盖、不抛出", async () => {
  const { client } = mkClient(new Error("network down"));
  const runs = { r1: run({ runKey: "#87@05c4473", outcome: { inline: 0, degraded: 0 } }) };
  const derived = await deriveOutcomeForRuns(Object.values(runs), client, { delayMs: 0 });
  assert.equal(derived.size, 0);
  applyDerivedOutcomes(runs, derived);
  assert.deepEqual(runs["r1"]!.outcome, { inline: 0, degraded: 0 }, "日志值原样保留");
});

test("deriveOutcomeForRuns：listComments 失败只废该 runKey，同 PR 其余 runKey 照常派生（失败隔离）", async () => {
  const { client } = mkClient(
    [
      { id: 1001, body: BODY(FULL_SHA), submitted_at: "2026-11-04T17:00:00Z" },
      { id: 1002, body: BODY("80268e2ffff0123456789abcdef0123456789"), submitted_at: "2026-11-04T17:30:00Z" },
    ],
    { 1001: new Error("comments boom"), 1002: [{ id: 9 }] },
  );
  const derived = await deriveOutcomeForRuns(
    [run({ runKey: "#87@05c4473", outcome: { inline: 0, degraded: 0 } }), run({ runKey: "#87@80268e2", headSha: "80268e2" })],
    client,
    { delayMs: 0 },
  );
  assert.equal(derived.has("#87@05c4473"), false, "comments 失败的 runKey 保留日志值");
  assert.deepEqual(derived.get("#87@80268e2"), { inline: 1, degraded: 1, folded: 2, source: "github", reactions: { plus: 0, minus: 0 } });
});

test("deriveOutcomeForRuns：runKey 去重——同 runKey 多段记录只派生一次；apply 覆盖该 runKey 全部记录（publish 段脏值一并纠正）", async () => {
  const { client, calls } = mkClient([{ id: 1001, body: BODY(FULL_SHA) }], { 1001: [{ id: 1 }, { id: 2 }] });
  const runs = {
    "req-review": run({ runKey: "#87@05c4473", outcome: null }), // review 段：outcome 没抓到
    "req-publish": run({ runKey: "#87@05c4473", reviewTokens: null, outcome: { inline: 0, degraded: 0 } }), // publish 段：脏 0/0
  };
  const derived = await deriveOutcomeForRuns(Object.values(runs), client, { delayMs: 0 });
  assert.equal(calls.listReviews, 1);
  assert.equal(calls.listComments, 1, "每 runKey 去重：派生只调一次");
  const applied = applyDerivedOutcomes(runs, derived);
  assert.equal(applied, 2, "同 runKey 全部记录统一口径");
  const want = { inline: 2, degraded: 1, folded: 2, source: "github" };
  assert.deepEqual(runs["req-review"]!.outcome, want);
  assert.deepEqual(runs["req-publish"]!.outcome, want);
});

test("deriveOutcomeForRuns：runKey/reviewTokens 缺席的记录不参与派生（零 API 调用）", async () => {
  const { client, calls } = mkClient([{ id: 1001, body: BODY(FULL_SHA) }]);
  const derived = await deriveOutcomeForRuns(
    [
      run({ runKey: null, reviewTokens: { in: 1, out: 1 } }), // prepare 段
      run({ runKey: "#87@05c4473", reviewTokens: null }), // 审查段没跑完（超时 run）
    ],
    client,
    { delayMs: 0 },
  );
  assert.equal(derived.size, 0);
  assert.equal(calls.listReviews, 0);
  assert.equal(calls.listComments, 0);
});

test("deriveOutcomeForRuns：同 PR 多个 runKey 共享一次 listReviews（按 PR 分组，#87 四连审场景）", async () => {
  const { client, calls } = mkClient(
    [
      { id: 1001, body: BODY(FULL_SHA), submitted_at: "2026-11-04T17:00:00Z" },
      { id: 1002, body: BODY("80268e2ffff0123456789abcdef0123456789"), submitted_at: "2026-11-04T17:30:00Z" },
    ],
    { 1001: [{ id: 1 }], 1002: [{ id: 2 }, { id: 3 }] },
  );
  const derived = await deriveOutcomeForRuns(
    [run({ runKey: "#87@05c4473" }), run({ runKey: "#87@80268e2", headSha: "80268e2" })],
    client,
    { delayMs: 0 },
  );
  assert.equal(calls.listReviews, 1, "同 PR 只拉一次 reviews");
  assert.equal(calls.listComments, 2);
  assert.equal(derived.size, 2);
});

test("deriveOutcomeForRuns：LEDGER_GITHUB_REPO 非法形态显式报错", async () => {
  const { client } = mkClient([]);
  await assert.rejects(() => deriveOutcomeForRuns([run({ runKey: "#87@05c4473" })], client, { repo: "no-slash", delayMs: 0 }), /owner\/repo/);
});

test("mergeRuns 不回归：派生 outcome（folded/source 两格）经字段级合并保留，且 prev 派生值赢过新抓日志值", () => {
  const prev: Record<string, ProdRun> = { r1: run({ runKey: "#1@abc", outcome: { inline: 3, degraded: 1, folded: 2, source: "github" } }) };
  const fresh = aggregateRuns([parseLogLine(L("2026-11-04T17:00:00Z", "r1", "[worker] x/y#1@abc 完成：0 条行内，0 条降级"))!]!);
  const merged = mergeLedger({ fetchedAt: "t0", runs: prev }, fresh, "t1");
  const want = { inline: 3, degraded: 1, folded: 2, source: "github" };
  assert.deepEqual(merged.runs["r1"]!.outcome, want, "prev 非空 outcome 赢（a ?? b），两格扩展字段随对象整体保留");
});

test("#106 reactions：review body + 行内评论两面的 👍/👎 聚合（缺格按 0，零新增调用）", async () => {
  const { client } = mkClient(
    [{ id: 1001, body: BODY(FULL_SHA), reactions: { "+1": 2, "-1": 1 } }],
    { 1001: [{ id: 1, reactions: { "+1": 3, "-1": 0 } }, { id: 2 }, { id: 3, reactions: { "+1": 0, "-1": 4 } }] },
  );
  const runs = [run({ runKey: "#87@05c4473", reviewTokens: { in: 1, out: 1 }, pr: 87, headSha: "05c4473" })];
  const derived = await deriveOutcomeForRuns(runs, client, { delayMs: 0 });
  assert.deepEqual(derived.get("#87@05c4473")!.reactions, { plus: 5, minus: 5 }, "body 2/1 + 评论 3/4 求和；缺格评论按 0");
  const ledgerRuns = { req: run({ runKey: "#87@05c4473", outcome: { inline: 0, degraded: 0 } }) };
  applyDerivedOutcomes(ledgerRuns, derived);
  assert.deepEqual(ledgerRuns["req"]!.reactions, { plus: 5, minus: 5 });
  assert.deepEqual(ledgerRuns["req"]!.outcome, { inline: 3, degraded: 1, folded: 2, source: "github" }, "outcome 不夹带 reactions");
});
