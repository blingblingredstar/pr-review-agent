import assert from "node:assert/strict";
import { test } from "node:test";
import { diffCoveredLines, withExtraBody } from "../src/review.ts";

test("withExtraBody：扩展字段合并进 JSON 请求体，显式配置优先", async () => {
  let captured: string | undefined;
  const fakeFetch = (async (_input: unknown, init?: { body?: string }) => {
    captured = init?.body;
    return new Response("{}");
  }) as unknown as typeof fetch;

  const doFetch = withExtraBody(fakeFetch, { thinking: { type: "disabled" }, temperature: 0.1 });
  await doFetch("https://example.test", { body: JSON.stringify({ model: "m", temperature: 0.7, messages: [] }) });

  assert.deepEqual(JSON.parse(captured!), {
    model: "m",
    messages: [],
    temperature: 0.1,
    thinking: { type: "disabled" },
  });
});

test("withExtraBody：非 JSON 请求体原样透传", async () => {
  let captured: unknown;
  const fakeFetch = (async (_input: unknown, init?: { body?: unknown }) => {
    captured = init?.body;
    return new Response("{}");
  }) as unknown as typeof fetch;

  await withExtraBody(fakeFetch, { thinking: { type: "disabled" } })("https://example.test", { body: "raw-bytes" });
  assert.equal(captured, "raw-bytes");
});

test("diffCoveredLines：收集各文件 hunk 覆盖的新侧行号", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,4 +10,5 @@",
    " ctx1",
    "+added line",
    " ctx2",
    "-removed",
    " ctx3",
    "diff --git a/src/b.ts b/src/b.ts",
    "index 3..4 100644",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -3,2 +3,3 @@",
    "keep",
    "+new",
  ].join("\n");
  const covered = diffCoveredLines(diff);
  const a = covered.get("src/a.ts")!;
  // 10=ctx1, 11=added, 12=ctx2, 13=ctx3（删除行不计），起始 hunk 上一行的伪影不存在
  assert.deepEqual([...a].sort((x, y) => x - y), [10, 11, 12, 13]);
  assert.deepEqual([...covered.get("src/b.ts")!].sort((x, y) => x - y), [3, 4]);
});

test("diffCoveredLines：b/ 前缀规范化，空 diff 返回空 Map", () => {
  const covered = diffCoveredLines("diff --git a/x.ts b/x.ts\n@@ -1,1 +1,1 @@\n- old\n+ new\n");
  assert.ok(covered.get("x.ts")!.has(1));
  assert.equal(diffCoveredLines("").size, 0);
});
