import assert from "node:assert/strict";
import { test } from "node:test";
import { zipSync, strToU8 } from "fflate";
import {
  buildContextText,
  buildRepoContext,
  contextMaxChars,
  fetchZipballEntries,
  fileReaderFromEntries,
  makeFileReader,
  MAX_ZIP_BYTES,
  resolveSnapshotPath,
} from "../src/context.ts";
import { diffTouchedPaths } from "../src/review.ts";

// 测试内改环境变量后必须还原，避免污染同进程的其他用例
async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("contextMaxChars：默认 100000；数值 0（含 \"0.0\"）显式关闭；合法值生效；非法值告警回退", async () => {
  await withEnv({ CONTEXT_MAX_CHARS: undefined }, () => {
    assert.equal(contextMaxChars(), 100_000);
  });
  for (const off of ["0", "0.0", "00"]) {
    await withEnv({ CONTEXT_MAX_CHARS: off }, () => {
      assert.equal(contextMaxChars(), 0, `数值 0 写法 "${off}" 应关闭而非回退默认`);
    });
  }
  await withEnv({ CONTEXT_MAX_CHARS: "5000" }, () => {
    assert.equal(contextMaxChars(), 5000);
  });
  for (const bad of ["-5", "abc", "1.5"]) {
    await withEnv({ CONTEXT_MAX_CHARS: bad }, () => {
      assert.equal(contextMaxChars(), 100_000, `非法值 ${bad} 应回退默认`);
    });
  }
});

test("diffTouchedPaths：b 侧路径、出现顺序去重", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,1 +1,2 @@",
    "+x",
    "diff --git a/src/b.ts b/src/b.ts",
    "index 3..4 100644",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1,1 +1,2 @@",
    "+y",
    "diff --git a/src/a.ts b/src/a.ts",
    "index 2..5 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -5,1 +5,2 @@",
    "+z",
  ].join("\n");
  assert.deepEqual(diffTouchedPaths(diff), ["src/a.ts", "src/b.ts"]);
});

const FIXTURE_ZIP = zipSync({
  "acme-demo-abc1234/": new Uint8Array(0),
  "acme-demo-abc1234/src/a.ts": strToU8("export const a = 1;\n"),
  "acme-demo-abc1234/README.md": strToU8("# demo\n"),
});

function fakeZipFetch(zipBody: Uint8Array, redirect = true): { fetch: typeof fetch; calls: { url: string; headers?: Record<string, string>; redirect?: string }[] } {
  const calls: { url: string; headers?: Record<string, string>; redirect?: string }[] = [];
  const impl = (async (input: unknown, init?: Record<string, unknown>) => {
    const url = String(input);
    calls.push({ url, headers: init?.headers as Record<string, string>, redirect: init?.redirect as string | undefined });
    if (redirect && calls.length === 1) {
      return new Response(null, { status: 302, headers: { location: "https://codeload.github.com/acme/demo/zip/abc1234" } });
    }
    return new Response(new Uint8Array(zipBody), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

test("fetchZipballEntries：剥根目录段、跳过目录条目；302 手动跟进并重发凭证", async () => {
  const { fetch: impl, calls } = fakeZipFetch(FIXTURE_ZIP);
  const entries = await fetchZipballEntries("acme/demo", "abc1234def", "token-xyz", impl);
  assert.equal(calls[0]!.url, "https://api.github.com/repos/acme/demo/zipball/abc1234def");
  assert.equal(calls[0]!.redirect, "manual");
  assert.equal(calls[1]!.url, "https://codeload.github.com/acme/demo/zip/abc1234");
  assert.equal(calls[1]!.headers?.Authorization, calls[0]!.headers?.Authorization, "跨源重定向须重发凭证");
  assert.equal(entries.size, 2, "目录条目不计");
  assert.equal(Buffer.from(entries.get("src/a.ts")!).toString("utf8"), "export const a = 1;\n");
  assert.ok(entries.has("README.md"));
});

test("fetchZipballEntries：非 2xx 抛错、超体积上限抛错、损坏 zip 抛错", async () => {
  const bad = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(fetchZipballEntries("acme/demo", "abc", "t", bad), /HTTP 404/);
  // 无 content-length：流式累计超限中止（Response 由 Uint8Array 构造，自带 body 流）
  const huge = (async () => new Response(new Uint8Array(MAX_ZIP_BYTES + 1), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(fetchZipballEntries("acme/demo", "abc", "t", huge), /流式中止/);
  // content-length 前置拒绝：声明超限的响应一个字节都不读
  let bodyRead = false;
  const declared = (async () => {
    const res = new Response(null, { status: 200, headers: { "content-length": String(MAX_ZIP_BYTES + 1) } });
    const orig = res.arrayBuffer.bind(res);
    res.arrayBuffer = async () => ((bodyRead = true), orig());
    return res;
  }) as unknown as typeof fetch;
  await assert.rejects(fetchZipballEntries("acme/demo", "abc", "t", declared), /content-length.*超过/);
  assert.equal(bodyRead, false, "声明超限不应读 body");
  const corrupt = (async () => new Response(strToU8("not a zip"), { status: 200 })) as unknown as typeof fetch;
  await assert.rejects(fetchZipballEntries("acme/demo", "abc", "t", corrupt));
});

test("fetchZipballEntries：重定向到非 GitHub 域拒发凭证；无 body 流回退路径也查体积", async () => {
  let calls = 0;
  const evil = (async () => {
    calls++;
    if (calls === 1) return new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } });
    return new Response(new Uint8Array(FIXTURE_ZIP), { status: 200 });
  }) as unknown as typeof fetch;
  await assert.rejects(fetchZipballEntries("acme/demo", "abc", "t", evil), /重定向目标不可信/);
  assert.equal(calls, 1, "第二个请求不应发出");
  // Response(null) 无 body 流 → 回退 arrayBuffer；桩成超大返回后必须被字节检查拦下
  const noStream = (async () => {
    const res = new Response(null, { status: 200 });
    res.arrayBuffer = async () => (MAX_ZIP_BYTES + 1) as unknown as ArrayBuffer;
    return res;
  }) as unknown as typeof fetch;
  await assert.rejects(fetchZipballEntries("acme/demo", "abc", "t", noStream), /超过/);
});

test("buildContextText：触及文件全文按 diff 顺序 + 文件树字母序；缺文件/二进制留说明", () => {
  const entries = new Map<string, Uint8Array>([
    ["src/b.ts", strToU8("export const b = 2;\n")],
    ["src/a.ts", strToU8("export const a = 1;\n")],
    ["img/logo.png", strToU8("P\x00NG")],
    ["README.md", strToU8("# demo\n")],
  ]);
  const text = buildContextText(entries, ["src/a.ts", "gone.ts", "img/logo.png", "src/b.ts"], Number.MAX_SAFE_INTEGER);
  assert.ok(text);
  assert.ok(text.startsWith("[仓库上下文]"), "自描述头部开头");
  const aIdx = text.indexOf("=== 文件全文（diff 触及）：src/a.ts ===\nexport const a = 1;");
  const bIdx = text.indexOf("=== 文件全文（diff 触及）：src/b.ts ===");
  assert.ok(aIdx > -1 && bIdx > aIdx, "触及文件按 diff 顺序全文注入");
  assert.ok(text.includes("[上下文] gone.ts 不在 head 快照中"), "已删除文件留说明");
  assert.ok(text.includes("[上下文] img/logo.png 为二进制文件，跳过"), "二进制跳过留说明");
  const treeIdx = text.indexOf("=== 仓库文件树（4 个文件）===");
  assert.ok(treeIdx > bIdx, "文件树在文件全文之后");
  const tree = text.slice(treeIdx);
  const readMeIdx = tree.indexOf("README.md");
  const srcAIdx = tree.indexOf("src/a.ts");
  const srcBIdx = tree.indexOf("src/b.ts");
  const imgIdx = tree.indexOf("img/logo.png");
  assert.ok(readMeIdx > -1 && readMeIdx < imgIdx && imgIdx < srcAIdx && srcAIdx < srcBIdx, "树字母序");
});

test("buildContextText：超预算文件整块跳过并留说明；文件树先落说明再装前缀；预算 0 / 触及为空返回 null", () => {
  const entries = new Map<string, Uint8Array>([["big.ts", strToU8("x".repeat(500))]]);
  const tight = buildContextText(entries, ["big.ts"], 150)!;
  assert.ok(tight.includes("big.ts 全文 500 字符超出剩余预算"), "装不下的文件留说明行");

  // 30 个 41 字符长路径：树总量 ~1260 字符必然超预算，说明行 ~35 字符必然装得下
  const many = new Map<string, Uint8Array>();
  for (let i = 1; i <= 30; i++) many.set(`dir${String(i).padStart(2, "0")}/${"x".repeat(30)}.txt`, strToU8(String(i)));
  const first = "dir01/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.txt";
  const withTree = buildContextText(many, [first], 300)!;
  assert.ok(withTree.includes("文件树超预算，仅显示装得下的前缀（共 30 个文件）"), "说明先占位不被挤掉");
  assert.ok(withTree.includes("dir01/"), "说明之后仍尽力装前缀");
  assert.ok(!withTree.includes("dir30/"), "装不下的尾部不出现");

  assert.equal(buildContextText(many, [], Number.MAX_SAFE_INTEGER), null, "触及为空直接 null");
  assert.equal(buildContextText(many, [first], 0), null, "预算 0 关闭");
});

test("buildRepoContext：预算 0 不发请求；下载失败返回 null；成功拼出上下文", async () => {
  await withEnv({ CONTEXT_MAX_CHARS: "0", GITHUB_TOKEN: "t" }, async () => {
    const boom = (async () => {
      throw new Error("不应发起请求");
    }) as unknown as typeof fetch;
    assert.equal(await buildRepoContext({ headRepo: "acme/demo", headSha: "abc", diff: "diff --git a/f b/f\n" }, boom), null);
  });
  await withEnv({ CONTEXT_MAX_CHARS: undefined, GITHUB_TOKEN: "t" }, async () => {
    const failing = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    assert.equal(
      await buildRepoContext({ headRepo: "acme/demo", headSha: "abc", diff: "diff --git a/f b/f\n" }, failing),
      null,
      "best-effort：失败返回 null 不抛",
    );
    const { fetch: impl } = fakeZipFetch(FIXTURE_ZIP);
    const diff = ["diff --git a/src/a.ts b/src/a.ts", "index 1..2 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,1 +1,2 @@", "+x"].join("\n");
    const text = await buildRepoContext({ headRepo: "acme/demo", headSha: "abc1234def", diff }, impl);
    assert.ok(text?.includes("export const a = 1;"));
  });
});

test("resolveSnapshotPath：目录键（尾斜杠）与目录请求同义未命中，不给 0 字符伪成功", () => {
  const entries = new Map<string, Uint8Array>([
    ["repo-hash/src/", strToU8("")],
    ["repo-hash/src/a.ts", strToU8("export const a = 1;")],
  ]);
  const reader = fileReaderFromEntries(entries);
  assert.equal(reader("src/"), null, "目录请求返回 null（file not found 语义）");
  assert.equal(reader("src/a.ts"), "export const a = 1;", "文件照常命中");
});

test("resolveSnapshotPath：剥 ./ 前缀、拒绝 .. 段与反斜杠、精确匹配快照键（D027）", () => {
  const entries = new Map<string, Uint8Array>([["src/a.ts", strToU8("x")], ["b.md", strToU8("y")]]);
  assert.equal(resolveSnapshotPath(entries, "src/a.ts"), "src/a.ts", "命中返回快照键原文");
  assert.equal(resolveSnapshotPath(entries, "./src/a.ts"), "src/a.ts", "剥单层 ./ 前缀");
  assert.equal(resolveSnapshotPath(entries, "././src/a.ts"), "src/a.ts", "剥多层 ./ 前缀");
  assert.equal(resolveSnapshotPath(entries, "  b.md  "), "b.md", "trim 空白");
  assert.equal(resolveSnapshotPath(entries, "../secret"), null, "含 .. 段拒绝");
  assert.equal(resolveSnapshotPath(entries, "src/../../etc/passwd"), null, "路径中段 .. 拒绝");
  assert.equal(resolveSnapshotPath(entries, "src\\a.ts"), null, "反斜杠拒绝");
  assert.equal(resolveSnapshotPath(entries, ""), null, "空路径拒绝");
  assert.equal(resolveSnapshotPath(entries, "./"), null, "剥完前缀后为空拒绝");
  assert.equal(resolveSnapshotPath(entries, "src/missing.ts"), null, "未命中返回 null");
  assert.equal(resolveSnapshotPath(entries, "/etc/passwd"), null, "绝对路径按精确键匹配自然未命中");
});

test("fileReaderFromEntries：命中全文、./ 归一、../与未命中与二进制同义 null；同文件不同写法只解一次", () => {
  const entries = new Map<string, Uint8Array>([
    ["src/a.ts", strToU8("export const a = 1;\n")],
    ["img/logo.png", strToU8("P\x00NG")],
  ]);
  const reader = fileReaderFromEntries(entries);
  assert.equal(reader("src/a.ts"), "export const a = 1;\n");
  assert.equal(reader("./src/a.ts"), "export const a = 1;\n", "./ 前缀归一到同一键");
  assert.equal(reader("../src/a.ts"), null, ".. 段拒绝");
  assert.equal(reader("gone.ts"), null, "未命中 null（不抛错，模型凭说明行自行纠正）");
  assert.equal(reader("img/logo.png"), null, "二进制与未命中同义 null");
});

test("makeFileReader：快照下载成功返回 reader；失败/缺 token 返回 undefined（best-effort 降级，D027）", async () => {
  await withEnv({ GITHUB_TOKEN: "t" }, async () => {
    const { fetch: impl } = fakeZipFetch(FIXTURE_ZIP);
    const reader = await makeFileReader({ headRepo: "acme/demo", headSha: "abc1234def" }, impl);
    assert.ok(reader, "成功返回 reader");
    assert.equal(reader!("src/a.ts"), "export const a = 1;\n");
    assert.equal(reader!("nope.ts"), null);
  });
  await withEnv({ GITHUB_TOKEN: "t" }, async () => {
    const failing = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
    const reader = await makeFileReader({ headRepo: "acme/demo", headSha: "abc" }, failing);
    assert.equal(reader, undefined, "失败返回 undefined → reviewDiff 不注入 → 单次调用原路径");
  });
  await withEnv({ GITHUB_TOKEN: undefined }, async () => {
    const boom = (async () => {
      throw new Error("缺 token 不应发起请求");
    }) as unknown as typeof fetch;
    const reader = await makeFileReader({ headRepo: "acme/demo", headSha: "abc" }, boom);
    assert.equal(reader, undefined, "缺 GITHUB_TOKEN 同样 best-effort 降级");
  });
});
