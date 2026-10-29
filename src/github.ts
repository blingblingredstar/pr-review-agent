// GitHub API 封装：拉 PR diff、发 review。只依赖 octokit，便于 eval 时 mock（见 docs/architecture.md）。
import { Octokit } from "octokit";
import type { ReviewResult } from "./review.ts";

export type PrRef = { owner: string; repo: string; pullNumber: number };

export function getOctokit(): Octokit {
  const { GITHUB_TOKEN } = process.env;
  if (!GITHUB_TOKEN) {
    throw new Error("缺少环境变量 GITHUB_TOKEN（PAT，需 repo 权限，参照 .env.example）");
  }
  return new Octokit({ auth: GITHUB_TOKEN });
}

export async function fetchPr(
  client: Octokit,
  { owner, repo, pullNumber }: PrRef,
): Promise<{ diff: string; headSha: string }> {
  const [meta, diff] = await Promise.all([
    client.rest.pulls.get({ owner, repo, pull_number: pullNumber }),
    client.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      mediaType: { format: "diff" },
    }),
  ]);
  return { diff: String(diff.data), headSha: meta.data.head.sha };
}

const SEVERITY_ORDER = ["blocker", "major", "minor", "nit"] as const;

function summaryBody(result: ReviewResult): string {
  const bySeverity = SEVERITY_ORDER.map((s) => `${s}×${result.comments.filter((c) => c.severity === s).length}`)
    .filter((s) => !s.endsWith("×0"))
    .join(" / ");
  return [
    `🤖 pr-review-agent 审查意见（共 ${result.comments.length} 条${bySeverity ? `：${bySeverity}` : ""}）`,
    "",
    "<!-- pr-review-agent -->",
  ].join("\n");
}

export async function postReview(
  client: Octokit,
  { owner, repo, pullNumber, commitId }: PrRef & { commitId: string },
  result: ReviewResult,
): Promise<void> {
  const comments = result.comments.map((c) => ({
    path: c.file,
    line: c.line,
    side: "RIGHT" as const,
    body: `**[${c.severity}]** ${c.body}`,
  }));
  const summary = summaryBody(result);
  try {
    await client.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: commitId,
      event: "COMMENT",
      body: summary,
      comments,
    });
  } catch (err) {
    // 模型给的 (file, line) 可能不在 diff 内 → GitHub 返回 422。降级为全部意见写进 review body。
    if (!isStatus(err, 422)) throw err;
    const fallback = [
      summary,
      "",
      "> 部分意见的行号不在 diff 内，无法行内定位，全部列在下面：",
      ...result.comments.map((c) => `- \`${c.file}:${c.line}\` **[${c.severity}]** ${c.body}`),
    ].join("\n");
    await client.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: commitId,
      event: "COMMENT",
      body: fallback,
    });
  }
}

function isStatus(err: unknown, status: number): boolean {
  return typeof err === "object" && err !== null && "status" in err && (err as { status?: unknown }).status === status;
}
