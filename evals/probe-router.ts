// 路由探针（#66 第一步，会话 44）：同一 fixture 输入分别打主评审端点（生产现状 router）与
// DECISION_* 指向的候选端点，对比 plan 解析成功率 / tokens / 时长 / plan 形态。只调用 runReviewRouter，
// 零生产行为影响（worker/主评审不触碰）；端点由环境决定——生产现状 = `DECISION_MODEL=glm-5.3-flash
// node --env-file=.env`，候选 = DECISION_* 四件套指向候选端点。PROBE_LABEL 标记输出归属。
import { runReviewRouter, diffSkeleton } from "../src/router.ts";
import { snapshotTree, type ZipballEntries } from "../src/context.ts";
import caseRepo02 from "./cases/repo-02-removed-export-still-used.ts";

const encoder = new TextEncoder();
function entriesFromRepo(repo: Record<string, string>): ZipballEntries {
  return new Map(Object.entries(repo).map(([p, content]) => [p, encoder.encode(content)]));
}

const label = process.env.PROBE_LABEL ?? "probe";
const n = Number(process.env.PROBE_N ?? 3);
const tree = snapshotTree(entriesFromRepo((caseRepo02 as { repo: Record<string, string> }).repo));
const skeleton = diffSkeleton((caseRepo02 as { diff: string }).diff);
const results: { ok: boolean; ms: number; detail: string }[] = [];

for (let i = 0; i < n; i++) {
  const t0 = Date.now();
  try {
    const plan = await runReviewRouter({ tree, skeleton });
    const ms = Date.now() - t0;
    results.push({ ok: true, ms, detail: `focus=${plan.focusAreas.length} risk=${plan.riskAreas.length} readPaths=${JSON.stringify(plan.readPaths)} strategy=${plan.strategy.slice(0, 50)}` });
    console.log(`[${label} #${i + 1}] OK ${ms}ms ${results[results.length - 1]!.detail}`);
  } catch (e) {
    const ms = Date.now() - t0;
    results.push({ ok: false, ms, detail: (e as Error).message.slice(0, 200) });
    console.log(`[${label} #${i + 1}] FAIL ${ms}ms ${(e as Error).message.slice(0, 200)}`);
  }
}

const ok = results.filter((r) => r.ok);
const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : -1);
console.log(`[${label}] 汇总：${ok.length}/${n} 解析成功 | 平均 ${avg(results.map((r) => r.ms))}ms（成功 ${avg(ok.map((r) => r.ms))}ms）`);
