import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { handleWebhook, reviewTriggerUsers, verifySignature } from "../src/webhook.ts";
import { hasReviewed, reviewMarker } from "../src/dedupe.ts";

const SECRET = "test-secret";
process.env.WEBHOOK_SECRET ??= SECRET;

function signedHeaders(event: string, body: string): Record<string, string> {
  return {
    "x-github-event": event,
    "x-github-delivery": "test-delivery",
    "x-hub-signature-256": `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`,
  };
}

const prPayload = (action: string, author?: string) =>
  JSON.stringify({
    action,
    repository: { owner: { login: "acme" }, name: "demo" },
    pull_request: {
      number: 7,
      head: { sha: "abc123def4567890" },
      ...(author ? { user: { login: author } } : {}),
    },
  });

test("verifySignature：合法签名通过", () => {
  const body = prPayload("opened");
  assert.equal(verifySignature(SECRET, body, signedHeaders("pull_request", body)["x-hub-signature-256"]), true);
});

test("verifySignature：篡改 body / 缺头 / 错 secret / 非法前缀均拒绝", () => {
  const body = prPayload("opened");
  const sig = signedHeaders("pull_request", body)["x-hub-signature-256"];
  assert.equal(verifySignature(SECRET, body + " ", sig), false);
  assert.equal(verifySignature(SECRET, body, undefined), false);
  assert.equal(verifySignature("wrong", body, sig), false);
  assert.equal(verifySignature(SECRET, body, "md5=deadbeef"), false);
});

test("分发：opened / synchronize 调度审查，携带 owner/repo/number/sha", () => {
  for (const action of ["opened", "synchronize"]) {
    const body = prPayload(action);
    const scheduled: Array<() => Promise<void>> = [];
    const outcome = handleWebhook(signedHeaders("pull_request", body), body, (t) => scheduled.push(t));
    assert.equal(outcome.status, 200);
    assert.equal(scheduled.length, 1, `${action} 应调度一次`);
    assert.ok(outcome.note.includes("acme/demo#7@abc123d"));
  }
});

test("分发：ping / 其他事件 / opened 以外动作一律 200 忽略且不调度", () => {
  const scheduled: Array<() => Promise<void>> = [];
  const noop = (t: () => Promise<void>) => scheduled.push(t);
  const pingBody = JSON.stringify({ zen: "Design for failure." });
  assert.equal(handleWebhook(signedHeaders("ping", pingBody), pingBody, noop).status, 200);
  const issuesBody = JSON.stringify({ action: "opened" });
  assert.equal(handleWebhook(signedHeaders("issues", issuesBody), issuesBody, noop).status, 200);
  const closedBody = prPayload("closed");
  assert.equal(handleWebhook(signedHeaders("pull_request", closedBody), closedBody, noop).status, 200);
  assert.equal(scheduled.length, 0);
});

test("分发：payload 字段缺失 200 忽略且不调度", () => {
  const body = JSON.stringify({ action: "opened", repository: { owner: { login: "acme" } } });
  const scheduled: Array<() => Promise<void>> = [];
  const outcome = handleWebhook(signedHeaders("pull_request", body), body, (t) => scheduled.push(t));
  assert.equal(outcome.status, 200);
  assert.equal(scheduled.length, 0);
});

test("分发：签名不符返回 401 且不调度", () => {
  const body = prPayload("opened");
  const headers = signedHeaders("pull_request", body);
  headers["x-hub-signature-256"] = "sha256=" + "0".repeat(64);
  const scheduled: Array<() => Promise<void>> = [];
  const outcome = handleWebhook(headers, body, (t) => scheduled.push(t));
  assert.equal(outcome.status, 401);
  assert.equal(scheduled.length, 0);
});

test("触发白名单：名单内作者调度（大小写不敏感），名单外 / 缺作者 200 忽略不调度", () => {
  const scheduled: Array<() => Promise<void>> = [];
  const noop = (t: () => Promise<void>) => scheduled.push(t);
  process.env.REVIEW_TRIGGER_USERS = "blingblingredstar, Reviewer2";
  try {
    const inList = prPayload("opened", "BlingBlingRedStar");
    assert.equal(handleWebhook(signedHeaders("pull_request", inList), inList, noop).status, 200);
    assert.equal(scheduled.length, 1, "名单内作者应调度（大小写不敏感）");
    scheduled.length = 0;
    const outList = prPayload("synchronize", "stranger");
    assert.equal(handleWebhook(signedHeaders("pull_request", outList), outList, noop).status, 200);
    assert.equal(scheduled.length, 0, "名单外作者不应调度");
    const noAuthor = prPayload("opened");
    assert.equal(handleWebhook(signedHeaders("pull_request", noAuthor), noAuthor, noop).status, 200);
    assert.equal(scheduled.length, 0, "名单启用但 payload 缺作者应按拒绝处理（D021 fail-closed）");
  } finally {
    delete process.env.REVIEW_TRIGGER_USERS;
  }
});

test("触发白名单：* 全放行；未配置保持现行为（所有人可触发）", () => {
  const scheduled: Array<() => Promise<void>> = [];
  const noop = (t: () => Promise<void>) => scheduled.push(t);
  process.env.REVIEW_TRIGGER_USERS = "*";
  try {
    const body = prPayload("opened", "anyone");
    handleWebhook(signedHeaders("pull_request", body), body, noop);
    assert.equal(scheduled.length, 1, "* 应显式全放行");
  } finally {
    delete process.env.REVIEW_TRIGGER_USERS;
  }
  scheduled.length = 0;
  const body = prPayload("synchronize", "stranger");
  handleWebhook(signedHeaders("pull_request", body), body, noop);
  assert.equal(scheduled.length, 1, "未配置 = 所有人可触发（向后兼容）");
});

test("reviewTriggerUsers 解析：空白 / 纯逗号视同未配置", () => {
  process.env.REVIEW_TRIGGER_USERS = " , ";
  try {
    assert.equal(reviewTriggerUsers(), null);
  } finally {
    delete process.env.REVIEW_TRIGGER_USERS;
  }
  assert.equal(reviewTriggerUsers(), null);
  process.env.REVIEW_TRIGGER_USERS = "a, b,c";
  try {
    assert.deepEqual(reviewTriggerUsers(), ["a", "b", "c"]);
  } finally {
    delete process.env.REVIEW_TRIGGER_USERS;
  }
});

test("reviewMarker / hasReviewed：按 body 内嵌 sha 标记判定", async () => {
  const ref = { owner: "acme", repo: "demo", pullNumber: 7 };
  assert.equal(reviewMarker("abc123"), `<!-- pr-review-agent sha:abc123 -->`);
  const client = (bodies: (string | null)[]) =>
    ({
      paginate: async () => bodies.map((body) => ({ body })),
      rest: { pulls: { listReviews: () => undefined } },
    }) as unknown as Parameters<typeof hasReviewed>[0];
  assert.equal(await hasReviewed(client([null, `意见\n${reviewMarker("abc123")}`]), ref, "abc123"), true);
  assert.equal(await hasReviewed(client([reviewMarker("other-sha")]), ref, "abc123"), false);
  assert.equal(await hasReviewed(client([]), ref, "abc123"), false);
});
