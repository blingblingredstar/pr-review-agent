// Webhook 核心编排（docs/architecture.md）：HMAC-SHA256 验签 → 事件分发 →
// 立即 200 + waitUntil 发 prepare 信封（D004 先 200 再异步；D026 起调度对象是 worker 信封而非整个审查，
// 审查本体拆 prepare/review/publish 三阶段在 src/worker.ts 执行）。与 Vercel 解耦：headers/body 进、{status, note} 出，便于单测。
import { createHmac, timingSafeEqual } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import type { PrRef } from "./github.ts";
import { chainWorker, prepareEnvelope, type WorkerEnvelope } from "./worker.ts";

export function verifySignature(secret: string, rawBody: string, signature: string | undefined): boolean {
  if (!signature?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(signature.slice("sha256=".length), "hex");
  return received.length === expected.length && timingSafeEqual(expected, received);
}

export type Dispatch = { status: number; note: string };

// 触发白名单（D021）：REVIEW_TRIGGER_USERS 逗号分隔的 GitHub 用户名，限定哪些 PR 作者可触发审查。
// 未设置/空白 = 所有人（向后兼容）；含 "*" = 显式全放行；名单启用但 payload 缺作者按拒绝处理（成本闸门宁可误拒）
export function reviewTriggerUsers(): string[] | null {
  const raw = process.env.REVIEW_TRIGGER_USERS;
  if (!raw?.trim()) return null;
  const users = raw
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean);
  return users.length === 0 || users.includes("*") ? null : users;
}

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export function header(headers: WebhookHeaders, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export function handleWebhook(
  headers: WebhookHeaders,
  rawBody: string,
  // 依赖注入：生产默认走 waitUntil，测试传入 spy 只记录不执行
  schedule: (task: () => Promise<void>) => void = (task) => waitUntil(task()),
  // 调度对象（D026）：生产发 prepare 信封给 worker（chainWorker），测试传 spy 观察信封形状
  dispatch: (envelope: WorkerEnvelope) => Promise<void> = chainWorker,
): Dispatch {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret) throw new Error("缺少环境变量 WEBHOOK_SECRET（scripts/setup-webhook.ts 首跑自动生成）");
  if (!verifySignature(secret, rawBody, header(headers, "x-hub-signature-256"))) {
    return { status: 401, note: "signature verification failed" };
  }
  let payload: {
    action?: string;
    repository?: { owner?: { login?: string }; name?: string };
    pull_request?: { number?: number; head?: { sha?: string; repo?: { full_name?: string } }; user?: { login?: string } };
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
  // headRepo：fork PR 的 head 快照在 fork 仓库里（zipball 按 head 仓库取，D023）；payload 缺字段回退 base 仓库（同仓 PR 两者相同）
  const ref: PrRef & { headSha: string; headRepo?: string } = {
    owner,
    repo,
    pullNumber,
    headSha,
    headRepo: payload.pull_request?.head?.repo?.full_name,
  };
  // 白名单判定在调度前用 payload 自带的作者字段完成：零 GitHub API、零 LLM token（D021）
  const allowedUsers = reviewTriggerUsers();
  if (allowedUsers) {
    const author = payload.pull_request?.user?.login?.toLowerCase();
    if (!author || !allowedUsers.includes(author)) {
      console.log(
        `[webhook] ${ref.owner}/${ref.repo}#${ref.pullNumber} 作者 ${author ?? "(payload 缺失)"} 不在 REVIEW_TRIGGER_USERS 名单，跳过审查`,
      );
      return { status: 200, note: "ignored: PR author not in REVIEW_TRIGGER_USERS" };
    }
  }
  // 自发现公开入口：webhook 本身就是从公开可达的域名进来的（GitHub 只会 POST 配置时填的 URL），
  // host + x-forwarded-proto 还原 origin 塞进信封——后续续链优先走它（VERCEL_URL 部署专属 URL 会被
  // Standard Protection 挡掉，生产实测 PR #30）
  const proto = header(headers, "x-forwarded-proto") ?? "https";
  const host = header(headers, "host");
  const origin = host ? `${proto}://${host}` : undefined;
  schedule(() => dispatch(prepareEnvelope(ref, origin)));
  return {
    status: 200,
    note: `review scheduled: ${ref.owner}/${ref.repo}#${ref.pullNumber}@${ref.headSha.slice(0, 7)}`,
  };
}
