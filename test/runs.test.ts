import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRunRecord,
  handleRunsApi,
  listRunRecords,
  runBlobPath,
  runsApiEnabled,
  runsTtlDays,
  runsWriteEnabled,
  writeRunRecord,
  type RunRecord,
} from "../src/runs.ts";
import { withEnv } from "./helpers.ts";

const REF = { owner: "acme", repo: "demo", pullNumber: 7, headSha: "abc123def4567890abcdef1234567890abcdef12" };

const RESULT = {
  comments: [
    { file: "src/demo.ts", line: 2, severity: "major", body: "问题 A", confidence: "high" },
    { file: "src/other.ts", line: 9, severity: "nit", body: "问题 B" },
  ],
  usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
};

const POSTED = { inline: 1, degraded: 0, folded: 1 };

// withEnv 临时清掉宿主环境的 Blob 凭证，保证「未配置跳过」分支与测试确定性
const CLEAR_BLOB = ["BLOB_STORE_ID", "BLOB_READ_WRITE_TOKEN"] as const;

test("buildRunRecord：全字段构造（repo/pr/sha、tokens、outcome、findings 全 severity 含 confidence）", () => {
  const built = buildRunRecord(REF, RESULT, POSTED, "base1234", 1700000000000, 1700000060000);
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const r = built.record;
  assert.equal(r.v, 1);
  assert.equal(r.repo, "acme/demo");
  assert.equal(r.pr, 7);
  assert.equal(r.headSha, REF.headSha);
  assert.equal(r.startedAt, 1700000000000);
  assert.equal(r.finishedAt, 1700000060000);
  assert.equal(r.incrementalBase, "base1234");
  assert.deepEqual(r.tokens, { input: 100, output: 50, total: 150, cached: null });
  assert.deepEqual(r.outcome, POSTED);
  assert.equal(r.findings.length, 2);
  assert.deepEqual(r.findings[0], { file: "src/demo.ts", line: 2, severity: "major", body: "问题 A", confidence: "high" });
  assert.deepEqual(r.findings[1], { file: "src/other.ts", line: 9, severity: "nit", body: "问题 B" });
});

test("buildRunRecord：usage 缺字段 → null（端点不返回口径）", () => {
  const built = buildRunRecord(REF, { comments: [] }, POSTED, null, null, 1);
  assert.ok(built.ok);
  if (built.ok) assert.deepEqual(built.record.tokens, { input: null, output: null, total: null, cached: null });
});

test("buildRunRecord：纵深校验拒绝非法 repo/sha/pr（P2-1，不抛错返回 reason）", () => {
  for (const bad of [
    { ...REF, repo: "../evil" },
    { ...REF, repo: "acme/d em o" },
    { ...REF, owner: "ac me" },
    { ...REF, headSha: "zzz-not-hex" },
    { ...REF, headSha: "abc123; drop" },
    { ...REF, pullNumber: 0 },
    { ...REF, pullNumber: 1.5 },
  ]) {
    const built = buildRunRecord(bad, RESULT, POSTED, null, null, 1);
    assert.equal(built.ok, false, `应拒绝：${JSON.stringify(bad)}`);
    if (!built.ok) assert.ok(built.reason.length > 0);
  }
});

test("buildRunRecord：comments 字段漂移整条拒绝（不带病入库）", () => {
  const built = buildRunRecord(REF, { comments: [{ file: "a.ts", line: "x", severity: "major", body: "b" }] }, POSTED, null, null, 1);
  assert.equal(built.ok, false);
  if (!built.ok) assert.match(built.reason, /漂移|类型/);
  const noComments = buildRunRecord(REF, undefined, POSTED, null, null, 1);
  assert.equal(noComments.ok, false);
});

test("runBlobPath：runs/ 前缀 + 按仓分层 + 确定性", () => {
  const built = buildRunRecord(REF, RESULT, POSTED, null, null, 1);
  assert.ok(built.ok);
  if (!built.ok) return;
  const path = runBlobPath(built.record);
  assert.equal(path, `runs/acme/demo/7-${REF.headSha}.json`);
  assert.equal(path, runBlobPath(built.record));
  assert.ok(!path.includes(".."));
});

test("runsTtlDays：默认 730 / 0 关闭 / 非法回退默认 / 越界拒绝", () => {
  withEnv({ RUNS_TTL_DAYS: "" }, () => assert.equal(runsTtlDays(), 730));
  withEnv({ RUNS_TTL_DAYS: "0" }, () => assert.equal(runsTtlDays(), undefined));
  withEnv({ RUNS_TTL_DAYS: "90" }, () => assert.equal(runsTtlDays(), 90));
  withEnv({ RUNS_TTL_DAYS: "abc" }, () => assert.equal(runsTtlDays(), 730));
  withEnv({ RUNS_TTL_DAYS: "9999" }, () => assert.equal(runsTtlDays(), 730));
  withEnv({ RUNS_TTL_DAYS: "-1" }, () => assert.equal(runsTtlDays(), 730));
});

test("writeRunRecord：凭证缺席静默跳过（put 不被触碰）", async () => {
  let putCalls = 0;
  withEnv({ BLOB_STORE_ID: "", BLOB_READ_WRITE_TOKEN: "" }, async () => {
    assert.equal(runsWriteEnabled(), false);
    const built = buildRunRecord(REF, RESULT, POSTED, null, null, 1);
    assert.ok(built.ok);
    if (!built.ok) return;
    await writeRunRecord(built.record, { put: async () => { putCalls += 1; } });
    assert.equal(putCalls, 0);
  });
});

test("writeRunRecord：凭证在 → put 收到 private/确定性路径/allowOverwrite:false/超时信号/ttlDays", async () => {
  let captured: unknown;
  withEnv({ BLOB_STORE_ID: "store-1", RUNS_TTL_DAYS: "90" }, async () => {
    const built = buildRunRecord(REF, RESULT, POSTED, null, null, 1);
    assert.ok(built.ok);
    if (!built.ok) return;
    await writeRunRecord(built.record, {
      put: async (pathname, body, options) => {
        captured = { pathname, body, options };
        return { url: "https://blob.example/should-not-be-logged" };
      },
    });
    const c = captured as { pathname: string; body: string; options: Record<string, unknown> };
    assert.equal(c.pathname, `runs/acme/demo/7-${REF.headSha}.json`);
    assert.equal(c.options.access, "private");
    assert.equal(c.options.allowOverwrite, false);
    assert.equal(c.options.addRandomSuffix, false);
    assert.equal(c.options.contentType, "application/json");
    assert.equal(c.options.ttlDays, 90);
    assert.ok(c.options.abortSignal instanceof AbortSignal);
    assert.equal(JSON.parse(c.body).repo, "acme/demo");
  });
});

test("writeRunRecord：put 抛错被吞（绝不连坐 publish）", async () => {
  withEnv({ BLOB_STORE_ID: "store-1" }, async () => {
    const built = buildRunRecord(REF, RESULT, POSTED, null, null, 1);
    assert.ok(built.ok);
    if (!built.ok) return;
    await writeRunRecord(built.record, {
      put: async () => {
        throw new Error("Blob down");
      },
    });
  });
});

// —— 读侧与 API 门 ——

function fakeListGet(records: RunRecord[]) {
  const blobs = records.map((r) => ({ pathname: runBlobPath(r), url: "https://blob.example/x" }));
  return {
    list: async () => ({ blobs, cursor: undefined }),
    get: async (pathname: string) => {
      const hit = records.find((r) => runBlobPath(r) === pathname);
      if (!hit) return null;
      const body = JSON.stringify(hit);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      });
      return { statusCode: 200 as const, stream, headers: new Headers(), blob: { pathname, contentType: "application/json", size: body.length } };
    },
  };
}

const SAMPLE: RunRecord = {
  v: 1,
  repo: "acme/demo",
  pr: 7,
  headSha: REF.headSha,
  startedAt: null,
  finishedAt: 1,
  incrementalBase: null,
  tokens: { input: null, output: null, total: null, cached: null },
  outcome: { inline: 0, degraded: 0, folded: 0 },
  findings: [],
};

test("listRunRecords：前缀锁死 + 解析 + 跳过计数（坏记录不炸列表）", async () => {
  let listedPrefix = "";
  const base = fakeListGet([SAMPLE]);
  const { runs, skipped } = await listRunRecords({
    list: async (opts) => {
      listedPrefix = (opts as { prefix: string }).prefix;
      return base.list();
    },
    get: async (pathname) => {
      if (pathname === `runs/acme/demo/7-${REF.headSha}.json`) return base.get(pathname);
      throw new Error("bad blob");
    },
  });
  assert.equal(listedPrefix, "runs/");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].repo, "acme/demo");
  assert.equal(skipped, 0);
});

test("listRunRecords：非 RunRecord 形态跳过不炸", async () => {
  const blobs = [{ pathname: "runs/x/y/1-zzz.json" }];
  const { runs, skipped } = await listRunRecords({
    list: async () => ({ blobs, cursor: undefined }),
    get: async () => ({
      statusCode: 200 as const,
      stream: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"hello":1}'));
          c.close();
        },
      }),
      headers: new Headers(),
      blob: { pathname: "runs/x/y/1-zzz.json", contentType: "application/json", size: 10 },
    }),
  });
  assert.equal(runs.length, 0);
  assert.equal(skipped, 1);
});

test("handleRunsApi：门关闭（含未设置）一律 404，与路由不存在无区别（P0-1 fail-closed）", async () => {
  withEnv({ RUNS_API_ENABLED: "" }, async () => {
    const off = await handleRunsApi("GET");
    assert.equal(off.status, 404);
    assert.equal(off.contentType, "text/plain");
    assert.equal(off.body, "not found");
    assert.equal(off.noStore, false);
    assert.equal(runsApiEnabled(), false);
  });
  withEnv({ RUNS_API_ENABLED: "0" }, async () => assert.equal((await handleRunsApi("GET")).status, 404));
  withEnv({ RUNS_API_ENABLED: "true" }, async () => assert.equal((await handleRunsApi("GET")).status, 404));
});

test("handleRunsApi：门开 + GET → JSON（no-store）；非 GET → 405", async () => {
  withEnv({ RUNS_API_ENABLED: "1" }, async () => {
    assert.equal(runsApiEnabled(), true);
    const ok = await handleRunsApi("GET", fakeListGet([SAMPLE]));
    assert.equal(ok.status, 200);
    assert.equal(ok.contentType, "application/json");
    assert.equal(ok.noStore, true);
    const parsed = JSON.parse(ok.body) as { runs: RunRecord[]; skipped: number };
    assert.equal(parsed.runs.length, 1);
    assert.equal(parsed.skipped, 0);
    const notGet = await handleRunsApi("POST", fakeListGet([SAMPLE]));
    assert.equal(notGet.status, 405);
  });
});

test("listRunRecords：有限并发分批（bot major #123）——在途上界 10、结果保序、全量回收", async () => {
  const total = 25;
  const records: RunRecord[] = Array.from({ length: total }, (_, i) => ({ ...SAMPLE, pr: i + 1 }));
  const paths = records.map((r) => runBlobPath(r));
  let inFlight = 0;
  let maxInFlight = 0;
  const { runs, skipped } = await listRunRecords({
    list: async () => ({ blobs: paths.map((pathname) => ({ pathname })) }),
    get: async (pathname) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      const hit = records.find((r) => runBlobPath(r) === pathname);
      if (!hit) return null;
      const body = JSON.stringify(hit);
      return {
        statusCode: 200 as const,
        stream: new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode(body));
            c.close();
          },
        }),
        headers: new Headers(),
        blob: { pathname, contentType: "application/json", size: body.length },
      };
    },
  });
  assert.equal(runs.length, total, "25 条全部回收");
  assert.equal(skipped, 0);
  assert.ok(maxInFlight <= 10, `并发上界 10，实测 ${maxInFlight}`);
  assert.equal(runs[0]!.pr, 1, "结果保序（按 blob 顺序）");
  assert.equal(runs[runs.length - 1]!.pr, total);
});

test("handleRunsApi：405 带 Allow: GET 头（bot nit #123，与 webhook 405 先例一致）", async () => {
  withEnv({ RUNS_API_ENABLED: "1" }, async () => {
    const notGet = await handleRunsApi("DELETE", fakeListGet([SAMPLE]));
    assert.equal(notGet.status, 405);
    assert.deepEqual(notGet.headers, { Allow: "GET" });
  });
});
