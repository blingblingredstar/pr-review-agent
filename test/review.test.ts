import assert from "node:assert/strict";
import { test } from "node:test";
import { diffCoveredLines, diffMaxChars, pathVariants, truncateDiff, unquoteGitPath, withExtraBody } from "../src/review.ts";

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

test("truncateDiff：预算内原样返回", () => {
  const diff = "diff --git a/a.ts b/a.ts\n@@ -1,1 +1,2 @@\n ctx\n+new\n";
  assert.equal(truncateDiff(diff, 10_000), diff);
});

test("truncateDiff：超预算丢最大块，保留块按原顺序重组，省略行带路径与增删计数", () => {
  const a = ["diff --git a/a.ts b/a.ts", "@@ -1,1 +1,2 @@", " ctx", "+a1"].join("\n") + "\n";
  const b = ["diff --git a/big.ts b/big.ts", "@@ -1,1 +1,2 @@", " ctx", "+" + "x".repeat(200)].join("\n") + "\n";
  const c = ["diff --git a/c.ts b/c.ts", "@@ -1,1 +1,2 @@", " ctx", "+c1"].join("\n") + "\n";
  const out = truncateDiff(a + b + c, a.length + c.length + 50);
  assert.equal(out, a + c + "\n[diff 截断] 省略 big.ts (+1/-0)");
});

test("truncateDiff：装不下最大的就跳过继续试更小的（continue 而非 break）", () => {
  const small = ["diff --git a/s.ts b/s.ts", "@@ -1,1 +1,2 @@", " ctx", "+s1"].join("\n") + "\n";
  const huge = ["diff --git a/h.ts b/h.ts", "@@ -1,1 +1,2 @@", " ctx", "+" + "x".repeat(500)].join("\n") + "\n";
  const mid = ["diff --git a/m.ts b/m.ts", "@@ -1,1 +1,2 @@", " ctx", "+" + "y".repeat(100)].join("\n") + "\n";
  // 顺序 small→huge→mid：贪心遇 huge 装不下，mid 在后面仍要能装进
  const out = truncateDiff(small + huge + mid, small.length + mid.length + 50);
  assert.ok(out.includes("s.ts") && out.includes("m.ts"), "small 与 mid 都应保留");
  assert.ok(out.includes("省略 h.ts"), "huge 应被省略");
});

test("truncateDiff：全部块都超预算时压缩为汇总（无条件核对，单文件也一样）", () => {
  const a = ["diff --git a/a.ts b/a.ts", "@@ -1,1 +1,2 @@", " ctx", "+" + "x".repeat(50)].join("\n") + "\n";
  const out = truncateDiff(a, 10);
  assert.equal(out, "[diff 截断] 省略 1 个文件（超出 10 字符预算，合计 +1/-0）");
});

test("truncateDiff：GIT binary patch 数据行不计入增删", () => {
  const a = [
    "diff --git a/img.png b/img.png",
    "index 1..2 100644",
    "GIT binary patch",
    "literal 10",
    "+cmVtb3ZlZC1iYXNlNjQ=",
    "-c2Fk",
  ].join("\n") + "\n";
  const out = truncateDiff(a, 10);
  // binary 标记行之后的 +/- 数据行不计：合计 +0/-0
  assert.ok(out.includes("省略 1 个文件"), `实际输出: ${out}`);
  assert.ok(out.includes("合计 +0/-0"), `实际输出: ${out}`);
});

test("truncateDiff：省略行自身超预算时压缩为汇总行", () => {
  // 主块最小（贪心先保留，used=50），d 块 130 > 剩余 40 全部被丢——30 条省略行 ~900 字符超剩余预算触发压缩
  const kept = "diff --git a/k.ts b/k.ts\n@@ -1,1 +1,2 @@\n ctx\n+kk\n";
  let diff = kept;
  for (let i = 0; i < 30; i++) diff += `diff --git a/d${i}.ts b/d${i}.ts\n@@ -1,1 +1,2 @@\n ctx\n+${"x".repeat(80)}\n`;
  const out = truncateDiff(diff, kept.length + 40);
  assert.equal((out.match(/\[diff 截断\]/g) ?? []).length, 1, "应只有压缩后的汇总行");
  assert.ok(out.includes("省略 30 个文件"), `实际输出末尾: ${out.slice(-120)}`);
});

test("truncateDiff：压缩汇总行保留生成物/新建文件计数（PR #18 自审意见）", () => {
  const kept = "diff --git a/k.ts b/k.ts\n@@ -1,1 +1,2 @@\n ctx\n+kk\n";
  let diff = kept;
  diff += `diff --git a/package-lock.json b/package-lock.json\n@@ -1,1 +1,2 @@\n ctx\n+${"x".repeat(80)}\n`;
  diff += `diff --git a/src/n.ts b/src/n.ts\nnew file mode 100644\n@@ -0,0 +1,1 @@\n+${"x".repeat(80)}\n`;
  for (let i = 0; i < 28; i++) diff += `diff --git a/d${i}.ts b/d${i}.ts\n@@ -1,1 +1,2 @@\n ctx\n+${"x".repeat(80)}\n`;
  const out = truncateDiff(diff, kept.length + 40);
  assert.equal((out.match(/\[diff 截断\]/g) ?? []).length, 1);
  assert.ok(out.includes("省略 30 个文件"), `实际输出末尾: ${out.slice(-120)}`);
  assert.ok(out.includes("其中生成物 1、新建文件 1"), `标注计数应进汇总行: ${out.slice(-120)}`);
});

test("truncateDiff：通用目录名只认顶层，嵌套同名词目录不误伤（PR #18 自审意见）", () => {
  const top = "diff --git a/build/lib/manifest.json b/build/lib/manifest.json\n@@ -1,1 +1,2 @@\n ctx\n+" + "x".repeat(60) + "\n";
  const nested = "diff --git a/src/build/steps.ts b/src/build/steps.ts\n@@ -1,1 +1,2 @@\n ctx\n+" + "y".repeat(60) + "\n";
  const out = truncateDiff(top + nested, nested.length + 60);
  assert.equal(out, nested + "\n[diff 截断] 省略 build/lib/manifest.json（生成物） (+1/-0)");
});

test("truncateDiff：diff 头之前的散落内容被丢弃时不产出伪路径省略行", () => {
  const junk = "not a diff line\n";
  const a = "diff --git a/a.ts b/a.ts\n@@ -1,1 +1,2 @@\n ctx\n+kk\n";
  // budget 60：junk（16）保留、a（50）装不下被丢；省略行 31 字符在剩余 44 内不触发压缩
  const out = truncateDiff(junk + a, 60);
  assert.ok(!out.includes("diff 头之前"), `伪块不应产出省略行，实际输出: ${out}`);
  assert.equal(out, "not a diff line\n[diff 截断] 省略 a.ts (+1/-0)");
});

test("truncateDiff：lock 文件按名单前置排除，预算让给真实代码", () => {
  const lock = ["diff --git a/package-lock.json b/package-lock.json", "@@ -1,1 +1,2 @@", " ctx", "+" + "x".repeat(200)].join("\n") + "\n";
  const src = ["diff --git a/src/app.ts b/src/app.ts", "@@ -1,1 +1,2 @@", " ctx", "+" + "y".repeat(200)].join("\n") + "\n";
  const out = truncateDiff(lock + src, src.length + 60);
  assert.equal(out, src + "\n[diff 截断] 省略 package-lock.json（生成物） (+1/-0)");
});

test("truncateDiff：预算内不启用生成物过滤，diff 字节级原样", () => {
  const lock = "diff --git a/yarn.lock b/yarn.lock\n@@ -1,1 +1,2 @@\n ctx\n+frozen\n";
  assert.equal(truncateDiff(lock, 10_000), lock);
});

test("truncateDiff：长行占优的块按生成物排除（压缩/混淆产物不依赖文件名）", () => {
  const bundle = [
    "diff --git a/assets/app.js b/assets/app.js",
    "@@ -1,2 +1,3 @@",
    "-" + "a".repeat(2000),
    "+" + "b".repeat(2000),
    "+" + "c".repeat(2000),
  ].join("\n") + "\n";
  const src = ["diff --git a/src/app.ts b/src/app.ts", "@@ -1,1 +1,2 @@", " ctx", "+" + "y".repeat(200)].join("\n") + "\n";
  const out = truncateDiff(bundle + src, src.length + 60);
  assert.equal(out, src + "\n[diff 截断] 省略 assets/app.js（生成物） (+2/-1)");
});

test("truncateDiff：新建文件头部 @generated 横幅按生成物排除，标注优先于新建文件", () => {
  const gen = [
    "diff --git a/src/proto/api.ts b/src/proto/api.ts",
    "new file mode 100644",
    "@@ -0,0 +1,3 @@",
    "+// @generated by protoc",
    "+" + "x".repeat(200),
    "+" + "y".repeat(200),
  ].join("\n") + "\n";
  const src = ["diff --git a/src/app.ts b/src/app.ts", "@@ -1,1 +1,2 @@", " ctx", "+" + "y".repeat(200)].join("\n") + "\n";
  const out = truncateDiff(gen + src, src.length + 60);
  assert.equal(out, src + "\n[diff 截断] 省略 src/proto/api.ts（生成物） (+3/-0)");
});

test("truncateDiff：@generated 出现在第 10 个新增行之后不触发生成物排除", () => {
  const lines = ["diff --git a/src/big.ts b/src/big.ts", "@@ -1,1 +12,12 @@"];
  for (let i = 0; i < 11; i++) lines.push("+" + "z".repeat(50));
  lines.push("+// 见 @generated 说明文档"); // 第 12 个新增行，超出头部窗口
  const big = lines.join("\n") + "\n";
  const src = ["diff --git a/src/app.ts b/src/app.ts", "@@ -1,1 +1,2 @@", " ctx", "+" + "y".repeat(200)].join("\n") + "\n";
  const out = truncateDiff(big + src, src.length + 60);
  assert.ok(out.includes("省略 src/big.ts (+12/-0)"), `实际输出: ${out.slice(-120)}`);
  assert.ok(!out.includes("生成物"), "预算丢弃的普通文件不应带生成物标注");
});

test("truncateDiff：预算丢弃的新建文件在省略行标注，标记审查盲区", () => {
  const src = ["diff --git a/src/app.ts b/src/app.ts", "@@ -1,1 +1,2 @@", " ctx", "+" + "y".repeat(60)].join("\n") + "\n";
  const added = [
    "diff --git a/src/new-module.ts b/src/new-module.ts",
    "new file mode 100644",
    "@@ -0,0 +1,2 @@",
    "+" + "x".repeat(200),
    "+" + "w".repeat(200),
  ].join("\n") + "\n";
  const out = truncateDiff(src + added, src.length + 60);
  // 被丢弃块是末块（尾部空串元素随块丢弃），保留文本后无空行
  assert.equal(out, src + "[diff 截断] 省略 src/new-module.ts（新建文件） (+2/-0)");
});

test("diffMaxChars：未配置默认 300000，非法值告警回退，合法值生效", () => {
  const saved = process.env.DIFF_MAX_CHARS;
  try {
    delete process.env.DIFF_MAX_CHARS;
    assert.equal(diffMaxChars(), 300_000);
    process.env.DIFF_MAX_CHARS = "abc";
    assert.equal(diffMaxChars(), 300_000);
    process.env.DIFF_MAX_CHARS = "0";
    assert.equal(diffMaxChars(), 300_000);
    process.env.DIFF_MAX_CHARS = "0.5";
    assert.equal(diffMaxChars(), 300_000);
    process.env.DIFF_MAX_CHARS = "1234";
    assert.equal(diffMaxChars(), 1234);
  } finally {
    if (saved === undefined) delete process.env.DIFF_MAX_CHARS;
    else process.env.DIFF_MAX_CHARS = saved;
  }
});
