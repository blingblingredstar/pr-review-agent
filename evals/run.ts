// npm run eval —— 全部用例串行跑 LLM 审查，输出打分表，结果落盘 evals/runs/
// 串行 + 用例间隔：本地代理对连续 API 请求间歇性失败（journal 会话 13），失败自动重试一次
import { mkdirSync, writeFileSync } from "node:fs";
import { loadCases } from "./cases/index.ts";
import { scoreCase, sourceOf, type CaseScore } from "./score.ts";
import { reviewDiff, type ReviewResult } from "../src/review.ts";

const CASE_GAP_MS = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type CaseRun = {
  caseId: string;
  kind: "bug" | "linked";
  source: "synthetic" | "real" | "dogfood";
  error: string | null;
  comments: ReviewResult["comments"];
  durationMs: number;
  // 失败用例为 null：空 comments 的 0% recall 是 API 抖动伪影，不能进 JSON 误导下游报告
  score: CaseScore | null;
};

async function reviewWithRetry(diff: string): Promise<ReviewResult> {
  let firstError: unknown = null;
  try {
    return await reviewDiff(diff);
  } catch (e) {
    firstError = e;
    console.warn(`\n  首次失败（${String(e).slice(0, 160)}），10s 后重试一次`);
    await sleep(10_000);
  }
  try {
    return await reviewDiff(diff);
  } catch (e) {
    throw new Error(`首次：${String(firstError).slice(0, 160)}；重试：${String(e).slice(0, 160)}`);
  }
}

function percent(n: number): string {
  // 一位小数：多轮对比时 toFixed(0) 会把 66.7% 与 67% 混淆
  return `${(n * 100).toFixed(1)}%`;
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
    const score = error ? null : scoreCase(c, comments);
    runs.push({ caseId: c.id, kind: c.kind, source: sourceOf(c), error, comments, durationMs, score });
    const mark = error ? `✗ 出错` : `命中 ${score!.hits}/${score!.verdicts.length}`;
    console.log(`${mark}，${comments.length} 条意见，${(durationMs / 1000).toFixed(1)}s`);
    if (i < cases.length - 1) await sleep(CASE_GAP_MS);
  }

  // 失败用例的空意见是 API 抖动的伪影，不进指标（失败数单独展示）
  const okRuns = runs.filter((r): r is CaseRun & { score: CaseScore } => !r.error && r.score !== null);
  // 能力评估 = synthetic + real；dogfood 是回归集（考过的原题），单独统计不进能力结论
  const capability = okRuns.filter((r) => r.source !== "dogfood");
  const metrics = (rs: (typeof okRuns)) => {
    const expectN = rs.reduce((s, r) => s + r.score.verdicts.length, 0);
    const hits = rs.reduce((s, r) => s + r.score.hits, 0);
    const comments = rs.reduce((s, r) => s + r.score.agentComments, 0);
    const tp = rs.reduce((s, r) => s + r.score.truePositives, 0);
    return {
      recall: expectN ? hits / expectN : 0,
      precision: comments ? tp / comments : null,
      expectN, hits, comments, tp,
    };
  };
  const totalExpect = capability.reduce((s, r) => s + r.score.verdicts.length, 0);
  const totalHits = capability.reduce((s, r) => s + r.score.hits, 0);
  const totalComments = capability.reduce((s, r) => s + r.score.agentComments, 0);
  const totalTp = capability.reduce((s, r) => s + r.score.truePositives, 0);
  const totalMs = runs.reduce((s, r) => s + r.durationMs, 0);
  const recall = totalExpect ? totalHits / totalExpect : 0;
  // 全部失败 / 零意见时 precision 无意义，置 null 报告显示 —（与单用例语义一致）
  const precision = totalComments ? totalTp / totalComments : null;
  const failed = runs.length - okRuns.length;

  const groupLines = (["synthetic", "real", "dogfood"] as const)
    .map((src) => {
      const rs = okRuns.filter((r) => r.source === src);
      if (rs.length === 0) return null;
      const m = metrics(rs);
      return `- **${src}**（${rs.length} 用例）：recall ${percent(m.recall)}（${m.hits}/${m.expectN}），precision ${m.precision === null ? "—" : percent(m.precision)}（${m.tp}/${m.comments}）`
        + (src === "dogfood" ? "（回归集，不计入能力评估）" : "");
    })
    .filter((x): x is string => x !== null);

  const tableLines = [
    `| case | source | kind | 期望命中 | recall | 意见数 | TP | precision | 耗时s |`,
    `|---|---|---|---|---|---|---|---|---|`,
    ...runs.map((r) => {
      if (r.error) {
        // error 文本可能含 |、换行、反引号，破坏 markdown 表格结构
        const reason = r.error.slice(0, 60).replace(/[|`\\\n]/g, " ");
        return `| ${r.caseId} ✗ ${reason} | ${r.source} | ${r.kind} | — | — | — | — | — | ${(r.durationMs / 1000).toFixed(1)} |`;
      }
      const s = r.score!;
      const rec = s.hits === s.verdicts.length ? `${s.hits}/${s.verdicts.length}` : `**${s.hits}/${s.verdicts.length}**`;
      const prec = s.precision === null ? "—" : s.precision.toFixed(2);
      return `| ${r.caseId} | ${r.source} | ${r.kind} | ${rec} | ${percent(s.recall)} | ${s.agentComments} | ${s.truePositives} | ${prec} | ${(r.durationMs / 1000).toFixed(1)} |`;
    }),
    `| **汇总**（能力评估；${failed > 0 ? `排除 ${failed} 个失败用例、` : ""}dogfood 回归集单独统计） | | | **${totalHits}/${totalExpect}** | **${percent(recall)}** | ${totalComments} | ${totalTp} | **${precision === null ? "—" : percent(precision)}** | ${(totalMs / 1000).toFixed(0)} |`,
  ];

  const report = [
    `# eval run ${startedAt}`,
    ``,
    `- 模型：\`${model}\``
    + (process.env.LLM_BASE_URL ? `（${process.env.LLM_BASE_URL}）` : ""),
    `- 汇总（能力评估 = synthetic + real）：recall ${percent(recall)}（${totalHits}/${totalExpect}），precision ${precision === null ? "—" : percent(precision)}（${totalTp}/${totalComments}），失败用例 ${failed}（不计入指标），总耗时 ${(totalMs / 1000 / 60).toFixed(1)} 分钟`,
    ``,
    ...groupLines,
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
    JSON.stringify({ startedAt, model, llmBaseUrl: process.env.LLM_BASE_URL ?? null, runs, summary: { recall, precision, totalExpect, totalHits, totalComments, totalTp, failed } }, null, 2) + "\n",
  );
  writeFileSync(new URL(`./runs/${base}.md`, import.meta.url), report);

  console.log(`\n${report}`);
  console.log(`结果已写入 evals/runs/${base}.{json,md}`);
  // 失败用例已排除在指标外、表格与汇总均已标注，进程正常退出——CI 里一次 API 抖动不应让整轮跑分红灯
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
