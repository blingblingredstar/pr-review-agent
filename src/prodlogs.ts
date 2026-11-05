// 生产 run 台账（Step 4 数据出口，夜间批量三号 PR-2）：Vercel runtime log 行 → 按 requestId 聚合的
// 结构化 run 记录。动机：Hobby 的 runtime log 只保留 ~30 分钟，bot 每审一个 PR 数据就在蒸发；
// 台账让 Step 4 门槛（≥10 run）与成本/行为观测机械可测，替代手贴 dashboard 截图。
// 纯函数（解析/聚合/合并），CLI 包装见 scripts/fetch-prod-usage.ts；数据源 = `vercel logs --json` 输出
// 或 dashboard 导出的同格式 JSONL，两路共用本解析。
// 红线：只读采集，零 LLM 调用、零 prompt 接触——能力组红线由构造保证。

export type VercelLogLine = {
  timestamp: string;
  requestId: string;
  level: string;
  message: string;
  deploymentId?: string;
  environment?: string;
};

export type ToolCall = { step: number; kind: "search" | "read"; detail: string };

// run 的意见落点计数。folded（#89）：D032 起 minor/nit 折叠进 review body `<details>` 段，
// 日志「完成」行不带这一格，只有 GitHub 派生口径能补齐；老记录无此字段（optional 向后兼容）。
// source：值来源标记——缺省 = 日志「完成」行解析（fallback：该行在 Vercel 日志捕获中系统性缺失，
// #89 实证两批 run outcome null/0 而线程里有真实意见）；"github" = GitHub 侧派生（事实源），
// harvest 派生值覆盖日志值，合并时 prev 的派生值天然赢过新抓的日志值（mergeRuns 字段级 a ?? b）
export type RunOutcome = {
  inline: number;
  degraded: number;
  folded?: number;
  source?: "github";
};

export type ProdRun = {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  pr: number | null;
  headSha: string | null;
  // 一次审查 = 多个 requestId（worker 阶段机 prepare/review/publish 各自独立调用），runKey = "pr@sha"
  // 把同一次审查的多段请求归组；run 级统计与 Step 4 门槛（≥10 run）按 distinct runKey 计数
  runKey: string | null;
  routerTokens: { in: number; out: number } | null;
  probeTokens: { in: number; out: number } | null;
  reviewTokens: { in: number; out: number; total?: number } | null;
  toolRequests: string | null;
  toolCalls: ToolCall[];
  task: string | null;
  context: string | null;
  truncation: string | null;
  warnings: string[];
  outcome: RunOutcome | null;
  timeout: boolean;
  deploymentId: string | null;
  environment: string | null;
};

export type Ledger = { fetchedAt: string; runs: Record<string, ProdRun> };

// 非运行时行（CLI 的 --json 末尾 summary 等）返回 null。
// 兼容两种形态：CLI `vercel logs --json` = {type:"log", data:{timestamp:ISO, requestId, message, level, ...}}；
// dashboard 导出 JSONL = 扁平 {id, requestId, timestamp:epoch毫秒, message, level, ...}（无 data 包装）
export function parseLogLine(raw: string): VercelLogLine | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  const flat = obj as Record<string, unknown>;
  const data = (typeof flat.data === "object" && flat.data !== null ? flat.data : flat) as Record<string, unknown>;
  const { requestId, message } = data;
  if (typeof requestId !== "string" || typeof message !== "string") return null;
  let timestamp: string;
  if (typeof data.timestamp === "string") timestamp = data.timestamp;
  else if (typeof data.timestamp === "number") timestamp = new Date(data.timestamp).toISOString();
  else return null;
  return {
    timestamp,
    requestId,
    message,
    level: typeof data.level === "string" ? data.level : "info",
    deploymentId: typeof data.deploymentId === "string" ? data.deploymentId : undefined,
    environment: typeof data.environment === "string" ? data.environment : undefined,
  };
}

const tokens = (i: string | undefined, o: string | undefined, t?: string) =>
  i === undefined || o === undefined ? null : { in: Number(i), out: Number(o), ...(t !== undefined ? { total: Number(t) } : {}) };

// 逐行提取结构化字段；一行命中多个模式时各自生效（互不重叠）
function applyMessage(run: ProdRun, line: VercelLogLine): void {
  const m = line.message;
  let x: RegExpMatchArray | null;
  if ((x = m.match(/\[worker\] [^#]+#(\d+)@([0-9a-f]+)/))) {
    run.pr = Number(x[1]);
    run.headSha = x[2]!;
    run.runKey = `#${x[1]}@${x[2]}`;
  }
  if ((x = m.match(/完成：(\d+) 条行内[^，]*，(\d+) 条降级/))) {
    run.outcome = { inline: Number(x[1]), degraded: Number(x[2]) };
  }
  if (m.includes("审查超时") || m.includes("未返回，本次跳过")) run.timeout = true;
  if (line.level === "warn" || line.level === "error") run.warnings.push(m);
  if ((x = m.match(/\[router\] tokens: in (\d+) \/ out (\d+)/))) run.routerTokens = tokens(x[1], x[2]);
  if ((x = m.match(/\[tools\] probe tokens: in (\d+) \/ out (\d+)/))) run.probeTokens = tokens(x[1], x[2]);
  if ((x = m.match(/\[reviewDiff\] tokens[^:]*: in (\d+) \/ out (\d+)(?: \/ total (\d+))?/))) {
    run.reviewTokens = tokens(x[1], x[2], x[3]);
  }
  if ((x = m.match(/\[tools\] 第一段工具请求：(.+)$/))) run.toolRequests = x[1]!;
  if ((x = m.match(/\[tools\] step (\d+): (search|read) (.+)$/))) {
    run.toolCalls.push({ step: Number(x[1]), kind: x[2] as ToolCall["kind"], detail: x[3]! });
  }
  if (m.startsWith("[task] ")) run.task = m.slice(7);
  if ((x = m.match(/\[context\] (.+)$/))) run.context = x[1]!;
  if ((x = m.match(/\[truncateDiff\] (.+)$/))) run.truncation = x[1]!;
}

export function aggregateRuns(lines: (VercelLogLine | null)[]): Record<string, ProdRun> {
  const runs: Record<string, ProdRun> = {};
  for (const line of lines) {
    if (!line) continue;
    let run = runs[line.requestId];
    if (!run) {
      run = runs[line.requestId] = {
        startedAt: line.timestamp,
        finishedAt: line.timestamp,
        durationMs: 0,
        pr: null,
        headSha: null,
        runKey: null,
        routerTokens: null,
        probeTokens: null,
        reviewTokens: null,
        toolRequests: null,
        toolCalls: [],
        task: null,
        context: null,
        truncation: null,
        warnings: [],
        outcome: null,
        timeout: false,
        deploymentId: line.deploymentId ?? null,
        environment: line.environment ?? null,
      };
    }
    applyMessage(run, line);
    if (line.timestamp < run.startedAt) run.startedAt = line.timestamp;
    if (line.timestamp > run.finishedAt) run.finishedAt = line.timestamp;
    run.deploymentId ??= line.deploymentId ?? null;
    run.environment ??= line.environment ?? null;
  }
  for (const run of Object.values(runs)) {
    run.durationMs = Math.max(0, new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime());
  }
  return runs;
}

// 台账合并：requestId 相同 = 同一次审查的多段请求。**字段级合并**（非 null 字段才落位、数组并集去重、
// 时间窗取并集）而非整记录覆盖——同一 requestId 的日志行可能跨抓取窗口分布（上一次抓到 review 段、
// 这一次只抓到 publish 段的完成行），整记录覆盖会把已捕获的 tokens/toolCalls 丢掉，台账只会越跑越少
export function mergeLedger(prev: Ledger | null, fresh: Record<string, ProdRun>, fetchedAt: string): Ledger {
  const runs: Record<string, ProdRun> = { ...prev?.runs };
  for (const [rid, next] of Object.entries(fresh)) {
    const prevRun = runs[rid];
    runs[rid] = prevRun ? mergeRuns(prevRun, next) : next;
  }
  return { fetchedAt, runs };
}

function mergeRuns(a: ProdRun, b: ProdRun): ProdRun {
  const startedAt = a.startedAt < b.startedAt ? a.startedAt : b.startedAt;
  const finishedAt = a.finishedAt > b.finishedAt ? a.finishedAt : b.finishedAt;
  const seen = new Set(a.toolCalls.map((t) => JSON.stringify(t)));
  return {
    startedAt,
    finishedAt,
    durationMs: Math.max(0, new Date(finishedAt).getTime() - new Date(startedAt).getTime()),
    pr: a.pr ?? b.pr,
    headSha: a.headSha ?? b.headSha,
    runKey: a.runKey ?? b.runKey,
    routerTokens: a.routerTokens ?? b.routerTokens,
    probeTokens: a.probeTokens ?? b.probeTokens,
    reviewTokens: a.reviewTokens ?? b.reviewTokens,
    toolRequests: a.toolRequests ?? b.toolRequests,
    toolCalls: [...a.toolCalls, ...b.toolCalls.filter((t) => !seen.has(JSON.stringify(t)))],
    task: a.task ?? b.task,
    context: a.context ?? b.context,
    truncation: a.truncation ?? b.truncation,
    warnings: [...new Set([...a.warnings, ...b.warnings])],
    outcome: a.outcome ?? b.outcome,
    timeout: a.timeout || b.timeout,
    deploymentId: a.deploymentId ?? b.deploymentId,
    environment: a.environment ?? b.environment,
  };
}

// 台账汇总（报告/journal 引用的机械出口）：审查次数 = distinct runKey（一次审查的多段请求归组）。
// runKey 为 null 的记录（prepare 段：只有 [task]/[context]/[snapshot] 行、无 [worker] 行，日志本身不携带
// pr/sha、与审查段无 requestId 关联）不计入审查数，单列 unattributed 防止 Step 4 门槛被虚增计数
export function summarize(ledger: Ledger): string {
  const runs = Object.values(ledger.runs);
  const byRun = new Map<string, ProdRun[]>();
  const unattributed: ProdRun[] = [];
  for (const r of runs) {
    if (r.runKey === null) {
      unattributed.push(r);
      continue;
    }
    byRun.set(r.runKey, [...(byRun.get(r.runKey) ?? []), r]);
  }
  const reviews = [...byRun.values()].map((rs) => {
    const withOutcome = rs.find((r) => r.outcome !== null);
    return {
      outcome: withOutcome?.outcome ?? null,
      timeout: rs.some((r) => r.timeout),
      tools: rs.some((r) => r.toolCalls.length > 0),
      reviewIn: rs.reduce((s, r) => s + (r.reviewTokens?.in ?? 0), 0),
      reviewOut: rs.reduce((s, r) => s + (r.reviewTokens?.out ?? 0), 0),
      routerOut: rs.reduce((s, r) => s + (r.routerTokens?.out ?? 0), 0),
    };
  });
  const finished = reviews.filter((r) => r.outcome !== null).length;
  const timeouts = reviews.filter((r) => r.timeout).length;
  const toolRuns = reviews.filter((r) => r.tools).length;
  const reviewIn = reviews.reduce((s, r) => s + r.reviewIn, 0);
  const reviewOut = reviews.reduce((s, r) => s + r.reviewOut, 0);
  const routerOut = reviews.reduce((s, r) => s + r.routerOut, 0);
  return (
    `审查 ${reviews.length} 次（完成 ${finished}，超时 ${timeouts}）` +
    `；review in ${reviewIn} / out ${reviewOut}，router out ${routerOut}` +
    `；带工具调用审查 ${toolRuns} 次` +
    `；未归组段 ${unattributed.length}（prepare 阶段 request，无 [worker] 行不计数）`
  );
}
