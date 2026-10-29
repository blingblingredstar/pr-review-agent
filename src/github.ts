// GitHub API 封装：拉 PR diff、发 review。只依赖 octokit，便于 eval 时 mock（见 docs/architecture.md）。
import { Octokit } from "octokit";
import type { ReviewComment, ReviewResult } from "./review.ts";
import { diffCoveredLines, pathVariants } from "./review.ts";
import { reviewMarker } from "./dedupe.ts";

export type PrRef = { owner: string; repo: string; pullNumber: number };

// 审查生命周期 status（D017）：审查中 pending、完成 success、失败 failure。
// 与 review-threads.yml 的线程状态（context: review-threads）分离，二者共同构成合并闸门——
// pending 补上「review 尚未发布」的窗口期（PR #9 合并瞬间意见落地的竞态）；转 public 后作为 required check 硬闸门
export async function setReviewStatus(
  client: Octokit,
  { owner, repo, sha }: PrRef & { sha: string },
  state: "pending" | "success" | "failure",
  description: string,
): Promise<void> {
  await client.rest.repos.createCommitStatus({
    owner,
    repo,
    sha,
    state,
    context: "pr-review",
    description: description.slice(0, 140),
  });
}

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

function summaryBody(result: ReviewResult, headSha: string): string {
  const bySeverity = SEVERITY_ORDER.map((s) => `${s}×${result.comments.filter((c) => c.severity === s).length}`)
    .filter((s) => !s.endsWith("×0"))
    .join(" / ");
  return [
    `🤖 pr-review-agent 审查意见（共 ${result.comments.length} 条${bySeverity ? `：${bySeverity}` : ""}）`,
    "",
    reviewMarker(headSha),
  ].join("\n");
}

// severity → 标签：blocker/major 是需要人介入的信号，minor/nit 常见、打满成噪音。
// 标签随 PR 历史累积，Day 6 eval 可当按时间的审查质量分布数据。
export function severityLabels(result: ReviewResult): string[] {
  const severities = new Set(result.comments.map((c) => c.severity));
  return [severities.has("blocker") && "has-blocker", severities.has("major") && "has-major"].filter(
    (l): l is string => typeof l === "string",
  );
}

// 意见按「行号是否落在 diff 内」拆分：可定位的行内发（进线程、可 resolve 闭环），
// 其余列进 summary body（Day 2 的全量降级会把可定位意见也拖进无线程的 body，逃出意见闭环）。
// covered 的 key 是 diff 头解析出的真实路径；模型报的路径做 a/ b/ 变体对照（照抄 diff 头的情况），
// 不能预先剥前缀——仓库真有顶层 a/ b/ 目录时会误剥导致错误降级。
// inline 带命中变体的 path：发帖必须用 diff 头的真实路径，模型原话可能是 a/src/x.ts 这类带前缀形态（仓库不存在，发帖必 422）
export function splitByLocatable(
  result: ReviewResult,
  diff: string,
): { inline: { comment: ReviewComment; path: string }[]; degraded: ReviewComment[] } {
  const covered = diffCoveredLines(diff);
  const inline: { comment: ReviewComment; path: string }[] = [];
  const degraded: ReviewComment[] = [];
  for (const c of result.comments) {
    const hit = pathVariants(c.file).find((v) => covered.get(v)?.has(c.line));
    // 已知接受：仓库同时存在 x.ts 与 a/x.ts 时，幻觉前缀剥离可能命中另一真实文件——语义歧义无解，碰撞概率远低于全量降级的代价
    if (hit) inline.push({ comment: c, path: hit });
    else degraded.push(c);
  }
  return { inline, degraded };
}

export async function postReview(
  client: Octokit,
  { owner, repo, pullNumber, commitId }: PrRef & { commitId: string },
  result: ReviewResult,
  diff: string,
): Promise<{ inline: number; degraded: number }> {
  const { inline, degraded } = splitByLocatable(result, diff);
  const comments = inline.map(({ comment: c, path }) => ({
    path,
    line: c.line,
    side: "RIGHT" as const,
    body: `**[${c.severity}]** ${c.body}`,
  }));
  const summary = summaryBody(result, commitId);
  const body = degraded.length
    ? [
        summary,
        "",
        "> 以下意见的行号不在 diff 内，无法行内定位（无法进入意见闭环线程），处理时请对照文件：",
        ...degraded.map((c) => `- \`${c.file}:${c.line}\` **[${c.severity}]** ${c.body}`),
      ].join("\n")
    : summary;
  const reviewEvent = result.comments.length > 0 ? "REQUEST_CHANGES" : "COMMENT";
  // 实际落点计数：422 回落全量降级后 inline=0——日志与 pr-review status 必须反映真实落点
  // （行内意味着可闭环线程，降级意味着需人工看 body），不能沿用预定位切分
  let posted = { inline: inline.length, degraded: degraded.length };
  const postReviewRequest = (event: "COMMENT" | "REQUEST_CHANGES", reviewBody: string) =>
    client.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: commitId,
      event,
      body: reviewBody,
      comments,
    });
  try {
    try {
      await postReviewRequest(reviewEvent, body);
    } catch (err) {
      // REQUEST_CHANGES 需要写权限：403 时回退 COMMENT 保住意见本身（降级为不 block，也不丢意见）
      if (isStatus(err, 403) && reviewEvent === "REQUEST_CHANGES") {
        console.warn("[github] REQUEST_CHANGES 发送 403（token 无写权限？），回退 COMMENT 重发");
        await postReviewRequest("COMMENT", body);
      } else {
        throw err;
      }
    }
  } catch (err) {
    // 预定位仍有漏网（或 422 的其他原因）→ 整体降级为全部意见写进 review body，保证不丢意见
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
    posted = { inline: 0, degraded: result.comments.length };
  }
  const labels = severityLabels(result);
  if (labels.length > 0) {
    try {
      await client.rest.issues.addLabels({ owner, repo, issue_number: pullNumber, labels });
    } catch (err) {
      // 评论已发成功，标签失败只告警不连坐
      console.warn(`[github] PR#${pullNumber} 打标签失败（${labels.join(",")}）`, err);
    }
  }
  return posted;
}

function isStatus(err: unknown, status: number): boolean {
  return typeof err === "object" && err !== null && "status" in err && (err as { status?: unknown }).status === status;
}

// 超时降级（docs/decisions.md D011）：LLM 超时后发 issue comment 告知，不带 sha 标记——
// dedupe 只认 review，同 SHA 重投 delivery 仍会重新审查，保留重试余地。
export async function postTimeoutNotice(
  client: Octokit,
  { owner, repo, pullNumber }: PrRef,
  timeoutMs: number,
): Promise<void> {
  await client.rest.issues.createComment({
    owner,
    repo,
    issue_number: pullNumber,
    body: `🤖 pr-review-agent 审查超时：LLM 端点 ${Math.round(timeoutMs / 1000)}s 未返回，本次跳过。重推 commit 或重投 webhook 可重试。`,
  });
}
