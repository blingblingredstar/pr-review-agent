import assert from "node:assert/strict";
import { test } from "node:test";
import type { Octokit } from "octokit";
import {
  decideIncrement,
  fetchDeltaDiff,
  hasBlockerOrMajor,
  listBotReviews,
  listCommitShas,
  parseBotReviews,
  type BotReview,
} from "../src/incremental.ts";
import { reviewMarker } from "../src/dedupe.ts";

const botReview = (over: Partial<BotReview> = {}): BotReview => ({
  id: 1,
  sha: "aaaa1111",
  base: null,
  submittedAt: "2026-11-05T00:00:00Z",
  body: "🤖 pr-review-agent 审查意见（共 0 条）\n\n<!-- pr-review-agent sha:aaaa1111 -->",
  ...over,
});

const review = (over: Partial<BotReview> = {}) => botReview(over);

test("parseBotReviews：新形态 sha+base / 旧形态 / 多标记 / 非字符串 body / 人工 review 无标记", () => {
  const parsed = parseBotReviews([
    { id: 1, body: `x\n${reviewMarker("aaaa1111", "bbbb2222")}\ny`, submitted_at: "2026-11-05T00:00:00Z" },
    { id: 2, body: `意见\n${reviewMarker("cccc3333")}`, submitted_at: "2026-11-04T00:00:00Z" },
    { id: 3, body: "人工 review，无标记", submitted_at: "2026-11-04T00:00:00Z" },
    { id: 4, body: null },
    { id: 5, body: `${reviewMarker("dddd4444")} ${reviewMarker("eeee5555")}`, submitted_at: "2026-11-03T00:00:00Z" },
  ]);
  assert.deepEqual(
    parsed.map((r) => [r.id, r.sha, r.base]),
    [
      [1, "aaaa1111", "bbbb2222"],
      [2, "cccc3333", null],
      [5, "dddd4444", null],
      [5, "eeee5555", null],
    ],
    "容忍多标记（各产出独立条目）、跳过无标记/非字符串 body",
  );
});

test("hasBlockerOrMajor：summary 行 blocker×N / 折叠与降级行 **[major]** 命中；纯 minor/nit 不命中", () => {
  assert.ok(hasBlockerOrMajor("共 3 条：blocker×1 / minor×2"));
  assert.ok(hasBlockerOrMajor("- `a.ts:1` **[major]** 问题"));
  assert.ok(hasBlockerOrMajor("major×2 / nit×1"));
  assert.ok(!hasBlockerOrMajor("共 2 条：minor×1 / nit×1"));
  assert.ok(!hasBlockerOrMajor("共 0 条"));
});

test("decideIncrement：skip（head 已审）/ full（无有效标记）/ full（block 继承）/ delta", () => {
  const commits = new Set(["aaaa1111", "bbbb2222", "cccc3333"]);
  // head 已审 → skip（dedupe 命中，与 D010 同语义）
  assert.equal(decideIncrement({ headSha: "cccc3333", reviews: [review({ sha: "cccc3333" })], commitShas: commits }).mode, "skip");
  // 无标记 → full（首审）
  assert.equal(decideIncrement({ headSha: "cccc3333", reviews: [], commitShas: commits }).mode, "full");
  // 标记全被 force-push 清出 commits 列表 → full
  const stale = decideIncrement({ headSha: "cccc3333", reviews: [review({ sha: "dead0000" })], commitShas: commits });
  assert.equal(stale.mode, "full");
  assert.match((stale as { reason: string }).reason, /force-push|首审/);
  // 最新有效 review 含 blocker/major → full（block 继承）
  const blocking = decideIncrement({
    headSha: "cccc3333",
    reviews: [review({ sha: "aaaa1111", submittedAt: "2026-11-05T00:00:00Z", body: "blocker×1" }), review({ sha: "bbbb2222", submittedAt: "2026-11-04T00:00:00Z" })],
    commitShas: commits,
  });
  assert.equal(blocking.mode, "full");
  assert.match((blocking as { reason: string }).reason, /block 继承/);
  // 干净 → delta，base = 最新有效
  const delta = decideIncrement({
    headSha: "cccc3333",
    reviews: [review({ sha: "aaaa1111", submittedAt: "2026-11-05T00:00:00Z" }), review({ sha: "bbbb2222", submittedAt: "2026-11-04T00:00:00Z" })],
    commitShas: commits,
  });
  assert.deepEqual(delta, { mode: "delta", base: "aaaa1111", latestReviewId: 1 });
});

test("decideIncrement：force-push 边界——最新标记被清出历史，落在次新有效一条（与 base 同源同滤）", () => {
  const commits = new Set(["aaaa1111", "cccc3333"]);
  // bbbb2222 最新但已不在 commits；次新 aaaa1111 有效且干净 → delta base=aaaa1111
  const d = decideIncrement({
    headSha: "cccc3333",
    reviews: [review({ id: 2, sha: "bbbb2222", submittedAt: "2026-11-06T00:00:00Z" }), review({ id: 1, sha: "aaaa1111", submittedAt: "2026-11-05T00:00:00Z" })],
    commitShas: commits,
  });
  assert.deepEqual(d, { mode: "delta", base: "aaaa1111", latestReviewId: 1 });
  // 次新有效一条含 blocker → full（不因更新的失效 review 干净而放行）
  const f = decideIncrement({
    headSha: "cccc3333",
    reviews: [
      review({ id: 2, sha: "bbbb2222", submittedAt: "2026-11-06T00:00:00Z" }),
      review({ id: 1, sha: "aaaa1111", submittedAt: "2026-11-05T00:00:00Z", body: "major×1" }),
    ],
    commitShas: commits,
  });
  assert.equal(f.mode, "full");
});

// 最小 fake octokit：paginate 走注入表，rest.repos.compareCommits 返回 files
function fakeClient(opts: { reviews?: unknown[]; commits?: unknown[]; files?: unknown[]; fail?: boolean } = {}) {
  const calls: { compare?: { base: string; head: string } } = {};
  const client = {
    paginate: async (fn: unknown) => {
      const name = (fn as { name?: string }).name ?? "";
      if (name.includes("listReviews")) return opts.reviews ?? [];
      if (name.includes("listCommits")) return opts.commits ?? [];
      return [];
    },
    rest: {
      repos: {
        compareCommits: async (args: { base: string; head: string }) => {
          if (opts.fail) throw new Error("boom");
          calls.compare = { base: args.base, head: args.head };
          return { data: { files: opts.files ?? [] } };
        },
      },
      // paginate 按 fn.name 分发，rest.pulls 的函数需存在（实体被 paginate 拦截，不会真调）
      pulls: {
        listReviews: async () => ({ data: [] }),
        listCommits: async () => ({ data: [] }),
      },
    },
  } as unknown as Octokit;
  return { client, calls };
}

test("listBotReviews / listCommitShas / fetchDeltaDiff：fake octokit 端到端（compare files 走 fileToDiffBlock 同形拼装）", async () => {
  const { client, calls } = fakeClient({
    reviews: [{ id: 7, body: reviewMarker("aaaa1111"), submitted_at: "2026-11-05T00:00:00Z" }],
    commits: [{ sha: "aaaa1111" }, { sha: "cccc3333" }],
    files: [
      { filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1,1 +1,2 @@\n ctx\n+added" },
      { filename: "src/removed.ts", status: "removed", additions: 0, deletions: 2, previous_filename: "src/removed.ts", patch: "@@ -1,2 +0,0 @@\n-a\n-b" },
    ],
  });
  const reviews = await listBotReviews(client, { owner: "o", repo: "r", pullNumber: 1 });
  assert.deepEqual(reviews.map((r) => r.sha), ["aaaa1111"]);
  const shas = await listCommitShas(client, { owner: "o", repo: "r", pullNumber: 1 });
  assert.deepEqual([...shas].sort(), ["aaaa1111", "cccc3333"]);
  const diff = await fetchDeltaDiff(client, { owner: "o", repo: "r", pullNumber: 1, headSha: "cccc3333" }, "aaaa1111");
  assert.equal(calls.compare!.base, "aaaa1111");
  assert.equal(calls.compare!.head, "cccc3333");
  assert.ok(diff.startsWith("diff --git a/src/a.ts b/src/a.ts"));
  assert.ok(diff.includes("--- a/src/a.ts") && diff.includes("+++ b/src/a.ts"), "修改文件标准头");
  assert.ok(diff.includes("+++ /dev/null"), "删除文件走既有语义（行内评论必 422 的文件）");
  assert.ok(diff.includes("@@ -1,1 +1,2 @@"), "patch 原样进入块");
});

test("fetchDeltaDiff：空区间 / 超单响应上限 / API 失败 → 上抛（worker 回退全量）", async () => {
  const empty = fakeClient({ files: [] });
  await assert.rejects(() => fetchDeltaDiff(empty.client, { owner: "o", repo: "r", pullNumber: 1, headSha: "h" }, "b"), /空区间/);
  const many = fakeClient({ files: Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts`, status: "modified", additions: 0, deletions: 0, patch: "@@ -1,1 +1,1 @@\n+x" })) });
  await assert.rejects(() => fetchDeltaDiff(many.client, { owner: "o", repo: "r", pullNumber: 1, headSha: "h" }, "b"), /单响应上限/);
  const boom = fakeClient({ fail: true });
  await assert.rejects(() => fetchDeltaDiff(boom.client, { owner: "o", repo: "r", pullNumber: 1, headSha: "h" }, "b"), /boom/);
});
