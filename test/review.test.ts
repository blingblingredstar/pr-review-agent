import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import {
  buildReviewPrompt,
  buildToolBlock,
  extractToolRequests,
  fileToolEnabled,
  fileToolMaxSteps,
  loadPrompt,
  reviewDiff,
  sumUsage,
  withExtraBody,
  withJsonSuffixFor,
  type ToolRequests,
} from "../src/review.ts";
import { buildPlanBlock, type ReviewPlan } from "../src/router.ts";
import { fileReaderFromEntries, searcherFromEntries } from "../src/context.ts";
import { buildTaskContext } from "../src/task.ts";
import { buildPrevFindings } from "../src/findings.ts";
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

test("extractToolRequests：readRequests 纯 JSON / 围栏 / 前后闲话都可解析；字符串与 {path} 元素兼容；去重并按步预算截断", () => {
  assert.deepEqual(extractToolRequests('{"readRequests":[{"path":"src/a.ts"}]}', 2), { searches: [], reads: ["src/a.ts"] });
  assert.deepEqual(extractToolRequests('```json\n{"readRequests":["src/a.ts","src/b.ts"]}\n```', 2), {
    searches: [],
    reads: ["src/a.ts", "src/b.ts"],
  });
  assert.deepEqual(
    extractToolRequests('好的，我需要读取：{"readRequests":[{"path":"src/a.ts"},{"path":"src/a.ts"},{"path":"src/a.ts"}]} 请处理', 2),
    { searches: [], reads: ["src/a.ts"] },
    "前后闲话 + 重复路径去重",
  );
  assert.deepEqual(extractToolRequests('{"readRequests":[{"path":"./src/a.ts"},{"path":"src/a.ts"}]}', 5), {
    searches: [],
    reads: ["./src/a.ts"],
  }, "写法变体（./ 前缀）按归一键去重，保留首个");
  assert.deepEqual(extractToolRequests('{"readRequests":[{"path":"a.ts"},{"path":"b.ts"},{"path":"c.ts"}]}', 2), {
    searches: [],
    reads: ["a.ts", "b.ts"],
  }, "超出步预算截断");
  assert.deepEqual(extractToolRequests('{"readRequests":[{"path":"a.ts"},{"path":{"nested":1}}]}', 5), { searches: [], reads: ["a.ts"] }, "非字符串元素跳过");
  assert.deepEqual(extractToolRequests('{"readRequests":[]}', 2), { searches: [], reads: [] }, "空请求 = 不用工具");
  assert.deepEqual(extractToolRequests("我觉得不需要读文件，直接审。", 2), { searches: [], reads: [] }, "无 JSON 返回空（协议违规不炸审查）");
  assert.deepEqual(extractToolRequests('{"other":1}', 2), { searches: [], reads: [] }, "缺 readRequests 字段返回空");
  assert.deepEqual(extractToolRequests("任何文本", 0), { searches: [], reads: [] }, "步预算 0 直接空");
});

test("extractToolRequests：searchRequests 与 readRequests 并列解析、{query} 形态兼容、去重、共享步预算 search 先占（D031）", () => {
  assert.deepEqual(extractToolRequests('{"searchRequests":["formatPrice"],"readRequests":[{"path":"src/a.ts"}]}', 2), {
    searches: ["formatPrice"],
    reads: ["src/a.ts"],
  }, "两类并列声明");
  assert.deepEqual(extractToolRequests('{"searchRequests":[{"query":"sync:done"},{"query":"sync:done"},{"query":"  "},{"query":"oldUtil"}]}', 5), {
    searches: ["sync:done", "oldUtil"],
    reads: [],
  }, "{query} 对象形态兼容；精确串去重（大小写敏感）；空白词丢弃");
  assert.deepEqual(extractToolRequests('{"searchRequests":["formatPrice"]} ', 2), { searches: ["formatPrice"], reads: [] }, "只有 search 也合法（省略另一键）");
  assert.deepEqual(extractToolRequests('{"searchRequests":["a","b","c"],"readRequests":[{"path":"x.ts"}]}', 2), {
    searches: ["a", "b"],
    reads: [],
  }, "共享步预算：search 先占满，read 无剩余被丢弃");
  assert.deepEqual(extractToolRequests('{"searchRequests":["a"],"readRequests":[{"path":"x.ts"},{"path":"y.ts"}]}', 2), {
    searches: ["a"],
    reads: ["x.ts"],
  }, "read 用剩余预算");
  assert.deepEqual(extractToolRequests('{"searchRequests":[{"path":"not-a-query"}]}', 2), { searches: [], reads: [] }, "非字符串/非 {query} 元素跳过");
  // 大小写是不同的搜索（查询本身大小写敏感）
  assert.deepEqual(extractToolRequests('{"searchRequests":["formatPrice","formatprice"]}', 2), {
    searches: ["formatPrice", "formatprice"],
    reads: [],
  });
});

const NO_REQS: ToolRequests = { searches: [], reads: [] };

test("buildToolBlock：命中全文 / 未命中说明行 / 每步观测日志", () => {
  const entries = new Map<string, Uint8Array>([["small.ts", strToU8("export const a = 1;\n")]]);
  const reader = fileReaderFromEntries(entries);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    const hit = buildToolBlock({ ...NO_REQS, reads: ["small.ts"] }, reader, undefined);
    assert.ok(hit.startsWith("[工具结果]"), "块头部让模型识别第二段（D031 起 search/read 共用一块）");
    assert.ok(hit.includes("=== read_file：small.ts（全文 20 字符）===\nexport const a = 1;\n"));
    const miss = buildToolBlock({ ...NO_REQS, reads: ["nope.ts"] }, reader, undefined);
    assert.ok(miss.includes("[read_file] nope.ts: file not found in head snapshot"), "未命中说明行，模型可自行纠正");
  } finally {
    console.log = origLog;
  }
  assert.ok(logs.some((l) => l.includes("[tools] step 1: read small.ts (20 chars)")), "每步观测日志");
  assert.ok(logs.some((l) => l.includes("[tools] step 1: read nope.ts (not found)")));
});

test("buildToolBlock：search 段——命中行块、无匹配、预算截断说明、未注入防御行；步号 search 先于 read（D031）", () => {
  const entries = new Map<string, Uint8Array>([["src/a.ts", strToU8("export const a = slugify(x);\n")], ["src/b.ts", strToU8("plain\n")]]);
  const searcher = searcherFromEntries(entries);
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    const hit = buildToolBlock({ searches: ["slugify"], reads: ["src/b.ts"] }, fileReaderFromEntries(entries), searcher);
    assert.ok(hit.startsWith("[工具结果]"), "统一块头");
    assert.ok(hit.includes('=== search："slugify"（1 个文件 1 处匹配）==='), "头部带全量统计");
    assert.ok(hit.includes("src/a.ts:1: export const a = slugify(x);"), "命中行 path:line: text");
    assert.ok(hit.indexOf("=== search：") < hit.indexOf("=== read_file："), "search 段在 read 段之前");
    const none = buildToolBlock({ ...NO_REQS, searches: ["absent"] }, undefined, searcher);
    assert.ok(none.includes('=== search："absent"（无匹配）==='), "无匹配给明确说明（真无残留，不要硬凑）");
    // searcher 未注入时请求了搜索：显式「未能执行」，不伪报「无匹配」压掉真发现
    const noSearcher = buildToolBlock({ ...NO_REQS, searches: ["anything"] }, fileReaderFromEntries(entries), undefined);
    assert.ok(noSearcher.includes('=== search："anything"（未能执行：搜索不可用）==='));
    // reader 未注入时请求了读取（PR #42 bot minor）：与 search 侧同型——显式「未能执行」，
    // 不伪报「file not found」让模型误信文件不在快照里
    const noReader = buildToolBlock({ ...NO_REQS, reads: ["src/config.ts"] }, undefined, searcher);
    assert.ok(noReader.includes("[read_file] src/config.ts: 未能执行（读取不可用）"));
    assert.ok(!noReader.includes("file not found"));
  } finally {
    console.log = origLog;
  }
  assert.ok(logs.some((l) => l.includes('[tools] step 1: search "slugify" (1 files / 1 matches)')), "search 步观测日志");
  assert.ok(logs.some((l) => l.includes("[tools] step 2: read src/b.ts (6 chars)")), "步号连续：read 排在 search 之后");
});

test("buildToolBlock：search 结果自带查询预算（SEARCH_MAX_TOTAL_CHARS），超预算落 [search] 说明行", () => {
  // 每文件 5 行 × ~430 字符 ≈ 2.1k，15 个文件必超 20k 查询预算
  const fat = Array.from({ length: 5 }, () => `needle ${"y".repeat(400)}`).join("\n");
  const entries = new Map<string, Uint8Array>();
  for (let i = 0; i < 15; i++) entries.set(`d${String(i).padStart(2, "0")}.ts`, strToU8(fat));
  const searcher = searcherFromEntries(entries);
  const origLog = console.log;
  console.log = () => {};
  try {
    const block = buildToolBlock({ ...NO_REQS, searches: ["needle"] }, undefined, searcher);
    assert.ok(block.includes("[search] 结果超出字符预算，仅显示部分匹配"), "预算截断说明行");
    assert.ok(block.length < 80_000, "search 结果受独立查询预算约束，远小于整块 80k");
  } finally {
    console.log = origLog;
  }
});

test("buildToolBlock：多查询累加受整块 80k 封顶——装不下的查询整段未纳入留说明（PR #42 bot minor）", () => {
  // 每文件 5 行 × ~340 字符 ≈ 1.7k，15 个文件 ≈ 25k → 单查询被 SEARCH_MAX_TOTAL_CHARS 截到 20k；
  // 5 个查询累加 ≈ 100k 必破 80k 整块契约（FILE_TOOL_MAX_STEPS 可配 ≥5 的现实路径）
  const fat = Array.from({ length: 5 }, () => `${"y".repeat(300)} q1 q2 q3 q4 q5`).join("\n");
  const entries = new Map<string, Uint8Array>();
  for (let i = 0; i < 15; i++) entries.set(`d${String(i).padStart(2, "0")}.ts`, strToU8(fat));
  const searcher = searcherFromEntries(entries);
  const origLog = console.log;
  console.log = () => {};
  try {
    const block = buildToolBlock({ searches: ["q1", "q2", "q3", "q4", "q5"], reads: [] }, undefined, searcher);
    assert.ok(block.includes('=== search："q1"'), "预算内的查询照常注入");
    assert.ok(block.includes('结果超出整块字符预算，未纳入'), "装不下的查询整段未纳入留说明（不静默丢弃）");
    assert.ok(block.length <= 80_000 + 100, `整块长度 ${block.length} 应 ≲ 80k`);
    assert.ok(!block.includes('=== search："q5"（') || block.includes('"q5" 结果超出整块字符预算'), "尾部查询不再整段注入");
  } finally {
    console.log = origLog;
  }
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
    const block = buildToolBlock({ ...NO_REQS, reads: ["first.ts", "big.ts", "last.ts"] }, reader, undefined);
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
    const block = buildToolBlock({ ...NO_REQS, reads: ["first.ts", "tiny.ts"] }, reader, undefined);
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

test("buildToolBlock：search 段先消费记账，read 段用剩余预算（两类结果共享 80k 整块封顶）", () => {
  // search 段 ~21k（满预算）+ first.ts 79_700 全文装不下 → 转截断而非溢出
  const fat = Array.from({ length: 5 }, () => `needle ${"y".repeat(400)}`).join("\n");
  const entries = new Map<string, Uint8Array>();
  for (let i = 0; i < 15; i++) entries.set(`d${String(i).padStart(2, "0")}.ts`, strToU8(fat));
  entries.set("first.ts", strToU8("y".repeat(79_700)));
  const origLog = console.log;
  console.log = () => {};
  try {
    const block = buildToolBlock({ searches: ["needle"], reads: ["first.ts"] }, fileReaderFromEntries(entries), searcherFromEntries(entries));
    assert.ok(block.includes('=== search："needle"'), "search 段在块内");
    assert.ok(block.includes("=== read_file：first.ts（截断）==="), "search 消费后剩余预算不足以放全文，转截断");
    assert.ok(block.length <= 80_000 + 100, `整块长度 ${block.length} 应 ≲ 80k`);
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

test("JSON 模式（LLM_JSON_MODE=1）：system 追加 json-output.md + response_format json_schema 降级 json_object", async () => {
  const fake = await startFakeLLM(() => ({ content: REVIEW_JSON, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  try {
    await withEnv(
      { LLM_BASE_URL: fake.url, LLM_API_KEY: "test", LLM_MODEL: "fake", LLM_EXTRA_BODY: undefined, LLM_TIMEOUT_MS: undefined, LLM_JSON_MODE: "1" },
      async () => {
        const out = await reviewDiff("DIFF_TEXT", undefined, { timeoutMs: 10_000 });
        const body = fake.calls[0]!.body;
        const [sys] = messagesOf(body).filter((m) => m.role === "system");
        const jsonPrompt = readFileSync(new URL("../prompts/json-output.md", import.meta.url), "utf8");
        assert.equal(sys!.content, `${loadPrompt()}\n\n${jsonPrompt}`, "system = review.md + json-output.md 追加");
        assert.equal((body.response_format as { type?: string }).type, "json_object", "json_schema 降级为 json_object");
        assert.deepEqual(out.comments, [{ file: "src/a.ts", line: 1, severity: "major", body: "b" }]);
      },
    );
  } finally {
    await fake.close();
  }
});

test("JSON 模式显式配置优先：LLM_EXTRA_BODY 带 response_format 时不做降级替换", async () => {
  const fake = await startFakeLLM(() => ({ content: REVIEW_JSON, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  try {
    await withEnv(
      {
        LLM_BASE_URL: fake.url, LLM_API_KEY: "test", LLM_MODEL: "fake", LLM_TIMEOUT_MS: undefined, LLM_JSON_MODE: "1",
        LLM_EXTRA_BODY: '{"response_format":{"type":"json_object","my_marker":1}}',
      },
      async () => {
        await reviewDiff("DIFF_TEXT", undefined, { timeoutMs: 10_000 });
        const body = fake.calls[0]!.body;
        assert.deepEqual(body.response_format, { type: "json_object", my_marker: 1 }, "显式 response_format 原样透传");
      },
    );
  } finally {
    await fake.close();
  }
});

test("JSON 模式 × 两段协议：probe 段不带 json 后缀与 response_format，产出段两者都有", async () => {
  const fake = await startFakeLLM((i) => {
    if (i === 0) return { content: '{"readRequests":["src/a.ts"]}', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    return { content: REVIEW_JSON, usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
  });
  try {
    await withEnv(
      { LLM_BASE_URL: fake.url, LLM_API_KEY: "test", LLM_MODEL: "fake", LLM_EXTRA_BODY: undefined, LLM_TIMEOUT_MS: undefined, LLM_JSON_MODE: "1", FILE_TOOL_MAX_STEPS: "2" },
      async () => {
        const entries = new Map<string, Uint8Array>([["src/a.ts", strToU8("export const a = 1;\n")]]);
        await reviewDiff("DIFF_TEXT", undefined, { timeoutMs: 60_000, fileReader: fileReaderFromEntries(entries) });
        assert.equal(fake.calls.length, 2, "两段协议 = 两次调用");

        const first = fake.calls[0]!.body;
        const firstSys = messagesOf(first).find((m) => m.role === "system")!;
        assert.equal(firstSys.content, `${loadPrompt()}\n\n${TOOLS_PROMPT}`, "probe 段 system 不含 json-output.md（两段协议判据不被污染）");
        assert.equal(first.response_format, undefined, "probe 段无 response_format（json_object 不压制工具请求形态）");

        const second = fake.calls[1]!.body;
        const secondSys = messagesOf(second).find((m) => m.role === "system")!;
        const jsonPrompt = readFileSync(new URL("../prompts/json-output.md", import.meta.url), "utf8");
        assert.equal(secondSys.content, `${loadPrompt()}\n\n${TOOLS_PROMPT}\n\n${jsonPrompt}`, "产出段 system 追加 json-output.md");
        assert.equal((second.response_format as { type?: string }).type, "json_object", "产出段 json_schema 降级 json_object");
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
        assert.ok(secondUser.content.startsWith("[工具结果]"), "工具结果块在 prompt 前段（D031 起 search/read 共用一块头）");
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

test("reviewDiff：fileReader 注入但首段不请求文件（工具请求空）→ 第二段 prompt 与单调用形态一致", async () => {
  const fake = await startFakeLLM((i) => (i === 0 ? { content: '{"readRequests": [], "searchRequests": []}' } : { content: REVIEW_JSON }));
  try {
    await withEnv(
      { LLM_BASE_URL: fake.url, LLM_API_KEY: "test", LLM_MODEL: "fake", LLM_EXTRA_BODY: undefined, LLM_TIMEOUT_MS: undefined, FILE_TOOL_MAX_STEPS: "2" },
      async () => {
        await reviewDiff("DIFF_TEXT", undefined, { timeoutMs: 60_000, fileReader: () => "unused", searcher: () => ({ files: [], totalMatches: 0, totalFiles: 0, omittedFiles: 0, charTruncated: false }) });
        const secondUser = messagesOf(fake.calls[1]!.body).find((m) => m.role === "user")!;
        // 空工具请求也注入占位块（自审 minor）：与第一段 prompt 保持可区分，模型不再重复输出请求
        assert.equal(
          secondUser.content,
          "[工具结果]（本轮无工具请求，请直接给出审查意见）\n\nDIFF_TEXT",
          "空请求占位块 + 原形态 diff",
        );
      },
    );
  } finally {
    await fake.close();
  }
});

test("reviewDiff：首段声明 searchRequests → 第二段注入搜索命中行（search 与 read 并列执行，单轮协议，D031）", async () => {
  const fake = await startFakeLLM((i) => {
    if (i === 0) {
      return { content: '{"searchRequests":["slugify"],"readRequests":[{"path":"src/config.ts"}]}', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    }
    return { content: REVIEW_JSON, usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
  });
  const entries = new Map<string, Uint8Array>([
    ["src/render/summary.ts", strToU8("import { slugify } from '../utils/slug.ts';\n")],
    ["src/config.ts", strToU8("export const MAX = 1;\n")],
  ]);
  try {
    await withEnv(
      { LLM_BASE_URL: fake.url, LLM_API_KEY: "test", LLM_MODEL: "fake", LLM_EXTRA_BODY: undefined, LLM_TIMEOUT_MS: undefined, FILE_TOOL_MAX_STEPS: "2" },
      async () => {
        const out = await reviewDiff("DIFF_TEXT", undefined, {
          timeoutMs: 60_000,
          fileReader: fileReaderFromEntries(entries),
          searcher: searcherFromEntries(entries),
        });
        assert.equal(fake.calls.length, 2, "单轮两段：search 与 read 一次声明一次执行，无链式多轮");
        const secondUser = messagesOf(fake.calls[1]!.body).find((m) => m.role === "user")!;
        assert.ok(secondUser.content.startsWith("[工具结果]"), "第二段工具块前置");
        assert.ok(secondUser.content.includes('=== search："slugify"（1 个文件 1 处匹配）==='), "搜索命中行进第二段");
        assert.ok(secondUser.content.includes("src/render/summary.ts:1: import { slugify } from '../utils/slug.ts';"), "命中行 path:line: text");
        assert.ok(secondUser.content.includes("=== read_file：src/config.ts（全文 22 字符）==="), "read 结果照常注入");
        assert.ok(secondUser.content.endsWith("DIFF_TEXT"), "diff 仍末尾");
        assert.deepEqual(out.comments, [{ file: "src/a.ts", line: 1, severity: "major", body: "b" }]);
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

const PLAN: ReviewPlan = {
  focusAreas: [{ area: "分页边界", files: ["src/github.ts"], why: "off-by-one 高发" }],
  riskAreas: [{ area: "调用方未同步", why: "getPage 的调用方直接透传 page 参数" }],
  readPaths: ["src/index.ts"],
  strategy: "先核对分页循环边界，再扫关联调用方",
};

test("buildReviewPrompt：无 plan 字节级现状（有/无 context 均不变，eval 红线由构造保证，D028）", () => {
  assert.equal(buildReviewPrompt("DIFF_TEXT"), "DIFF_TEXT");
  assert.equal(buildReviewPrompt("DIFF_TEXT", { context: "CTX" }), "CTX\n\n[diff 开始]\nDIFF_TEXT");
});

test("buildReviewPrompt：plan 块在 context 之后、[diff 开始] 之前；无 context 时在 diff 之前；diff 恒末尾（D028）", () => {
  const block = buildPlanBlock(PLAN);
  assert.equal(buildReviewPrompt("DIFF_TEXT", { context: "CTX", plan: PLAN }), `CTX\n\n${block}\n\n[diff 开始]\nDIFF_TEXT`);
  assert.equal(buildReviewPrompt("DIFF_TEXT", { plan: PLAN }), `${block}\n\nDIFF_TEXT`);
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

// ============ 任务上下文注入（D029）============

const TASK_BLOCK = buildTaskContext("fix: 支付状态机", [{ number: 42, title: "under_review 必返回 409", body: "任务正文。" }], 4_000).text!;

test("buildReviewPrompt：taskContext 任务块置顶（context/计划块之前），diff 恒末尾；无 taskContext 字节级现状（D029）", () => {
  // 三块并存：任务块在最前（需求是最高层信号），context → 计划块 → [diff 开始] → diff
  assert.equal(
    buildReviewPrompt("DIFF_TEXT", { context: "CTX", plan: PLAN, taskContext: TASK_BLOCK }),
    `${TASK_BLOCK}\n\nCTX\n\n${buildPlanBlock(PLAN)}\n\n[diff 开始]\nDIFF_TEXT`,
  );
  // 只有任务块：任务块 + diff（中间无空段）
  assert.equal(buildReviewPrompt("DIFF_TEXT", { taskContext: TASK_BLOCK }), `${TASK_BLOCK}\n\nDIFF_TEXT`);
  // 任务块 + 计划块（无 context）：任务块 → 计划块 → diff
  assert.equal(buildReviewPrompt("DIFF_TEXT", { plan: PLAN, taskContext: TASK_BLOCK }), `${TASK_BLOCK}\n\n${buildPlanBlock(PLAN)}\n\nDIFF_TEXT`);
  // 无 taskContext → 字节级现状（eval 红线由构造保证）
  assert.equal(buildReviewPrompt("DIFF_TEXT"), "DIFF_TEXT");
  assert.equal(buildReviewPrompt("DIFF_TEXT", { context: "CTX" }), "CTX\n\n[diff 开始]\nDIFF_TEXT");
  assert.equal(buildReviewPrompt("DIFF_TEXT", { plan: PLAN }), `${buildPlanBlock(PLAN)}\n\nDIFF_TEXT`);
  // taskContext 为空串按无任务块（null 传递语义，与 falsy 同形）
  assert.equal(buildReviewPrompt("DIFF_TEXT", { taskContext: "" }), "DIFF_TEXT");
});

// ============ 上一轮意见注入（D035）============

const PREV_BLOCK = buildPrevFindings(
  [{ file: "src/demo.ts", line: 2, severity: "blocker", body: "老意见：a.missing 未判空" }],
  "abcdef1234",
  6_000,
).text!;

test("buildReviewPrompt：previousFindings 块在计划块之后、[diff 开始] 之前（紧邻 diff），diff 恒末尾；无值字节级现状（D035）", () => {
  // 四块并存：任务块 → context → 计划块 → 上一轮意见块 → [diff 开始] → diff
  assert.equal(
    buildReviewPrompt("DIFF_TEXT", { context: "CTX", plan: PLAN, taskContext: TASK_BLOCK, previousFindings: PREV_BLOCK }),
    `${TASK_BLOCK}\n\nCTX\n\n${buildPlanBlock(PLAN)}\n\n${PREV_BLOCK}\n\n[diff 开始]\nDIFF_TEXT`,
  );
  // 只有意见块（无 context/plan）：意见块紧贴 diff
  assert.equal(buildReviewPrompt("DIFF_TEXT", { previousFindings: PREV_BLOCK }), `${PREV_BLOCK}\n\nDIFF_TEXT`);
  // 意见块 + 计划块（无 context）：计划块 → 意见块 → diff
  assert.equal(
    buildReviewPrompt("DIFF_TEXT", { plan: PLAN, previousFindings: PREV_BLOCK }),
    `${buildPlanBlock(PLAN)}\n\n${PREV_BLOCK}\n\nDIFF_TEXT`,
  );
  // 无 previousFindings → 字节级现状（eval 红线由构造保证）
  assert.equal(buildReviewPrompt("DIFF_TEXT"), "DIFF_TEXT");
  assert.equal(buildReviewPrompt("DIFF_TEXT", { context: "CTX" }), "CTX\n\n[diff 开始]\nDIFF_TEXT");
  assert.equal(buildReviewPrompt("DIFF_TEXT", { previousFindings: "" }), "DIFF_TEXT", "空串按无意见块（null 传递语义）");
});

test("reviewDiff：opts.taskContext 注入 → 任务块进 prompt 置顶，system/调用形态不变，两段协议不丢任务块（D029）", async () => {
  const fake = await startFakeLLM((i) => {
    if (i === 0) return { content: '{"readRequests":["src/a.ts"]}', usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    return { content: REVIEW_JSON, usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
  });
  try {
    await withEnv(
      { LLM_BASE_URL: fake.url, LLM_API_KEY: "test", LLM_MODEL: "fake", LLM_EXTRA_BODY: undefined, LLM_TIMEOUT_MS: undefined, FILE_TOOL_MAX_STEPS: "2" },
      async () => {
        const out = await reviewDiff("DIFF_TEXT", "CTX", { timeoutMs: 10_000, taskContext: TASK_BLOCK, fileReader: () => "content" });
        assert.deepEqual(out.comments, [{ file: "src/a.ts", line: 1, severity: "major", body: "b" }]);
        assert.equal(fake.calls.length, 2, "fileReader 注入时两段协议，任务块不改变调用形态");
        const first = messagesOf(fake.calls[0]!.body).find((m) => m.role === "user")!;
        assert.ok(first.content.startsWith(TASK_BLOCK), "第一段 prompt 任务块置顶");
        assert.ok(first.content.includes("CTX"), "第一段 prompt 含 context");
        const second = messagesOf(fake.calls[1]!.body).find((m) => m.role === "user")!;
        // 第二段工具结果块在 prompt 前段（D027 口径：工具结果前置、diff 保持生成前最近位置）——
        // 任务块仍在块序列内（工具块之后、context 之前），不因两段协议丢失
        assert.ok(second.content.startsWith("[工具结果]"), "第二段工具块前置");
        assert.ok(second.content.includes(TASK_BLOCK), "第二段 prompt 仍含任务块（两段协议不丢）");
        assert.ok(second.content.indexOf(TASK_BLOCK) < second.content.indexOf("CTX"), "任务块仍在 context 之前");
        assert.ok(second.content.endsWith("DIFF_TEXT"), "diff 仍末尾");
        const sys = messagesOf(fake.calls[0]!.body).find((m) => m.role === "system")!;
        assert.equal(sys.content, `${loadPrompt()}\n\n${readFileSync(new URL("../prompts/review-tools.md", import.meta.url), "utf8")}`, "system 仍只有 review.md + review-tools.md");
      },
    );
  } finally {
    await fake.close();
  }
});

test("reviewDiff：opts.taskContext 不传 = 裸路径字节级不变（能力组红线由构造保证，D029）", async () => {
  const fake = await startFakeLLM(() => ({ content: REVIEW_JSON, usage: { prompt_tokens: 583, completion_tokens: 130, total_tokens: 713 } }));
  try {
    await withEnv(
      { LLM_BASE_URL: fake.url, LLM_API_KEY: "test", LLM_MODEL: "fake", LLM_EXTRA_BODY: undefined, LLM_TIMEOUT_MS: undefined },
      async () => {
        await reviewDiff("DIFF_TEXT", "CTX", { timeoutMs: 10_000 });
        const user = messagesOf(fake.calls[0]!.body).find((m) => m.role === "user")!;
        assert.equal(user.content, "CTX\n\n[diff 开始]\nDIFF_TEXT", "无任务块 = 现状字节级");
      },
    );
  } finally {
    await fake.close();
  }
});

test("LLM_MAX_OUTPUT_TOKENS：设置 → 请求体带 max_tokens；未设置/非法值 → 不传（字节级不变）", async () => {
  const fake = await startFakeLLM(() => ({ content: REVIEW_JSON, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  try {
    await withEnv(
      { LLM_BASE_URL: fake.url, LLM_API_KEY: "test", LLM_MODEL: "fake", LLM_EXTRA_BODY: undefined, LLM_TIMEOUT_MS: undefined, LLM_JSON_MODE: undefined, LLM_MAX_OUTPUT_TOKENS: "2048" },
      async () => {
        await reviewDiff("DIFF_TEXT", undefined, { timeoutMs: 10_000 });
        assert.equal((fake.calls[0]!.body as { max_tokens?: number }).max_tokens, 2048, "设置 → max_tokens 透传");
      },
    );
    await withEnv(
      { LLM_BASE_URL: fake.url, LLM_API_KEY: "test", LLM_MODEL: "fake", LLM_EXTRA_BODY: undefined, LLM_TIMEOUT_MS: undefined, LLM_JSON_MODE: undefined, LLM_MAX_OUTPUT_TOKENS: undefined },
      async () => {
        fake.calls.length = 0;
        await reviewDiff("DIFF_TEXT", undefined, { timeoutMs: 10_000 });
        assert.equal((fake.calls[0]!.body as { max_tokens?: number }).max_tokens, undefined, "未设置 → 不传（字节级不变）");
      },
    );
    await withEnv(
      { LLM_BASE_URL: fake.url, LLM_API_KEY: "test", LLM_MODEL: "fake", LLM_EXTRA_BODY: undefined, LLM_TIMEOUT_MS: undefined, LLM_JSON_MODE: undefined, LLM_MAX_OUTPUT_TOKENS: "abc" },
      async () => {
        fake.calls.length = 0;
        await reviewDiff("DIFF_TEXT", undefined, { timeoutMs: 10_000 });
        assert.equal((fake.calls[0]!.body as { max_tokens?: number }).max_tokens, undefined, "非法值 → 按未设置处理");
      },
    );
  } finally {
    await fake.close();
  }
});

// ============ scoped json 模式开关（决策端点 plumbing，#66 前置）============

test("withJsonSuffixFor：显式 enabled 优先于全局 jsonMode()（缺省保持现状语义）", async () => {
  await withEnv({ LLM_JSON_MODE: undefined }, () => {
    assert.ok(withJsonSuffixFor("BASE", "SUFFIX", true).endsWith("SUFFIX"), "显式 true：全局未开也追加");
    assert.equal(withJsonSuffixFor("BASE", "SUFFIX", false), "BASE", "显式 false：不追加");
    assert.equal(withJsonSuffixFor("BASE", "SUFFIX"), "BASE", "缺省：跟随全局（未开）——现状语义");
  });
  await withEnv({ LLM_JSON_MODE: "1" }, () => {
    assert.equal(withJsonSuffixFor("BASE", "SUFFIX", false), "BASE", "全局开着但显式 false：不追加（跨端点隔离）");
    assert.ok(withJsonSuffixFor("BASE", "SUFFIX").endsWith("SUFFIX"), "缺省：跟随全局（开）");
  });
});

test("withExtraBody：scoped 开关控制 json_schema→json_object 替换（extra.response_format 显式配置仍优先）", async () => {
  const fetchBody = async (input: unknown, init?: RequestInit) => new Response(init?.body as string);
  const schemaBody = JSON.stringify({ response_format: { type: "json_schema" } });
  await withEnv({ LLM_JSON_MODE: undefined, LLM_EXTRA_BODY: undefined }, async () => {
    const swapped = JSON.parse(await (await withExtraBody(fetchBody as typeof fetch, {}, true)("https://x", { method: "POST", body: schemaBody })).text());
    assert.deepEqual(swapped.response_format, { type: "json_object" }, "全局关但显式开：仍替换（决策端点独立开 json 模式）");
    const intact = JSON.parse(await (await withExtraBody(fetchBody as typeof fetch, {}, false)("https://x", { method: "POST", body: schemaBody })).text());
    assert.deepEqual(intact.response_format, { type: "json_schema" }, "显式 false：不替换");
  });
  await withEnv({ LLM_JSON_MODE: "1", LLM_EXTRA_BODY: undefined }, async () => {
    const kept = JSON.parse(await (await withExtraBody(fetchBody as typeof fetch, { response_format: { type: "json_object" } }, true)("https://x", { method: "POST", body: schemaBody })).text());
    assert.deepEqual(kept.response_format, { type: "json_object" }, "extra 显式带 response_format：不覆盖（显式配置优先语义不变）");
  });
});
