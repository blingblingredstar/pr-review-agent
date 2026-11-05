// 台账 outcome 的 GitHub 侧派生（#89）：日志「完成：N 条行内…」行在 Vercel 日志捕获中系统性缺失
//（#89 两批实证——有真实行内 major 的 run outcome 为 null/0，同 run 更早的 tokens 行都在；疑因
// waitUntil 生命周期尾部日志在函数冻结边界丢失），outcome 不可靠。修向 = 以 GitHub 为事实源：
// 按 runKey（pr + headSha）查该 commit 的 bot review（body 内 sha 标记匹配，dedupe.ts 同一解析），
// 行内评论数（API）+ body 降级单行数（findings.parseDegradedLines 同一 regex）+ 折叠段行数派生 outcome；
// 日志解析降级为 fallback。纯只读（listReviews / listCommentsForReview），零写操作，能力组红线不涉。
// 本模块不落盘：派生 → applyDerivedOutcomes 覆盖 → 写台账的编排归 scripts/fetch-prod-usage.ts。
import { parseBotReviews } from "./dedupe.ts";
import { parseDegradedLines } from "./findings.ts";
import type { ProdRun, RunOutcome } from "./prodlogs.ts";

// 派生值形态：日志口径两格 + 折叠一格 + 来源标记。ProdRun.outcome 的 folded/source 为 optional，
// 老台账记录缺这两格照常读（summarize 只看 inline/degraded）
export type DerivedOutcome = RunOutcome & { source: "github" };

// 派生目标仓库（owner/repo）：台账记录不携带 owner/repo（日志行只有 #pr@sha），默认本仓库，
// 派生别的仓库的台账时用 LEDGER_GITHUB_REPO 覆盖（.env.example 已记）
export const DEFAULT_LEDGER_REPO = "blingblingredstar/pr-review-agent";

// 最小 client 面（Octokit 结构兼容，单测用 mock 对象直填）：派生只读 reviews 与 review comments。
// per_page=100 单页取全——单 review 的行内意见受 MAX_PREV_FINDINGS=10 与发布层上限约束，
// 单 PR 的 bot review 数受幂等去重约束（同 sha 不重审），现实量级离 100 两个数量级
export type DeriveGithubClient = {
  rest: {
    pulls: {
      listReviews(params: {
        owner: string;
        repo: string;
        pull_number: number;
        per_page: number;
      }): Promise<{ data: { id: number; body: unknown; submitted_at?: string | null }[] }>;
      listCommentsForReview(params: {
        owner: string;
        repo: string;
        pull_number: number;
        review_id: number;
        per_page: number;
      }): Promise<{ data: unknown[] }>;
    };
  };
};

// 折叠段单行（与 findings.ts DEGRADED_LINE_RE 同构，severity 分支换成 minor/nit）：
// D032 折叠段格式 = `- \`file:line\` **[minor|nit]** 全文`，机器可解析（AGENTS.md 意见闭环口径）
const FOLDED_LINE_RE = /^- `([^`:]+):(\d+)` \*\*\[(minor|nit)\]\*\* (.+)$/;

// review body 折叠段行数：只数 `<details>`…`</details>` 之间的 minor/nit 单行。
// 裸行的 minor/nit 天然不存在（发布层 minor/nit 全走折叠段），severity 交替分支兜底排除
export function parseFoldedLines(reviewBody: string): number {
  let inDetails = false;
  let count = 0;
  for (const line of reviewBody.split("\n")) {
    if (line.includes("<details>")) inDetails = true;
    else if (line.includes("</details>")) inDetails = false;
    else if (inDetails && FOLDED_LINE_RE.test(line)) count++;
  }
  return count;
}

// runKey 匹配策略：台账 headSha 是日志行的 7 位短 sha（worker key `headSha.slice(0, 7)`），
// marker 里是发帖时的全量 sha——按前缀比对（对全量 sha 也成立），兼容两条来源的长度差
function matchesHeadSha(markerSha: string, headSha: string): boolean {
  return markerSha.slice(0, headSha.length) === headSha;
}

// 命中 headSha 的全部标记里取最新提交的 review（增量标记 `sha:X base:Y` 只按 sha 匹配；
// 可能多条：同 PR 重派 / 历史 body 手拼——parseBotReviews 容忍一条 body 多标记，按 review id 去重后
// 取 submitted_at 最新，submitted_at 缺失的排最旧）。无匹配返回 null → 该 run outcome 不动
export function latestReviewForSha(
  reviews: { id: number; body: unknown; submitted_at?: string | null }[],
  headSha: string,
): { id: number; body: string; submittedAt: string } | null {
  const matched = parseBotReviews(reviews).filter((r) => matchesHeadSha(r.sha, headSha));
  if (matched.length === 0) return null;
  const byId = new Map(matched.map((r) => [r.id, r]));
  // submitted_at 缺失显式排最旧（bot 折叠 minor：undefined 参与字符串比较时两侧都 false、落到 id 分支，
  // 缺失项与有日期项的相对顺序由 id 决定——注释声称的「排最旧」没有兑现，同 sha 多标记时可能选错最新）
  const rank = (r: { submittedAt?: string }): number | null => (r.submittedAt ? Date.parse(r.submittedAt) : null);
  const latest = [...byId.values()].sort((a, b) => {
    const ta = rank(a), tb = rank(b);
    if (ta === null && tb === null) return a.id - b.id;
    if (ta === null) return -1;
    if (tb === null) return 1;
    return ta !== tb ? ta - tb : a.id - b.id;
  });
  return latest.at(-1) ?? null;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// 从台账派生 outcome：输入台账 run 记录（runKey 非空且 reviewTokens 非空的才参与——reviewTokens
// 缺席 ≈ 审查段未跑完/超时，没有可派生的 review；每 runKey 去重），输出 runKey → 派生值。
// 同 PR 的多个 runKey（如 #87 四连审）共享一次 listReviews（按 PR 分组省调用）。
// 失败语义（#89 定案）：派生失败（网络/权限）或无匹配 review → 该 runKey 不进结果，outcome 保留
// 日志值不覆盖——GitHub 是事实源，但「取不到事实」时日志值是唯一在手证据，宁可留着也不清成 null。
// 节流：串行 + 每次 API 调用前 delayMs（默认 100ms）防突发；去重后 runKey 数量级 ~17，可接受
export async function deriveOutcomeForRuns(
  runs: ProdRun[],
  client: DeriveGithubClient,
  opts?: { repo?: string; delayMs?: number },
): Promise<Map<string, DerivedOutcome>> {
  const repoSpec = opts?.repo?.trim() || DEFAULT_LEDGER_REPO;
  const [owner, repo] = repoSpec.split("/");
  if (!owner || !repo || owner.includes("/") || repo.includes("/")) {
    throw new Error(`LEDGER_GITHUB_REPO 形态应为 "owner/repo"，当前："${repoSpec}"`);
  }
  const delayMs = opts?.delayMs ?? 100;

  // 按 PR 分组收集参与派生的 (runKey, headSha)
  const byPr = new Map<number, { runKey: string; headSha: string }[]>();
  for (const run of runs) {
    if (run.runKey === null || run.reviewTokens === null) continue;
    if (run.pr === null || run.headSha === null) continue;
    const group = byPr.get(run.pr) ?? [];
    // 每 runKey 去重：同一次审查的多段请求（review/publish）共享 runKey，派生一次
    if (group.some((g) => g.runKey === run.runKey)) continue;
    group.push({ runKey: run.runKey, headSha: run.headSha });
    byPr.set(run.pr, group);
  }

  const derived = new Map<string, DerivedOutcome>();
  for (const [pr, group] of byPr) {
    await sleep(delayMs);
    let reviews: { id: number; body: unknown; submitted_at?: string | null }[];
    try {
      reviews = (
        await client.rest.pulls.listReviews({ owner, repo, pull_number: pr, per_page: 100 })
      ).data;
    } catch (err) {
      console.warn(`[derive] PR #${pr} reviews 拉取失败，该 PR 的 ${group.length} 个 runKey 保留日志值`, err);
      continue;
    }
    for (const { runKey, headSha } of group) {
      await sleep(delayMs);
      try {
        const review = latestReviewForSha(reviews, headSha);
        if (!review) continue; // 无匹配 → outcome 不动（超时 run / review 未发出，日志值也别清）
        const comments = (
          await client.rest.pulls.listCommentsForReview({
            owner,
            repo,
            pull_number: pr,
            review_id: review.id,
            per_page: 100,
          })
        ).data;
        derived.set(runKey, {
          inline: comments.length,
          degraded: parseDegradedLines(review.body).length,
          folded: parseFoldedLines(review.body),
          source: "github",
        });
      } catch (err) {
        console.warn(`[derive] runKey ${runKey} 派生失败，保留日志值`, err);
      }
    }
  }
  return derived;
}

// 派生值落台账：该 runKey 的**全部**记录（含 publish 段——脏 0/0 常落在这段、reviewTokens 为 null，
// 只改参与派生的记录会让 summarize 的 rs.find(outcome !== null) 捞到脏值）统一覆盖，一次审查一条口径。
// 覆盖而非标 dirty（#89 验收闸门 2 的二选一）：ledger 是活工具不是历史档案——旧值在派生值与日志行
// 两侧都可追溯，标 dirty 只会给 summarize 加一条永久分支；合并语义下 prev 派生值天然赢过后续日志值
export function applyDerivedOutcomes(runs: Record<string, ProdRun>, derived: Map<string, DerivedOutcome>): number {
  let applied = 0;
  for (const run of Object.values(runs)) {
    const d = run.runKey === null ? undefined : derived.get(run.runKey);
    if (!d) continue;
    run.outcome = { ...d };
    applied++;
  }
  return applied;
}
