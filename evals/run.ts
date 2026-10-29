// npm run eval —— 全部用例串行跑 LLM 审查，输出打分表，结果落盘 evals/runs/
// 串行 + 用例间隔：本地代理对连续 API 请求间歇性失败（journal 会话 13），失败自动重试一次
import { mkdirSync, writeFileSync } from "node:fs";
import { loadCases } from "./cases/index.ts";
import { scoreCase, type CaseScore } from "./score.ts";
import { reviewDiff, type ReviewResult } from "../src/review.ts";

const CASE_GAP_MS = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type CaseRun = {
  caseId: string;
  kind: "bug" | "linked";
  error: string | null;
  comments: ReviewResult["comments"];
  durationMs: number;
  score: CaseScore;
};

async function reviewWithRetry(diff: string): Promise<ReviewResult> {
  try {
    return await reviewDiff(diff);
  } catch (e) {
    console.warn(`\n  首次失败（${String(e).slice(0, 160)}），10s 后重试一次`);
    await sleep(10_000);
    return reviewDiff(diff);
  }
}

function percent(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

async function main() {
  const cases = await loadCases();
  const model = process.env.LLM_MODEL ?? "(unknown)";
  const startedAt = new Date().toISOString();
  console.log(`eval 开始：${cases.length} 个用例，模型 ${model}`);

  const runs: CaseRun[] = [];
  for (const [i, c] of cases.entries()) {
    process.stdout.write(`[${i + 1}/${cases.length}] ${c.id} ... `);
    const started = Date.now();
    let error: string | null = null;
    let comments: ReviewResult["comments"] = [];
    try {
      comments = (await reviewWithRetry(c.diff)).comments;
    } catch (e) {
      error = String(e);
    }
    const durationMs = Date.now() - started;
    const score = scoreCase(c, comments);
    runs.push({ caseId: c.id, kind: c.kind, error, comments, durationMs, score });
    const mark = error ? `✗ 出错` : `命中 ${score.hits}/${score.verdicts.length}`;
    console.log(`${mark}，${comments.length} 条意见，${(durationMs / 1000).toFixed(1)}s`);
    if (i < cases.length - 1) await sleep(CASE_GAP_MS);
  }

  const totalExpect = runs.reduce((s, r) => s + r.score.verdicts.length, 0);
  const totalHits = runs.reduce((s, r) => s + r.score.hits, 0);
  const totalComments = runs.reduce((s, r) => s + r.score.agentComments, 0);
  const totalTp = runs.reduce((s, r) => s + r.score.truePositives, 0);
  const totalMs = runs.reduce((s, r) => s + r.durationMs, 0);
  const recall = totalHits / totalExpect;
  const precision = totalComments ? totalTp / totalComments : 0;
  const failed = runs.filter((r) => r.error).length;

  const tableLines = [
    `| case | kind | 期望命中 | recall | 意见数 | TP | precision | 耗时s |`,
    `|---|---|---|---|---|---|---|---|`,
    ...runs.map((r) => {
      const rec = r.score.hits === r.score.verdicts.length ? `${r.score.hits}/${r.score.verdicts.length}` : `**${r.score.hits}/${r.score.verdicts.length}**`;
      const prec = r.score.precision === null ? "—" : r.score.precision.toFixed(2);
      const status = r.error ? ` ✗ ${r.error.slice(0, 60)}` : "";
      return `| ${r.caseId}${status} | ${r.kind} | ${rec} | ${percent(r.score.recall)} | ${r.score.agentComments} | ${r.score.truePositives} | ${prec} | ${(r.durationMs / 1000).toFixed(1)} |`;
    }),
    `| **汇总** | | **${totalHits}/${totalExpect}** | **${percent(recall)}** | ${totalComments} | ${totalTp} | **${percent(precision)}** | ${(totalMs / 1000).toFixed(0)} |`,
  ];

  const report = [
    `# eval run ${startedAt}`,
    ``,
    `- 模型：\`${model}\``
    + (process.env.LLM_BASE_URL ? `（${process.env.LLM_BASE_URL}）` : ""),
    `- 汇总：recall ${percent(recall)}（${totalHits}/${totalExpect}），precision ${percent(precision)}（${totalTp}/${totalComments}），失败用例 ${failed}，总耗时 ${(totalMs / 1000 / 60).toFixed(1)} 分钟`,
    ``,
    ...tableLines,
    ``,
  ].join("\n");

  mkdirSync(new URL("./runs/", import.meta.url), { recursive: true });
  const stamp = startedAt.replace(/[:.]/g, "-").slice(0, 19);
  const safeModel = model.replace(/[^a-zA-Z0-9._-]/g, "_");
  const base = `${stamp}-${safeModel}`;
  writeFileSync(
    new URL(`./runs/${base}.json`, import.meta.url),
    JSON.stringify({ startedAt, model, llmBaseUrl: process.env.LLM_BASE_URL ?? null, runs, summary: { recall, precision, totalExpect, totalHits, totalComments, totalTp, failed } }, null, 2),
  );
  writeFileSync(new URL(`./runs/${base}.md`, import.meta.url), report);

  console.log(`\n${report}`);
  console.log(`结果已写入 evals/runs/${base}.{json,md}`);
  if (failed > 0) process.exitCode = 1;
}

main();
