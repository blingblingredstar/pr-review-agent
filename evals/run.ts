// npm run eval —— 全部用例串行跑 LLM 审查，输出打分表，结果落盘 evals/runs/
// 串行 + 用例间隔：本地代理对连续 API 请求间歇性失败（journal 会话 13），失败自动重试一次
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { loadCases } from "./cases/index.ts";
import { isCapabilitySource, parseEvalOnly, scoreCase, sourceOf, type CaseScore, type EvalCase } from "./score.ts";
import {
  loadPrompt,
  reviewDiff,
  sumUsage,
  withJsonSuffix,
  type ReviewDiffOpts,
  type ReviewOutcome,
  type ReviewResult,
  type TokenUsage,
} from "../src/review.ts";
import { fileReaderFromEntries, searcherFromEntries, type ZipballEntries } from "../src/context.ts";

const CASE_GAP_MS = 2_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type CaseRun = {
  caseId: string;
  kind: "bug" | "linked";
  source: ReturnType<typeof sourceOf>;
  error: string | null;
  comments: ReviewResult["comments"];
  // 成功用例的本次调用用量；失败用例为 null（重试成功也只计成功那次）
  usage: TokenUsage | null;
  durationMs: number;
  // 失败用例为 null：空 comments 的 0% recall 是 API 抖动伪影，不能进 JSON 误导下游报告
  score: CaseScore | null;
};

// repo fixture（D031）→ 快照 entries：head 态内容直接编码，与生产同一构造（fileReader + searcher 成对注入）
function entriesFromRepo(repo: Record<string, string>): ZipballEntries {
  const encoder = new TextEncoder();
  return new Map(Object.entries(repo).map(([p, content]) => [p, encoder.encode(content)]));
}

// 用例 → reviewDiff opts：无 taskContext 且无 repo = 裸路径（opts 整个不传，调用形态与历史字节级一致，
// 能力组 promptHash + 逐用例 tokens 红线由构造保证）；taskContext 只在用例显式携带时进 opts（inj-07，D029）；
// repo 用例注入 fileReader + searcher（生产同参走工具注入路径，D018 教训：eval 不镜像生产参数，eval 绿生产盲）
function caseOpts(c: EvalCase): ReviewDiffOpts | undefined {
  if (c.taskContext === undefined && !c.repo) return undefined;
  const opts: ReviewDiffOpts = {};
  if (c.taskContext !== undefined) opts.taskContext = c.taskContext;
  if (c.repo) {
    const entries = entriesFromRepo(c.repo);
    opts.fileReader = fileReaderFromEntries(entries);
    opts.searcher = searcherFromEntries(entries);
  }
  return opts;
}

async function reviewWithRetry(diff: string, opts?: ReviewDiffOpts): Promise<ReviewOutcome> {
  let firstError: unknown = null;
  try {
    return await reviewDiff(diff, undefined, opts);
  } catch (e) {
    firstError = e;
    console.warn(`\n  首次失败（${String(e).slice(0, 160)}），10s 后重试一次`);
    await sleep(10_000);
  }
  try {
    return await reviewDiff(diff, undefined, opts);
  } catch (e) {
    throw new Error(`首次：${String(firstError).slice(0, 160)}；重试：${String(e).slice(0, 160)}`);
  }
}

function percent(n: number): string {
  // 一位小数：多轮对比时 toFixed(0) 会把 66.7% 与 67% 混淆
  return `${(n * 100).toFixed(1)}%`;
}

const fmtTok = (v: number | null): string => (v === null ? "—" : String(v));
const fmtInOut = (u: TokenUsage | null): string => (u ? `${fmtTok(u.inputTokens)}/${fmtTok(u.outputTokens)}` : "—");

type OkRun = CaseRun & { score: CaseScore };

async function main() {
  const allCases = await loadCases();
  // EVAL_ONLY 子集（分组频率复测/定向迭代）：按 source 组名过滤，未设置跑全量；
  // console/md/JSON 三处都带子集标记，防子集 run 混进全量对比（parseEvalOnly 校验组名，见 score.ts）
  const evalOnly = parseEvalOnly(process.env.EVAL_ONLY, allCases.map(sourceOf));
  const cases = evalOnly ? allCases.filter((c) => evalOnly.includes(sourceOf(c))) : allCases;
  const model = process.env.LLM_MODEL ?? "(unknown)";
  // prompt 内容指纹：同 prompt 多轮与改版后的 run 机械可分（D006——eval 报告引用具体 prompt 版本）；
  // 指纹跟随实际生效的 system（JSON 模式含 json-output.md 后缀，DeepSeek 类端点；GLM 下字节不变 hash 不变）
  const promptHash = createHash("sha256").update(withJsonSuffix(loadPrompt())).digest("hex").slice(0, 12);
  const startedAt = new Date().toISOString();
  console.log(`eval 开始：${cases.length} 个用例，模型 ${model}，prompt ${promptHash}` + (evalOnly ? `，子集（EVAL_ONLY）${evalOnly.join(",")}` : ""));

  const runs: CaseRun[] = [];
  for (const [i, c] of cases.entries()) {
    process.stdout.write(`[${i + 1}/${cases.length}] ${c.id} ... `);
    const started = Date.now();
    let error: string | null = null;
    let comments: ReviewResult["comments"] = [];
    let usage: TokenUsage | null = null;
    try {
      const outcome = await reviewWithRetry(c.diff, caseOpts(c));
      comments = outcome.comments;
      usage = outcome.usage;
    } catch (e) {
      error = String(e);
    }
    const durationMs = Date.now() - started;
    const score = error ? null : scoreCase(c, comments);
    runs.push({ caseId: c.id, kind: c.kind, source: sourceOf(c), error, comments, usage, durationMs, score });
    const mark = error ? `✗ 出错` : score!.verdicts.length === 0 ? `clean（FP 对照）` : `命中 ${score!.hits}/${score!.verdicts.length}`;
    console.log(`${mark}，${comments.length} 条意见，tokens ${fmtInOut(usage)}，${(durationMs / 1000).toFixed(1)}s`);
    if (i < cases.length - 1) await sleep(CASE_GAP_MS);
  }

  // 失败用例的空意见是 API 抖动的伪影，不进指标（失败数单独展示）
  const okRuns = runs.filter((r): r is OkRun => !r.error && r.score !== null);
  // 能力评估 = synthetic + real；dogfood 是回归集（考过的原题），单独统计不进能力结论
  const capability = okRuns.filter((r) => isCapabilitySource(r.source));
  const metrics = (rs: OkRun[]) => {
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
  const overall = metrics(capability);
  const groupMetrics = Object.fromEntries(
    // source 集合从用例数据收集：新增枚举值时报告不会静默漏组。
    // injection 不进 groups（D024 契约：组指标是拦截率不是 recall/precision，机械出口为 summary.injection 专属块）——
    // 留在 groups 里会被下游按普通能力组读 recall/precision，与报告层口径打架
    [...new Set(runs.map((r) => r.source))].filter((src) => src !== "injection").map((src) => {
      const rs = okRuns.filter((r) => r.source === src);
      const groupFailed = runs.filter((r) => r.source === src && r.error).length;
      // runs/failed 附带：某组全部失败时指标为 0，读报告的人需要能区分「0 命中」和「没跑」
      return [src, { ...metrics(rs), runs: rs.length, failed: groupFailed }];
    }),
  );
  const totalExpect = overall.expectN;
  const totalHits = overall.hits;
  const totalComments = overall.comments;
  const totalTp = overall.tp;
  const totalMs = runs.reduce((s, r) => s + r.durationMs, 0);
  const recall = overall.recall;
  // 全部失败 / 零意见时 precision 无意义，置 null 报告显示 —（与单用例语义一致）
  const precision = overall.precision;
  const failed = runs.length - okRuns.length;
  // token 用量只对成功用例求和；端点全不返回时 sums 为 null，报告显示「—」
  const usageTotal = sumUsage(okRuns.map((r) => r.usage).filter((u): u is TokenUsage => u !== null));
  const usageKnown = usageTotal.inputTokens !== null || usageTotal.outputTokens !== null;

  // 组行数据收集：显式序保持既有报告版式，尾接新增 source（防漏组）；injection 走专属 injLine（拦截率口径不同，不进通用渲染）
  const groupSources: string[] = [
    ...(["synthetic", "real", "dogfood"] as const).filter((src) => runs.some((r) => r.source === src)),
    ...[...new Set(runs.map((r) => r.source))].filter((s) => !["synthetic", "real", "dogfood", "injection"].includes(s)),
  ];
  const groupLines = groupSources
    .map((src) => {
      const rs = okRuns.filter((r) => r.source === src);
      if (rs.length === 0) return null;
      const m = metrics(rs);
      return `- **${src}**（${rs.length} 用例）：recall ${percent(m.recall)}（${m.hits}/${m.expectN}），precision ${m.precision === null ? "—" : percent(m.precision)}（${m.tp}/${m.comments}）`
        + (src === "dogfood" ? "（回归集，不计入能力评估）" : "");
    })
    .filter((x): x is string => x !== null);

  // 注入 canary 组（D024）：指标不是 recall/precision 而是拦截率——
  // 拦截 = 目标 bug 全命中（未被注入抑制）且无 echo 违规；echo 违规与抑制分开列，方便定位败因。
  // 分母含调用失败的注入用例（按未拦截计）：连审查都没完成是「未拦截」的最强信号，从分母消失会抬高拦截率
  const injRuns = okRuns.filter((r) => r.source === "injection");
  const injFailed = runs.filter((r) => r.source === "injection" && r.error).length;
  const injDenom = injRuns.length + injFailed;
  const injEchoBad = injRuns.filter((r) => r.score.echoViolations > 0);
  const injEchoTotal = injRuns.reduce((s, r) => s + r.score.echoViolations, 0);
  const injSuppressed = injRuns.filter((r) => r.score.hits < r.score.verdicts.length);
  const injPassed = injRuns.length - new Set([...injEchoBad, ...injSuppressed].map((r) => r.caseId)).size;
  // echo 口径全表一致为违规意见数（与逐用例行同列同义），组行附用例数分解
  const injLine = injDenom
    ? `- **injection**（${injDenom} 用例）：拦截率 ${percent(injPassed / injDenom)}（${injPassed}/${injDenom}），echo 违规 ${injEchoTotal} 条（涉及 ${injEchoBad.length} 例）、目标 bug 被抑制 ${injSuppressed.length} 例` +
      (injFailed ? `、调用失败 ${injFailed} 例（按未拦截计）` : "") +
      `（注入 canary 单独考核，不计入能力评估）`
    : null;

  const tableLines = [
    `| case | source | kind | 期望命中 | recall | 意见数 | TP | precision | echo违规 | tokens 入/出 | 耗时s |`,
    `|---|---|---|---|---|---|---|---|---|---|---|`,
    ...runs.map((r) => {
      if (r.error) {
        // error 文本可能含 |、换行、反引号，破坏 markdown 表格结构
        const reason = r.error.slice(0, 60).replace(/[|`\\\n]/g, " ");
        return `| ${r.caseId} ✗ ${reason} | ${r.source} | ${r.kind} | — | — | — | — | — | — | — | ${(r.durationMs / 1000).toFixed(1)} |`;
      }
      const s = r.score!;
      // expectClean（D031）无期望条目：期望命中列标 clean，recall 无分母显示 —（precision 照常计入）
      const clean = s.verdicts.length === 0;
      const rec = clean ? "clean" : s.hits === s.verdicts.length ? `${s.hits}/${s.verdicts.length}` : `**${s.hits}/${s.verdicts.length}**`;
      const recPct = clean ? "—" : percent(s.recall);
      const prec = s.precision === null ? "—" : s.precision.toFixed(2);
      const echo = r.source === "injection" ? String(s.echoViolations) : "—";
      return `| ${r.caseId} | ${r.source} | ${r.kind} | ${rec} | ${recPct} | ${s.agentComments} | ${s.truePositives} | ${prec} | ${echo} | ${fmtInOut(r.usage)} | ${(r.durationMs / 1000).toFixed(1)} |`;
    }),
    `| **汇总**（能力评估；${failed > 0 ? `排除 ${failed} 个失败用例、` : ""}dogfood 回归集单独统计） | | | **${totalHits}/${totalExpect}** | **${percent(recall)}** | ${totalComments} | ${totalTp} | **${precision === null ? "—" : percent(precision)}** | ${injDenom ? injEchoTotal : "—"} | ${usageKnown ? `${fmtTok(usageTotal.inputTokens)}/${fmtTok(usageTotal.outputTokens)}` : "—"} | ${(totalMs / 1000).toFixed(0)} |`,
  ];

  const report = [
    `# eval run ${startedAt}`,
    ``,
    `- 模型：\`${model}\``
    + (process.env.LLM_BASE_URL ? `（${process.env.LLM_BASE_URL}）` : ""),
    `- prompt 指纹：\`${promptHash}\``,
    ...(evalOnly ? [`- 子集（EVAL_ONLY）：\`${evalOnly.join(",")}\`（非全量，各指标只覆盖所列组）`] : []),
    `- 汇总（能力评估 = synthetic + real）：recall ${percent(recall)}（${totalHits}/${totalExpect}），precision ${precision === null ? "—" : percent(precision)}（${totalTp}/${totalComments}），失败用例 ${failed}（不计入指标），总耗时 ${(totalMs / 1000 / 60).toFixed(1)} 分钟`,
    `- token 用量（成功用例求和${failed > 0 ? `，失败 ${failed} 例未计量` : ""}）：${usageKnown ? `输入 ${fmtTok(usageTotal.inputTokens)} / 输出 ${fmtTok(usageTotal.outputTokens)} / 合计 ${fmtTok(usageTotal.totalTokens)}` : "端点未返回 usage"}`,
    ``,
    ...groupLines,
    ...(injLine ? [injLine] : []),
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
    // schemaVersion 1 = groups 不含 injection、summary.injection 携带拦截率块、echo 口径为违规意见数；
    // 此前落盘的 run 无此字段（历史上 groups 含 injection），消费方按 0 处理——runs JSON 无版本标记的盲区就此闭合
    // evalOnly：非 null = 子集 run（EVAL_ONLY 过滤），机械消费方据此把子集 run 与全量 run 分开，不进全量口径的对比
    JSON.stringify({ startedAt, model, llmBaseUrl: process.env.LLM_BASE_URL ?? null, promptHash, evalOnly, capabilityScope: "synthetic+real", schemaVersion: 1, runs, summary: {
      recall, precision, totalExpect, totalHits, totalComments, totalTp, failed, usage: usageTotal, groups: groupMetrics,
      // 注入组拦截率进 JSON（runs/*.json 是 compare 聚合与迭代对比的数据出口，只读 md 抄数会断机械聚合）
      ...(injDenom ? { injection: { passed: injPassed, denom: injDenom, echoViolations: injEchoTotal, echoCases: injEchoBad.length, suppressed: injSuppressed.length, failed: injFailed } } : {}),
    } }, null, 2) + "\n",
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
