import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { buildPlanBlock, decisionModel, diffSkeleton, reviewPlanSchema, runReviewRouter, type ReviewPlan } from "../src/router.ts";
import { messagesOf, startFakeLLM, withEnv } from "./helpers.ts";

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
