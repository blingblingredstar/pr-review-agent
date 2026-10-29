// Webhook 核心编排（docs/architecture.md）：HMAC-SHA256 验签 → 事件分发 →
// 立即 200 + waitUntil 后台审查（D004）。与 Vercel 解耦：headers/body 进、{status, note} 出，便于单测。
import { createHmac, timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { fetchPr, getOctokit, postReview, postTimeoutNotice, setReviewStatus, type PrRef } from "./github.ts";
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
  let client: ReturnType<typeof getOctokit> | undefined;
  try {
    client = getOctokit();
    if (await hasReviewed(client, ref, ref.headSha)) {
      console.log(`[review] ${key} 已有同 SHA 审查，跳过（幂等，D010）`);
      return;
    }
    // 审查生命周期 status（D017）：开始即 pending，补上「review 尚未发布」的合并窗口期；
    // 失败只记日志不连坐流程，status 由下方 finally 之外的成功/失败路径分别落定
    try {
      await setReviewStatus(client, { ...ref, sha: ref.headSha }, "pending", "审查进行中");
    } catch (statusErr) {
      console.error(`[review] ${key} pending status 写失败`, statusErr);
    }
    const { diff } = await fetchPr(client, ref);
    const result = await reviewDiff(diff);
    const posted = await postReview(client, { owner: ref.owner, repo: ref.repo, pullNumber: ref.pullNumber, commitId: ref.headSha }, result, diff);
    console.log(`[review] ${key} 完成：${posted.inline} 条行内（进线程可闭环），${posted.degraded} 条降级进 body`);
    try {
      await setReviewStatus(
        client,
        { ...ref, sha: ref.headSha },
        "success",
        posted.degraded > 0 ? `完成：${posted.inline} 条行内 / ${posted.degraded} 条降级进 body` : `完成：${posted.inline} 条意见`,
      );
    } catch (statusErr) {
      console.error(`[review] ${key} success status 写失败`, statusErr);
    }
  } catch (err) {
    // failure status 落定独立于任何其他动作成败——永久 pending（「审查在途」的黄灯）比红灯更具误导性
    const markFailed = async (description: string) => {
      try {
        await setReviewStatus(client ?? getOctokit(), { ...ref, sha: ref.headSha }, "failure", description);
      } catch (statusErr) {
        console.error(`[review] ${key} failure status 写失败`, statusErr);
      }
    };
    if (isTimeoutError(err)) {
      console.error(`[review] ${key} LLM 超时（${llmTimeoutMs()}ms），发降级通知（D011）`);
      try {
        await postTimeoutNotice(getOctokit(), ref, llmTimeoutMs());
      } catch (postErr) {
        console.error(`[review] ${key} 降级通知发送失败`, postErr);
      }
      await markFailed("审查超时，重推 commit 可重试");
      return;
    }
    await markFailed("审查失败，见 Vercel 日志");
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
