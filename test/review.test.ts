import assert from "node:assert/strict";
import { test } from "node:test";
import { diffCoveredLines, pathVariants, unquoteGitPath, withExtraBody } from "../src/review.ts";

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

test("diffCoveredLines：引号路径的八进制转义解码", () => {
  // "中文.md" 的 UTF-8 字节被 quotePath 编成八进制
  const oct = [..."中文.md"].flatMap((ch) => [...Buffer.from(ch, "utf8")].map((b) => `\\${b.toString(8)}`)).join("");
  const diff = [
    `diff --git "a/docs/${oct}" "b/docs/${oct}"`,
    "index 1..2 100644",
    `--- "a/docs/${oct}"`,
    `+++ "b/docs/${oct}"`,
    "@@ -1,1 +1,2 @@",
    " ctx",
    "+new",
  ].join("\n");
  const covered = diffCoveredLines(diff);
  assert.ok(covered.get("docs/中文.md")!.has(2), `实际 key: ${[...covered.keys()].join(", ")}`);
});

test("diffCoveredLines：hunk 内以 ++ /dev/null 开头的新增行不误判为删除文件", () => {
  const diff = [
    "diff --git a/x.md b/x.md",
    "index 1..2 100644",
    "--- a/x.md",
    "+++ b/x.md",
    "@@ -1,2 +1,3 @@",
    " ctx",
    "+++ /dev/null",
    "+after",
  ].join("\n");
  const covered = diffCoveredLines(diff);
  assert.ok(covered.get("x.md")!.has(3), "hunk 内容行不应重置 file");
});

test("pathVariants：原样 + 剥 a/ + 剥 b/ 三种变体", () => {
  assert.deepEqual(pathVariants("src/x.ts"), ["src/x.ts", "src/x.ts", "src/x.ts"]);
  assert.deepEqual(pathVariants("a/src/x.ts"), ["a/src/x.ts", "src/x.ts", "a/src/x.ts"]);
  assert.deepEqual(pathVariants("b/a/x.ts"), ["b/a/x.ts", "b/a/x.ts", "a/x.ts"]);
});

test("unquoteGitPath：无引号带转义也解码（正则消费引号后的输入形态），无转义原样返回", () => {
  assert.equal(unquoteGitPath("b/docs/\\344\\270\\255.md"), "b/docs/中.md");
  assert.equal(unquoteGitPath("plain/path.ts"), "plain/path.ts");
});

test("diffCoveredLines：引号内含转义引号的路径不切错侧", () => {
  // git 对路径内引号字符转义为 \"：(?:[^"\\]|\\.)* 不会跨引号
  const diff = [
    'diff --git "a/we\\"ird.ts" "b/we\\"ird.ts"',
    "index 1..2 100644",
    '--- "a/we\\"ird.ts"',
    '+++ "b/we\\"ird.ts"',
    "@@ -1,1 +1,2 @@",
    " ctx",
    "+new",
  ].join("\n");
  const covered = diffCoveredLines(diff);
  assert.ok(covered.has('we"ird.ts'), `实际 key: ${[...covered.keys()].join(", ")}`);
});

test("diffCoveredLines：rename 混合引号形态（a 侧引号 b 侧裸）取 b 侧路径", () => {
  const diff = [
    'diff --git "a/old path.ts" b/new.ts',
    "similarity index 90%",
    'rename from "a/old path.ts"',
    "rename to b/new.ts",
    "@@ -1,1 +1,2 @@",
    " ctx",
    "+new",
  ].join("\n");
  const covered = diffCoveredLines(diff);
  assert.ok(covered.has("new.ts"), `实际 key: ${[...covered.keys()].join(", ")}`);
});

test("diffCoveredLines：真实 diff 的尾部换行不产生幻影行号", () => {
  // 真实 GitHub diff 以 \n 结尾：split 出的尾部空串曾被当上下文行 mark 出「最后一行 +1」的幻影。
  // hunk 声明 3 行新侧，内容 3 行后尾空串应被 remain 拒绝
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,3 @@",
    " ctx",
    "+added",
    " tail",
    "",
  ].join("\n") + "\n";
  const covered = diffCoveredLines(diff);
  assert.deepEqual([...covered.get("src/a.ts")!].sort((x, y) => x - y), [10, 11, 12]);
});

test("diffCoveredLines：hunk 声明内的空上下文行是真实内容，正常记录", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,4 @@",
    " ctx",
    "+added",
    " tail",
    "",
  ].join("\n") + "\n";
  const covered = diffCoveredLines(diff);
  // 声明新侧 4 行：第 4 行就是空上下文行（行号 13），不是幻影。
  // 已知残余盲区：模型产出声明行数偏大的畸形 diff 时尾部伪影仍可能被记——由 422 全量降级兜底（journal 会话 18 取舍）
  assert.deepEqual([...covered.get("src/a.ts")!].sort((x, y) => x - y), [10, 11, 12, 13]);
});

test("diffCoveredLines：+++ /dev/null 精确匹配，路径含该字样的真实文件不受影响", () => {
  const diff = [
    "diff --git a/test/a/dev/null b/test/a/dev/null",
    "index 1..2 100644",
    "--- a/test/a/dev/null",
    "+++ b/test/a/dev/null",
    "@@ -1,1 +1,2 @@",
    " ctx",
    "+new",
  ].join("\n") + "\n";
  const covered = diffCoveredLines(diff);
  assert.ok(covered.get("test/a/dev/null")!.has(2), "路径含 /dev/null 字样的真实文件应正常解析");
});
