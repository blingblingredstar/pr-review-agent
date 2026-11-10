// 离线消融：按方面拆分 A/B 对照（issue #127）——零 LLM 调用，读存量 eval run 存档。
// A = 现生产 prompt 单遍（多方面清单）；B = 按方面拆 N 遍（每遍全量 diff，aspect 后缀 prompt），
// 合并规则沿用 evals/analyze-cross-review.ts 已实现的两套（保守合并 / 课程四步，D036）+ 原样并集，
// 不新写合并逻辑。回放：node --import tsx evals/analyze-aspect-split.ts <A-run.json> <B1.json> <B2.json> ...
// （首个参数为 A 臂，其余为 B 臂的 N 遍 aspect run——JSON 内 aspectArm.name 自描述，缺标记即报错）
//
// 口径注意：injection 组不进 A/B 对照——B 臂的「其余方面不报」是设计内合法范围限定，注入组的期望意见会被它
// 按设计压制（与注入攻击的抑制不可区分），对照读数会失真；echo 回显违规单独一行报告。
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadCases } from "./cases/index.ts";
import { isCapabilitySource, scoreCase, sourceOf } from "./score.ts";
import { mergeConservative, mergeCourse4, type RawComment } from "./merge-rules.ts";

type StoredRun = {
  caseId: string;
  source: string;
  error: string | null;
  comments: RawComment[];
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null; cachedInputTokens?: number | null } | null;
  score: { hits: number; agentComments: number; truePositives: number; echoViolations: number } | null;
};

// 路径解析：先按 cwd 相对（终端回放的自然形态），不存在再按 evals/ 相对（与 analyze-cross-review 同款）
function runUrl(file: string): URL {
  const cwdAttempt = pathToFileURL(`${process.cwd()}/${file}`);
  if (existsSync(cwdAttempt)) return cwdAttempt;
  return new URL(file, import.meta.url);
}

function loadRun(file: string): Map<string, StoredRun> {
  const j = JSON.parse(readFileSync(runUrl(file), "utf8")) as { runs: StoredRun[]; aspectArm?: { name?: string } | null };
  if (bSide(file) && !j.aspectArm?.name) throw new Error(`${file}: aspect run 缺 aspectArm 标记（传成基线 run 了？）`);
  const out = new Map<string, StoredRun>();
  for (const r of j.runs) out.set(r.caseId, r);
  return out;
}
const bSide = (file: string): boolean => process.argv.slice(3).includes(file);

// N 遍折叠合并：二元 merge 逐轮左折叠 merge(merge(p1,p2),p3)——保守合并的未配对保留语义使折叠结果
// ≈ N 路 union+配对去重；课程四步的 severity floor 使折叠结果 ≈ N 路一致化提取
function foldN(merge: (a: RawComment[], b: RawComment[]) => RawComment[], lists: RawComment[][]): RawComment[] {
  return lists.reduce((acc, cur) => merge(acc, cur));
}

const cases = await loadCases();
const [aFile, ...bFiles] = process.argv.slice(2);
if (!aFile || bFiles.length === 0) {
  console.error("用法：node --import tsx evals/analyze-aspect-split.ts <A-run.json> <B1.json> <B2.json> ...");
  process.exit(1);
}
const A = loadRun(aFile);
const Bs = bFiles.map(loadRun);

type Line = {
  label: string;
  recall: number | null; precision: number | null; f1: number | null;
  hits: number; expectN: number; comments: number; tp: number;
  tokensIn: number | null; tokensOut: number | null; tokensCached: number | null;
};

function evaluate(label: string, getComments: (caseId: string) => RawComment[], sumBTokens: boolean): Line {
  let hits = 0, expectN = 0, comments = 0, tp = 0;
  let inTok = 0, outTok = 0, cached = 0, anyTok = false;
  for (const c of cases) {
    if (!isCapabilitySource(sourceOf(c))) continue;
    expectN += scoreCase(c, []).verdicts.length;
    const s = scoreCase(c, getComments(c.id));
    hits += s.hits;
    comments += s.agentComments;
    tp += s.truePositives;
    if (sumBTokens) {
      for (const b of Bs) {
        const r = b.get(c.id);
        if (r && !r.error && r.usage) {
          anyTok = true;
          inTok += r.usage.inputTokens ?? 0;
          outTok += r.usage.outputTokens ?? 0;
          cached += r.usage.cachedInputTokens ?? 0;
        }
      }
    }
  }
  const recall = expectN ? hits / expectN : null;
  const precision = comments ? tp / comments : null;
  const f1 = recall !== null && precision !== null && recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : null;
  return { label, recall, precision, f1, hits, expectN, comments, tp, tokensIn: anyTok ? inTok : null, tokensOut: anyTok ? outTok : null, tokensCached: anyTok ? cached : null };
}

const lines: Line[] = [
  evaluate("A 单遍（现生产 prompt）", (id) => A.get(id)?.comments ?? [], false),
  evaluate("B union（N 遍原样并集，跨遍重复不折）", (id) => Bs.flatMap((b) => b.get(id)?.comments ?? []), true),
  evaluate("B 保守合并（pr-agent 口径）", (id) => foldN(mergeConservative, Bs.map((b) => b.get(id)?.comments ?? [])), true),
  evaluate("B 课程四步（severity floor + 激进去重）", (id) => foldN(mergeCourse4, Bs.map((b) => b.get(id)?.comments ?? [])), true),
];

// injection echo：B 臂各遍的回显违规合计（对照口径外，单独记档）
let echoTotal = 0;
for (const b of Bs) for (const r of b.values()) if (r.source === "injection" && !r.error) echoTotal += r.score?.echoViolations ?? 0;

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
console.log(`# 按方面拆分消融（#127）：A=${aFile}`);
console.log(`# B 臂 ${bFiles.length} 遍：${bFiles.join(" / ")}\n`);
console.log("能力口径 synthetic+real：");
console.log("| 形态 | recall | precision | F1 | 期望 | 命中 | 意见数 | TP | tokens 入/出（cached） |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const l of lines) {
  const tok = l.tokensIn === null ? "—" : `${l.tokensIn}/${l.tokensOut}（cached ${l.tokensCached}）`;
  console.log(`| ${l.label} | ${pct(l.recall)} | ${pct(l.precision)} | ${pct(l.f1)} | ${l.expectN} | ${l.hits} | ${l.comments} | ${l.tp} | ${tok} |`);
}
// 成本倍数用全量口径（run JSON summary.usage 覆盖全部 87 例）——能力组口径只数能力用例，与 A 不对齐会得出假倍数
const aJson = JSON.parse(readFileSync(runUrl(aFile), "utf8")) as { summary?: { usage?: { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null } } };
const aTotal = aJson.summary?.usage?.totalTokens ?? null;
let bTotal = 0;
for (const f of bFiles) {
  const j = JSON.parse(readFileSync(runUrl(f), "utf8")) as { summary?: { usage?: { totalTokens?: number | null } } };
  bTotal += j.summary?.usage?.totalTokens ?? 0;
}
if (aTotal !== null && bTotal > 0) console.log(`\n成本倍数（全量口径）：A total ${aTotal}，B ${bFiles.length} 遍合计 ${bTotal}，= ${(bTotal / aTotal).toFixed(2)}×`);
console.log(`injection echo（口径外记档）：B 臂合计 ${echoTotal} 违规`);
console.log("\n判读（#127 验收闸门）：B 显著胜 → 重开分发形态讨论（与 D036 cheap-pair 叠加评估）；B 不胜或胜幅小于成本倍数 → 「单遍多方面 + reflect 按阶段拆」定案。");
