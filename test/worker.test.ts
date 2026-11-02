import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { zipSync, strToU8 } from "fflate";
import type { Octokit } from "octokit";
import {
  chainBase,
  chainWorker,
  defaultWorkerDeps,
  handleWorker,
  MAX_HOPS,
  prepareEnvelope,
  runStage,
  type WorkerDeps,
  type WorkerEnvelope,
} from "../src/worker.ts";
import { handleWebhook } from "../src/webhook.ts";
import { reviewMarker } from "../src/dedupe.ts";
import { llmTimeoutMs, type ReviewDiffOpts, type ReviewOutcome } from "../src/review.ts";

const SECRET = "test-secret";
process.env.WEBHOOK_SECRET ??= SECRET;
// prepare 编排不测 zipball 下载路径（context.ts 有独立测试）：预算 0 显式关闭上下文注入（D023），buildRepoContext 直接返回 null
process.env.CONTEXT_MAX_CHARS ??= "0";
// worker 接线的工具循环默认开（D027）——除专属接线用例外统一关闭，避免默认路径发 zipball 请求
process.env.FILE_TOOL_MAX_STEPS ??= "0";
delete process.env.VERCEL_URL;

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

// 假 Octokit：记录 status / review / comment / label 调用，paginate 可注入已有 review 列表（hasReviewed 按标记判定）
function fakeClient(reviews?: { body: string }[]) {
  const calls = {
    statuses: [] as { sha: string; state: string; description: string }[],
    reviews: [] as Record<string, unknown>[],
    comments: [] as Record<string, unknown>[],
    labels: [] as Record<string, unknown>[],
    paginateCalls: 0,
  };
  const client = {
    paginate: async () => {
      calls.paginateCalls++;
      return reviews ?? [];
    },
    rest: {
      repos: {
        createCommitStatus: async (args: { sha: string; state: string; description: string }) => {
          calls.statuses.push(args);
          return { data: {} };
        },
      },
      pulls: {
        get: async (args: { mediaType?: unknown }) => (args.mediaType ? { data: DIFF } : { data: { head: { sha: REF.headSha } } }),
        createReview: async (args: Record<string, unknown>) => {
          calls.reviews.push(args);
          return { data: {} };
        },
        listReviews: () => undefined,
      },
      issues: {
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
  // prepare：dedupe（第 1 次 paginate）→ pending → fetchPr；publish：二次 dedupe（第 2 次 paginate）
  assert.equal(calls.paginateCalls, 2);
  assert.deepEqual(
    calls.statuses.map((s) => [s.sha, s.state, s.description]),
    [
      [REF.headSha, "pending", "审查进行中"],
      [REF.headSha, "success", "完成：1 条意见"],
    ],
  );
  // prepare 拉到的 diff 直传 review（context 关闭 → undefined）；state 随信封携带
  assert.deepEqual(reviewed, [{ diff: DIFF, context: undefined }]);
  assert.equal(calls.reviews.length, 1);
  const review = calls.reviews[0]!;
  assert.equal(review.commit_id, REF.headSha);
  assert.equal(review.event, "REQUEST_CHANGES", "有意见以 REQUEST_CHANGES 提交（D017）");
  assert.ok(String(review.body).includes(reviewMarker(REF.headSha)), "summary 内嵌 sha 标记（D010）");
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

test("chainBase：WORKER_BASE_URL 合法生效（剥尾斜杠）、漏 scheme warn 后视为未配置、VERCEL_URL 兜底、全空 undefined（本地直调）", async () => {
  const saved = { W: process.env.WORKER_BASE_URL, V: process.env.VERCEL_URL };
  try {
    delete process.env.WORKER_BASE_URL;
    delete process.env.VERCEL_URL;
    assert.equal(chainBase(), undefined, "全空 → 本地直调回退");
    process.env.VERCEL_URL = "proj-abc.vercel.app";
    assert.equal(chainBase(), "https://proj-abc.vercel.app", "VERCEL_URL 兜底（Standard Protection 下会 403，仅作最后兜底）");
    process.env.WORKER_BASE_URL = "demo.vercel.app";
    assert.equal(chainBase(), "https://proj-abc.vercel.app", "漏 scheme 不合法，warn 后按未配置处理");
    process.env.WORKER_BASE_URL = "https://host?x=1";
    assert.equal(chainBase(), "https://proj-abc.vercel.app", "带 query 不合法（URL 解析断言 pathname），回退 VERCEL_URL");
    process.env.WORKER_BASE_URL = "https://custom.example.com/";
    assert.equal(chainBase(), "https://custom.example.com", "显式配置最高优先（剥尾斜杠）");
  } finally {
    if (saved.W === undefined) delete process.env.WORKER_BASE_URL; else process.env.WORKER_BASE_URL = saved.W;
    if (saved.V === undefined) delete process.env.VERCEL_URL; else process.env.VERCEL_URL = saved.V;
  }
});


