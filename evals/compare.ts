// evals/compare.ts —— 多轮 run 按 prompt 指纹聚合对比（Day 6 对比报告的数据出口，test/compare.test.ts 覆盖核心）
// 用法：node --import tsx evals/compare.ts evals/runs/<run>.json [more.json ...]
// 指标口径与 run.ts 一致：能力评估 = synthetic + real（dogfood 不进）；跨轮微平均 = Σhits/ΣexpectN、Σtp/Σcomments。
// 外部 golden 子集（#157 → D048）单列 ±3/±5 两行对照：±3 取落库 score（打分契约），±5 由落盘 comments 重打分
// （锚点伪影回收口径，全局默认不动）；子集识别见 isExternalGolden。
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isCapabilitySource, matchesExpectation, type Expectation } from "./score.ts";

// 只声明 compare 消费的字段：run.ts 写盘的 summary/groups 等其余结构不在此处复述——
// 两边各留各的，类型漂移不会有编译期信号，复述反而误导按类型消费 run JSON 的人。
// planArm（#65 闸门 2）：EVAL_PLAN 臂标记（enabled: true 即 plan 臂；null/缺失 = baseline），
// 进分组键——同模型同 prompt 的两臂混聚会被当「同版多轮」，消融对照失义。
// contextArm（#80）：EVAL_CONTEXT 臂标记（enabled: true 即 ctx 臂；null/缺失 = baseline），同进分组键
export type RunJson = {
  startedAt: string;
  model: string;
  promptHash?: string;
  planArm?: { enabled?: boolean } | null;
  contextArm?: { enabled?: boolean } | null;
  reflectArm?: { enabled?: boolean } | null;
  runs: {
    caseId: string;
    source: string;
    error: string | null;
    // K=5 重打分消费的落盘原始意见（run.ts 一直落库；声明成消费子集，历史 run 缺失时 K=5 显示 —）
    comments?: { file: string; line: number; body: string }[];
    score: {
      hits: number;
      verdicts: { hit: boolean; expect: { file: string | string[]; line: number | null; mustMention?: string[] } }[];
      agentComments: number;
      truePositives: number;
      // 双口径（#105）：历史 run（#105 前落库）无此二字段 → LP/Noise 列显示 —
      contentComments?: number;
      locatedComments?: number;
    } | null;
  }[];
};

export type VersionAggregate = {
  promptHash: string;
  model: string;
  // "plan" = EVAL_PLAN 臂组；"" = baseline（legacy run 无 planArm 字段同落这里）
  planArm: string;
  // "ctx" = EVAL_CONTEXT 臂组（#80）；"" = baseline（legacy run 无 contextArm 字段同落这里）
  contextArm: string;
  // "reflect" = EVAL_REFLECT 臂组（#73）；"" = baseline（legacy run 无 reflectArm 字段同落这里）
  reflectArm: string;
  files: string[];
  micro: Micro;
  groups: Record<string, Micro>;
  // 外部 golden 子集单列读数（#157 → D048）：k3 = 落库 score 聚合（打分契约 ±3）；k5 = 落盘 comments
  // 重打分 ±5（锚点伪影回收口径）。null = 本组无外部 golden 用例（历史组零扰动）；k5 另在 run 缺
  // comments 或 verdict 缺 mustMention 时单独置 null（不能按 0 抹平，#105 同款纪律）
  extGolden: { k3: Micro | null; k5: Micro | null };
  // 跨轮未全命中的用例（全命中的不列，矩阵只看短板）
  unstable: { caseId: string; source: string; perRun: string[]; missAt: string[] }[];
};

// 外部 golden 子集识别（#157 → D048）：外部 golden 只单列读数、不改打分契约，不进 case 的 source 枚举——
// AACR 转译组走 aacr- 前缀自动覆盖，#107 withmartian offline 转译 5 例 caseId 硬列（与自建 real 共用 real 组，
// 无独立 source 可辨）；新外部例若不在 aacr 前缀内，在此登记
const EXT_REAL_GOLDEN_IDS = new Set([
  "real-16-calcom-delete-non-sms",
  "real-17-calcom-dayjs-eq-slot-end",
  "real-18-discourse-downsize-redef",
  "real-19-grafana-dcl-recheck",
  "real-20-sentry-optimized-paginator",
]);
export const isExternalGolden = (caseId: string): boolean =>
  caseId.startsWith("aacr-") || EXT_REAL_GOLDEN_IDS.has(caseId);

function micro(
  hits: number[],
  expects: number[],
  tps: number[],
  comments: number[],
  content: (number | undefined)[] = [],
  located: (number | undefined)[] = [],
) {
  const expectN = expects.reduce((s, n) => s + n, 0);
  const hitN = hits.reduce((s, n) => s + n, 0);
  const tpN = tps.reduce((s, n) => s + n, 0);
  const cmN = comments.reduce((s, n) => s + n, 0);
  // 双口径（#105）只在该组**全部** run 都带 contentComments/locatedComments 时才计算——
  // 历史 run 缺字段不能按 0 抹平（bot major：缺失→0 会产出假 100% noise），混传同理（部分有值 =
  // 分子分母口径不齐）。allHave 不满足 → LP/Noise 置 null 显示 —
  const allHave = content.length > 0 && content.every((n) => n !== undefined) && located.every((n) => n !== undefined);
  const ctN = allHave ? (content as number[]).reduce((s, n) => s + n, 0) : 0;
  const lcN = allHave ? (located as number[]).reduce((s, n) => s + n, 0) : 0;
  // 空数据返回 null（显示 —）而非 0——0% 会被误读成「全 miss」
  return {
    recall: expectN ? hitN / expectN : null,
    precision: cmN ? tpN / cmN : null,
    linePrecision: allHave && ctN ? lcN / ctN : null,
    noiseRate: allHave && cmN ? (cmN - lcN) / cmN : null,
  };
}

export type Micro = { recall: number | null; precision: number | null; linePrecision: number | null; noiseRate: number | null };

export function aggregateRuns(files: { name: string; data: RunJson }[]): VersionAggregate[] {
  // model + prompt 指纹 + plan/ctx 臂一起分组：同 prompt 换模型不属于同一次对比；EVAL_PLAN / EVAL_CONTEXT 臂与
  // baseline 臂是消融的列，也不属于同一次对比（run.ts planArm / contextArm 字段，#65 闸门 2 / #80）。
  // 无指纹记空串（真实指纹是 12 位 hex，不可能为空），与 legacy 的展示文案解耦、零碰撞
  const byGroup = new Map<string, { name: string; data: RunJson }[]>();
  for (const f of files) {
    const model = f.data.model ?? "(unknown)";
    const promptHash = f.data.promptHash ?? "";
    const planArm = f.data.planArm?.enabled ? "plan" : "";
    const ctxArm = f.data.contextArm?.enabled ? "ctx" : "";
    const reflectArm = f.data.reflectArm?.enabled ? "reflect" : "";
    const key = `${model}\u0000${promptHash}\u0000${planArm}\u0000${ctxArm}\u0000${reflectArm}`;
    const list = byGroup.get(key) ?? [];
    list.push(f);
    byGroup.set(key, list);
  }
  return [...byGroup.entries()].map(([key, list]) => {
    const [model, rawHash, planArm, ctxArm, reflectArm] = key.split("\u0000");
    const promptHash = rawHash || "legacy(无指纹)";
    // startedAt 相同（精度截断）时以文件名稳定排序，保证「轮N」与命令行顺序可对上
    const ordered = [...list].sort(
      (a, b) => a.data.startedAt.localeCompare(b.data.startedAt) || a.name.localeCompare(b.name),
    );
    // 能力评估口径：dogfood 排除（与 run.ts 一致）
    const capScores = ordered
      .flatMap((f) => f.data.runs.filter((r) => !r.error && r.score && isCapabilitySource(r.source)))
      .map((r) => r.score!);
    const microM = micro(
      capScores.map((s) => s.hits),
      capScores.map((s) => s.verdicts.length),
      capScores.map((s) => s.truePositives),
      capScores.map((s) => s.agentComments),
      capScores.map((s) => s.contentComments),
      capScores.map((s) => s.locatedComments),
    );
    // groups 含全部 source（dogfood 照常输出、打印处标注回归集），能力口径只作用于 micro 合计；
    // injection 不进组聚合（D024：组指标是拦截率不是 recall/precision，按普通组展示会误导跨轮对比）
    const sources = [...new Set(ordered.flatMap((f) => f.data.runs.map((r) => r.source)))].filter((src) => src !== "injection");
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
          ss.map((s) => s.contentComments),
          ss.map((s) => s.locatedComments),
        )];
      }),
    );
    // 外部 golden 子集（#157 → D048）：k3 直接聚合落库 score（±3 契约）；k5 用落盘 comments 按容差 5 重打分。
    // 重打分前置检查全组通过才计算（部分 run 缺 comments / verdict 缺 mustMention → k5 置 null 显示 —，
    // 不能按 0 抹平出假 0%）；混传多轮时以轮为单位检查，缺的轮不进 k5 分母会拉偏口径——所以任一轮缺即置 null
    const extRuns = ordered.flatMap((f) =>
      f.data.runs.filter((r) => !r.error && r.score && isExternalGolden(r.caseId)),
    );
    const extGolden: VersionAggregate["extGolden"] = { k3: null, k5: null };
    if (extRuns.length > 0) {
      extGolden.k3 = micro(
        extRuns.map((r) => r.score!.hits),
        extRuns.map((r) => r.score!.verdicts.length),
        extRuns.map((r) => r.score!.truePositives),
        extRuns.map((r) => r.score!.agentComments),
      );
      const rescorable = extRuns.every(
        (r) => Array.isArray(r.comments) && r.score!.verdicts.every((v) => Array.isArray(v.expect.mustMention)),
      );
      if (rescorable) {
        const k5 = { hit: 0, expect: 0, tp: 0, cm: 0 };
        for (const r of extRuns) {
          const comments = r.comments!;
          for (const v of r.score!.verdicts) {
            k5.expect++;
            if (comments.some((cm) => matchesExpectation(v.expect as Expectation, cm, 5))) k5.hit++;
          }
          for (const cm of comments) {
            k5.cm++;
            if (r.score!.verdicts.some((v) => matchesExpectation(v.expect as Expectation, cm, 5))) k5.tp++;
          }
        }
        extGolden.k5 = micro([k5.hit], [k5.expect], [k5.tp], [k5.cm]);
      }
    }
    // 逐用例矩阵：用例清单取各文件并集——不同批次的 run（用例集增删前后）混传时按缺失标注而不是崩溃
    const caseIds = [...new Set(ordered.flatMap((f) => f.data.runs.map((r) => r.caseId)))];
    const unstable = caseIds.flatMap((caseId) => {
      const lookup = (f: { data: RunJson }) => f.data.runs.find((x) => x.caseId === caseId);
      const perRun = ordered.map((f) => {
        const r = lookup(f);
        if (!r) return "缺";
        if (r.error || !r.score) return "err";
        const { hits, verdicts } = r.score;
        // 空期望显示 —：「没有期望可打分」与「全 miss」（0/N）是两回事
        return verdicts.length === 0 ? "—" : hits === verdicts.length ? "✓" : `${hits}/${verdicts.length}`;
      });
      const allFull = ordered.every((f) => {
        const r = lookup(f);
        return r && !r.error && r.score && r.score.verdicts.length > 0 && r.score.hits === r.score.verdicts.length;
      });
      if (allFull) return [];
      const missAt = [
        ...new Set(
          ordered.flatMap((f) => {
            const r = lookup(f);
            if (!r || r.error || !r.score) return [] as string[];
            return r.score.verdicts.filter((v) => !v.hit).map((v) => {
              // 数组期望列出全部候选（实际漏在哪侧未知，只取第一个会误导短板分析）
              const files = Array.isArray(v.expect.file) ? v.expect.file : [v.expect.file];
              return `${files.join("|")}:${v.expect.line ?? "*"}`;
            });
          }),
        ),
      ];
      const source = ordered.map((f) => lookup(f)).find((r) => r)?.source ?? "?";
      return [{ caseId, source, perRun, missAt }];
    });
    return {
      promptHash,
      model,
      planArm,
      contextArm: ctxArm,
      reflectArm,
      files: ordered.map((f) => f.name),
      micro: microM,
      groups,
      extGolden,
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
  try {
    const files = paths.map((p) => {
      let data: RunJson;
      try {
        data = JSON.parse(readFileSync(p, "utf8")) as RunJson;
      } catch (e) {
        throw new Error(`run 文件不可读或非 JSON：${p}（${String(e).slice(0, 120)}）`);
      }
      if (!Array.isArray(data?.runs)) throw new Error(`run 文件结构不对（缺 runs 数组）：${p}`);
      return { name: p, data };
    });
    const models = [...new Set(files.map((f) => f.data.model ?? "(unknown)"))];
    console.log(`# eval 对比：${files.length} 轮，模型 ${models.join(", ")}\n`);
    // 按 prompt 首次出现顺序输出（命令行顺序即时间顺序）
    for (const agg of aggregateRuns(files)) {
      console.log(`## ${agg.model} · prompt \`${agg.promptHash}\`${agg.planArm ? " · EVAL_PLAN 臂" : ""}${agg.contextArm ? " · EVAL_CONTEXT 臂" : ""}${agg.reflectArm ? " · EVAL_REFLECT 臂" : ""}（${agg.files.length} 轮：${agg.files.join(", ")}）\n`);
      console.log(`| 组 | recall（微平均） | precision（微平均） | LP（located/content） | Noise |`);
      console.log(`|---|---|---|---|---|`);
      for (const [src, m] of Object.entries(agg.groups)) {
        const tag = isCapabilitySource(src) ? "" : "（回归集，不进合计）";
        // ctxpair TP 按对计（#112 根治后口径）；LP/Noise 仅 #105 后落库的 run 有值（历史 run 显示 —）
        const lp = m.linePrecision === null ? "—" : percent(m.linePrecision);
        const noise = m.noiseRate === null ? "—" : percent(m.noiseRate);
        console.log(`| ${src}${tag} | ${percent(m.recall)} | ${percent(m.precision)} | ${lp} | ${noise} |`);
      }
      const mLP = agg.micro.linePrecision === null ? "—" : percent(agg.micro.linePrecision);
      const mNoise = agg.micro.noiseRate === null ? "—" : percent(agg.micro.noiseRate);
      console.log(`| **合计（能力评估）** | **${percent(agg.micro.recall)}** | **${percent(agg.micro.precision)}** | **${mLP}** | **${mNoise}** |`);
      // 外部 golden 单列块（#157 → D048）：±3 = 打分契约（与上面 aacr/real 组行同源）；±5 = 锚点伪影回收口径。
      // LP/Noise 不随容差重算（contentComments/locatedComments 是 ±3 落库值），故本块只列 recall/precision 两列
      if (agg.extGolden.k3 || agg.extGolden.k5) {
        console.log(`\n外部 golden 子集（aacr-* + real-16..20，#157/D048 裁定单列读数）：\n`);
        console.log(`| 容差 | recall（微平均） | precision（微平均） |`);
        console.log(`|---|---|---|`);
        console.log(`| ±3（打分契约） | ${percent(agg.extGolden.k3?.recall ?? null)} | ${percent(agg.extGolden.k3?.precision ?? null)} |`);
        console.log(`| ±5（锚点伪影回收） | ${percent(agg.extGolden.k5?.recall ?? null)} | ${percent(agg.extGolden.k5?.precision ?? null)} |`);
      }
      if (agg.unstable.length > 0) {
        console.log(`\n跨轮未全命中的用例（短板矩阵；含 dogfood 回归用例——它不进上面的能力指标，单独解读；injection 用例的 0/1 是「沉默=未拦截」，走组行拦截率口径，不作能力短板解读）：\n`);
        console.log(`| case | source | ${agg.files.map((_, i) => `轮${i + 1}`).join(" | ")} | 未命中期望定位 |`);
        console.log(`|---|---|${agg.files.map(() => "---").join("|")}|---|`);
        for (const u of agg.unstable) {
          const miss = u.missAt.length ? u.missAt.join("、") : "(仅错误/缺失轮，无未命中定位)";
          console.log(`| ${u.caseId} | ${u.source} | ${u.perRun.join(" | ")} | ${miss} |`);
        }
      } else {
        console.log(`\n（全部用例跨轮全命中）`);
      }
      console.log("");
    }
  } catch (e) {
    // 工具脚本：干净报错退出，不甩未捕获堆栈
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
}

// 直跑判定：两侧都做 realpath 归一（macOS /tmp → /private/tmp 这类符号链接会让字面比对失配）
function invokedDirectly(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}
if (invokedDirectly()) main();
