import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { zipSync, strToU8 } from "fflate";
import type { Octokit } from "octokit";
import {
  chainBase,
  chainWorker,
  defaultWorkerDeps,
  deductBudget,
  handleWorker,
  MAX_HOPS,
  prepareEnvelope,
  runStage,
  type WorkerDeps,
  type WorkerEnvelope,
} from "../src/worker.ts";
import { handleWebhook } from "../src/webhook.ts";
import { reviewMarker } from "../src/dedupe.ts";
import { llmTimeoutMs, loadPrompt, type ReviewDiffOpts, type ReviewOutcome } from "../src/review.ts";
import { buildPlanBlock, type ReviewPlan } from "../src/router.ts";
import { messagesOf, startFakeLLM, withEnv } from "./helpers.ts";

const SECRET = "test-secret";
process.env.WEBHOOK_SECRET ??= SECRET;
// prepare 编排不测 zipball 下载路径（context.ts 有独立测试）：预算 0 显式关闭上下文注入（D023），buildRepoContext 直接返回 null
process.env.CONTEXT_MAX_CHARS ??= "0";
// worker 接线的工具循环默认开（D027）——除专属接线用例外统一关闭，避免默认路径发 zipball 请求
process.env.FILE_TOOL_MAX_STEPS ??= "0";
delete process.env.VERCEL_URL;

const REF = { owner: "acme", repo: "demo", pullNumber: 7, headSha: "abc123def4567890" };

const DIFF = [
  "diff --git a/src/demo.ts b/src/demo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/demo.ts",
  "+++ b/src/demo.ts",
  "@@ -1,3 +1,4 @@",
  " const a = 1;",
  "+const b = a.missing.method();",
  " const c = 2;",
].join("\n");

const REVIEW_RESULT: ReviewOutcome = {
  comments: [{ file: "src/demo.ts", line: 2, severity: "minor", body: "a 可能为 null，直接取 method 会炸" }],
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
};

function sig(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

// 链路不应出网/不应触发真实 LLM 的哨兵注入
const boomFetch = (async () => {
  throw new Error("网络不应被触碰");
}) as unknown as typeof fetch;

const boomChain = async (): Promise<void> => {
  throw new Error("chain 不应被调用");
};

// 假 Octokit：记录 status / review / comment / label 调用，paginate 可注入已有 review 列表（hasReviewed 按标记判定）。
// D029 任务上下文：prTitle/prBody 进 meta（fetchPr 随手带回），issues 可注入 issue 正文（含 Error 注入失败、
// { pr: true } 注入 PR 形响应）；缺省 meta 无 title/body、issues.get 未命中即 404。
// D035 v2：reviewThreads 注入 GraphQL reviewThreads.nodes（dismissed 取数 mock，缺省空线程集）
function fakeClient(
  reviews?: { body: string; sha?: string; id?: number; submitted_at?: string }[],
  opts?: {
    prTitle?: string;
    prBody?: string;
    issues?: Record<number, { title: string; body: string } | Error | { pr: true }>;
    reviewComments?: unknown[];
    compareFiles?: unknown[];
    reviewThreads?: unknown[];
  },
) {
  const calls = {
    statuses: [] as { sha: string; state: string; description: string }[],
    reviews: [] as Record<string, unknown>[],
    comments: [] as Record<string, unknown>[],
    labels: [] as Record<string, unknown>[],
    issueGets: [] as number[],
    commentReviewIds: [] as number[],
    paginateCalls: 0,
    graphqlQueries: 0,
  };
  const client = {
    graphql: async () => {
      calls.graphqlQueries++;
      return {
        repository: {
          pullRequest: {
            reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: opts?.reviewThreads ?? [] },
          },
        },
      };
    },
    paginate: async (fn: unknown, args?: { review_id?: number }) => {
      calls.paginateCalls++;
      const name = (fn as { name?: string } | undefined)?.name ?? "";
      if (name === "listCommentsForReview" || args?.review_id !== undefined) {
        calls.commentReviewIds.push(args?.review_id ?? -1);
        return opts?.reviewComments ?? [];
      }
      return reviews ?? [];
    },
    rest: {
      repos: {
        createCommitStatus: async (args: { sha: string; state: string; description: string }) => {
          calls.statuses.push(args);
          return { data: {} };
        },
        compareCommits: async () => ({ data: { files: opts?.compareFiles ?? [] } }),
      },
      pulls: {
        get: async (args: { mediaType?: unknown }) =>
          args.mediaType
            ? { data: DIFF }
            : { data: { head: { sha: REF.headSha }, title: opts?.prTitle, body: opts?.prBody } },
        createReview: async (args: Record<string, unknown>) => {
          calls.reviews.push(args);
          return { data: {} };
        },
        listReviews: () => undefined,
        listCommits: () => undefined,
        listCommentsForReview: () => undefined,
      },
      issues: {
        get: async (args: { issue_number: number }) => {
          calls.issueGets.push(args.issue_number);
          const found = opts?.issues?.[args.issue_number];
          if (!found) throw Object.assign(new Error("Not Found"), { status: 404 });
          if (found instanceof Error) throw found;
          if ("pr" in found) return { data: { number: args.issue_number, title: "PR 标题", body: "PR 描述", pull_request: {} } };
          return { data: { number: args.issue_number, title: found.title, body: found.body } };
        },
        createComment: async (args: Record<string, unknown>) => {
          calls.comments.push(args);
          return { data: {} };
        },
        addLabels: async (args: Record<string, unknown>) => {
          calls.labels.push(args);
          return { data: {} };
        },
      },
    },
  };
  return { client: client as unknown as Octokit, calls };
}

// 完整 deps：默认铺生产形状（chain=chainWorker），单测只覆写关心的注入点
function fullDeps(overrides: Partial<WorkerDeps>): WorkerDeps {
  return { ...defaultWorkerDeps(), ...overrides };
}

function workerHeaders(body: string): Record<string, string> {
  return { "x-worker-signature": sig(body) };
}

test("worker 入口：签名信封 roundtrip——验签、解析、阶段收到原信封并续出 publish 信封", async () => {
  const envelope: WorkerEnvelope = {
    v: 1,
    stage: "review",
    hop: 1,
    ref: REF,
    issuedAt: Date.now(),
    state: { diff: DIFF, context: null },
  };
  const body = JSON.stringify(envelope);
  const tasks: Array<() => Promise<void>> = [];
  const chained: WorkerEnvelope[] = [];
  const reviewed: { diff: string; context: string | undefined }[] = [];
  const outcome = handleWorker(workerHeaders(body), body, {
    schedule: (t) => tasks.push(t),
    review: async (diff, context) => {
      reviewed.push({ diff, context });
      return REVIEW_RESULT;
    },
    chain: async (e) => {
      chained.push(e);
    },
  });
  assert.equal(outcome.status, 200);
  assert.equal(tasks.length, 1);
  await tasks[0]!();
  // context 为 null（D023 best-effort 失败）时按无上下文审查（与原 runReview 的 `context ?? undefined` 同形）
  assert.deepEqual(reviewed, [{ diff: DIFF, context: undefined }]);
  // review → publish：state 累积（postReview 仍需 diff 做行内预定位），hop +1
  assert.equal(chained.length, 1);
  assert.equal(chained[0]!.stage, "publish");
  assert.equal(chained[0]!.hop, 2);
  // ref 经 JSON roundtrip 是新对象：结构一致即 roundtrip 成立
  assert.deepEqual(chained[0]!.ref, envelope.ref);
  // 信封 state 原样透传累积（taskContext 等未设置键不凭空出现，`...state` 展开语义）
  assert.deepEqual(chained[0]!.state, { diff: DIFF, context: null, result: REVIEW_RESULT });
});

test("worker 入口：篡改 body / GitHub 头名代打均 403 不调度（x-worker-signature 语义分离）", () => {
  const body = JSON.stringify(prepareEnvelope(REF));
  const tasks: Array<() => Promise<void>> = [];
  const deps = { schedule: (t: () => Promise<void>) => tasks.push(t) };
  assert.equal(handleWorker(workerHeaders(body + " "), body, deps).status, 403);
  // x-hub-signature-256 只属于 GitHub 来信：签名对了也进不了 worker 门
  assert.equal(handleWorker({ "x-hub-signature-256": sig(body) }, body, deps).status, 403);
  assert.equal(tasks.length, 0);
});

test("worker 入口：issuedAt 明显超前（未来值）同样 403，重放窗不为负时钟开口", async () => {
  const future = JSON.stringify({ ...prepareEnvelope(REF), issuedAt: Date.now() + 10 * 60 * 1000 });
  const tasks: Array<() => Promise<void>> = [];
  assert.equal(handleWorker(workerHeaders(future), future, { schedule: (t) => tasks.push(t) }).status, 403);
  assert.equal(tasks.length, 1, "落灯任务照常调度（签名合法链路断在入口）");
});

test("worker 入口：issuedAt 超新鲜窗口 403 不调度阶段、落 failure status（发送方可能已死，链路断在这）；窗口内放行；缺失按过期拒绝", async () => {
  const stale = JSON.stringify({ ...prepareEnvelope(REF), issuedAt: Date.now() - 10 * 60 * 1000 - 1 });
  const staleTasks: Array<() => Promise<void>> = [];
  const { client: staleClient, calls: staleCalls } = fakeClient();
  assert.equal(
    handleWorker(workerHeaders(stale), stale, { schedule: (t) => staleTasks.push(t), client: () => staleClient }).status,
    403,
  );
  assert.equal(staleTasks.length, 1, "仅调度落灯任务，不调度阶段");
  await staleTasks[0]!();
  assert.deepEqual(
    staleCalls.statuses.map((s) => [s.state, s.description]),
    [["failure", "审查中断"]],
  );

  const fresh = JSON.stringify({ ...prepareEnvelope(REF), issuedAt: Date.now() - 1000 });
  const freshTasks: Array<() => Promise<void>> = [];
  assert.equal(handleWorker(workerHeaders(fresh), fresh, { schedule: (t) => freshTasks.push(t) }).status, 200);
  assert.equal(freshTasks.length, 1);

  const noIssuedAt = JSON.stringify({ v: 1, stage: "prepare", hop: 0, ref: REF });
  // 闸门拒绝路径会调度落灯任务（round: 自审 major）：必须注入 deps，默认 waitUntil/getOctokit 在测试环境会出网
  const { client: gateClient, calls: gateCalls } = fakeClient();
  const gateTasks: Array<() => Promise<void>> = [];
  assert.equal(
    handleWorker(workerHeaders(noIssuedAt), noIssuedAt, { schedule: (t) => gateTasks.push(t), client: () => gateClient }).status,
    403,
  );
  await gateTasks[0]!();
  assert.deepEqual(gateCalls.statuses.map((s) => s.state), ["failure"]);
});

test("worker 入口：hop 超上限 403 且落 failure status「审查中断」（防御性）；边界 hop=MAX_HOPS 放行", async () => {
  const over = JSON.stringify({ ...prepareEnvelope(REF), hop: MAX_HOPS + 1 });
  const tasks: Array<() => Promise<void>> = [];
  const { client, calls } = fakeClient();
  const outcome = handleWorker(workerHeaders(over), over, { schedule: (t) => tasks.push(t), client: () => client });
  assert.equal(outcome.status, 403);
  assert.equal(tasks.length, 1, "failure status 落定走调度");
  await tasks[0]!();
  assert.deepEqual(
    calls.statuses.map((s) => [s.state, s.description]),
    [["failure", "审查中断"]],
  );

  const edge = JSON.stringify({ ...prepareEnvelope(REF), hop: MAX_HOPS });
  const edgeTasks: Array<() => Promise<void>> = [];
  assert.equal(handleWorker(workerHeaders(edge), edge, { schedule: (t) => edgeTasks.push(t) }).status, 200);
  assert.equal(edgeTasks.length, 1);
});

test("三阶段编排：prepare→review→publish 本地直调串成一条链，dedupe/status/回帖全部落定", async () => {
  const { client, calls } = fakeClient();
  const reviewed: { diff: string; context: string | undefined }[] = [];
  await chainWorker(prepareEnvelope(REF), {
    client: () => client,
    review: async (diff, context) => {
      reviewed.push({ diff, context });
      return REVIEW_RESULT;
    },
    fetchImpl: boomFetch,
  });
  // prepare：dedupe（第 1 次 paginate）→ pending → fetchPr → 增量决策（listReviews+listCommits 第 2/3 次，无标记回退全量）；
  // publish：二次 dedupe（第 4 次 paginate）
  assert.equal(calls.paginateCalls, 4);
  assert.deepEqual(
    calls.statuses.map((s) => [s.sha, s.state, s.description]),
    [
      [REF.headSha, "pending", "审查进行中"],
      [REF.headSha, "success", "完成：0 条意见 + 1 条 minor/nit 折叠"],
    ],
  );
  // prepare 拉到的 diff 直传 review（context 关闭 → undefined）；state 随信封携带
  assert.deepEqual(reviewed, [{ diff: DIFF, context: undefined }]);
  assert.equal(calls.reviews.length, 1);
  const review = calls.reviews[0]!;
  assert.equal(review.commit_id, REF.headSha);
  assert.equal(review.event, "COMMENT", "纯 minor/nit 收窄为 COMMENT（D032 发布门槛：block 的本意是需要人介入）");
  assert.ok(String(review.body).includes(reviewMarker(REF.headSha)), "summary 内嵌 sha 标记（D010）");
  assert.ok(String(review.body).includes("<details>"), "minor/nit 折叠进 body details（D032 门槛）");
  assert.ok(String(review.body).includes("**[minor]**"), "折叠段逐条同构格式（机器可解析）");
  assert.equal(calls.labels.length, 0, "minor 不打标签（blocker/major 才打）");
});

test("publish 二次 dedupe：不回帖（防重派），补落 success status（上次 postReview 成功但终态未落定的重派路径）", async () => {
  const { client, calls } = fakeClient([{ body: `意见\n${reviewMarker(REF.headSha)}` }]);
  await runStage(fullDeps({ client: () => client, chain: boomChain }), {
    v: 1,
    stage: "publish",
    hop: 2,
    ref: REF,
    issuedAt: Date.now(),
    state: { diff: DIFF, result: REVIEW_RESULT },
  });
  assert.equal(calls.reviews.length, 0, "review 已存在，不再回帖");
  assert.deepEqual(
    calls.statuses.map((s) => [s.state, s.description]),
    [["success", "完成（重派路径补落终态）"]],
  );
});

test("prepare dedupe：已有同 SHA 审查，不拉 diff 不续链，补落 success status（重派路径终态）", async () => {
  const { client, calls } = fakeClient([{ body: reviewMarker(REF.headSha) }]);
  await runStage(fullDeps({ client: () => client, chain: boomChain }), prepareEnvelope(REF));
  assert.equal(calls.paginateCalls, 1);
  assert.deepEqual(
    calls.statuses.map((s) => [s.state, s.description]),
    [["success", "完成（重派路径补落终态）"]],
  );
});

test("review 阶段超时：降级通知（D011）+ failure status「审查超时，重推 commit 可重试」", async () => {
  const { client, calls } = fakeClient();
  const timeoutErr = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  await runStage(
    fullDeps({
      client: () => client,
      review: async () => {
        throw timeoutErr;
      },
      chain: boomChain,
    }),
    { v: 1, stage: "review", hop: 1, ref: REF, issuedAt: Date.now(), state: { diff: DIFF } },
  );
  assert.equal(calls.comments.length, 1, "超时发 issue comment 降级通知");
  assert.deepEqual(
    calls.statuses.map((s) => [s.state, s.description]),
    [["failure", "审查超时，重推 commit 可重试"]],
  );
});

test("review 阶段其他异常：failure status「审查失败，见 Vercel 日志」，与原 runReview 语义一致", async () => {
  const { client, calls } = fakeClient();
  await runStage(
    fullDeps({
      client: () => client,
      review: async () => {
        throw new Error("boom");
      },
      chain: boomChain,
    }),
    { v: 1, stage: "review", hop: 1, ref: REF, issuedAt: Date.now(), state: { diff: DIFF } },
  );
  assert.equal(calls.comments.length, 0);
  assert.deepEqual(
    calls.statuses.map((s) => [s.state, s.description]),
    [["failure", "审查失败，见 Vercel 日志"]],
  );
});

test("续链失败：2 次尝试（请求体带签名头）后 best-effort 落 failure status「审查中断」，不抛出", async () => {
  process.env.VERCEL_URL = "test-deploy.vercel.app";
  try {
    const { client, calls } = fakeClient();
    const posts: { url: string; method?: string; headers: Record<string, string>; body: string }[] = [];
    const failingFetch = (async (input: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
      posts.push({
        url: String(input),
        method: (init as { method?: string } | undefined)?.method,
        headers: init?.headers ?? {},
        body: init?.body ?? "",
      });
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    await chainWorker(prepareEnvelope(REF), { client: () => client, fetchImpl: failingFetch, chainRetryDelayMs: 1 });
    assert.equal(posts.length, 2, "最多 2 次尝试");
    assert.equal(posts[0]!.url, "https://test-deploy.vercel.app/api/worker");
    assert.equal(posts[0]!.method, "POST");
    assert.equal(posts[0]!.headers["x-worker-signature"], sig(posts[0]!.body), "签名与请求体配套");
    assert.equal(JSON.parse(posts[0]!.body).stage, "prepare");
    assert.deepEqual(
      calls.statuses.map((s) => [s.state, s.description]),
      [["failure", "审查中断"]],
    );
  } finally {
    delete process.env.VERCEL_URL;
  }
});

test("续链 4xx 确定性失败：不重试直接终失败（重试必同败，不白等间隔）", async () => {
  process.env.VERCEL_URL = "test-deploy.vercel.app";
  try {
    const { client, calls } = fakeClient();
    let attempts = 0;
    const notFoundFetch = (async () => {
      attempts++;
      return new Response("envelope rejected", { status: 403 });
    }) as unknown as typeof fetch;
    await chainWorker(prepareEnvelope(REF), { client: () => client, fetchImpl: notFoundFetch, chainRetryDelayMs: 1 });
    assert.equal(attempts, 1, "403 只打一次，不进重试");
    assert.deepEqual(
      calls.statuses.map((s) => [s.state, s.description]),
      [["failure", "审查中断"]],
    );
  } finally {
    delete process.env.VERCEL_URL;
  }
});

test("续链 429 可重试：2 次尝试后落 failure status；单次请求带硬超时 signal", async () => {
  process.env.VERCEL_URL = "test-deploy.vercel.app";
  try {
    const { client, calls } = fakeClient();
    let attempts = 0;
    const throttledFetch = (async (_input: unknown, init?: { signal?: AbortSignal }) => {
      attempts++;
      assert.ok(init?.signal instanceof AbortSignal, "fetch 带硬超时 signal");
      return new Response("slow down", { status: 429 });
    }) as unknown as typeof fetch;
    await chainWorker(prepareEnvelope(REF), { client: () => client, fetchImpl: throttledFetch, chainRetryDelayMs: 1 });
    assert.equal(attempts, 2, "429 属可重试类，最多 2 次尝试");
    assert.deepEqual(
      calls.statuses.map((s) => [s.state, s.description]),
      [["failure", "审查中断"]],
    );
  } finally {
    delete process.env.VERCEL_URL;
  }
});

test("续链成功：POST 到自部署 /api/worker 后即返回，不在本进程执行阶段", async () => {
  process.env.VERCEL_URL = "test-deploy.vercel.app";
  try {
    const { client, calls } = fakeClient();
    const reviewed: string[] = [];
    await chainWorker(prepareEnvelope(REF), {
      client: () => client,
      fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch,
      review: async (diff) => {
        reviewed.push(diff);
        return REVIEW_RESULT;
      },
      chainRetryDelayMs: 1,
    });
    assert.equal(calls.statuses.length, 0);
    assert.equal(reviewed.length, 0, "生产续链交给新调用执行，本进程不跑阶段");
  } finally {
    delete process.env.VERCEL_URL;
  }
});

test("VERCEL_URL 未设置：直调回退在本进程执行下一阶段（同 schedule 直调语义），链到注入 chain 为止", async () => {
  const { client, calls } = fakeClient();
  const chained: WorkerEnvelope[] = [];
  const reviewed: { diff: string; context: string | undefined }[] = [];
  await chainWorker(
    { v: 1, stage: "review", hop: 1, ref: REF, issuedAt: Date.now(), state: { diff: DIFF, context: "仓库上下文" } },
    {
      client: () => client,
      review: async (diff, context) => {
        reviewed.push({ diff, context });
        return REVIEW_RESULT;
      },
      chain: async (e) => {
        chained.push(e);
      },
      fetchImpl: boomFetch,
    },
  );
  assert.deepEqual(reviewed, [{ diff: DIFF, context: "仓库上下文" }]);
  assert.equal(chained.length, 1);
  assert.equal(chained[0]!.stage, "publish");
  assert.equal(chained[0]!.hop, 2);
  assert.deepEqual(chained[0]!.state, { diff: DIFF, context: "仓库上下文", result: REVIEW_RESULT });
  assert.equal(calls.statuses.length, 0, "publish 交给注入 chain，本次调用只走一跳");
});

test("webhook 调度对象：发 prepare 信封（hop 0、ref 含 headRepo、不带 state）", async () => {
  const payload = JSON.stringify({
    action: "opened",
    repository: { owner: { login: "acme" }, name: "demo" },
    pull_request: {
      number: 7,
      head: { sha: "abc123def4567890", repo: { full_name: "fork/demo" } },
      user: { login: "acme" },
    },
  });
  const headers = {
    "x-github-event": "pull_request",
    "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`,
  };
  const tasks: Array<() => Promise<void>> = [];
  const dispatched: WorkerEnvelope[] = [];
  handleWebhook(headers, payload, (t) => tasks.push(t), async (e) => {
    dispatched.push(e);
  });
  assert.equal(tasks.length, 1);
  await tasks[0]!();
  assert.equal(dispatched.length, 1);
  const envelope = dispatched[0]!;
  assert.equal(envelope.v, 1);
  assert.equal(envelope.stage, "prepare");
  assert.equal(envelope.hop, 0);
  assert.equal(envelope.ref.owner, "acme");
  assert.equal(envelope.ref.repo, "demo");
  assert.equal(envelope.ref.pullNumber, 7);
  assert.equal(envelope.ref.headSha, "abc123def4567890");
  assert.equal(envelope.ref.headRepo, "fork/demo", "fork PR 的 head 仓库随信封传递（D023）");
  assert.ok(Math.abs(envelope.issuedAt - Date.now()) < 1000);
  assert.equal(envelope.state, undefined, "prepare 信封不携带状态");
});

test("续链缺 WEBHOOK_SECRET：不抛出（waitUntil 契约），落 failure status「审查中断」", async () => {
  process.env.VERCEL_URL = "test-deploy.vercel.app";
  const savedSecret = process.env.WEBHOOK_SECRET;
  delete process.env.WEBHOOK_SECRET;
  try {
    const { client, calls } = fakeClient();
    let fetched = 0;
    const fetchSpy = (async () => {
      fetched++;
      return new Response("ok");
    }) as unknown as typeof fetch;
    await chainWorker(prepareEnvelope(REF), { client: () => client, fetchImpl: fetchSpy, chainRetryDelayMs: 1 });
    assert.equal(fetched, 0, "无法签名，不发请求");
    assert.deepEqual(
      calls.statuses.map((s) => [s.state, s.description]),
      [["failure", "审查中断"]],
    );
  } finally {
    delete process.env.VERCEL_URL;
    if (savedSecret !== undefined) process.env.WEBHOOK_SECRET = savedSecret;
  }
});

test("续链 408 可重试：与网络异常同属瞬态，2 次尝试后落灯", async () => {
  process.env.VERCEL_URL = "test-deploy.vercel.app";
  try {
    const { client, calls } = fakeClient();
    let attempts = 0;
    const timeoutFetch = (async () => {
      attempts++;
      return new Response("request timeout", { status: 408 });
    }) as unknown as typeof fetch;
    await chainWorker(prepareEnvelope(REF), { client: () => client, fetchImpl: timeoutFetch, chainRetryDelayMs: 1 });
    assert.equal(attempts, 2, "408 属瞬态可重试类");
    assert.deepEqual(
      calls.statuses.map((s) => [s.state, s.description]),
      [["failure", "审查中断"]],
    );
  } finally {
    delete process.env.VERCEL_URL;
  }
});

test("review 阶段传给 LLM 的超时 = min(LLM_TIMEOUT_MS, 260s 阶段封顶)——把 LLM 打满 + 续链 + 落灯整体关进墙钟（自审 major）", async () => {
  const { client } = fakeClient();
  const received: ({ timeoutMs?: number } | undefined)[] = [];
  await runStage(
    fullDeps({
      client: () => client,
      review: async (diff, context, opts) => {
        received.push(opts);
        return REVIEW_RESULT;
      },
      chain: boomChain,
    }),
    { v: 1, stage: "review", hop: 1, ref: REF, issuedAt: Date.now(), state: { diff: DIFF, context: null } },
  );
  const opts = received[0];
  assert.ok(opts && typeof opts.timeoutMs === "number", "deps.review 收到 timeoutMs 覆写");
  assert.equal(opts!.timeoutMs, Math.min(llmTimeoutMs(), 260_000));
  assert.ok(opts!.timeoutMs! + 22_000 + 2_000 < 285_000, "LLM 打满 + 续链最坏 22s + 落灯关进阶段墙钟 285s");
});

test("阶段墙钟：阶段内挂起超线由 race 兜底落 failure「审查中断」，不等平台强杀（自审 major）", async () => {
  const { client, calls } = fakeClient();
  const body = JSON.stringify({
    v: 1,
    stage: "review",
    hop: 1,
    ref: REF,
    issuedAt: Date.now(),
    state: { diff: DIFF },
  } satisfies WorkerEnvelope);
  const tasks: Array<() => Promise<void>> = [];
  const outcome = handleWorker(workerHeaders(body), body, {
    schedule: (t) => tasks.push(t),
    client: () => client,
    review: () => new Promise(() => {}), // 永不 resolve：模拟 octokit 无超时挂起
    chain: boomChain,
    stageDeadlineMs: 20,
  });
  assert.equal(outcome.status, 200);
  await tasks[0]!();
  assert.deepEqual(
    calls.statuses.map((s) => [s.state, s.description]),
    [["failure", "审查中断"]],
  );
});

test("过期信封但审查已完成（另一条重试链跑完了）：补落 success 而非 failure 翻红灯", async () => {
  const stale = JSON.stringify({ ...prepareEnvelope(REF), issuedAt: Date.now() - 10 * 60 * 1000 - 1 });
  const staleTasks: Array<() => Promise<void>> = [];
  const { client, calls } = fakeClient([{ body: `意见\n${reviewMarker(REF.headSha)}` }]);
  assert.equal(
    handleWorker(workerHeaders(stale), stale, { schedule: (t) => staleTasks.push(t), client: () => client }).status,
    403,
  );
  await staleTasks[0]!();
  assert.deepEqual(
    calls.statuses.map((s) => [s.state, s.description]),
    [["success", "完成（重派路径补落终态）"]],
  );
});

// D027 接线用例的快照夹具：与 REF 的 headRepo（acme/demo）无关——fetchImpl 直接按序返回 zip，不校验 URL
const FIXTURE_ZIP = zipSync({
  "acme-demo-abc1234/": new Uint8Array(0),
  "acme-demo-abc1234/src/a.ts": strToU8("export const a = 1;\n"),
});

test("worker review 阶段接线：FILE_TOOL_MAX_STEPS 开启 → 重取快照并注入 deps.review（D027）", async () => {
  const { client } = fakeClient();
  const received: ReviewDiffOpts[] = [];
  let zipFetches = 0;
  const zipFetch = (async () => {
    zipFetches++;
    return new Response(new Uint8Array(FIXTURE_ZIP), { status: 200 });
  }) as unknown as typeof fetch;
  await withEnv({ FILE_TOOL_MAX_STEPS: "2", GITHUB_TOKEN: "t" }, async () => {
    await runStage(
      fullDeps({
        client: () => client,
        fetchImpl: zipFetch,
        chain: boomChain,
        review: async (diff, context, opts) => {
          received.push(opts ?? {});
          return REVIEW_RESULT;
        },
      }),
      { v: 1, stage: "review", hop: 1, ref: REF, issuedAt: Date.now(), state: { diff: DIFF, context: null } },
    );
  });
  assert.equal(zipFetches, 1, "review 阶段重取一次快照（不走信封携带，D027）");
  const reader = received[0]!.fileReader;
  assert.ok(typeof reader === "function", "deps.review 收到 fileReader");
  assert.equal(reader!("src/a.ts"), "export const a = 1;\n", "reader 从快照出全文");
  assert.equal(reader!("./src/a.ts"), "export const a = 1;\n", "./ 前缀归一");
  assert.equal(reader!("../secret"), null, ".. 段拒绝");
  assert.equal(reader!("missing.ts"), null, "未命中 null");
  const search = received[0]!.searcher;
  assert.ok(typeof search === "function", "deps.review 收到 searcher（D031：同一快照派生，与 reader 同生同灭）");
  assert.equal(search!("a = 1")!.totalMatches, 1, "searcher 从同一快照出结果");
});

test("worker review 阶段接线：FILE_TOOL_MAX_STEPS=0 → 不注入 fileReader、不发 zipball 请求（kill switch）", async () => {
  const { client } = fakeClient();
  const received: ReviewDiffOpts[] = [];
  const spy = (async () => {
    throw new Error("zipball 不应被请求");
  }) as unknown as typeof fetch;
  await withEnv({ FILE_TOOL_MAX_STEPS: "0" }, async () => {
    await runStage(
      fullDeps({
        client: () => client,
        fetchImpl: spy,
        chain: boomChain,
        review: async (diff, context, opts) => {
          received.push(opts ?? {});
          return REVIEW_RESULT;
        },
      }),
      { v: 1, stage: "review", hop: 1, ref: REF, issuedAt: Date.now(), state: { diff: DIFF } },
    );
  });
  assert.equal(received[0]!.fileReader, undefined, "关闭时不注入 fileReader");
  assert.equal(received[0]!.searcher, undefined, "关闭时 searcher 一并关闭（同一快照同生同灭，D031）");
});

test("worker review 阶段接线：快照重取失败 → fileReader undefined 降级单次调用（best-effort）", async () => {
  const { client } = fakeClient();
  const received: ReviewDiffOpts[] = [];
  const failing = (async () => new Response(null, { status: 500 })) as unknown as typeof fetch;
  await withEnv({ FILE_TOOL_MAX_STEPS: "2", GITHUB_TOKEN: "t" }, async () => {
    await runStage(
      fullDeps({
        client: () => client,
        fetchImpl: failing,
        chain: boomChain,
        review: async (diff, context, opts) => {
          received.push(opts ?? {});
          return REVIEW_RESULT;
        },
      }),
      { v: 1, stage: "review", hop: 1, ref: REF, issuedAt: Date.now(), state: { diff: DIFF } },
    );
  });
  assert.equal(received[0]!.fileReader, undefined, "快照失败返回 undefined → 不注入 → 单次调用原路径");
});

test("chainBase：WORKER_BASE_URL 合法生效（剥尾斜杠）、非法（漏 scheme/带 query）按未配置处理、VERCEL_URL 兜底、全空 undefined（本地直调）", async () => {
  const { client } = fakeClient();
  await withEnv({ WORKER_BASE_URL: undefined, VERCEL_URL: undefined }, async () => {
    assert.equal(chainBase(), undefined, "全空 → 本地直调回退");
  });
  await withEnv({ WORKER_BASE_URL: undefined, VERCEL_URL: "proj-abc.vercel.app" }, async () => {
    assert.equal(chainBase(), "https://proj-abc.vercel.app", "VERCEL_URL 兜底（Standard Protection 下会 403，仅作最后兜底）");
  });
  await withEnv({ WORKER_BASE_URL: "demo.vercel.app", VERCEL_URL: "proj-abc.vercel.app" }, async () => {
    assert.equal(chainBase(), "https://proj-abc.vercel.app", "漏 scheme 不合法，warn 后按未配置处理");
  });
  await withEnv({ WORKER_BASE_URL: "https://host?x=1", VERCEL_URL: "proj-abc.vercel.app" }, async () => {
    assert.equal(chainBase(), "https://proj-abc.vercel.app", "带 query 不合法（URL 解析断言 pathname），回退 VERCEL_URL");
  });
  await withEnv({ WORKER_BASE_URL: "https://custom.example.com/", VERCEL_URL: "proj-abc.vercel.app" }, async () => {
    assert.equal(chainBase(), "https://custom.example.com", "显式配置最高优先（剥尾斜杠）");
  });
  void client;
});

// ============ 决策模型路由编排（D028）============

const ROUTER_PLAN: ReviewPlan = {
  focusAreas: [{ area: "空指针", files: ["src/a.ts"], why: "a 可能为 null" }],
  riskAreas: [{ area: "调用方未同步", why: "missing.method 的调用方" }],
  readPaths: ["src/a.ts"],
  strategy: "先核对空引用再扫调用方",
};

test("worker review 阶段接线：DECISION_MODEL 注入 → mock router 拿文件树/diff 骨架，plan 进 deps.review；快照只为 router 取（D028）", async () => {
  const { client } = fakeClient();
  const received: ReviewDiffOpts[] = [];
  const routed: { tree: string; skeleton: string }[] = [];
  let zipFetches = 0;
  const zipFetch = (async () => {
    zipFetches++;
    return new Response(new Uint8Array(FIXTURE_ZIP), { status: 200 });
  }) as unknown as typeof fetch;
  await withEnv({ DECISION_MODEL: "cheap-model", FILE_TOOL_MAX_STEPS: "0", GITHUB_TOKEN: "t" }, async () => {
    await runStage(
      fullDeps({
        client: () => client,
        fetchImpl: zipFetch,
        chain: boomChain,
        route: async (args) => {
          routed.push(args);
          return ROUTER_PLAN;
        },
        review: async (diff, context, opts) => {
          received.push(opts ?? {});
          return REVIEW_RESULT;
        },
      }),
      { v: 1, stage: "review", hop: 1, ref: REF, issuedAt: Date.now(), state: { diff: DIFF, context: null } },
    );
  });
  assert.equal(zipFetches, 1, "router 开启即需要快照（FILE_TOOL_MAX_STEPS=0 也取，快照只取一次）");
  assert.equal(routed.length, 1, "router 恰好一次调用");
  assert.ok(routed[0]!.tree.includes("src/a.ts"), "router 拿到快照文件树");
  assert.ok(routed[0]!.skeleton.includes("src/demo.ts (+1/-0)"), "router 拿到 diff 骨架（逐文件 ± 行数）");
  assert.equal(received[0]!.plan, ROUTER_PLAN, "deps.review 收到 plan");
  assert.equal(received[0]!.fileReader, undefined, "工具循环关闭时 reader 不注入（快照只为 router 取）");
});

test("worker review 阶段接线：DECISION_MODEL 未注入 → 零 router 调用、零快照请求（关闭 = 零行为差异，D028）", async () => {
  const { client } = fakeClient();
  const received: ReviewDiffOpts[] = [];
  let routerCalls = 0;
  const spy = (async () => {
    throw new Error("zipball 不应被请求");
  }) as unknown as typeof fetch;
  await withEnv({ DECISION_MODEL: undefined, FILE_TOOL_MAX_STEPS: "0" }, async () => {
    await runStage(
      fullDeps({
        client: () => client,
        fetchImpl: spy,
        chain: boomChain,
        route: async () => {
          routerCalls++;
          return null;
        },
        review: async (diff, context, opts) => {
          received.push(opts ?? {});
          return REVIEW_RESULT;
        },
      }),
      { v: 1, stage: "review", hop: 1, ref: REF, issuedAt: Date.now(), state: { diff: DIFF } },
    );
  });
  assert.equal(routerCalls, 0, "未注入 DECISION_MODEL → 零 router 调用");
  assert.equal(received[0]!.plan, undefined, "无 plan");
});

test("worker review 阶段接线：router 失败 → 无计划继续，主评审照常（best-effort 降级，绝不连垮，D028）", async () => {
  const { client } = fakeClient();
  const received: ReviewDiffOpts[] = [];
  await withEnv({ DECISION_MODEL: "cheap-model", FILE_TOOL_MAX_STEPS: "0", GITHUB_TOKEN: "t" }, async () => {
    await runStage(
      fullDeps({
        client: () => client,
        fetchImpl: (async () => new Response(new Uint8Array(FIXTURE_ZIP), { status: 200 })) as unknown as typeof fetch,
        chain: boomChain,
        route: async () => {
          throw new Error("端点 500");
        },
        review: async (diff, context, opts) => {
          received.push(opts ?? {});
          return REVIEW_RESULT;
        },
      }),
      { v: 1, stage: "review", hop: 1, ref: REF, issuedAt: Date.now(), state: { diff: DIFF } },
    );
  });
  assert.equal(received[0]!.plan, undefined, "router 失败 → 无计划");
  assert.ok(received[0]!.timeoutMs, "主评审照常带预算执行");
});

test("worker review 阶段接线：router 开启但快照失败 → 跳过 router（无文件树），审查照常（D028 best-effort 链）", async () => {
  const { client } = fakeClient();
  const received: ReviewDiffOpts[] = [];
  let routerCalls = 0;
  await withEnv({ DECISION_MODEL: "cheap-model", FILE_TOOL_MAX_STEPS: "0", GITHUB_TOKEN: "t" }, async () => {
    await runStage(
      fullDeps({
        client: () => client,
        fetchImpl: (async () => new Response(null, { status: 500 })) as unknown as typeof fetch,
        chain: boomChain,
        route: async () => {
          routerCalls++;
          return null;
        },
        review: async (diff, context, opts) => {
          received.push(opts ?? {});
          return REVIEW_RESULT;
        },
      }),
      { v: 1, stage: "review", hop: 1, ref: REF, issuedAt: Date.now(), state: { diff: DIFF } },
    );
  });
  assert.equal(routerCalls, 0, "无文件树不跑 router");
  assert.equal(received[0]!.plan, undefined);
});

test("worker review 阶段接线：router 耗时从主评审预算扣除（D028 墙钟账，快照扣减同款）", async () => {
  const { client } = fakeClient();
  const received: ReviewDiffOpts[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  await withEnv({ DECISION_MODEL: "cheap-model", FILE_TOOL_MAX_STEPS: "0", GITHUB_TOKEN: "t" }, async () => {
    await runStage(
      fullDeps({
        client: () => client,
        fetchImpl: (async () => new Response(new Uint8Array(FIXTURE_ZIP), { status: 200 })) as unknown as typeof fetch,
        chain: boomChain,
        route: async () => {
          await sleep(100);
          return null;
        },
        review: async (diff, context, opts) => {
          received.push(opts ?? {});
          return REVIEW_RESULT;
        },
      }),
      { v: 1, stage: "review", hop: 1, ref: REF, issuedAt: Date.now(), state: { diff: DIFF } },
    );
  });
  const base = Math.min(llmTimeoutMs(), 260_000);
  const timeout = received[0]!.timeoutMs!;
  assert.ok(timeout <= base - 100, `router 睡 100ms 应被扣除（${timeout} vs 基线 ${base}）`);
  assert.ok(timeout > base - 2_000, "快照 mock 即时，扣减后仍贴近原预算（2s 容差防 CI 时序抖动）");
});

test("deductBudget：纯线性扣减不触底（触底在 deps.review 调用点统一一次，D028 自审 major）", () => {
  assert.equal(deductBudget(260_000, 10_000), 250_000, "线性扣减");
  assert.equal(deductBudget(90_000, 40_000), 50_000, "可为负值/低于 60s——触底交给调用点单次处理");
  assert.equal(deductBudget(30_000, 40_000), -10_000, "超耗返回负值，由统一触底截断");
});

test("worker 编排端到端：DECISION_MODEL + mock route → 真实 reviewDiff 收到 plan，主评审 prompt 含计划块、system 仍只有 review.md（D028）", async () => {
  const fake = await startFakeLLM(() => ({
    content: JSON.stringify({ comments: REVIEW_RESULT.comments }),
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  }));
  try {
    const { client } = fakeClient();
    await withEnv(
      {
        DECISION_MODEL: "cheap-model",
        FILE_TOOL_MAX_STEPS: "0",
        GITHUB_TOKEN: "t",
        LLM_BASE_URL: fake.url,
        LLM_API_KEY: "test",
        LLM_MODEL: "fake",
        LLM_EXTRA_BODY: undefined,
        LLM_TIMEOUT_MS: undefined,
      },
      async () => {
        await runStage(
          fullDeps({
            client: () => client,
            fetchImpl: (async () => new Response(new Uint8Array(FIXTURE_ZIP), { status: 200 })) as unknown as typeof fetch,
            chain: boomChain,
            route: async () => ROUTER_PLAN,
          }),
          { v: 1, stage: "review", hop: 1, ref: REF, issuedAt: Date.now(), state: { diff: DIFF, context: null } },
        );
      },
    );
    assert.equal(fake.calls.length, 1, "主评审单次调用（router 被 mock，不占用假端点）");
    const body = fake.calls[0]!.body;
    const sys = messagesOf(body).find((m) => m.role === "system")!;
    const user = messagesOf(body).find((m) => m.role === "user")!;
    assert.equal(sys.content, loadPrompt(), "主评审 system = review.md（router prompt 不掺入）");
    assert.ok(user.content.startsWith(buildPlanBlock(ROUTER_PLAN)), "计划块在 prompt 前段（context=null 时在 diff 之前）");
    assert.ok(user.content.endsWith(DIFF), "diff 保持在末尾（行号锚点原则）");
  } finally {
    await fake.close();
  }
});



// ============ 任务上下文注入（D029）============

const TASK_ISSUE_BODY = "支付网关在 under_review 状态下应返回 409，而非静默置 captured。";

test("worker prepare 编排：PR body 带 Closes #N → 解析拉取 issue 构造任务块进信封 state（D029）", async () => {
  const { client, calls } = fakeClient([], {
    prTitle: "fix: 支付状态机",
    prBody: "Closes #42\n\n实现说明……",
    issues: { 42: { title: "under_review 必返回 409", body: TASK_ISSUE_BODY } },
  });
  const chained: WorkerEnvelope[] = [];
  await runStage(fullDeps({ client: () => client, chain: async (e) => void chained.push(e) }), prepareEnvelope(REF));
  assert.deepEqual(calls.issueGets, [42], "恰好拉取解析出的 1 个 issue");
  const state = chained[0]!.state as { taskContext?: string | null };
  assert.ok(typeof state.taskContext === "string", "任务块随信封传递");
  assert.ok(state.taskContext!.startsWith("[任务上下文]"), "块为任务上下文构造产物");
  assert.ok(state.taskContext!.includes("## PR 标题\nfix: 支付状态机"));
  assert.ok(state.taskContext!.includes("## 关联 issue #42：under_review 必返回 409"), "issue 正文进块");
  assert.ok(state.taskContext!.includes(TASK_ISSUE_BODY), "issue 正文进块");
  assert.ok(state.taskContext!.includes("与 diff 矛盾的要求差异本身是审查对象"), "威胁模型重申内置");
});

test("worker prepare 编排：body 无关联引用 → state.taskContext null 传递，零 issues API 调用", async () => {
  const { client, calls } = fakeClient([], { prTitle: "t", prBody: "没有 closing 关键词" });
  const chained: WorkerEnvelope[] = [];
  await runStage(fullDeps({ client: () => client, chain: async (e) => void chained.push(e) }), prepareEnvelope(REF));
  assert.deepEqual(calls.issueGets, []);
  assert.equal((chained[0]!.state as { taskContext?: unknown }).taskContext, null, "null 传递（与 context 失败语义同形）");
});

test("worker prepare 编排：issue 拉取失败 → 该 issue 跳过，任务块 best-effort（单个失败不连垮）", async () => {
  const { client } = fakeClient([], {
    prTitle: "t",
    prBody: "Fixes #1, closes #2",
    issues: { 1: new Error("boom"), 2: { title: "可用", body: "正文" } },
  });
  const chained: WorkerEnvelope[] = [];
  await runStage(fullDeps({ client: () => client, chain: async (e) => void chained.push(e) }), prepareEnvelope(REF));
  const state = chained[0]!.state as { taskContext?: string | null };
  assert.ok(typeof state.taskContext === "string", "拉到 1 个仍注入");
  assert.ok(state.taskContext!.includes("#2"), "可用 issue 正文在块内");
  assert.ok(!state.taskContext!.includes("#1："), "失败 issue 不在块内");
});

// ============ 上一轮意见注入（D035）============

const OLD_SHA = "aaaa1111bbbb2222cccc3333dddd4444eeee5555";

test("worker prepare 编排：block 继承全量重审 → 上一轮意见进信封 state（D035）", async () => {
  const { client, calls } = fakeClient(
    [
      {
        id: 7,
        sha: OLD_SHA,
        submitted_at: "2026-11-04T00:00:00Z",
        body: `🤖 pr-review-agent 审查意见（共 1 条：blocker×1）\n<!-- pr-review-agent sha:${OLD_SHA} -->`,
      },
    ],
    {
      prTitle: "t",
      prBody: "b",
      reviewComments: [{ path: "src/demo.ts", line: 2, original_line: null, body: "**[blocker]** 老意见：a.missing 未判空" }],
    },
  );
  const chained: WorkerEnvelope[] = [];
  await runStage(fullDeps({ client: () => client, chain: async (e) => void chained.push(e) }), prepareEnvelope(REF));
  assert.deepEqual(calls.commentReviewIds, [7], "只拉最新有效 review 的行内评论");
  const state = chained[0]!.state as { previousFindings?: string | null; incrementalBase?: string | null };
  assert.equal(state.incrementalBase, null, "全量路径无区间 base");
  assert.ok(typeof state.previousFindings === "string", "意见块随信封传递");
  assert.ok(state.previousFindings!.startsWith("[上一轮审查意见]"), "块为 buildPrevFindings 构造产物");
  assert.ok(state.previousFindings!.includes(OLD_SHA.slice(0, 7)), "头部带上一轮短 SHA");
  assert.ok(state.previousFindings!.includes("**[blocker]** 老意见：a.missing 未判空"), "行内意见进块");
  assert.ok(state.previousFindings!.includes("逐字重报"), "对照规则内置");
});

test("worker prepare 编排：首审无历史 → previousFindings null 传递，零行内评论拉取（D035）", async () => {
  const { client, calls } = fakeClient([], { prTitle: "t", prBody: "b" });
  const chained: WorkerEnvelope[] = [];
  await runStage(fullDeps({ client: () => client, chain: async (e) => void chained.push(e) }), prepareEnvelope(REF));
  assert.deepEqual(calls.commentReviewIds, [], "latestValidReview 为 null 不发起拉取");
  assert.equal((chained[0]!.state as { previousFindings?: unknown }).previousFindings, null, "null 传递（与 taskContext 失败语义同形）");
});

test("worker prepare 编排：delta 路径绝不注入上一轮意见（锚点不在区间 diff，D035）", async () => {
  const { client, calls } = fakeClient(
    [
      {
        id: 7,
        sha: OLD_SHA,
        submitted_at: "2026-11-04T00:00:00Z",
        body: `🤖 pr-review-agent 审查意见（共 0 条）\n<!-- pr-review-agent sha:${OLD_SHA} -->`,
      },
    ],
    {
      prTitle: "t",
      prBody: "b",
      compareFiles: [{ filename: "src/demo.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1,3 +1,4 @@\n const a = 1;\n+const b = 2;\n const c = 3;" }],
    },
  );
  const chained: WorkerEnvelope[] = [];
  await runStage(fullDeps({ client: () => client, chain: async (e) => void chained.push(e) }), prepareEnvelope(REF));
  const state = chained[0]!.state as { previousFindings?: string | null; incrementalBase?: string | null; diff?: string };
  assert.equal(state.incrementalBase, OLD_SHA, "delta 命中（compare mock 提供区间 diff）");
  assert.ok(String(state.diff).includes("+const b = 2;"), "diff 已替换为区间 diff");
  assert.deepEqual(calls.commentReviewIds, [], "delta 不拉上一轮意见");
  assert.equal(state.previousFindings, null, "老意见留在旧线程，不进增量审查");
});

test("worker prepare 编排：full 路径取 dismissed 线程并随块注入（D035 v2，#93）", async () => {
  const { client, calls } = fakeClient(
    [
      {
        id: 7,
        sha: OLD_SHA,
        submitted_at: "2026-11-04T00:00:00Z",
        body: `🤖 pr-review-agent 审查意见（共 1 条：blocker×1）\n<!-- pr-review-agent sha:${OLD_SHA} -->`,
      },
    ],
    {
      prTitle: "t",
      prBody: "b",
      reviewComments: [{ path: "src/demo.ts", line: 2, original_line: null, body: "**[blocker]** 老意见：a.missing 未判空" }],
      reviewThreads: [
        {
          isResolved: true,
          comments: {
            nodes: [
              { path: "src/demo.ts", line: 2, originalLine: 2, body: "**[major]** 老意见：超时未设", author: { login: "pr-review-agent[bot]" } },
              { path: "src/demo.ts", line: 2, originalLine: 2, body: "设计如此，不改了", author: { login: "maintainer" } },
            ],
          },
        },
        {
          isResolved: false,
          comments: {
            nodes: [{ path: "src/other.ts", line: 3, originalLine: 3, body: "**[blocker]** 未 resolve 不注入", author: { login: "pr-review-agent[bot]" } }],
          },
        },
      ],
    },
  );
  const chained: WorkerEnvelope[] = [];
  await runStage(fullDeps({ client: () => client, chain: async (e) => void chained.push(e) }), prepareEnvelope(REF));
  assert.equal(calls.graphqlQueries, 1, "full 路径恰好一次 GraphQL dismissed 取数");
  const state = chained[0]!.state as { previousFindings?: string | null };
  assert.ok(typeof state.previousFindings === "string", "意见块随信封传递");
  assert.ok(state.previousFindings!.includes("4. 人工裁定不修复"), "规则 4 随块注入");
  assert.ok(state.previousFindings!.includes("@maintainer 回复「设计如此，不改了」"), "裁定回复进块");
  assert.ok(!state.previousFindings!.includes("未 resolve 不注入"), "未 resolve 线程不进块");
});

test("worker prepare 编排：delta 路径不取 dismissed（GraphQL 零调用，D035 v2，#93）", async () => {
  const { client, calls } = fakeClient(
    [
      {
        id: 7,
        sha: OLD_SHA,
        submitted_at: "2026-11-04T00:00:00Z",
        body: `🤖 pr-review-agent 审查意见（共 0 条）\n<!-- pr-review-agent sha:${OLD_SHA} -->`,
      },
    ],
    {
      prTitle: "t",
      prBody: "b",
      compareFiles: [{ filename: "src/demo.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1,3 +1,4 @@\n const a = 1;\n+const b = 2;\n const c = 3;" }],
      reviewThreads: [
        {
          isResolved: true,
          comments: {
            nodes: [{ path: "src/demo.ts", line: 2, originalLine: 2, body: "**[major]** 已裁定不修复", author: { login: "pr-review-agent[bot]" } }],
          },
        },
      ],
    },
  );
  const chained: WorkerEnvelope[] = [];
  await runStage(fullDeps({ client: () => client, chain: async (e) => void chained.push(e) }), prepareEnvelope(REF));
  const state = chained[0]!.state as { previousFindings?: string | null };
  assert.equal(state.previousFindings, null, "delta 不注入上一轮意见");
  assert.equal(calls.graphqlQueries, 0, "delta 不发起 dismissed 取数");
});

test("worker prepare 编排：TASK_CONTEXT_MAX_CHARS=0 → kill switch 零 issues API 调用，state.taskContext null", async () => {
  const { client, calls } = fakeClient([], {
    prTitle: "t",
    prBody: "Closes #42",
    issues: { 42: { title: "x", body: "y" } },
  });
  const chained: WorkerEnvelope[] = [];
  await withEnv({ TASK_CONTEXT_MAX_CHARS: "0" }, async () => {
    await runStage(fullDeps({ client: () => client, chain: async (e) => void chained.push(e) }), prepareEnvelope(REF));
  });
  assert.deepEqual(calls.issueGets, [], "kill switch 零拉取");
  assert.equal((chained[0]!.state as { taskContext?: unknown }).taskContext, null);
});

test("worker review 阶段接线：信封 state.taskContext → deps.review 收到 opts.taskContext（null 按无任务块）", async () => {
  const { client } = fakeClient();
  const received: ReviewDiffOpts[] = [];
  await runStage(
    fullDeps({
      client: () => client,
      chain: boomChain,
      review: async (diff, context, opts) => {
        received.push(opts ?? {});
        return REVIEW_RESULT;
      },
    }),
    { v: 1, stage: "review", hop: 1, ref: REF, issuedAt: Date.now(), state: { diff: DIFF, context: null, taskContext: "[任务上下文] 块" } },
  );
  assert.equal(received[0]!.taskContext, "[任务上下文] 块");

  const received2: ReviewDiffOpts[] = [];
  await runStage(
    fullDeps({
      client: () => client,
      chain: boomChain,
      review: async (diff, context, opts) => {
        received2.push(opts ?? {});
        return REVIEW_RESULT;
      },
    }),
    { v: 1, stage: "review", hop: 1, ref: REF, issuedAt: Date.now(), state: { diff: DIFF, context: null, taskContext: null } },
  );
  assert.equal(received2[0]!.taskContext, undefined, "null 传递 = 无任务块审查");
});

test("worker 编排端到端：信封带 taskContext → 真实 reviewDiff 的 prompt 任务块置顶、diff 末尾（D029）", async () => {
  const fake = await startFakeLLM(() => ({
    content: JSON.stringify({ comments: REVIEW_RESULT.comments }),
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  }));
  try {
    const { client } = fakeClient();
    await withEnv(
      { FILE_TOOL_MAX_STEPS: "0", GITHUB_TOKEN: "t", LLM_BASE_URL: fake.url, LLM_API_KEY: "test", LLM_MODEL: "fake", LLM_EXTRA_BODY: undefined, LLM_TIMEOUT_MS: undefined },
      async () => {
        await runStage(
          fullDeps({ client: () => client, chain: boomChain }),
          {
            v: 1,
            stage: "review",
            hop: 1,
            ref: REF,
            issuedAt: Date.now(),
            state: { diff: DIFF, context: null, taskContext: "[任务上下文] 任务块置顶验证" },
          },
        );
      },
    );
    const body = fake.calls[0]!.body;
    const sys = messagesOf(body).find((m) => m.role === "system")!;
    const user = messagesOf(body).find((m) => m.role === "user")!;
    assert.equal(sys.content, loadPrompt(), "system = review.md（任务块走 prompt 不走 system）");
    assert.ok(user.content.startsWith("[任务上下文] 任务块置顶验证"), "任务块置顶（context/计划块之前）");
    assert.ok(user.content.endsWith(DIFF), "diff 保持在末尾（行号锚点原则）");
  } finally {
    await fake.close();
  }
});
