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

export async function hasReviewed(
  client: Octokit,
  { owner, repo, pullNumber }: PrRef,
  headSha: string,
): Promise<boolean> {
  const marker = reviewMarker(headSha);
  const reviews = await client.paginate(client.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: pullNumber,
  });
  return reviews.some((r) => typeof r.body === "string" && r.body.includes(marker));
}
