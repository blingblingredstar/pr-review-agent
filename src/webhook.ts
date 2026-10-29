// Webhook 核心编排（docs/architecture.md）：HMAC-SHA256 验签 → 事件分发 →
// 立即 200 + waitUntil 后台审查（D004）。与 Vercel 解耦：headers/body 进、{status, note} 出，便于单测。
import { createHmac, timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { fetchPr, getOctokit, postReview, postTimeoutNotice, type PrRef } from "./github.ts";
import { hasReviewed } from "./dedupe.ts";
import { llmTimeoutMs, reviewDiff } from "./review.ts";

export function verifySignature(secret: string, rawBody: string, signature: string | undefined): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(signature.slice("sha256=".length), "hex");
  return received.length === expected.length && timingSafeEqual(expected, received);
}

export type Dispatch = { status: number; note: string };

export type WebhookHeaders = Record<string, string | string[] | undefined>;

function header(headers: WebhookHeaders, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function handleWebhook(
  headers: WebhookHeaders,
  rawBody: string,
  // 依赖注入：生产默认走 waitUntil，测试传入 spy 只记录不执行
  schedule: (task: () => Promise<void>) => void = (task) => waitUntil(task()),
): Dispatch {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) throw new Error("缺少环境变量 WEBHOOK_SECRET（scripts/setup-webhook.ts 首跑自动生成）");
  if (!verifySignature(secret, rawBody, header(headers, "x-hub-signature-256"))) {
    return { status: 401, note: "signature verification failed" };
  }
  let payload: {
    action?: string;
    repository?: { owner?: { login?: string }; name?: string };
    pull_request?: { number?: number; head?: { sha?: string } };
  };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { status: 400, note: "invalid JSON payload" };
  }
  const event = header(headers, "x-github-event") ?? "";
  if (event !== "pull_request") {
    return { status: 200, note: `ignored event: ${event}` };
  }
  const action = payload.action ?? "";
  if (action !== "opened" && action !== "synchronize") {
    return { status: 200, note: `ignored action: ${action}` };
  }
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const pullNumber = payload.pull_request?.number;
  const headSha = payload.pull_request?.head?.sha;
  if (!owner || !repo || !pullNumber || !headSha) {
    // 畸形 payload（schema 漂移等）：与未知事件同语义，200 忽略并留日志，不拿空值去打 GitHub API
    console.error(`[webhook] pull_request payload 字段缺失，忽略（owner=${owner} repo=${repo} number=${pullNumber}）`);
    return { status: 200, note: "ignored: malformed pull_request payload" };
  }
  const ref: PrRef & { headSha: string } = { owner, repo, pullNumber, headSha };
  schedule(() => runReview(ref));
  return {
    status: 200,
    note: `review scheduled: ${ref.owner}/${ref.repo}#${ref.pullNumber}@${ref.headSha.slice(0, 7)}`,
  };
}

// 后台任务：任何失败只记日志不抛出——waitUntil 无人接 catch，抛了只会变成 unhandled rejection
async function runReview(ref: PrRef & { headSha: string }): Promise<void> {
  const key = `${ref.owner}/${ref.repo}#${ref.pullNumber}@${ref.headSha.slice(0, 7)}`;
  try {
    const client = getOctokit();
    if (await hasReviewed(client, ref, ref.headSha)) {
      console.log(`[review] ${key} 已有同 SHA 审查，跳过（幂等，D010）`);
      return;
    }
    const { diff } = await fetchPr(client, ref);
    const result = await reviewDiff(diff);
    await postReview(client, { owner: ref.owner, repo: ref.repo, pullNumber: ref.pullNumber, commitId: ref.headSha }, result);
    console.log(`[review] ${key} 完成：${result.comments.length} 条意见`);
  } catch (err) {
    if (isTimeoutError(err)) {
      console.error(`[review] ${key} LLM 超时（${llmTimeoutMs()}ms），发降级通知（D011）`);
      try {
        await postTimeoutNotice(getOctokit(), ref, llmTimeoutMs());
      } catch (postErr) {
        console.error(`[review] ${key} 降级通知发送失败`, postErr);
      }
      return;
    }
    console.error(`[review] ${key} 审查失败`, err);
  }
}

// AbortSignal.timeout 抛出的 TimeoutError 可能被 AI SDK 包一层，沿 cause 链找
function isTimeoutError(err: unknown): boolean {
  for (let e = err; e instanceof Error; e = (e as { cause?: unknown }).cause as Error) {
    if (e.name === "TimeoutError" || e.name === "AbortError") return true;
  }
  return false;
}
