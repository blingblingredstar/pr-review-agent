import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import {
  buildPlanBlock,
  buildReviewPrompt,
  buildToolBlock,
  decisionModel,
  diffCoveredLines,
  diffMaxChars,
  diffSkeleton,
  extractReadRequests,
  fileToolEnabled,
  fileToolMaxSteps,
  loadPrompt,
  pathVariants,
  reviewDiff,
  reviewPlanSchema,
  runReviewRouter,
  sumUsage,
  truncateDiff,
  unquoteGitPath,
  withExtraBody,
  type ReviewPlan,
} from "../src/review.ts";
import { fileReaderFromEntries } from "../src/context.ts";
import { messagesOf, startFakeLLM, withEnv } from "./helpers.ts";

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

test("sumUsage：字段独立求和，null 不拖累其他字段、不虚构 0", () => {
  assert.deepEqual(sumUsage([]), { inputTokens: null, outputTokens: null, totalTokens: null });
  assert.deepEqual(
    sumUsage([
      { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
      { inputTokens: null, outputTokens: 30, totalTokens: null },
    ]),
    { inputTokens: 100, outputTokens: 50, totalTokens: 120 },
  );
  // 端点全不返回 usage：保持 null，报告显示「—」而不是 0
  assert.deepEqual(sumUsage([{ inputTokens: null, outputTokens: null, totalTokens: null }]), {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
  });
});

test("fileToolMaxSteps：默认 2；数值 0（含 \"0.0\"/\"00\"）显式关闭；非法值告警回退默认（D027）", async () => {
  await withEnv({ FILE_TOOL_MAX_STEPS: undefined }, () => {
    assert.equal(fileToolMaxSteps(), 2);
    assert.equal(fileToolEnabled(), true, "默认开启（D027：生产默认开，kill switch 留给异常场景）");
  });
  for (const off of ["0", "0.0", "00"]) {
    await withEnv({ FILE_TOOL_MAX_STEPS: off }, () => {
      assert.equal(fileToolMaxSteps(), 0, `数值 0 写法 "${off}" 应关闭`);
      assert.equal(fileToolEnabled(), false);
    });
  }
  await withEnv({ FILE_TOOL_MAX_STEPS: "5" }, () => {
    assert.equal(fileToolMaxSteps(), 5);
  });
  for (const bad of ["abc", "-1", "1.5", ""]) {
    await withEnv({ FILE_TOOL_MAX_STEPS: bad }, () => {
      assert.equal(fileToolMaxSteps(), 2, `非法值 "${bad}" 应回退默认`);
    });
  }
});

test("extractReadRequests：纯 JSON / 围栏 / 前后闲话都可解析；字符串与 {path} 元素兼容；去重并按步预算截断", () => {
  assert.deepEqual(extractReadRequests('{"readRequests":[{"path":"src/a.ts"}]}', 2), ["src/a.ts"]);
  assert.deepEqual(extractReadRequests('```json\n{"readRequests":["src/a.ts","src/b.ts"]}\n```', 2), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(
    extractReadRequests('好的，我需要读取：{"readRequests":[{"path":"src/a.ts"},{"path":"src/a.ts"},{"path":"src/a.ts"}]} 请处理', 2),
    ["src/a.ts"],
    "前后闲话 + 重复路径去重",
  );
  assert.deepEqual(
    extractReadRequests('{"readRequests":[{"path":"./src/a.ts"},{"path":"src/a.ts"}]}', 5),
    ["./src/a.ts"],
    "写法变体（./ 前缀）按归一键去重，保留首个",
  );
  assert.deepEqual(extractReadRequests('{"readRequests":[{"path":"a.ts"},{"path":"b.ts"},{"path":"c.ts"}]}', 2), ["a.ts", "b.ts"], "超出字符预算截断");
  assert.deepEqual(extractReadRequests('{"readRequests":[{"path":"a.ts"},{"path":{"nested":1}}]}', 5), ["a.ts"], "非字符串元素跳过");
  assert.deepEqual(extractReadRequests('{"readRequests":[]}', 2), [], "空请求 = 不读文件");
  assert.deepEqual(extractReadRequests("我觉得不需要读文件，直接审。", 2), [], "无 JSON 返回空（协议违规不炸审查）");
  assert.deepEqual(extractReadRequests('{"other":1}', 2), [], "缺 readRequests 字段返回空");
  assert.deepEqual(extractReadRequests("任何文本", 0), [], "步预算 0 直接空");
});

test("buildToolBlock：命中全文 / 未命中说明行 / 每步观测日志", () => {
  const entries = new Map<string, Uint8Array>([["small.ts", strToU8("export const a = 1;\n")]]);
  const reader = fileReaderFromEntries(entries);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    const hit = buildToolBlock(["small.ts"], reader);
    assert.ok(hit.startsWith("[read_file 工具结果]"), "块头部让模型识别第二段");
    assert.ok(hit.includes("=== read_file：small.ts（全文 20 字符）===\nexport const a = 1;\n"));
    const miss = buildToolBlock(["nope.ts"], reader);
    assert.ok(miss.includes("[read_file] nope.ts: file not found in head snapshot"), "未命中说明行，模型可自行纠正");
  } finally {
    console.log = origLog;
  }
  assert.ok(logs.some((l) => l.includes("[tools] step 1: read small.ts (20 chars)")), "每步观测日志");
  assert.ok(logs.some((l) => l.includes("[tools] step 1: read nope.ts (not found)")));
});

test("buildToolBlock：80k 字符预算（含包装与说明行实长）——第二个文件收敛截断，耗尽后未纳入", () => {
  const entries = new Map<string, Uint8Array>([
    ["first.ts", strToU8("y".repeat(79_700))],
    ["big.ts", strToU8("x".repeat(400))],
    ["last.ts", strToU8("z".repeat(50))],
  ]);
  const reader = fileReaderFromEntries(entries);
  const origLog = console.log;
  console.log = () => {};
  try {
    const block = buildToolBlock(["first.ts", "big.ts", "last.ts"], reader);
    assert.ok(block.includes("=== read_file：first.ts（全文 79700 字符）==="), "第一个文件全文注入（按实际片段记账）");
    assert.ok(block.includes("=== read_file：big.ts（截断）==="), "剩余预算扣除包装与说明行后仍可截断");
    assert.ok(/\[read_file\] big\.ts 超出字符预算截断：仅注入前 \d+\/400 字符/.test(block), `实际: ${block.slice(-250)}`);
    assert.ok(block.includes("[read_file] last.ts 全文 50 字符超出字符预算，未纳入"), "预算耗尽后未纳入留说明");
    // 封顶契约：整块（含头行）不超 FILE_TOOL_BLOCK_MAX_CHARS 一个说明行的余量
    assert.ok(block.length <= 80_000 + 100, `整块长度 ${block.length} 应 ≲ 80k`);
  } finally {
    console.log = origLog;
  }
});

test("buildToolBlock：全文块含包装头超顶时转截断；残余碎余量不出碎片段（先拼再量的边界语义）", () => {
  const entries = new Map<string, Uint8Array>([
    ["first.ts", strToU8("y".repeat(79_995))],
    ["tiny.ts", strToU8("x".repeat(20))],
  ]);
  const reader = fileReaderFromEntries(entries);
  const origLog = console.log;
  console.log = () => {};
  try {
    const block = buildToolBlock(["first.ts", "tiny.ts"], reader);
    // 79995 + 包装头 > 80k：先拼再量判为截断（收敛后 cut ≤ remaining 保住封顶）
    assert.ok(!block.includes("first.ts（全文"), `实际头: ${block.slice(0, 80)}`);
    assert.ok(block.includes("=== read_file：first.ts（截断）==="));
    assert.ok(/\[read_file\] first\.ts 超出字符预算截断：仅注入前 \d+\/79995 字符/.test(block));
    assert.ok(block.length <= 80_000 + 100, `整块长度 ${block.length} 应 ≲ 80k`);
    assert.ok(block.includes("[read_file] tiny.ts 全文 20 字符超出字符预算，未纳入"), `实际尾: ${block.slice(-200)}`);
    assert.ok(!block.includes("tiny.ts（截断）"), "残余余量 < 包装开销，不出碎片段");
  } finally {
    console.log = origLog;
  }
});

const TOOLS_PROMPT = readFileSync(new URL("../prompts/review-tools.md", import.meta.url), "utf8");

const REVIEW_JSON = JSON.stringify({ comments: [{ file: "src/a.ts", line: 1, severity: "major", body: "b" }] });

test("reviewDiff：fileReader 不注入 = 现状单调用（system/prompt 字节级不变，usage 透传）", async () => {
  const fake = await startFakeLLM(() => ({ content: REVIEW_JSON, usage: { prompt_tokens: 583, completion_tokens: 130, total_tokens: 713 } }));
  try {
    await withEnv(
      { LLM_BASE_URL: fake.url, LLM_API_KEY: "test", LLM_MODEL: "fake", LLM_EXTRA_BODY: undefined, LLM_TIMEOUT_MS: undefined },
      async () => {
        const out = await reviewDiff("DIFF_TEXT", "CTX", { timeoutMs: 10_000 });
        assert.equal(fake.calls.length, 1, "单次调用");
        const body = fake.calls[0]!.body;
        const [sys] = messagesOf(body).filter((m) => m.role === "system");
        const user = messagesOf(body).find((m) => m.role === "user")!;
        assert.equal(sys!.content, loadPrompt(), "system = prompts/review.md 原文（无工具指令）");
        assert.equal(user.content, "CTX\n\n[diff 开始]\nDIFF_TEXT");
        assert.equal((body.response_format as { type?: string } | undefined)?.type, "json_schema", "结构化输出走 response_format");
        assert.deepEqual(out.comments, [{ file: "src/a.ts", line: 1, severity: "major", body: "b" }]);
        assert.deepEqual(out.usage, { inputTokens: 583, outputTokens: 130, totalTokens: 713 });
      },
    );
  } finally {
    await fake.close();
  }
});

test("两段协议与单段同享 withExtraBody：两段请求体都合并 LLM_EXTRA_BODY（自审 major 误报的机械证明）", async () => {
  const bodies: unknown[] = [];
  const fake = await startFakeLLM((i) => {
    if (i === 0) return { content: '{"readRequests":["src/a.ts"]}', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    return { content: REVIEW_JSON, usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
  });
  // 包一层 withExtraBody 的抓取：绕过 provider 直连——直接在 fake 上记录不了 provider 内部包装，
  // 改为断言「provider 构造即包装」这一契约：reviewDiff 内 createOpenAI 传 withExtraBody(fetch)，
  // 这里用环境变量打开 extra body，fake 收到的请求体应已含 thinking 字段
  try {
    await withEnv(
      {
        LLM_BASE_URL: fake.url, LLM_API_KEY: "test", LLM_MODEL: "fake",
        LLM_EXTRA_BODY: '{"thinking":{"type":"disabled"}}', LLM_TIMEOUT_MS: undefined, FILE_TOOL_MAX_STEPS: "2",
      },
      async () => {
        const out = await reviewDiff("DIFF_TEXT", undefined, { timeoutMs: 10_000, fileReader: () => "content" });
        assert.deepEqual(out.comments, [{ file: "src/a.ts", line: 1, severity: "major", body: "b" }]);
        assert.equal(fake.calls.length, 2, "两段调用");
        for (const [i, call] of fake.calls.entries()) {
          const body = call.body as { thinking?: { type?: string } };
          assert.equal(body.thinking?.type, "disabled", `第 ${i + 1} 段请求体已合并 LLM_EXTRA_BODY`);
        }
      },
    );
  } finally {
    await fake.close();
  }
});

test("两段协议不丢 plan：prompt 在分支前构造，第二段请求体含计划块（fileReader+plan 并存场景，自审 major 留证）", async () => {
  const fake = await startFakeLLM((i) => {
    if (i === 0) return { content: '{"readRequests":["src/a.ts"]}', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    return { content: REVIEW_JSON, usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
  });
  const plan = {
    focusAreas: [{ area: "并发安全", files: ["src/a.ts"], why: "diff 触及共享状态" }],
    riskAreas: [{ area: "测试盲区", why: "无并发用例" }],
    readPaths: ["src/a.ts"],
    strategy: "先核对其余调用方",
  };
  try {
    await withEnv(
      { LLM_BASE_URL: fake.url, LLM_API_KEY: "test", LLM_MODEL: "fake", LLM_EXTRA_BODY: undefined, LLM_TIMEOUT_MS: undefined, FILE_TOOL_MAX_STEPS: "2" },
      async () => {
        await reviewDiff("DIFF_TEXT", "CTX", { timeoutMs: 10_000, fileReader: () => "content", plan });
        assert.equal(fake.calls.length, 2);
        // 第一段：计划块已在 prompt 内（buildReviewPrompt 分支前构造）
        const firstUser = messagesOf(fake.calls[0]!.body).find((m) => m.role === "user")!;
        assert.ok(firstUser.content.includes("并发安全"), "第一段 prompt 含计划块");
        // 第二段：工具块 + 原 prompt（计划块仍在）
        const secondUser = messagesOf(fake.calls[1]!.body).find((m) => m.role === "user")!;
        assert.ok(secondUser.content.includes("并发安全"), "第二段 prompt 含计划块（plan 未被两段路径丢弃）");
      },
    );
  } finally {
    await fake.close();
  }
});

test("reviewDiff：fileReader 注入 = 两段协议（第一段 readRequests 无 response_format，第二段注入工具结果复用同一 schema，usage 两段合计）", async () => {
  const fake = await startFakeLLM((i) => {
    if (i === 0) {
      return { content: '文件树已给出。{"readRequests":[{"path":"./src/a.ts"},{"path":"src/a.ts"},{"path":"nope.ts"}]}' };
    }
    return { content: REVIEW_JSON, usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 } };
  });
  try {
    await withEnv(
      { LLM_BASE_URL: fake.url, LLM_API_KEY: "test", LLM_MODEL: "fake", LLM_EXTRA_BODY: undefined, LLM_TIMEOUT_MS: undefined, FILE_TOOL_MAX_STEPS: "2" },
      async () => {
        const entries = new Map<string, Uint8Array>([["src/a.ts", strToU8("export const a = 1;\n")]]);
        const out = await reviewDiff("DIFF_TEXT", undefined, { timeoutMs: 60_000, fileReader: fileReaderFromEntries(entries) });
        assert.equal(fake.calls.length, 2, "两段协议 = 两次调用");

        const first = fake.calls[0]!.body;
        const firstSys = messagesOf(first).find((m) => m.role === "system")!;
        const firstUser = messagesOf(first).find((m) => m.role === "user")!;
        assert.equal(firstSys.content, `${loadPrompt()}\n\n${TOOLS_PROMPT}`, "两段 system 都 = review.md + review-tools.md 追加");
        assert.equal(firstUser.content, "DIFF_TEXT", "第一段 prompt 与单调用形态字节级一致");
        assert.equal(first.response_format, undefined, "第一段不带 response_format（tools 形态实测被其抑制，D027）");

        const second = fake.calls[1]!.body;
        const secondUser = messagesOf(second).find((m) => m.role === "user")!;
        assert.equal((second.response_format as { type?: string } | undefined)?.type, "json_schema", "第二段复用同一 schema 契约");
        assert.ok(secondUser.content.startsWith("[read_file 工具结果]"), "工具结果块在 prompt 前段");
        assert.ok(secondUser.content.includes("=== read_file：./src/a.ts（全文 20 字符）===\nexport const a = 1;\n"), "命中文件全文注入");
        assert.ok(secondUser.content.includes("[read_file] nope.ts: file not found in head snapshot"), "未命中说明行");
        assert.ok(secondUser.content.endsWith("DIFF_TEXT"), "diff 保持在生成前最近位置（行号锚点原则）");
        assert.equal((secondUser.content.match(/=== read_file：/g) ?? []).length, 1, "写法变体去重后同一文件只注入一次");
        assert.deepEqual(out.comments, [{ file: "src/a.ts", line: 1, severity: "major", body: "b" }], "最终出 ReviewResult");
        assert.deepEqual(out.usage, { inputTokens: 201, outputTokens: 31, totalTokens: 232 }, "usage 为两段合计");
      },
    );
  } finally {
    await fake.close();
  }
});

test("reviewDiff：fileReader 注入但首段不请求文件（readRequests 空）→ 第二段 prompt 与单调用形态一致", async () => {
  const fake = await startFakeLLM((i) => (i === 0 ? { content: '{"readRequests": []}' } : { content: REVIEW_JSON }));
  try {
    await withEnv(
      { LLM_BASE_URL: fake.url, LLM_API_KEY: "test", LLM_MODEL: "fake", LLM_EXTRA_BODY: undefined, LLM_TIMEOUT_MS: undefined, FILE_TOOL_MAX_STEPS: "2" },
      async () => {
        await reviewDiff("DIFF_TEXT", undefined, { timeoutMs: 60_000, fileReader: () => "unused" });
        const secondUser = messagesOf(fake.calls[1]!.body).find((m) => m.role === "user")!;
        // 空 readRequests 也注入占位块（自审 minor）：与第一段 prompt 保持可区分，模型不再重复输出请求
        assert.equal(
          secondUser.content,
          "[read_file 工具结果]（本轮无文件请求，请直接给出审查意见）\n\nDIFF_TEXT",
          "空请求占位块 + 原形态 diff",
        );
      },
    );
  } finally {
    await fake.close();
  }
});

test("工具循环：prompt 超过 120k 字符闸自动跳过，走单段（防两段延迟撞阶段墙钟，本 PR dogfood 实测）", async () => {
  const fake = await startFakeLLM(() => ({ content: REVIEW_JSON, usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
  try {
    await withEnv(
      { LLM_BASE_URL: fake.url, LLM_API_KEY: "test", LLM_MODEL: "fake", LLM_EXTRA_BODY: undefined, LLM_TIMEOUT_MS: undefined, FILE_TOOL_MAX_STEPS: "2" },
      async () => {
        // >120k 字符的 diff（<300k 预算，不触发 D018 截断；fileReader 注入但不应产生第二段）
        const bigDiff = [
          "diff --git a/big.ts b/big.ts",
          "index 1111111..2222222 100644",
          "--- a/big.ts",
          "+++ b/big.ts",
          "@@ -1,2 +1,3 @@",
          " context",
          "+" + "x".repeat(130_000),
        ].join("\n");
        const out = await reviewDiff(bigDiff, undefined, { timeoutMs: 10_000, fileReader: () => "content" });
        assert.equal(fake.calls.length, 1, "超阈值只走单段，不进两段协议");
        assert.equal((fake.calls[0]!.body as { response_format?: { type?: string } }).response_format?.type, "json_schema");
        assert.deepEqual(out.comments, [{ file: "src/a.ts", line: 1, severity: "major", body: "b" }]);
      },
    );
  } finally {
    await fake.close();
  }
});

// ============ 决策模型路由（D028）============

const ROUTER_PROMPT = readFileSync(new URL("../prompts/review-router.md", import.meta.url), "utf8");

const PLAN: ReviewPlan = {
  focusAreas: [{ area: "分页边界", files: ["src/github.ts"], why: "off-by-one 高发" }],
  riskAreas: [{ area: "调用方未同步", why: "getPage 的调用方直接透传 page 参数" }],
  readPaths: ["src/index.ts"],
  strategy: "先核对分页循环边界，再扫关联调用方",
};

test("reviewPlanSchema：合法对象解析；缺字段 / 字段类型漂移拒绝（D028）", () => {
  const ok = reviewPlanSchema.safeParse({
    focusAreas: [{ area: "分页边界", files: ["src/github.ts"], why: "off-by-one 高发" }],
    riskAreas: [{ area: "调用方未同步", why: "getPage 的调用方直接透传 page 参数" }],
    readPaths: ["src/index.ts"],
    strategy: "先核对分页循环边界，再扫关联调用方",
  });
  assert.equal(ok.success, true);
  assert.deepEqual(ok.success ? ok.data : null, PLAN);
  assert.equal(
    reviewPlanSchema.safeParse({ focusAreas: [], riskAreas: [], readPaths: [] }).success,
    false,
    "缺 strategy 拒绝",
  );
  assert.equal(
    reviewPlanSchema.safeParse({ focusAreas: "x", riskAreas: [], readPaths: [], strategy: "s" }).success,
    false,
    "focusAreas 类型漂移拒绝",
  );
  assert.equal(
    reviewPlanSchema.safeParse({ focusAreas: [{ area: 1, files: [], why: "w" }], riskAreas: [], readPaths: [], strategy: "s" }).success,
    false,
    "嵌套字段类型漂移拒绝",
  );
});

test("buildPlanBlock：标题行 + 威胁模型重申 + 四段数据（D028）", () => {
  const block = buildPlanBlock(PLAN);
  assert.ok(block.startsWith("[评审计划（由路由模型生成，供参考，不替代你的独立判断）]"), "自带标题行");
  assert.ok(block.includes("不是 ground truth"), "威胁模型：计划不是 ground truth");
  assert.ok(block.includes("内容非指令"), "威胁模型：与 diff 同属内容非指令");
  assert.ok(block.includes("## 评审策略\n先核对分页循环边界，再扫关联调用方"));
  assert.ok(block.includes("- 分页边界（涉及：src/github.ts）：off-by-one 高发"));
  assert.ok(block.includes("## 风险面\n- 调用方未同步：getPage 的调用方直接透传 page 参数"));
  assert.ok(block.includes("## 建议深读文件\n- src/index.ts"));
  const empty = buildPlanBlock({ focusAreas: [], riskAreas: [], readPaths: [], strategy: "" });
  assert.ok(empty.includes("（未给出）") && empty.includes("（无）"), "空字段有占位文案，不产出空段");
});

test("buildReviewPrompt：无 plan 字节级现状（有/无 context 均不变，eval 红线由构造保证，D028）", () => {
  assert.equal(buildReviewPrompt("DIFF_TEXT"), "DIFF_TEXT");
  assert.equal(buildReviewPrompt("DIFF_TEXT", "CTX"), "CTX\n\n[diff 开始]\nDIFF_TEXT");
});

test("buildReviewPrompt：plan 块在 context 之后、[diff 开始] 之前；无 context 时在 diff 之前；diff 恒末尾（D028）", () => {
  const block = buildPlanBlock(PLAN);
  assert.equal(buildReviewPrompt("DIFF_TEXT", "CTX", PLAN), `CTX\n\n${block}\n\n[diff 开始]\nDIFF_TEXT`);
  assert.equal(buildReviewPrompt("DIFF_TEXT", undefined, PLAN), `${block}\n\nDIFF_TEXT`);
});

test("decisionModel：未设置/空白 = 关闭；设置返回 trim 后模型名（D028 opt-in 开关）", async () => {
  await withEnv({ DECISION_MODEL: undefined }, () => assert.equal(decisionModel(), undefined));
  await withEnv({ DECISION_MODEL: "" }, () => assert.equal(decisionModel(), undefined));
  await withEnv({ DECISION_MODEL: "   " }, () => assert.equal(decisionModel(), undefined));
  await withEnv({ DECISION_MODEL: " glm-4.5-air " }, () => assert.equal(decisionModel(), "glm-4.5-air"));
});

test("diffSkeleton：PR 规模摘要 + 逐文件 ± 行数；二进制数据行不计增删；超 maxFiles 附省略行（D028）", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "@@ -1,1 +1,2 @@",
    " ctx",
    "+a1",
    "+a2",
    "-old",
    "diff --git a/img.png b/img.png",
    "GIT binary patch",
    "literal 10",
    "+cm9ibGlu",
    "-Zm9v",
    "diff --git a/src/b.ts b/src/b.ts",
    "@@ -1,1 +1,2 @@",
    " ctx",
    "+b1",
  ].join("\n");
  const sk = diffSkeleton(diff);
  assert.equal(sk.split("\n")[0], "共 3 个文件，+3/-1 行", "首行 = PR 规模摘要");
  assert.ok(sk.includes("- src/a.ts (+2/-1)"));
  assert.ok(sk.includes("- img.png (+0/-0)"), "二进制负载行不计数");
  assert.ok(sk.includes("- src/b.ts (+1/-0)"));
  const capped = diffSkeleton(diff, 2);
  assert.ok(capped.includes("（其余 1 个文件未列出）"), "封顶省略行");
  assert.ok(!capped.includes("- src/b.ts"), "封顶后的文件不列出");
});

test("diffSkeleton：diff 头之前散落内容不产出伪文件行", () => {
  const sk = diffSkeleton("not a diff line\ndiff --git a/a.ts b/a.ts\n@@ -1,1 +1,2 @@\n ctx\n+new\n");
  assert.equal(sk.split("\n")[0], "共 1 个文件，+1/-0 行");
  assert.ok(sk.includes("- a.ts (+1/-0)"));
});

test("runReviewRouter：假端点返回计划 JSON → 解析出 ReviewPlan，system=router prompt 原文，prompt 含树与概要（D028）", async () => {
  const fake = await startFakeLLM(() => ({ content: JSON.stringify(PLAN), usage: { prompt_tokens: 500, completion_tokens: 80, total_tokens: 580 } }));
  try {
    await withEnv(
      { DECISION_MODEL: "glm-4.5-air", LLM_BASE_URL: fake.url, LLM_API_KEY: "test", LLM_EXTRA_BODY: undefined },
      async () => {
        const plan = await runReviewRouter({ tree: "src/a.ts\nsrc/b.ts", skeleton: "共 2 个文件，+1/-0 行" });
        assert.deepEqual(plan, PLAN);
        assert.equal(fake.calls.length, 1, "单次调用");
        const body = fake.calls[0]!.body;
        const sys = messagesOf(body).find((m) => m.role === "system")!;
        const user = messagesOf(body).find((m) => m.role === "user")!;
        assert.equal(sys.content, ROUTER_PROMPT, "system = prompts/review-router.md 原文");
        assert.equal(user.content, "[仓库文件树]\nsrc/a.ts\nsrc/b.ts\n\n[diff 概要]\n共 2 个文件，+1/-0 行");
        assert.equal((body.response_format as { type?: string } | undefined)?.type, "json_schema", "强约束 schema 同主评审形态");
        assert.equal(body.model, "glm-4.5-air", "用 DECISION_MODEL 而非 LLM_MODEL");
      },
    );
  } finally {
    await fake.close();
  }
});

test("runReviewRouter：schema 违规输出抛错（编排层捕获降级）；DECISION_MODEL 未设置零端点调用（D028）", async () => {
  const bad = await startFakeLLM(() => ({ content: "我觉得没有明显风险。" }));
  try {
    await withEnv(
      { DECISION_MODEL: "m", LLM_BASE_URL: bad.url, LLM_API_KEY: "test", LLM_EXTRA_BODY: undefined },
      async () => {
        await assert.rejects(() => runReviewRouter({ tree: "t", skeleton: "s" }), "非 schema 输出 → 抛错 → worker 降级为无计划");
      },
    );
  } finally {
    await bad.close();
  }
  const unused = await startFakeLLM(() => ({ content: "{}" }));
  try {
    await withEnv({ DECISION_MODEL: undefined, LLM_BASE_URL: unused.url, LLM_API_KEY: "test" }, async () => {
      await assert.rejects(() => runReviewRouter({ tree: "t", skeleton: "s" }), /DECISION_MODEL/);
      assert.equal(unused.calls.length, 0, "router 关闭 = 零调用");
    });
  } finally {
    await unused.close();
  }
});

test("reviewDiff：opts.plan 注入 → 计划块进 prompt（context 之后 diff 之前），system 仍只有 review.md（D028）", async () => {
  const fake = await startFakeLLM(() => ({ content: REVIEW_JSON, usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
  try {
    await withEnv(
      { LLM_BASE_URL: fake.url, LLM_API_KEY: "test", LLM_MODEL: "fake", LLM_EXTRA_BODY: undefined, LLM_TIMEOUT_MS: undefined },
      async () => {
        const out = await reviewDiff("DIFF_TEXT", "CTX", { timeoutMs: 10_000, plan: PLAN });
        assert.equal(fake.calls.length, 1, "plan 注入不增加调用次数（router 是 worker 编排的独立调用）");
        const body = fake.calls[0]!.body;
        const sys = messagesOf(body).find((m) => m.role === "system")!;
        const user = messagesOf(body).find((m) => m.role === "user")!;
        assert.equal(sys.content, loadPrompt(), "system 不含 router prompt");
        assert.equal(user.content, `CTX\n\n${buildPlanBlock(PLAN)}\n\n[diff 开始]\nDIFF_TEXT`);
        assert.deepEqual(out.usage, { inputTokens: 100, outputTokens: 10, totalTokens: 110 }, "usage 契约不变：仅主调用自身（router 用量只落 [router] 日志）");
      },
    );
  } finally {
    await fake.close();
  }
});
