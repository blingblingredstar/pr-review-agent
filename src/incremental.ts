// 增量审查（D032 实现，spec 见 docs/plans/incremental-review.md）：base 推导 / block 继承 / 区间 diff 拉取。
// 定位一句话：增量是成本优化 + 噪音治理，不是新能力——任何一层失败上抛，由 worker 回退全量（增量是优化
// 不是依赖，绝不因增量路径失败导致 push 无审查）。evals 直调 reviewDiff 不经过本模块，能力组红线零接触。
import type { Octokit } from "octokit";
import { fileToDiffBlock, type PrFile, type PrRef } from "./github.ts";

// review body 内嵌标记：`<!-- pr-review-agent sha:<head> -->`（全量，旧形态）与
// `<!-- pr-review-agent sha:<head> base:<base> -->`（增量，D032 扩展；旧标记缺 base 合法）
const MARKER_RE = /<!-- pr-review-agent sha:([0-9a-f]{7,40})(?: base:([0-9a-f]{7,40}))? -->/g;

export type BotReview = {
  id: number;
  sha: string;
  base: string | null;
  submittedAt: string;
  body: string;
};

// 从 review 列表抽取本 agent 的标记（sha + 可选 base）。人工 review / 第三方 bot 无此标记天然不参与；
// 一条 review 只写一个标记（summaryBody），解析容忍多条（各产出独立条目，历史手拼 body 不炸）
export function parseBotReviews(reviews: { id: number; body: unknown; submitted_at?: string | null }[]): BotReview[] {
  const out: BotReview[] = [];
  for (const r of reviews) {
    if (typeof r.body !== "string") continue;
    for (const m of r.body.matchAll(MARKER_RE)) {
      out.push({ id: r.id, sha: m[1]!, base: m[2] ?? null, submittedAt: r.submitted_at ?? "", body: r.body });
    }
  }
  return out;
}

// 最新有效 review 的意见分布是否含 blocker/major——读自己写的 body：summary 行「blocker×N」与
// 降级/折叠行「**[blocker]**」两类形态（自审：inline 评论 body 不在 review.body 里，但折叠/降级/
// summary 三处已覆盖「有 blocker/major」的全部落点——inline 有 blocker 时 summary 必有 blocker×N）
export function hasBlockerOrMajor(body: string): boolean {
  return /(?:blocker|major)×[1-9]|\*\*\[(?:blocker|major)\]\*\*/.test(body);
}

export type IncrementDecision =
  | { mode: "skip"; reason: string } // head 已审（dedupe 命中，与 D010 同语义）
  | { mode: "full"; reason: string } // 回退全量（行为与现状逐字节一致）
  | { mode: "delta"; base: string; latestReviewId: number };

// base 推导 + block 继承（spec §二.1/§二.4 同源同滤：两处共用「过滤后的最新有效 review」一个推导结果）。
// 过滤 = SHA 仍在本 PR commits 列表中（force-push 重写后旧 SHA 天然出局，重写场景自动落回退分支）
export function decideIncrement(args: { headSha: string; reviews: BotReview[]; commitShas: Set<string> }): IncrementDecision {
  const reviewed = new Set(args.reviews.map((r) => r.sha));
  if (reviewed.has(args.headSha)) return { mode: "skip", reason: "head 已在已审集合（dedupe 命中）" };
  const valid = args.reviews.filter((r) => args.commitShas.has(r.sha));
  if (valid.length === 0) return { mode: "full", reason: "无有效历史标记（首审或 force-push 清空历史）" };
  const latest = [...valid].sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1))[0]!;
  if (hasBlockerOrMajor(latest.body)) {
    return { mode: "full", reason: "上条有效 review 含 blocker/major，回退全量重审（block 继承：旧意见的解除依据只能来自全量）" };
  }
  return { mode: "delta", base: latest.sha, latestReviewId: latest.id };
}

export async function listBotReviews(client: Octokit, { owner, repo, pullNumber }: PrRef): Promise<BotReview[]> {
  const reviews = await client.paginate(client.rest.pulls.listReviews, { owner, repo, pull_number: pullNumber });
  return parseBotReviews(reviews);
}

export async function listCommitShas(client: Octokit, { owner, repo, pullNumber }: PrRef): Promise<Set<string>> {
  const commits = await client.paginate(client.rest.pulls.listCommits, { owner, repo, pull_number: pullNumber });
  return new Set(commits.map((c) => c.sha as string));
}

// compare 单响应 files 上限（官方口径约 300）：超限不硬拼，回退全量（spec §二.5）
const COMPARE_FILES_LIMIT = 300;

// 增量区间 diff：compare API（files 条目与 pulls.listFiles 同形）→ fileToDiffBlock 原样复用拼装。
// 任何失败上抛（调用方回退全量）；空区间 / 超单响应上限同样上抛——前者无增量可言，后者超出本模块职责
export async function fetchDeltaDiff(client: Octokit, ref: PrRef & { headSha: string }, base: string): Promise<string> {
  const { data } = await client.rest.repos.compareCommits({
    owner: ref.owner,
    repo: ref.repo,
    base,
    head: ref.headSha,
  });
  const files = (data.files ?? []) as PrFile[];
  if (files.length === 0) throw new Error(`compare ${base}..${ref.headSha} 无文件差异（空区间不构成增量审查）`);
  if (files.length >= COMPARE_FILES_LIMIT) {
    throw new Error(`compare files ${files.length} ≥ 单响应上限 ${COMPARE_FILES_LIMIT}，不硬拼（spec §二.5 回退全量）`);
  }
  return files.map((f) => fileToDiffBlock(f)).join("\n");
}
