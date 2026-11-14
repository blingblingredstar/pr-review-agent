import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateRuns, isExternalGolden, type RunJson } from "../evals/compare.ts";

function runJson({ runs, ...rest }: Partial<RunJson> & { runs: RunJson["runs"] }): RunJson {
  return {
    startedAt: "2026-10-30T00:00:00Z",
    model: "test-model",
    promptHash: "aaa",
    ...rest,
    runs,
  } as RunJson;
}

const score = (hits: number, verdicts: number, comments: number, tp: number) => ({
  hits,
  verdicts: Array.from({ length: verdicts }, (_, i) => ({ hit: i < hits, expect: { file: "a.ts", line: 1 } })),
  agentComments: comments,
  truePositives: tp,
});

test("aggregateRuns：跨轮微平均与分组指标", () => {
  const f1 = runJson({
    runs: [
      { caseId: "s-01", source: "synthetic", error: null, score: score(1, 1, 3, 2) },
      { caseId: "r-01", source: "real", error: null, score: score(0, 1, 1, 0) },
      { caseId: "d-01", source: "dogfood", error: null, score: score(1, 1, 5, 5) },
    ],
  });
  const f2 = runJson({
    runs: [
      { caseId: "s-01", source: "synthetic", error: null, score: score(1, 1, 1, 1) },
      { caseId: "r-01", source: "real", error: null, score: score(1, 1, 1, 1) },
      { caseId: "d-01", source: "dogfood", error: null, score: score(0, 1, 2, 0) },
    ],
  });
  const [agg] = aggregateRuns([{ name: "a.json", data: f1 }, { name: "b.json", data: f2 }]);
  // 合计（synthetic+real）：recall 3/4，precision 4/6；dogfood 不进
  assert.equal(agg.promptHash, "aaa");
  assert.equal(agg.model, "test-model");
  assert.equal(agg.micro.recall, 0.75);
  assert.ok(Math.abs(agg.micro.precision! - 4 / 6) < 1e-9);
  assert.equal(agg.groups.synthetic.recall, 1);
  assert.ok(Math.abs(agg.groups.synthetic.precision! - 3 / 4) < 1e-9);
  assert.equal(agg.groups.real.recall, 0.5);
  // dogfood 组照常输出（打印处标注回归集），只是不进 micro 合计
  assert.equal(agg.groups.dogfood.recall, 0.5);
  assert.ok(Math.abs(agg.groups.dogfood.precision! - 5 / 7) < 1e-9);
  // 全命中轮显示 ✓（hits === verdicts，多期望用例也适用），miss 轮显示分数
  const r01 = agg.unstable.find((u) => u.caseId === "r-01")!;
  assert.deepEqual(r01.perRun, ["0/1", "✓"]);
});

test("aggregateRuns：旧 run 无指纹归 legacy 组；未全命中用例进短板矩阵并去重定位", () => {
  const legacy = runJson({
    promptHash: undefined,
    runs: [
      { caseId: "s-01", source: "synthetic", error: null, score: score(0, 1, 1, 0) },
    ],
  });
  const newer = runJson({
    promptHash: "bbb",
    runs: [
      { caseId: "s-01", source: "synthetic", error: null, score: score(1, 1, 1, 1) },
      {
        caseId: "r-01",
        source: "real",
        error: null,
        score: {
          hits: 0,
          verdicts: [
            { hit: false, expect: { file: ["src/x.ts", "src/y.ts"], line: 42 } },
            { hit: false, expect: { file: "src/z.ts", line: null } },
          ],
          agentComments: 2,
          truePositives: 0,
        },
      },
    ],
  });
  const aggs = aggregateRuns([{ name: "old.json", data: legacy }, { name: "new1.json", data: newer }, { name: "new2.json", data: newer }]);
  assert.deepEqual(aggs.map((a) => a.promptHash), ["legacy(无指纹)", "bbb"]);
  const bbb = aggs[1]!;
  // r-01 两轮都未全命中：数组期望列出全部候选、跨轮去重；s-01 两轮全命中不进矩阵
  const r01 = bbb.unstable.find((u) => u.caseId === "r-01")!;
  // 数组期望列出全部候选（fileA|fileB:行）
  assert.deepEqual(r01.missAt, ["src/x.ts|src/y.ts:42", "src/z.ts:*"]);
  assert.deepEqual(r01.perRun, ["0/2", "0/2"]);
  assert.ok(!bbb.unstable.some((u) => u.caseId === "s-01"));
});

test("aggregateRuns：失败/缺 score 用例不进指标，perRun 标 err；混传缺用例的 run 标缺", () => {
  const f = runJson({
    runs: [
      { caseId: "s-01", source: "synthetic", error: "boom", score: null },
      { caseId: "r-01", source: "real", error: null, score: score(1, 1, 1, 1) },
    ],
  });
  const partial = runJson({
    runs: [{ caseId: "r-01", source: "real", error: null, score: score(0, 1, 1, 0) }],
  });
  const [agg] = aggregateRuns([
    { name: "a.json", data: f },
    { name: "partial.json", data: partial },
  ]);
  // 微平均计入 partial run 的 r-01 0/1（跑过但 miss 的用例算数）：1/2
  assert.equal(agg.micro.recall, 0.5);
  const s01 = agg.unstable.find((u) => u.caseId === "s-01")!;
  assert.equal(s01.perRun[0], "err");
  // partial run 没跑过 s-01：标注「缺」而不是崩溃
  assert.equal(s01.perRun[1], "缺");
});

test("aggregateRuns：空组返回 null 而非 0（与 precision 的 — 语义一致）", () => {
  const f = runJson({
    runs: [{ caseId: "d-01", source: "dogfood", error: null, score: score(1, 1, 1, 1) }],
  });
  const [agg] = aggregateRuns([{ name: "a.json", data: f }]);
  // 全部用例是 dogfood：能力评估组为空
  assert.equal(agg.micro.recall, null);
  assert.equal(agg.micro.precision, null);
});

test("aggregateRuns：planArm 分组——EVAL_PLAN 臂与 baseline 不混聚，legacy/null 归 baseline（#65 闸门 2）", () => {
  const base = { caseId: "repo-01", source: "repo", error: null, score: score(1, 1, 2, 1) };
  const planRun = runJson({ planArm: { enabled: true }, runs: [base] });
  const nullArmRun = runJson({ planArm: null, runs: [base] });
  // legacy run：不传 planArm（run.ts 写出该字段之前的存量 run JSON 就是这个形态）
  const legacyRun = runJson({ runs: [base] });
  const aggs = aggregateRuns([
    { name: "plan.json", data: planRun },
    { name: "null-arm.json", data: nullArmRun },
    { name: "legacy.json", data: legacyRun },
  ]);
  // 同模型同 prompt：baseline 两个 run（null 臂 + legacy）聚一组、plan 臂单独一组——
  // 混聚会被当「同版多轮」微平均，消融对照失义
  assert.equal(aggs.length, 2);
  const planAgg = aggs.find((a) => a.planArm === "plan")!;
  const baseAgg = aggs.find((a) => a.planArm === "")!;
  assert.equal(planAgg.files.length, 1, "plan 臂独立成组");
  assert.equal(baseAgg.files.length, 2, "null 臂与 legacy 同归 baseline 组");
});

// 外部 golden 单列读数（#157 → D048）：意见行距 4 = ±3 miss / ±5 hit 的最小样本
const extVerdict = (line: number) => ({
  hit: false,
  expect: { file: "src/x.ts", line, mustMention: ["溢出"] },
});
const extComment = (line: number) => ({ file: "src/x.ts", line, severity: "major", body: "存在 2^31 溢出问题", confidence: null });

test("aggregateRuns：外部 golden 子集单列 ±3/±5——行距 4 的锚点伪影在 ±5 回收，±3 取落库 score（#157/D048）", () => {
  const f = runJson({
    runs: [
      {
        caseId: "aacr-01-test",
        source: "aacr",
        error: null,
        comments: [extComment(14)],
        score: {
          hits: 0,
          verdicts: [extVerdict(10)],
          agentComments: 1,
          truePositives: 0,
        },
      },
      // 同 run 混入一个非外部用例：不进 extGolden 分母
      { caseId: "s-01", source: "synthetic", error: null, score: score(1, 1, 1, 1) },
    ],
  });
  const [agg] = aggregateRuns([{ name: "a.json", data: f }]);
  assert.ok(agg.extGolden.k3, "有外部用例时 k3 必有值");
  assert.equal(agg.extGolden.k3!.recall, 0, "±3 契约口径：行距 4 记 miss（与落库 score 一致）");
  assert.equal(agg.extGolden.k3!.precision, 0);
  assert.ok(agg.extGolden.k5, "comments + mustMention 齐备时 k5 必有值");
  assert.equal(agg.extGolden.k5!.recall, 1, "±5 回收行距 4 的锚点伪影");
  assert.equal(agg.extGolden.k5!.precision, 1);
});

test("aggregateRuns：无外部 golden 用例时 extGolden 双 null（历史组零扰动）；外部例缺 comments 时 k5 单独置 null 不按 0 抹平", () => {
  const noExt = runJson({
    runs: [{ caseId: "s-01", source: "synthetic", error: null, score: score(1, 1, 1, 1) }],
  });
  const [aggNoExt] = aggregateRuns([{ name: "a.json", data: noExt }]);
  assert.equal(aggNoExt.extGolden.k3, null);
  assert.equal(aggNoExt.extGolden.k5, null);

  const noComments = runJson({
    runs: [{ caseId: "real-16-calcom-delete-non-sms", source: "real", error: null, score: score(0, 1, 1, 0) }],
  });
  const [aggNoCm] = aggregateRuns([{ name: "b.json", data: noComments }]);
  assert.ok(aggNoCm.extGolden.k3, "real-16 硬列 id 计入外部子集，k3 取落库 score");
  assert.equal(aggNoCm.extGolden.k5, null, "缺 comments 不能重打分，置 null 而非假 0%");
});

test("isExternalGolden：aacr 前缀自动覆盖 + #107 转译 5 例硬列 + 普通用例不误收", () => {
  assert.ok(isExternalGolden("aacr-01-cline-azure-detection"));
  assert.ok(isExternalGolden("aacr-99-future-case"), "前缀匹配，新 aacr 例免登记");
  assert.ok(isExternalGolden("real-20-sentry-optimized-paginator"));
  assert.ok(!isExternalGolden("real-01-fastify-setcookie"), "自建 real 不进外部子集");
  assert.ok(!isExternalGolden("dogfood-01-webhook-guard"));
});
