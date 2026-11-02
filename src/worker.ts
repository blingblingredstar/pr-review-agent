// worker 阶段机（D026，spec 见 docs/plans/async-worker.md）：审查拆 prepare / review / publish 三阶段，
// 每阶段独立函数调用、独立 300s 预算，阶段间用 HMAC-SHA256 签名信封自调用 /api/worker 续链——
// 突破单函数 300s 墙钟，为工具循环（路线图 4 第二阶段）与决策模型路由（第 3 项）提供
// 「串行深度有界、预算按阶段拆分」的运行底座。与 Vercel 解耦同 handleWebhook：headers/body 进、{status, note} 出。
// 复用 webhook.ts 的验签与头解析（webhook.ts 反向导入本文件的 chainWorker / prepareEnvelope，成环——
// 双方都只在调用期使用对方绑定，ESM 语义安全；为「验签逻辑不动」避免抽出第三个文件）。
import { createHmac } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import type { Octokit } from "octokit";
import { verifySignature, header, type WebhookHeaders, type Dispatch } from "./webhook.ts";
import { fetchPr, getOctokit, postReview, postTimeoutNotice, setReviewStatus, type PrRef } from "./github.ts";
import { hasReviewed } from "./dedupe.ts";
import { buildRepoContext } from "./context.ts";
import { llmTimeoutMs, reviewDiff, type ReviewOutcome } from "./review.ts";

export type WorkerStage = "prepare" | "review" | "publish";

// 信封（D026）：阶段产物 state 随请求直传，不在外部存中间态——单次审查中间态最大 ~400KB
// （DIFF_MAX_CHARS 300k + CONTEXT_MAX_CHARS 100k），远小于 Vercel 请求体 4.5MB 上限；
// 重派生（下阶段重拉 diff + 重下 zipball）多烧 API 配额且引入两次快照漂移风险，pass-state 更确定
export type WorkerEnvelope = {
  v: 1;
  stage: WorkerStage;
  hop: number; // 已执行的续链次数，MAX_HOPS 封顶
  ref: PrRef & { headSha: string; headRepo?: string };
  issuedAt: number; // Date.now()，新鲜度窗口校验
  state?: Record<string, unknown>; // prepare→review 带 diff/context；review→publish 累积带 result
};

// hop 封顶：固定三跳理论上到不了，防御后续阶段扩展期（review 阶段内扩展轮数）的失控循环
export const MAX_HOPS = 4;
// 新鲜度窗口：信封只能由内部铸造（需 WEBHOOK_SECRET），窗口限的是合法信封被截获后的重放面
const ENVELOPE_FRESH_MS = 10 * 60 * 1000;
// 续链最多尝试次数、间隔与单次硬超时（D026）：终失败由当前调用 best-effort 落 failure status，不静默。
// 硬超时必须远小于本函数 300s 墙钟——自调用挂起会占满 waitUntil 直到平台强杀，重试与落灯都到不了，
// 恰是本机制要消灭的永久 pending 黄灯（PR #29 自审 major）
const CHAIN_ATTEMPTS = 2;
const CHAIN_TIMEOUT_MS = 30_000;

// 依赖注入（生产默认、测试传 mock）：schedule 调度后台任务；client 工厂延迟构造（缺 token 不炸 handler）；
// review / chain / fetchImpl 可替换——chain 默认即 chainWorker，测试传 spy 观察信封
export type WorkerDeps = {
  schedule: (task: () => Promise<void>) => void;
  client: () => Octokit;
  review: (diff: string, context?: string) => Promise<ReviewOutcome>;
  chain: (envelope: WorkerEnvelope) => Promise<void>;
  fetchImpl: typeof fetch;
  chainRetryDelayMs: number;
  chainTimeoutMs: number;
};

export function defaultWorkerDeps(): WorkerDeps {
  return {
    schedule: (task) => waitUntil(task()),
    client: getOctokit,
    review: reviewDiff,
    chain: chainWorker,
    fetchImpl: fetch,
    chainRetryDelayMs: 2_000,
    chainTimeoutMs: CHAIN_TIMEOUT_MS,
  };
}

// webhook 的调度对象（D026）：从「整个 runReview」改为「发 prepare 信封」——首个阶段也跑在新调用里，
// 所有阶段共用同一条代码路径，没有「第一阶段特殊」的分支
export function prepareEnvelope(ref: PrRef & { headSha: string; headRepo?: string }): WorkerEnvelope {
  return { v: 1, stage: "prepare", hop: 0, ref, issuedAt: Date.now() };
}

function stageKey(ref: PrRef & { headSha: string }): string {
  return `${ref.owner}/${ref.repo}#${ref.pullNumber}@${ref.headSha.slice(0, 7)}`;
}

// 信封结构校验：签名闸已保证铸造者，这里只挡「字段缺失/类型漂移」——从宽解析，深度语义由阶段内消费；
// 不合法抛错由调用方 400。hop/issuedAt 的类型必须在这里收紧（NaN 会绕过下方数值比较闸）
function parseEnvelope(raw: unknown): WorkerEnvelope {
  if (typeof raw !== "object" || raw === null) throw new Error("envelope is not an object");
  const e = raw as Record<string, unknown>;
  if (e.v !== 1) throw new Error(`unsupported envelope version: ${String(e.v)}`);
  if (e.stage !== "prepare" && e.stage !== "review" && e.stage !== "publish") {
    throw new Error(`unknown stage: ${String(e.stage)}`);
  }
  const ref = e.ref as Record<string, unknown> | undefined;
  if (
    typeof ref?.owner !== "string" ||
    typeof ref.repo !== "string" ||
    typeof ref.pullNumber !== "number" ||
    typeof ref.headSha !== "string"
  ) {
    throw new Error("envelope ref 字段缺失或类型漂移");
  }
  if (typeof e.hop !== "number" || !Number.isInteger(e.hop) || e.hop < 0) {
    throw new Error(`invalid hop: ${String(e.hop)}`);
  }
  return e as unknown as WorkerEnvelope;
}

// worker 入口（D026）：验签 → 结构校验 → 三闸（签名 / 新鲜度 / hop 封顶）→ 调度阶段执行，当前函数立刻 200。
// 头名用独立的 x-worker-signature 与 GitHub 事件语义区分——x-hub-signature-256 只属于 GitHub 来信
export function handleWorker(headers: WebhookHeaders, rawBody: string, deps?: Partial<WorkerDeps>): Dispatch {
  // 注入的 deps 要随链传递：默认 chain 携带本次注入继续向前，否则本地直调/多跳扩展时 mock（或定制实现）会中途丢失。
  // 生产路径 deps 为空，等价于 chainWorker(next) 原样续链
  const d: WorkerDeps = {
    ...defaultWorkerDeps(),
    ...deps,
    chain: deps?.chain ?? ((next) => chainWorker(next, deps)),
  };
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) throw new Error("缺少环境变量 WEBHOOK_SECRET（scripts/setup-webhook.ts 首跑自动生成）");
  if (!verifySignature(secret, rawBody, header(headers, "x-worker-signature"))) {
    return { status: 403, note: "worker signature verification failed" };
  }
  let envelope: WorkerEnvelope;
  try {
    envelope = parseEnvelope(JSON.parse(rawBody));
  } catch {
    return { status: 400, note: "invalid worker envelope" };
  }
  const key = stageKey(envelope.ref);
  // 新鲜度闸：issuedAt 距今超 10 分钟 403（限重放窗口）；issuedAt 缺失/非数值按过期处理（fail-closed 同 D021 口味）
  if (!Number.isFinite(envelope.issuedAt) || Date.now() - envelope.issuedAt > ENVELOPE_FRESH_MS) {
    return { status: 403, note: "stale worker envelope" };
  }
  // hop 封顶闸：403 之外还要落 failure status——链路断在这里时 pending 黄灯比红灯更具误导性（D017）
  if (envelope.hop > MAX_HOPS) {
    console.error(`[worker] ${key} hop ${envelope.hop} 超过上限 ${MAX_HOPS}，拒绝续链`);
    d.schedule(() => markFailed(d.client, key, envelope.ref, "审查中断"));
    return { status: 403, note: "worker hop limit exceeded" };
  }
  // 阶段执行调度在 waitUntil：当前函数立刻 200，阶段末尾的续链 POST 也在本任务内完成（D026）。
  // runStage 自吞错误，catch 只兜 deps 构造等意外逃逸，避免 unhandled rejection 砸掉 Vercel 函数
  d.schedule(() =>
    runStage(d, envelope).catch((err) => {
      console.error(`[worker] ${key} 阶段 ${envelope.stage} 异常逃逸（不应发生）`, err);
    }),
  );
  return { status: 200, note: `worker ${envelope.stage} scheduled: ${key}` };
}

// 单阶段执行：失败 status 落定集中在 catch，与原 runReview 逐字一致（「永久 pending 比红灯更具误导性」）。
// 阶段产物经 deps.chain 交给下一阶段；publish 为终态不续链。
// client 按阶段惰性构造：review 阶段零 GitHub 依赖（失败兜底才需要 client），prepare/publish 各自构造
export async function runStage(deps: WorkerDeps, envelope: WorkerEnvelope): Promise<void> {
  const { ref } = envelope;
  const key = stageKey(ref);
  let client: Octokit | undefined;
  try {
    if (envelope.stage === "prepare") {
      client ??= deps.client();
      if (await hasReviewed(client, ref, ref.headSha)) {
        console.log(`[worker] ${key} 已有同 SHA 审查，跳过（幂等，D010）`);
        return;
      }
      // 审查生命周期 status（D017）：开始即 pending，补上「review 尚未发布」的合并窗口期；
      // 失败只记日志不连坐流程，status 由成功/失败路径分别落定
      try {
        await setReviewStatus(client, { ...ref, sha: ref.headSha }, "pending", "审查进行中");
      } catch (statusErr) {
        console.error(`[worker] ${key} pending status 写失败`, statusErr);
      }
      const { diff } = await fetchPr(client, ref);
      // 仓库上下文（D023，best-effort）：失败返回 null、审查照旧，绝不连垮主流程
      const context = await buildRepoContext({ headRepo: ref.headRepo ?? `${ref.owner}/${ref.repo}`, headSha: ref.headSha, diff });
      await deps.chain({ v: 1, stage: "review", hop: envelope.hop + 1, ref, issuedAt: Date.now(), state: { diff, context } });
      return;
    }
    if (envelope.stage === "review") {
      const state = (envelope.state ?? {}) as { diff?: string; context?: string | null };
      if (typeof state.diff !== "string") throw new Error("review 信封缺 state.diff");
      const result = await deps.review(state.diff, state.context ?? undefined);
      // state 累积传递：publish 的 postReview 仍需 diff 做行内预定位（splitByLocatable）
      await deps.chain({ v: 1, stage: "publish", hop: envelope.hop + 1, ref, issuedAt: Date.now(), state: { ...state, result } });
      return;
    }
    // publish（终态）：二次 dedupe 防重派——续链重试/信封重放会把 publish 再投一次（D026「明确不做」幂等键，
    // 重放由这里 + status 幂等吸收）
    client ??= deps.client();
    if (await hasReviewed(client, ref, ref.headSha)) {
      console.log(`[worker] ${key} publish 二次 dedupe：已有同 SHA 审查，跳过`);
      return;
    }
    const state = (envelope.state ?? {}) as { diff?: string; result?: ReviewOutcome };
    if (typeof state.diff !== "string" || !Array.isArray(state.result?.comments)) {
      throw new Error("publish 信封缺 state.diff / state.result");
    }
    const posted = await postReview(
      client,
      { owner: ref.owner, repo: ref.repo, pullNumber: ref.pullNumber, commitId: ref.headSha },
      state.result,
      state.diff,
    );
    console.log(`[worker] ${key} 完成：${posted.inline} 条行内（进线程可闭环），${posted.degraded} 条降级进 body`);
    try {
      await setReviewStatus(
        client,
        { ...ref, sha: ref.headSha },
        "success",
        posted.degraded > 0 ? `完成：${posted.inline} 条行内 / ${posted.degraded} 条降级进 body` : `完成：${posted.inline} 条意见`,
      );
    } catch (statusErr) {
      console.error(`[worker] ${key} success status 写失败`, statusErr);
    }
  } catch (err) {
    // failure status 落定独立于任何其他动作成败；isTimeoutError 随 runReview 迁入，超时语义不变（D011）
    if (isTimeoutError(err)) {
      console.error(`[worker] ${key} LLM 超时（${llmTimeoutMs()}ms），发降级通知（D011）`);
      try {
        await postTimeoutNotice(getFallbackClient(deps, client), ref, llmTimeoutMs());
      } catch (postErr) {
        console.error(`[worker] ${key} 降级通知发送失败`, postErr);
      }
      await markFailed(() => getFallbackClient(deps, client), key, ref, "审查超时，重推 commit 可重试");
      return;
    }
    await markFailed(() => getFallbackClient(deps, client), key, ref, "审查失败，见 Vercel 日志");
    console.error(`[worker] ${key} 审查失败`, err);
  }
}

// catch 路径的 client 兜底：try 里 client 工厂可能没走到（缺 token 抛出）——与原 runReview 的 `client ?? getOctokit()` 同形
function getFallbackClient(deps: WorkerDeps, client: Octokit | undefined): Octokit {
  return client ?? deps.client();
}

// failure status 落定独立于任何其他动作成败——永久 pending（「审查在途」的黄灯）比红灯更具误导性（D017）。
// client 走工厂：构造本身可能失败（缺 token），一并吞进 best-effort 语义
async function markFailed(client: () => Octokit, key: string, ref: PrRef & { headSha: string }, description: string): Promise<void> {
  try {
    await setReviewStatus(client(), { ...ref, sha: ref.headSha }, "failure", description);
  } catch (statusErr) {
    console.error(`[worker] ${key} failure status 写失败`, statusErr);
  }
}

// 续链（D026）：POST 信封到自部署的 /api/worker。目标 URL 用平台自动注入的 VERCEL_URL（preview 与 production
// 各自自洽；webhook 挂 production，链自然全在 production）。最多 2 次尝试（间隔 chainRetryDelayMs、
// 单次硬超时 chainTimeoutMs；仅网络异常/5xx/429 重试，确定性 4xx 直接终失败），
// 终失败由当前调用 best-effort 落 failure status「审查中断」——续链失败不静默，避免永久 pending 黄灯（D017）。
// 本函数不抛出：失败语义已闭环（落灯 + 日志），抛出只会变成上游 waitUntil 的 unhandled rejection
export async function chainWorker(envelope: WorkerEnvelope, deps?: Partial<WorkerDeps>): Promise<void> {
  // 同 handleWorker：默认 chain 携带本次注入向前传递，多跳串行（本地直调回退）中注入不丢失
  const d: WorkerDeps = {
    ...defaultWorkerDeps(),
    ...deps,
    chain: deps?.chain ?? ((next) => chainWorker(next, deps)),
  };
  const key = stageKey(envelope.ref);
  // VERCEL_URL 未设置（本地 scripts / 单测）→ 不走 HTTP，直接在本进程执行下一阶段（同 schedule 直调语义）——
  // 本地链路与生产行为一致、可单测
  const base = process.env.VERCEL_URL;
  if (!base) {
    await runStage(d, envelope);
    return;
  }
  const url = `https://${base}/api/worker`;
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) {
    // 缺 secret 理论上到不了（webhook/worker 入口验签用的就是同一 secret），但本函数跑在 waitUntil 里，
    // 抛出即 unhandled rejection——并入终失败路径，保持「不抛出」注释为真（PR #29 自审 minor）
    console.error(`[worker] ${key} 续链失败：缺少 WEBHOOK_SECRET，无法签名信封`);
    await markFailed(d.client, key, envelope.ref, "审查中断");
    return;
  }
  const body = JSON.stringify(envelope);
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= CHAIN_ATTEMPTS; attempt++) {
    try {
      const res = await d.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-worker-signature": signature },
        body,
        // 单次硬超时：自调用挂起（网络黑洞 / 冷启动卡死）时及时进入重试与落灯路径
        signal: AbortSignal.timeout(d.chainTimeoutMs),
      });
      if (res.ok) return;
      lastErr = new Error(`HTTP ${res.status}`);
      // 确定性 4xx（信封超限 413 / 结构非法 400 / 校验拒绝 403）重试必同败，不白等间隔直接终失败；
      // 仅网络异常（含上面的超时）与 5xx / 429 值得再试（PR #29 自审 minor）
      if (res.status < 500 && res.status !== 429) break;
    } catch (err) {
      lastErr = err;
    }
    if (attempt < CHAIN_ATTEMPTS) await sleep(d.chainRetryDelayMs);
  }
  console.error(`[worker] ${key} 续链 ${url} 失败（${CHAIN_ATTEMPTS} 次），best-effort 落 failure status`, lastErr);
  await markFailed(d.client, key, envelope.ref, "审查中断");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// AbortSignal.timeout 抛出的 TimeoutError 可能被 AI SDK 包一层，沿 cause 链找（随 runReview 自 webhook.ts 迁入）
function isTimeoutError(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = (e as { cause?: unknown }).cause as Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return true;
  }
  return false;
}
