// npm run prodlogs —— 拉取 Vercel runtime log 聚合生产 run 台账（Step 4 数据出口）。
// 数据源 = `npx vercel logs --json`（默认 30 分钟窗；Hobby 的 runtime log 保留期即 ~30 分钟，
// 1h 会报 "outside the available retention"）。台账按 requestId 合并累积（重复执行安全，跑得越勤台账越全）。
// 用法：
//   npm run prodlogs                        # 拉最近 30m，合并进 evals/prod-runs/ledger.json
//   npm run prodlogs -- --seed <jsonl文件>   # 追加解析 dashboard 导出的 JSONL（窗口外的历史数据）
//   npm run prodlogs -- --seed <f> --seed-only  # 只导入不实时拉取（端点不可达时的纯导入路径）
//   npm run prodlogs -- --since 10m         # 透传给 vercel logs
//   npm run prodlogs -- --skip-derive       # 跳过 GitHub 侧 outcome 派生（纯日志模式，#89 修复前口径）
// outcome 派生（#89）：日志「完成」行系统性缺失导致 outcome null/0 脏值——merge 后按 runKey 调 GitHub
// API 查 bot review 派生真实值并覆盖日志值（GitHub 是事实源）；派生失败保留日志值。仓库用
// LEDGER_GITHUB_REPO（默认 blingblingredstar/pr-review-agent），凭证沿用 GITHUB_TOKEN
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { aggregateRuns, mergeLedger, parseLogLine, summarize, type Ledger } from "../src/prodlogs.ts";
import { applyDerivedOutcomes, deriveOutcomeForRuns } from "../src/prod-runs-derived.ts";
import { getOctokit } from "../src/github.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  // 取到的值以 "--" 开头 = 实际是下一个开关（如 --seed --since 10m），视为未提供
  const v = i >= 0 ? args[i + 1] : undefined;
  return v !== undefined && !v.startsWith("--") ? v : undefined;
};
const seed = flag("--seed");
const since = flag("--since");

const outUrl = new URL("../evals/prod-runs/ledger.json", import.meta.url);
const readLedger = (): Ledger | null =>
  existsSync(outUrl) ? (JSON.parse(readFileSync(outUrl, "utf8")) as Ledger) : null;

const collected: string[] = [];
if (seed) {
  collected.push(...readFileSync(seed, "utf8").split("\n"));
  console.log(`[prodlogs] seed 文件：${seed}（${collected.filter((l) => l.trim()).length} 行）`);
}

if (process.argv.includes("--seed-only") && !seed) {
  console.error("[prodlogs] --seed-only 需要搭配 --seed <jsonl文件>（纯导入开关，不接受无数据的纯导出）");
  process.exit(1);
}
if (!process.argv.includes("--seed-only")) {
  const cmd = "npx";
  const argv = ["-y", "vercel@latest", "logs", "--json", ...(since ? ["--since", since] : [])];
  console.log(`[prodlogs] 运行 ${cmd} ${argv.join(" ")} …`);
  const r = spawnSync(cmd, argv, { encoding: "utf8", cwd: fileURLToPath(new URL("..", import.meta.url)), shell: process.platform === "win32" });
  const fetchFailed = r.error !== undefined || r.status !== 0;
  if (r.error) console.error(`[prodlogs] spawn 失败：${String(r.error)}`);
  else if (r.status !== 0) console.error(String(r.stderr || r.stdout));
  if (fetchFailed) {
    // 降级：seed 数据完好则只用 seed 写台账；失败输出可能是错误信息/残缺行，不并入 collected
    if (seed && collected.some((l) => l.trim())) {
      console.error("[prodlogs] 实时拉取失败，但 seed 数据可用——降级为 seed-only 写台账（告警不中断）");
    } else {
      console.error("[prodlogs] 采集失败，跳过写台账（保留既有 ledger 不被空数据覆盖）；可用 --seed <f> --seed-only 走纯导入");
      process.exit(1);
    }
  } else if (r.stdout) {
    collected.push(...r.stdout.split("\n"));
  }
}

const parsed = collected.map(parseLogLine);
const fresh = aggregateRuns(parsed);
const merged = mergeLedger(readLedger(), fresh, new Date().toISOString());

// outcome 派生（#89）：GitHub 侧派生值覆盖日志值（0/0 脏值一并纠正）；失败保留日志值不覆盖。
// 放在写台账前——派生失败只降级（纯日志口径），绝不挡台账落盘
if (process.argv.includes("--skip-derive")) {
  console.log("[derive] --skip-derive：跳过 GitHub 派生，outcome 保持日志口径");
} else if (!process.env.GITHUB_TOKEN) {
  console.warn("[derive] GITHUB_TOKEN 未设置，跳过派生（outcome 保持日志口径；日志完成行系统性缺失时该口径偏 null/0，见 #89）");
} else {
  try {
    const client = getOctokit();
    const derived = await deriveOutcomeForRuns(Object.values(merged.runs), client, {
      repo: process.env.LEDGER_GITHUB_REPO,
    });
    const applied = applyDerivedOutcomes(merged.runs, derived);
    const keyCount = new Set(Object.values(merged.runs).filter((r) => r.runKey !== null).map((r) => r.runKey)).size;
    console.log(`[derive] GitHub 派生 outcome：${derived.size}/${keyCount} 个 runKey 匹配 bot review，覆盖 ${applied} 条记录`);
  } catch (err) {
    console.warn("[derive] 派生初始化失败（保留日志值不覆盖）", err);
  }
}

mkdirSync(new URL("../evals/prod-runs/", import.meta.url), { recursive: true });
writeFileSync(outUrl, JSON.stringify(merged, null, 2) + "\n");
console.log(`[prodlogs] 本次解析 ${parsed.filter((p) => p !== null).length} 行 → ${Object.keys(fresh).length} 个 request → 台账 ${Object.keys(merged.runs).length} 个 run`);
console.log(`[prodlogs] ${summarize(merged)}`);
console.log(`[prodlogs] 已写入 evals/prod-runs/ledger.json`);
