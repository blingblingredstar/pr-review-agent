import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { strToU8 } from "fflate";
import {
  buildReviewPrompt,
  buildToolBlock,
  extractReadRequests,
  fileToolEnabled,
  fileToolMaxSteps,
  loadPrompt,
  reviewDiff,
  sumUsage,
  withExtraBody,
} from "../src/review.ts";
import { buildPlanBlock, type ReviewPlan } from "../src/router.ts";
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
