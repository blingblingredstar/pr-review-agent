import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadCases } from "../evals/cases/index.ts";
import { scoreCase, type EvalCase } from "../evals/score.ts";
import type { ReviewComment } from "../src/review.ts";

// #139 验收闸门 1 的确定性对账（零 LLM 调用，随 npm test 永久可回放）：
// 对同 prompt（f4e2b250e88b）两轮历史全量 run 用现行用例定义重打分，与存档 score 对账——
// 关键词补齐只翻正 11-10 轮的 bug-04 / real-03 两处伪 miss，其余 verdict 逐位一致；
// linked-04 旧 FP 以旧 fixture 双缺陷期望复核为真发现（fixture 缺陷，已随 #139 清理 diff）。

const RUNS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "evals", "runs");
const RUN_1106 = path.join(RUNS_DIR, "2026-11-06T16-57-38-glm-5.3-f4e2b250e88b-690926.json");
const RUN_1110 = path.join(RUNS_DIR, "2026-11-10T17-41-51-glm-5.3-f4e2b250e88b-690926.json");

type StoredRun = {
  caseId: string;
  error: string | null;
  comments: ReviewComment[];
  score: { verdicts: { hit: boolean }[]; commentTps: boolean[]; hits: number } | null;
};

// 11-10 轮唯一允许的 verdict 翻正（下标 → miss 翻 hit）。11-06 轮同发现恰用了旧表覆盖的措辞
//（「未等待」「丢失」），本来就没翻——该轮天然充当「其余 verdict 不变」的全量对照基线
const EXPECTED_FLIPS_1110: Record<string, number[]> = {
  "bug-04-missing-await": [0],
  "real-03-axios-bind-context": [0],
};

function loadStoredRuns(file: string): StoredRun[] {
  const data = JSON.parse(readFileSync(file, "utf8")) as { runs: StoredRun[] };
  return data.runs;
}

// 重打分与存档对账：翻正位置必须恰好等于 expectedFlips（miss→hit 单向），其余逐位一致
function reconcile(runFile: string, casesById: Map<string, EvalCase>, expectedFlips: Record<string, number[]>, label: string) {
  const stored = loadStoredRuns(runFile);
  let compared = 0;
  for (const s of stored) {
    if (s.error !== null || s.score === null) continue; // 当轮失败的用例无 score 可对
    const c = casesById.get(s.caseId);
    assert.ok(c, `${label}: 存档 caseId ${s.caseId} 在现行用例集中不存在`);
    const recomputed = scoreCase(c, s.comments);
    const storedHits = s.score.verdicts.map((v) => v.hit);
    const actualHits = recomputed.verdicts.map((v) => v.hit);
    assert.equal(actualHits.length, storedHits.length, `${label}/${s.caseId}: 现行 expect 数与存档不一致`);
    const flips = (expectedFlips[s.caseId] ?? []).sort();
    const flipped = storedHits.flatMap((h, i) => (h !== actualHits[i] ? [i] : []));
    assert.deepEqual(
      flipped,
      flips,
      `${label}/${s.caseId}: verdict 翻正位置 [${flipped}] 与预期 [${flips}] 不符`,
    );
    if (flips.length > 0) {
      // 翻正例的绝对值断言：miss→hit、对应意见翻 TP（这些用例各只有 1 条意见、1 条期望）
      assert.deepEqual(actualHits, flips.map(() => true), `${label}/${s.caseId}: 翻正后应为全 hit`);
      assert.deepEqual(recomputed.commentTps, s.comments.map(() => true), `${label}/${s.caseId}: 意见应全部翻 TP`);
    } else {
      assert.deepEqual(actualHits, storedHits, `${label}/${s.caseId}: verdict hit 逐位不一致`);
      assert.deepEqual(recomputed.commentTps, s.score.commentTps, `${label}/${s.caseId}: commentTps 逐位不一致`);
    }
    compared += 1;
  }
  return compared;
}

test("#139 对账：11-06 轮重打分与存档逐位一致（其余 verdict 不变的基线）", async () => {
  const casesById = new Map((await loadCases()).map((c) => [c.id, c]));
  const compared = reconcile(RUN_1106, casesById, {}, "11-06");
  assert.equal(compared, 87, "11-06 轮应有 87 个可比用例");
});

test("#139 对账：11-10 轮仅 bug-04/real-03 翻正，其余 verdict 逐位一致", async () => {
  const casesById = new Map((await loadCases()).map((c) => [c.id, c]));
  const compared = reconcile(RUN_1110, casesById, EXPECTED_FLIPS_1110, "11-10");
  assert.equal(compared, 87, "11-10 轮应有 87 个可比用例");
});

test("#139 对账：linked-04 11-10 的 FP 以旧 fixture 双缺陷期望复核为真发现", async () => {
  const current = (await loadCases()).find((c) => c.id === "linked-04-duplicated-constant");
  assert.ok(current, "现行用例集应有 linked-04");
  const entry = loadStoredRuns(RUN_1110).find((r) => r.caseId === "linked-04-duplicated-constant");
  assert.ok(entry?.score, "11-10 轮应有 linked-04 存档");

  // 旧 fixture（#139 修正前）：catch { /* 下一轮重试 */ } 在旧 diff 新侧第 28 行，耗尽重试静默返回
  // 是第二个真缺陷——11-10 模型在 :27 正确报出 rethrow 缺失，旧口径误记 FP。现行 fixture 已改
  // rethrow（单缺陷），该意见描述的缺陷不复存在，现行口径下不再是 TP 是设计内结果
  const legacy: EvalCase = {
    ...current,
    expect: [
      ...current.expect,
      { file: "src/ingest.ts", line: 28, mustMention: ["吞", "rethrow", "静默"] },
    ],
  };

  const legacyScore = scoreCase(legacy, entry.comments);
  assert.deepEqual(legacyScore.commentTps, [true, true], "旧 fixture 口径下两条意见都应是 TP（FP = fixture 缺陷非模型噪音）");

  const currentScore = scoreCase(current, entry.comments);
  assert.deepEqual(currentScore.commentTps, [true, false], "现行口径下硬编码意见仍 TP、吞异常意见不匹配（缺陷已从 fixture 移除）");
});
