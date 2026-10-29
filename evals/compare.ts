// evals/compare.ts —— 多轮 run 按 prompt 指纹聚合对比（Day 6 对比报告的数据出口，evals/compare.test.ts 覆盖核心）
// 用法：node --import tsx evals/compare.ts evals/runs/<run>.json [more.json ...]
// 指标口径与 run.ts 一致：能力评估 = synthetic + real（dogfood 不进）；跨轮微平均 = Σhits/ΣexpectN、Σtp/Σcomments。
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type RunJson = {
  startedAt: string;
  model: string;
  promptHash?: string;
  runs: {
    caseId: string;
    source: string;
    error: string | null;
    score: {
      hits: number;
      verdicts: { hit: boolean; expect: { file: string | string[]; line: number | null } }[];
      agentComments: number;
      truePositives: number;
    } | null;
  }[];
  summary: {
    groups: Record<string, { hits: number; expectN: number; tp: number; comments: number }>;
  };
};

export type VersionAggregate = {
  promptHash: string;
  files: string[];
  micro: Micro;
  groups: Record<string, Micro>;
  // 跨轮未全命中的用例（全命中的不列，矩阵只看短板）
  unstable: { caseId: string; source: string; perRun: string[]; missAt: string[] }[];
};

function micro(hits: number[], expects: number[], tps: number[], comments: number[]) {
  const expectN = expects.reduce((s, n) => s + n, 0);
  const hitN = hits.reduce((s, n) => s + n, 0);
  const tpN = tps.reduce((s, n) => s + n, 0);
  const cmN = comments.reduce((s, n) => s + n, 0);
  // 空数据返回 null（显示 —）而非 0——0% 会被误读成「全 miss」
  return { recall: expectN ? hitN / expectN : null, precision: cmN ? tpN / cmN : null };
}

export type Micro = { recall: number | null; precision: number | null };

export function aggregateRuns(files: { name: string; data: RunJson }[]): VersionAggregate[] {
  const byPrompt = new Map<string, { name: string; data: RunJson }[]>();
  for (const f of files) {
    const key = f.data.promptHash ?? "legacy(无指纹)";
    const list = byPrompt.get(key) ?? [];
    list.push(f);
    byPrompt.set(key, list);
  }
  return [...byPrompt.entries()].map(([promptHash, list]) => {
    const ordered = [...list].sort((a, b) => a.data.startedAt.localeCompare(b.data.startedAt));
    // 能力评估口径：dogfood 排除（与 run.ts 一致）
    const capScores = ordered
      .flatMap((f) => f.data.runs.filter((r) => !r.error && r.score && r.source !== "dogfood"))
      .map((r) => r.score!);
    const microM = micro(
      capScores.map((s) => s.hits),
      capScores.map((s) => s.verdicts.length),
      capScores.map((s) => s.truePositives),
      capScores.map((s) => s.agentComments),
    );
    const sources = [...new Set(ordered.flatMap((f) => f.data.runs.map((r) => r.source)))].filter((s) => s !== "dogfood");
    const groups = Object.fromEntries(
      sources.map((src) => {
        const ss = ordered
          .flatMap((f) => f.data.runs.filter((r) => !r.error && r.score && r.source === src))
          .map((r) => r.score!);
        return [src, micro(
          ss.map((s) => s.hits),
          ss.map((s) => s.verdicts.length),
          ss.map((s) => s.truePositives),
          ss.map((s) => s.agentComments),
        )];
      }),
    );
    // 逐用例矩阵：用例清单取各文件并集——不同批次的 run（用例集增删前后）混传时按缺失标注而不是崩溃
    const caseIds = [...new Set(ordered.flatMap((f) => f.data.runs.map((r) => r.caseId)))];
    const unstable = caseIds.flatMap((caseId) => {
      const lookup = (f: { data: RunJson }) => f.data.runs.find((x) => x.caseId === caseId);
      const perRun = ordered.map((f) => {
        const r = lookup(f);
        if (!r) return "缺";
        if (r.error || !r.score) return "err";
        return `${r.score.hits}/${r.score.verdicts.length}`;
      });
      const allFull = ordered.every((f) => {
        const r = lookup(f);
        return r && !r.error && r.score && r.score.hits === r.score.verdicts.length;
      });
      if (allFull) return [];
      const missAt = [
        ...new Map(
          ordered.flatMap((f) => {
            const r = lookup(f);
            if (!r || r.error || !r.score) return [];
            return r.score.verdicts.filter((v) => !v.hit).map((v) => {
              const file = Array.isArray(v.expect.file) ? v.expect.file[0] : v.expect.file;
              return [`${file}:${v.expect.line ?? "*"}`, true] as const;
            });
          }),
        ).keys(),
      ];
      const source = ordered.map((f) => lookup(f)).find((r) => r)?.source ?? "?";
      return [{ caseId, source, perRun, missAt }];
    });
    return {
      promptHash,
      files: ordered.map((f) => f.name.replace(/^.*\//, "")),
      micro: microM,
      groups,
      unstable,
    };
  });
}

const percent = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);

async function main() {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("用法：node --import tsx evals/compare.ts evals/runs/<run>.json [more.json ...]");
    process.exitCode = 1;
    return;
  }
  const files = paths.map((p) => ({ name: p, data: JSON.parse(readFileSync(p, "utf8")) as RunJson }));
  const models = [...new Set(files.map((f) => f.data.model))];
  console.log(`# eval 对比：${files.length} 轮，模型 ${models.join(", ")}\n`);
  // 按 prompt 首次出现顺序输出（命令行顺序即时间顺序）
  for (const agg of aggregateRuns(files)) {
    console.log(`## prompt \`${agg.promptHash}\`（${agg.files.length} 轮：${agg.files.join(", ")}）\n`);
    console.log(`| 组 | recall（微平均） | precision（微平均） |`);
    console.log(`|---|---|---|`);
    for (const [src, m] of Object.entries(agg.groups)) {
      console.log(`| ${src} | ${percent(m.recall)} | ${m.precision === null ? "—" : percent(m.precision)} |`);
    }
    console.log(`| **合计（能力评估）** | **${percent(agg.micro.recall)}** | **${agg.micro.precision === null ? "—" : percent(agg.micro.precision)}** |`);
    if (agg.unstable.length > 0) {
      console.log(`\n跨轮未全命中的用例（短板矩阵）：\n`);
      console.log(`| case | source | ${agg.files.map((_, i) => `轮${i + 1}`).join(" | ")} | 未命中期望定位 |`);
      console.log(`|---|---|${agg.files.map(() => "---").join("|")}|---|`);
      for (const u of agg.unstable) {
        console.log(`| ${u.caseId} | ${u.source} | ${u.perRun.map((s) => (s === "1/1" ? "✓" : s)).join(" | ")} | ${u.missAt.join("、")} |`);
      }
    } else {
      console.log(`\n（全部用例跨轮全命中）`);
    }
    console.log("");
  }
}

// 与 import.meta.url 全 URL 比对：文件名后缀判断会被符号链接/编译产物/别的路径误触发
const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isDirectRun) main();
