// 离线消融：跨模型交叉合并（issue #81）——零 LLM 调用，读存量 eval run 存档，按合并规则合成意见后用仓库判据重打分。
// 回放：node --import tsx evals/analyze-cross-review.ts（只读 evals/ 存档，markdown 报告块输出到 stdout，确定性可重放）
//
// 数据源（2026-11-06 时点，全部已入库）：
// - GLM-5.3@low ×3 轮全量 JSON（promptHash cd5353f4688c）：2026-11-04T15-22-44 / 15-38-18 / 15-49-04
// - DeepSeek@high 全量 JSON（promptHash 7be33f4d6fbc，LLM_JSON_MODE 适配——与 GLM 的 promptHash 不同，混杂因素见报告）：
//   2026-11-04T17-42-24-deepseek-flash.json = 三档并行覆盖事故后的幸存文件，经 token 总量 / 总耗时核对确认内容为 high 档
// - DeepSeek@disabled / @low：仅 stdout 流式日志（recovery-20261105-deepseek-tiers/）。事故后意见 body 不可恢复——
//   stdout 只有每例聚合计数（命中 / 意见数 / TP / tokens），**进不了意见级合并**：本脚本的解析器仅做
//   聚合计数提取与三方交叉校验（流式行 × markdown 表 × README 报告级数字 × high 档 JSON），并量化这一数据缺口
//
// 打分判据：直接 import evals/score.ts（matchesExpectation / scoreCase / normalizePath / sourceOf），
// 与 npm run eval 完全同源，不在本脚本内复刻。
import { readFileSync } from "node:fs";
import { loadCases } from "./cases/index.ts";
import { matchesExpectation, normalizePath, scoreCase, sourceOf, type CaseScore, type EvalCase } from "./score.ts";

// ---------------------------------------------------------------- 基础类型

type Sev = "blocker" | "major" | "minor" | "nit";
type RawComment = { file: string; line: number; severity: Sev; body: string };
type StoredRun = {
  caseId: string;
  kind: string;
  source: string;
  error: string | null;
  comments: RawComment[];
  durationMs: number;
  score: { hits: number; recall: number | null; agentComments: number; truePositives: number; precision: number | null; echoViolations: number } | null;
};

const SEV_RANK: Record<Sev, number> = { blocker: 3, major: 2, minor: 1, nit: 0 };
const isSev = (s: string): s is Sev => s === "blocker" || s === "major" || s === "minor" || s === "nit";
const isMajorPlus = (c: RawComment): boolean => c.severity === "blocker" || c.severity === "major";

function loadRun(file: string): Map<string, StoredRun> {
  const j = JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")) as { runs: StoredRun[] };
  const out = new Map<string, StoredRun>();
  for (const r of j.runs) {
    for (const c of r.comments) {
      if (!isSev(c.severity)) throw new Error(`${file} ${r.caseId}: 未知 severity ${c.severity}`);
    }
    out.set(r.caseId, r);
  }
  return out;
}

// ---------------------------------------------------------------- 词重叠判据（课程 §八移植 + 本数据再校准）

// token = 拉丁词（小写、长度>3，吃进代码标识符）+ CJK 字符 bigram（中文没有词边界，bigram 是最小可靠单元）。
// 课程原版判据是词集交并比（Jaccard，阈值 0.4/0.5 为英文校准）；本脚本用同批数据实测：
// Jaccard 在中文意见对上完全失效（同发现对 median 0.15，无一达到 0.4）——阈值 0.4/0.5 保持课程原值不变，
// 度量换为重叠系数 |A∩B|/min(|A|,|B|)（对称，课程「双向」校验在对称度量下退化为单值），
// 校准轮（GLM 15-38-18 × DS high，同文件对）同发现对捕获 38% / 异发现对误配 2%。
export function tokens(body: string): Set<string> {
  const out = new Set<string>();
  const lower = body.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_]+/g)) if (m[0].length > 3) out.add(m[0]);
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      out.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

export function overlap(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

const sameFile = (a: RawComment, b: RawComment): boolean => normalizePath(a.file) === normalizePath(b.file);

// ---------------------------------------------------------------- 合并策略一：课程四步（docs/plans/ai-code-review-course.md §四/§八）

export function mergeCourse4(A: RawComment[], B: RawComment[]): RawComment[] {
  const out: RawComment[] = [];
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  // ① 双模型一致（同文件 + 词重叠>0.4）：保留更详细一条（body 更长视为更详细）
  for (let i = 0; i < A.length; i++) {
    let matched = -1;
    for (let j = 0; j < B.length; j++) {
      if (usedB.has(j)) continue;
      if (sameFile(A[i], B[j]) && overlap(A[i].body, B[j].body) > 0.4) {
        matched = j;
        break;
      }
    }
    if (matched >= 0) {
      usedA.add(i);
      usedB.add(matched);
      out.push(A[i].body.length >= B[matched].body.length ? A[i] : B[matched]);
    }
  }
  // ② 有界召回兜底：每模型最多补 1 条对方没有的 major/blocker
  const aExtra = A.find((c, i) => !usedA.has(i) && isMajorPlus(c));
  if (aExtra) out.push(aExtra);
  const bExtra = B.find((c, j) => !usedB.has(j) && isMajorPlus(c));
  if (bExtra) out.push(bExtra);
  // ③ severity floor：课程 low 级全丢 → 本项目四级映射为丢 minor/nit
  const floored = out.filter(isMajorPlus);
  // ④ 激进去重：词重叠>0.5（同文件）去重，保留先出现者
  const kept: RawComment[] = [];
  for (const c of floored) {
    if (!kept.some((k) => sameFile(k, c) && overlap(k.body, c.body) > 0.5)) kept.push(c);
  }
  return kept;
}

// ---------------------------------------------------------------- 合并策略二：保守合并（pr-agent 口径，issue #74 设计要点）

// 合并对 = 完全同 file:line + 词重叠>0.4；severity 取更严（pr-agent「merged verdict is deliberately never
// less alarming than the worst chunk」——本 schema 意见无 security 独立字段，security 任一报忧则忧退化为
// severity 取更严，tie 时保留更详细 body）；不激进去重：未配对意见原样并集保留，无 severity floor（minor/nit 留存）。
export function mergeConservative(A: RawComment[], B: RawComment[]): RawComment[] {
  const out: RawComment[] = [];
  const usedB = new Set<number>();
  for (const a of A) {
    let matched = -1;
    for (let j = 0; j < B.length; j++) {
      if (usedB.has(j)) continue;
      if (sameFile(a, B[j]) && a.line === B[j].line && overlap(a.body, B[j].body) > 0.4) {
        matched = j;
        break;
      }
    }
    if (matched >= 0) {
      usedB.add(matched);
      const b = B[matched];
      if (SEV_RANK[a.severity] !== SEV_RANK[b.severity]) {
        out.push(SEV_RANK[a.severity] > SEV_RANK[b.severity] ? a : b);
      } else {
        out.push(a.body.length >= b.body.length ? a : b);
      }
    } else {
      out.push(a);
    }
  }
  for (let j = 0; j < B.length; j++) if (!usedB.has(j)) out.push(B[j]);
  return out;
}

// ---------------------------------------------------------------- DeepSeek stdout 解析器（disabled / low 档，聚合计数）

export type ParsedCaseAgg = {
  caseId: string;
  source: string;
  hits: number;
  expectN: number;
  comments: number;
  tp: number;
  echoViolations: number;
};

export function parseStdoutLog(text: string): Map<string, ParsedCaseAgg> {
  const out = new Map<string, ParsedCaseAgg>();
  const lines = text.split("\n");
  // 流式行（边界标记）：`[N/71] <caseId> ...` 后跟 `命中 X/Y，Z 条意见，...` / `clean（FP 对照），Z 条意见，...`
  const stream = new Map<string, { hits: number; expectN: number; comments: number }>();
  let pending: string | null = null;
  for (const line of lines) {
    const start = line.match(/^\[\d+\/\d+\] ([a-z0-9-]+) /);
    if (start) {
      pending = start[1];
      continue;
    }
    if (!pending) continue;
    const hit = line.match(/^命中 (\d+)\/(\d+)，(\d+) 条意见/);
    const clean = line.startsWith("clean（FP 对照）");
    if (hit) {
      stream.set(pending, { hits: Number(hit[1]), expectN: Number(hit[2]), comments: Number(hit[3]) });
      pending = null;
    } else if (clean) {
      const n = Number(line.match(/，(\d+) 条意见/)?.[1] ?? NaN);
      if (Number.isNaN(n)) throw new Error(`stdout clean 行解析失败：${line}`);
      stream.set(pending, { hits: 0, expectN: 0, comments: n });
      pending = null;
    }
  }
  // markdown 全量表（每例一行，含 TP / echo / source）
  let inTable = false;
  for (const line of lines) {
    if (line.startsWith("| case |")) {
      inTable = true;
      continue;
    }
    if (!inTable || !line.startsWith("|")) {
      if (inTable) inTable = false;
      continue;
    }
    const cells = line.split("|").map((s) => s.trim());
    // ['', case, source, kind, hits, recall, comments, tp, precision, echo, tokens, dur, '']
    // 表尾还有汇总行（**汇总**…）与分隔行，一律按 caseId 形状过滤
    if (cells.length < 13 || !/^[a-z0-9]+(-[a-z0-9]+)+$/.test(cells[1])) continue;
    const caseId = cells[1];
    if (cells[4] === "✗ 出错" || cells[4].startsWith("✗")) throw new Error(`stdout 表含错误用例（README 称 0 错误）: ${caseId}`);
    let hits: number;
    let expectN: number;
    const hitCell = cells[4].replaceAll("**", ""); // miss 行加粗 **0/1**
    if (hitCell === "clean") {
      hits = 0;
      expectN = 0;
    } else {
      const m = hitCell.match(/^(\d+)\/(\d+)$/);
      if (!m) throw new Error(`stdout 表期望命中列解析失败：${line}`);
      hits = Number(m[1]);
      expectN = Number(m[2]);
    }
    const comments = Number(cells[6]);
    const tp = Number(cells[7]);
    const echo = cells[9] === "—" ? 0 : Number(cells[9]);
    if ([comments, tp, echo].some(Number.isNaN)) throw new Error(`stdout 表数值列解析失败：${line}`);
    const prev = out.get(caseId);
    if (prev) throw new Error(`stdout 表重复用例：${caseId}`);
    out.set(caseId, { caseId, source: cells[2], hits, expectN, comments, tp, echoViolations: echo });
  }
  // 交叉校验：流式行 ⊆ 表，且计数一致
  for (const [caseId, s] of stream) {
    const t = out.get(caseId);
    if (!t) throw new Error(`流式行 caseId ${caseId} 不在 markdown 表中`);
    if (t.comments !== s.comments || t.hits !== s.hits || t.expectN !== s.expectN) {
      throw new Error(`流式行与 markdown 表不一致 ${caseId}: 表(${t.hits}/${t.expectN},${t.comments}条) vs 流(${s.hits}/${s.expectN},${s.comments}条)`);
    }
  }
  if (stream.size !== out.size) throw new Error(`流式行 ${stream.size} 例 != 表 ${out.size} 例（流式边界标记漏识别）`);
  return out;
}

// ---------------------------------------------------------------- 聚合

type CaseMeta = { source: string };
const GROUPS = ["synthetic", "real", "correlation", "repo", "incremental", "dogfood", "injection"] as const;
type Round = Map<string, CaseScore>;

function micro(rounds: Round[], metas: Map<string, CaseMeta>, srcFilter: (src: string) => boolean): { recall: number | null; precision: number | null; expectN: number; hits: number; comments: number; tp: number } {
  let expectN = 0;
  let hits = 0;
  let comments = 0;
  let tp = 0;
  for (const r of rounds) {
    for (const [caseId, s] of r) {
      if (!srcFilter(metas.get(caseId)!.source)) continue;
      expectN += s.verdicts.length;
      hits += s.hits;
      comments += s.agentComments;
      tp += s.truePositives;
    }
  }
  return {
    recall: expectN ? hits / expectN : null,
    precision: comments ? tp / comments : null,
    expectN,
    hits,
    comments,
    tp,
  };
}

const fmt = (v: number | null, pct = true): string => (v === null ? "—" : pct ? `${(v * 100).toFixed(1)}%` : v.toFixed(2));

// 每例跨轮池化（3 轮合并统计），用于 per-case 胜负：recall = Σhits/Σexpect；precision = Σtp/Σcomments（0 意见 = null）
function pooledPerCase(rounds: Round[]): Map<string, { recall: number; precision: number | null }> {
  const acc = new Map<string, { hits: number; expectN: number; comments: number; tp: number }>();
  for (const r of rounds) {
    for (const [caseId, s] of r) {
      const a = acc.get(caseId) ?? { hits: 0, expectN: 0, comments: 0, tp: 0 };
      a.hits += s.hits;
      a.expectN += s.verdicts.length;
      a.comments += s.agentComments;
      a.tp += s.truePositives;
      acc.set(caseId, a);
    }
  }
  const out = new Map<string, { recall: number; precision: number | null }>();
  for (const [caseId, a] of acc) {
    out.set(caseId, {
      recall: a.expectN ? a.hits / a.expectN : 1,
      precision: a.comments ? a.tp / a.comments : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- 主流程

const cases = await loadCases();
const byId = new Map(cases.map((c) => [c.id, c]));
const metas = new Map<string, CaseMeta>(cases.map((c) => [c.id, { source: sourceOf(c) }]));

const GLM_FILES = ["2026-11-04T15-22-44-glm-5.3.json", "2026-11-04T15-38-18-glm-5.3.json", "2026-11-04T15-49-04-glm-5.3.json"];
const DS_HIGH_FILE = "2026-11-04T17-42-24-deepseek-flash.json";
// D036 触发 run（2026-11-06 夜补数据）：DeepSeek@low 全量新鲜 run，意见 body 完整——主对（GLM@low × DS@low）消融解锁。
// promptHash 7be33f4d6fbc 与三档实验同口径（LLM_JSON_MODE 适配）；extraBody = enabled + reasoning_effort:low（低思考档）
const DS_LOW_FRESH_FILE = "2026-11-05T15-52-26-deepseek-flash-7be33f4d6fbc-690926.json";
// cheap-pair（用户提案：glm-flash + deepseek-flash，2026-11-06 夜）：两侧均便宜档、均旧 prompt 时代
//（GLM flash cd5353f4688c 无 json-mode / DS disabled 7be33f4d6fbc 有 json-mode 适配——混杂因素同 §混杂），
// 各 3 轮（GLM flash: 16-22/16-36/16-48；DS disabled: 16-16/16-36/16-48——r2 同秒启动不同模型名不互覆）
const GLM_FLASH_FILES = [
  "2026-11-05T16-22-50-glm-5.3-flash-cd5353f4688c-b5870a.json",
  "2026-11-05T16-36-46-glm-5.3-flash-cd5353f4688c-b5870a.json",
  "2026-11-05T16-48-23-glm-5.3-flash-cd5353f4688c-b5870a.json",
];
const DS_DISABLED_FILES = [
  "2026-11-05T16-16-46-deepseek-flash-7be33f4d6fbc-b5870a.json",
  "2026-11-05T16-36-46-deepseek-flash-7be33f4d6fbc-b5870a.json",
  "2026-11-05T16-48-23-deepseek-flash-7be33f4d6fbc-b5870a.json",
];

const glmRuns = GLM_FILES.map((f) => loadRun(`runs/${f}`));
const dsHigh = loadRun(`runs/${DS_HIGH_FILE}`);
const dsLowFresh = loadRun(`runs/${DS_LOW_FRESH_FILE}`);
const glmFlashRounds = GLM_FLASH_FILES.map((f) => loadRun(`runs/${f}`));
const dsDisabledRounds = DS_DISABLED_FILES.map((f) => loadRun(`runs/${f}`));

// 用例集一致性：存档 run 落盘时点（2026-11-04）早于当前用例目录（D035 inj-08 后 72 例）——
// 口径 = 存档交集（71 例），缺的用例点名（回放者可复核差异来源）
const runCaseSets = [...glmRuns, dsHigh];
const caseIds = cases.map((c) => c.id).filter((id) => runCaseSets.every((r) => r.has(id)));
const missing = cases.map((c) => c.id).filter((id) => runCaseSets.some((r) => !r.has(id)));
for (const [gi, r] of glmRuns.entries()) {
  if (r.size !== caseIds.length) throw new Error(`GLM 轮 ${GLM_FILES[gi]} 用例数 ${r.size} != 交集 ${caseIds.length}`);
}
if (dsHigh.size !== caseIds.length) throw new Error(`DS high 用例数 ${dsHigh.size} != 交集 ${caseIds.length}`);
if (missing.length > 0) console.log(`> 用例集：存档 run 71 例（当前用例目录 ${cases.length} 例，不在存档内的：${missing.join("、")}——口径取交集）`);
else console.log(`> 用例集：${caseIds.length} 例全对齐`);

// 打分一个 run（comments → scoreCase，与 npm run eval 同源判据）
function scoreStored(runs: Map<string, StoredRun>): Round {
  const out: Round = new Map();
  for (const id of caseIds) {
    const r = runs.get(id)!;
    if (r.error) throw new Error(`意外错误 run: ${id}`);
    out.set(id, scoreCase(byId.get(id)!, r.comments));
  }
  return out;
}

// ---- 校验 1：基线重算 == run 内嵌 score（证明 import 判据与 eval 打分同源）
let baselineMismatch = 0;
for (const [gi, runs] of glmRuns.entries()) {
  const scored = scoreStored(runs);
  for (const id of caseIds) {
    const emb = runs.get(id)!.score!;
    const s = scored.get(id)!;
    if (emb.hits !== s.hits || emb.agentComments !== s.agentComments || emb.truePositives !== s.truePositives || Math.abs((emb.recall ?? 0) - s.recall) > 1e-9) {
      baselineMismatch++;
      console.error(`!! 内嵌 score 不一致 ${GLM_FILES[gi]} ${id}`);
    }
  }
}
const dsScored = scoreStored(dsHigh);
for (const id of caseIds) {
  const emb = dsHigh.get(id)!.score!;
  const s = dsScored.get(id)!;
  if (emb.hits !== s.hits || emb.agentComments !== s.agentComments || emb.truePositives !== s.truePositives) {
    baselineMismatch++;
    console.error(`!! 内嵌 score 不一致 DS-high ${id}`);
  }
}
console.log(`> 校验1 基线重算 vs 内嵌 score：${baselineMismatch === 0 ? "一致（判据同源确认）" : `${baselineMismatch} 处不一致`}`);

// ---- 校验 2：DeepSeek stdout 解析（disabled/low）× README 报告级数字
const README_TIERS: Record<string, { capHits: number; capExpect: number; capPrecision: number; capComments: number; file: string }> = {
  disabled: { capHits: 30, capExpect: 35, capPrecision: 0.868, capComments: null as unknown as number, file: "runs/recovery-20261105-deepseek-tiers/disabled-stdout.log" },
  low: { capHits: 32, capExpect: 35, capPrecision: 0.825, capComments: null as unknown as number, file: "runs/recovery-20261105-deepseek-tiers/low-stdout.log" },
};
README_TIERS.disabled.capComments = 23; // 86.8% → README 分母未印；用 high 档同法从表内推出，校验改为按 hits/expect + precision 舍入一致
README_TIERS.low.capComments = 40; // 82.5% (33/40)

for (const [tier, cfg] of Object.entries(README_TIERS)) {
  const agg = parseStdoutLog(readFileSync(new URL(cfg.file, import.meta.url), "utf8"));
  if (agg.size !== caseIds.length) throw new Error(`${tier} 解析用例数 ${agg.size} != ${caseIds.length}`);
  const cap = [...agg.values()].filter((a) => a.source === "synthetic" || a.source === "real");
  const hits = cap.reduce((s, a) => s + a.hits, 0);
  const expectN = cap.reduce((s, a) => s + a.expectN, 0);
  const comments = cap.reduce((s, a) => s + a.comments, 0);
  const tp = cap.reduce((s, a) => s + a.tp, 0);
  const okHits = hits === cfg.capHits && expectN === cfg.capExpect;
  const okPrec = Math.abs(tp / comments - cfg.capPrecision) < 0.005;
  console.log(`> 校验2 DeepSeek@${tier} stdout 解析：能力口径 ${hits}/${expectN}（README ${cfg.capHits}/${cfg.capExpect}）${okHits ? "一致" : "不一致!!"}；precision ${(tp / comments * 100).toFixed(1)}%（README ${(cfg.capPrecision * 100).toFixed(1)}%）${okPrec ? "一致" : "不一致!!"}`);
}

// high 档：stdout 表 vs 幸存 JSON（最强语义校验——同一档位两种载体逐例对账）
{
  const agg = parseStdoutLog(readFileSync(new URL("runs/recovery-20261105-deepseek-tiers/high-stdout.log", import.meta.url), "utf8"));
  let mism = 0;
  for (const id of caseIds) {
    const a = agg.get(id)!;
    const s = dsScored.get(id)!;
    if (a.hits !== s.hits || a.expectN !== s.verdicts.length || a.comments !== s.agentComments || a.tp !== s.truePositives) mism++;
  }
  console.log(`> 校验3 DeepSeek@high stdout 表 vs 幸存 JSON 逐例对账：${mism === 0 ? "71/71 一致（解析语义确认）" : `${mism} 例不一致!!`}`);
}

// ---- 校准：重叠度量在真值标签上的分离度（可重放：每次运行重算）
{
  const glm = glmRuns[1]; // 校准轮 = 15-38-18（中位轮）
  let posJ = 0;
  let negJ = 0;
  let posN = 0;
  let negN = 0;
  let posJaccard: number[] = [];
  for (const id of caseIds) {
    const c = byId.get(id)!;
    const gr = glm.get(id)!;
    const dr = dsHigh.get(id)!;
    for (const a of gr.comments) {
      for (const b of dr.comments) {
        if (!sameFile(a, b)) continue;
        const sameFinding = c.expect.some((e) => matchesExpectation(e, a) && matchesExpectation(e, b));
        if (overlap(a.body, b.body) > 0.4) sameFinding ? posN++ : negN++;
        // Jaccard 对照（课程原版度量）
        const A = tokens(a.body);
        const B = tokens(b.body);
        let inter = 0;
        for (const w of A) if (B.has(w)) inter++;
        const jac = A.size + B.size ? inter / (A.size + B.size - inter) : 1;
        if (jac > 0.4) sameFinding ? posJ++ : negJ++;
        if (sameFinding) posJaccard.push(jac);
      }
    }
  }
  posJaccard.sort((x, y) => x - y);
  console.log(
    `> 校准 重叠系数>0.4：同发现对 ${posN} / 异发现对 ${negN}；课程原版 Jaccard>0.4：同发现对 ${posJ} / 异发现对 ${negJ}` +
      `（Jaccard 同发现对 median ${posJaccard.length ? posJaccard[Math.floor(posJaccard.length / 2)].toFixed(2) : "n/a"}，阈值不迁移实证）`,
  );
}

// ---------------------------------------------------------------- 口径计算

function injectStatus(rounds: Round[]): { intercepted: number; echoCases: number; suppressed: number; total: number } {
  let intercepted = 0;
  let echoCases = 0;
  let suppressed = 0;
  let total = 0;
  for (const id of caseIds) {
    if (metas.get(id)!.source !== "injection") continue;
    total++;
    const ss = rounds.map((r) => r.get(id)!);
    if (ss.every((s) => s.echoViolations === 0)) continue; // 任一轮有 echo 即计 echo 例
    echoCases++;
  }
  // 拦截 = 每轮目标 bug 全命中且无 echo（与 run.ts 口径一致）；抑制 = 目标 bug 该报未报
  for (const id of caseIds) {
    if (metas.get(id)!.source !== "injection") continue;
    const ss = rounds.map((r) => r.get(id)!);
    const allHit = ss.every((s) => s.verdicts.every((v) => v.hit));
    const anyEcho = ss.some((s) => s.echoViolations > 0);
    if (allHit && !anyEcho) intercepted++;
    if (!allHit) suppressed++;
  }
  return { intercepted, echoCases, suppressed, total };
}

type Approach = { key: string; label: string; rounds: Round[] };
const capFilter = (src: string): boolean => src === "synthetic" || src === "real";

const approaches: Approach[] = [
  { key: "glm-low", label: "GLM-5.3@low 单模型（基线）", rounds: glmRuns.map(scoreStored) },
  { key: "ds-high", label: "DeepSeek@high 单模型（对照）", rounds: [dsScored] },
  {
    key: "course4",
    label: "交叉合并·课程四步（GLM@low × DS@high）",
    rounds: glmRuns.map((runs) => {
      const out: Round = new Map();
      for (const id of caseIds) out.set(id, scoreCase(byId.get(id)!, mergeCourse4(runs.get(id)!.comments, dsHigh.get(id)!.comments)));
      return out;
    }),
  },
  {
    key: "conservative",
    label: "交叉合并·保守 pr-agent 口径（GLM@low × DS@high）",
    rounds: glmRuns.map((runs) => {
      const out: Round = new Map();
      for (const id of caseIds) out.set(id, scoreCase(byId.get(id)!, mergeConservative(runs.get(id)!.comments, dsHigh.get(id)!.comments)));
      return out;
    }),
  },
  {
    key: "course4-low",
    label: "交叉合并·课程四步（GLM@low × DS@low 触发run）",
    rounds: glmRuns.map((runs) => {
      const out: Round = new Map();
      for (const id of caseIds) out.set(id, scoreCase(byId.get(id)!, mergeCourse4(runs.get(id)!.comments, dsLowFresh.get(id)!.comments)));
      return out;
    }),
  },
  {
    key: "conservative-low",
    label: "交叉合并·保守 pr-agent 口径（GLM@low × DS@low 触发run）",
    rounds: glmRuns.map((runs) => {
      const out: Round = new Map();
      for (const id of caseIds) out.set(id, scoreCase(byId.get(id)!, mergeConservative(runs.get(id)!.comments, dsLowFresh.get(id)!.comments)));
      return out;
    }),
  },
  { key: "glm-flash", label: "glm-flash@disabled 单模型（cheap-pair 前半，3 轮池化）", rounds: glmFlashRounds.map(scoreStored) },
  { key: "ds-disabled", label: "DS@disabled 单模型（cheap-pair 后半，3 轮池化）", rounds: dsDisabledRounds.map(scoreStored) },
  {
    key: "course4-cheappair",
    label: "交叉合并·课程四步（glm-flash × DS@disabled，按轮配对池化）",
    rounds: glmFlashRounds.map((runs, i) => {
      const out: Round = new Map();
      const ds = dsDisabledRounds[i]!;
      for (const id of caseIds) out.set(id, scoreCase(byId.get(id)!, mergeCourse4(runs.get(id)!.comments, ds.get(id)!.comments)));
      return out;
    }),
  },
  {
    key: "conservative-cheappair",
    label: "交叉合并·保守 pr-agent 口径（glm-flash × DS@disabled，按轮配对池化）",
    rounds: glmFlashRounds.map((runs, i) => {
      const out: Round = new Map();
      const ds = dsDisabledRounds[i]!;
      for (const id of caseIds) out.set(id, scoreCase(byId.get(id)!, mergeConservative(runs.get(id)!.comments, ds.get(id)!.comments)));
      return out;
    }),
  },
];

console.log("\n## 主表：approach × recall / precision（全量 71 例 = 3 轮池化；能力口径 = synthetic+real）\n");
console.log("| approach | 全量 recall | 全量 precision | 能力 recall | 能力 precision | 意见总数 |");
console.log("|---|---|---|---|---|---|");
for (const a of approaches) {
  const all = micro(a.rounds, metas, () => true);
  const cap = micro(a.rounds, metas, capFilter);
  const comments = a.rounds.reduce((s, r) => s + [...r.values()].reduce((x, v) => x + v.agentComments, 0), 0);
  console.log(`| ${a.label} | ${fmt(all.recall)} | ${fmt(all.precision)} | ${fmt(cap.recall)} | ${fmt(cap.precision)} | ${comments} |`);
}

console.log("\n### 分组 recall（微平均）\n");
console.log("| 组 | " + approaches.map((a) => a.label).join(" | ") + " |");
console.log("|---" + "|---".repeat(approaches.length) + "|");
for (const g of GROUPS) {
  const cells = approaches.map((a) => {
    const m = micro(a.rounds, metas, (src) => src === g);
    return `${fmt(m.recall)}（p ${fmt(m.precision)}）`;
  });
  console.log(`| ${g} | ${cells.join(" | ")} |`);
}
console.log("\n> 分组注：injection 行 recall = 注入例目标 bug 命中（拦截见下）；dogfood 为回归集不计能力口径。");

console.log("\n### injection canary（合并后红线复核）\n");
for (const a of approaches) {
  const st = injectStatus(a.rounds);
  console.log(`- ${a.label}：拦截 ${st.intercepted}/${st.total}，echo 违规例 ${st.echoCases}，目标被抑制例 ${st.suppressed}`);
}

console.log("\n## per-case 胜负（合并 vs GLM@low 单模型；3 轮池化后按 recall→precision 字典序比较，只列非平局例）\n");
const basePooled = pooledPerCase(approaches[0].rounds);
for (const a of approaches.slice(2)) {
  const pooled = pooledPerCase(a.rounds);
  const cmp = (x: number | null, y: number | null): number => {
    const xv = x ?? 0;
    const yv = y ?? 0;
    return xv > yv ? 1 : xv < yv ? -1 : 0;
  };
  const rows: string[] = [];
  let win = 0;
  let tie = 0;
  let loss = 0;
  for (const id of caseIds) {
    const b = basePooled.get(id)!;
    const m = pooled.get(id)!;
    const r = cmp(m.recall, b.recall);
    const p = cmp(m.precision, b.precision);
    const verdict = r !== 0 ? r : p;
    if (verdict === 0) {
      tie++;
      continue;
    }
    if (verdict > 0) win++;
    else loss++;
    rows.push(`| ${id} | ${fmt(b.recall)}→${fmt(m.recall)} | ${fmt(b.precision)}→${fmt(m.precision)} | ${verdict > 0 ? "win" : "loss"} |`);
  }
  console.log(`### ${a.label}：win ${win} / tie ${tie} / loss ${loss}\n`);
  console.log("| case | recall 基线→合并 | precision 基线→合并 | 判定 |");
  console.log("|---|---|---|---|");
  for (const row of rows) console.log(row);
  console.log("");
}

console.log("\n## GLM 三轮各自读数（基线 vs 课程四步合并，全量 71 例）\n");
console.log("| 轮 | GLM@low recall/precision | 课程四步 recall/precision | 保守合并 recall/precision |");
console.log("|---|---|---|---|");
for (let gi = 0; gi < GLM_FILES.length; gi++) {
  const cells = approaches
    .filter((a) => a.key !== "ds-high")
    .map((a) => {
      const m = micro([a.rounds[gi]], metas, () => true);
      return `${fmt(m.recall)} / ${fmt(m.precision)}`;
    });
  console.log(`| ${GLM_FILES[gi].replace("2026-11-04T", "").replace("-glm-5.3.json", "")} | ${cells.join(" | ")} |`);
}

console.log("\n> 数据缺口：GLM@low × DeepSeek@disabled / @low 的意见级合并不可计算——两档意见 body 在覆盖事故中丢失，");
console.log("> stdout 仅存每例聚合计数（本脚本已解析并三方校验），无法执行任何依赖意见文本/定位/级别的合并规则。");

// ---- 数据缺口的可计算部分：GLM@low × DS@low / @disabled 的合并 recall 上界（union 上界）
// 合并后的意见 ⊆ 两模型意见并集 ⇒ 合并命中 ≤ 并集命中。stdout 只给每例命中计数（x/y），
// 单期望例（verdicts.length==1）x∈{0,1} 即该期望是否命中 ⇒ 并集命中可精确计算。
// 多期望例与全部 precision 无法界定——上界只在单期望例子集上成立，口径必须带 coverage 标注。
{
  const bound = (tier: string): string => {
    const agg = parseStdoutLog(readFileSync(new URL(`runs/recovery-20261105-deepseek-tiers/${tier}-stdout.log`, import.meta.url), "utf8"));
    let covered = 0;
    let baseHits = 0;
    let unionHits = 0;
    let expectN = 0;
    for (const id of caseIds) {
      const c = byId.get(id)!;
      if (c.expect.length !== 1) continue;
      const ds = agg.get(id);
      if (!ds || ds.expectN !== 1) continue;
      covered++;
      expectN += 3; // 3 轮 GLM
      for (const runs of glmRuns) {
        const s = scoreCase(c, runs.get(id)!.comments);
        baseHits += s.hits;
        unionHits += s.hits + (s.hits === 0 ? ds.hits : 0); // GLM 未中则 DS 的 x∈{0,1} 决定并集是否中
      }
    }
    return `单期望例 ${covered}/${caseIds.length}：GLM@low ${(baseHits / expectN * 100).toFixed(1)}% → 并集上界 ${(unionHits / expectN * 100).toFixed(1)}%（+${((unionHits - baseHits) / expectN * 100).toFixed(1)}pp）`;
  };
  console.log(`> 缺口量化 GLM@low × DS@low 合并 recall 上界（union 上界，全量口径）：${bound("low")}`);
  console.log(`> 缺口量化 GLM@low × DS@disabled 同法：${bound("disabled")}`);
}
