// 幂等去重（docs/decisions.md D010）：审过与否以 GitHub 已有 review 为准——
// review body 内嵌 sha 标记，处理事件前查同 head SHA 是否已有标记，命中即跳过。
// 零基建、跨实例持久；超时通知走 issue comment 不带标记，同 SHA 重投仍可重试。
import type { Octokit } from "octokit";
import type { PrRef } from "./github.ts";

// base：增量审查（D032）时记录区间起点——`sha:` 键语义不变（已审集合推导只看 sha），
// `base:` 是可观测元数据（旧标记缺 base 合法，读取路径容忍）
export function reviewMarker(headSha: string, base?: string | null): string {
  return base
    ? `<!-- pr-review-agent sha:${headSha} base:${base} -->`
    : `<!-- pr-review-agent sha:${headSha} -->`;
}

// 标记解析（本文件是标记的家，增量/去重共用同一解析——hasReviewed 曾用裸 includes("sha:X -->") 匹配，
// 增量标记 "sha:X base:Y -->" 不命中导致同 SHA 重派重复发 review（PR #59 复审 major））
export const MARKER_RE = /<!-- pr-review-agent sha:([0-9a-f]{6,40})(?: base:([0-9a-f]{6,40}))? -->/g;

export type BotReview = {
  id: number;
  sha: string;
  base: string | null;
  submittedAt: string;
  body: string;
};

// 从 review 列表抽取本 agent 的标记。人工 review / 第三方 bot 无此标记天然不参与；
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

export async function hasReviewed(
  client: Octokit,
  { owner, repo, pullNumber }: PrRef,
  headSha: string,
): Promise<boolean> {
  const reviews = await client.paginate(client.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pullNumber,
  });
  // 解析比对而非裸子串：增量标记带 base 后缀，includes 全标记形态会漏判（PR #59 复审 major）
  return parseBotReviews(reviews).some((r) => r.sha === headSha);
}
