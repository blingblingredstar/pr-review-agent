// GitHub API 封装：拉 PR diff、发 review。只依赖 octokit，便于 eval 时 mock（见 docs/architecture.md）。
import { Octokit } from "octokit";
import type { ReviewComment, ReviewResult } from "./review.ts";
import { diffCoveredLines, pathVariants } from "./diff.ts";
import { reviewMarker } from "./dedupe.ts";

export type PrRef = { owner: string; repo: string; pullNumber: number };

// pr-review 状态的 Details 深链（#148）：DASHBOARD_PANEL_URL 配置时，状态带 target_url 指向观测面板
// `#pr<N>`——PR 页的 pr-review 检查一键看到本 PR 的运行详情（「View deployment」按钮指向 Vercel 部署
// URL 不可定制，双项目拓扑下只有 dashboard 项目那条能打开面板；本深链是永远指向生产面板的单一入口）。
// 未配置 = 无 target_url，现状不变；域名走 Vercel env 不进仓库文档（#124 占位约定——它经公开的
// commit status API 可见，但其后是 Vercel Auth SSO + fail-closed 门，公开不增加可触达面）
export function panelTargetUrl(pullNumber: number, base: string | undefined = process.env.DASHBOARD_PANEL_URL): string | undefined {
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}/runs.html#pr${pullNumber}`;
}

// 审查生命周期 status（D017）：审查中 pending、完成 success、失败 failure。
// 与 review-threads.yml 的线程状态（context: review-threads）分离，二者共同构成合并闸门——
// pending 补上「review 尚未发布」的窗口期（PR #9 合并瞬间意见落地的竞态）；转 public 后作为 required check 硬闸门
export async function setReviewStatus(
  client: Octokit,
  { owner, repo, pullNumber, sha }: PrRef & { sha: string },
  state: "pending" | "success" | "failure",
  description: string,
): Promise<void> {
  const targetUrl = panelTargetUrl(pullNumber);
  await client.rest.repos.createCommitStatus({
    owner,
    repo,
    sha,
    state,
    context: "pr-review",
    description: description.slice(0, 140),
    ...(targetUrl ? { target_url: targetUrl } : {}),
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
): Promise<{ diff: string; headSha: string; title: string; body: string }> {
  // meta 与 diff 并行（正常 PR 行为与延迟不变）。Promise.allSettled 全程接管两个 Promise：
  // 非 406 抛出路径上不会留下无人接管的 meta rejection（unhandled rejection 会砸掉 Vercel 函数）
  const [metaSettled, diffSettled] = await Promise.allSettled([
    client.rest.pulls.get({ owner, repo, pull_number: pullNumber }),
    client.rest.pulls.get({ owner, repo, pull_number: pullNumber, mediaType: { format: "diff" } }),
  ]);
  if (diffSettled.status === "fulfilled") {
    if (metaSettled.status === "rejected") throw metaSettled.reason;
    const meta = metaSettled.value.data;
    // title/body 随 meta 免费带回（D029 任务上下文的原料）；GitHub 类型 body 可为 null
    return { diff: String(diffSettled.value.data), headSha: meta.head.sha, title: meta.title ?? "", body: meta.body ?? "" };
  }
  const diffErr = diffSettled.reason;
  if (!isStatus(diffErr, 406)) throw diffErr;
  // 超大 PR 兜底（D025）：diff 形态有 20,000 行硬上限，超限 406 too_large——审查原本只能失败告终。
  // 判断依据只有 406 本身（meta 的增删行数与含上下文的 diff 行数之间没有安全换算，hunk 散布的 context 放大 1×~11×，与 D025/spec 口径一致）
  if (metaSettled.status === "rejected") throw metaSettled.reason;
  const meta = metaSettled.value.data;
  console.log(
    `[fetchPr] diff API 406（超大 PR），切 files 分页拼合：changed_files=${meta.changed_files ?? "未知"} +${meta.additions ?? "?"}/-${meta.deletions ?? "?"}`,
  );
  const diff = await assembleDiffViaFiles(client, { owner, repo, pullNumber }, meta.changed_files);
  return { diff, headSha: meta.head.sha, title: meta.title ?? "", body: meta.body ?? "" };
}

// files API 单页容量与翻页上限：GitHub 端 files 列表硬上限 3000 文件（30 页 × 100）
const FILES_PER_PAGE = 100;
const FILES_MAX_PAGES = 30;

export type PrFile = {
  filename: string;
  previous_filename?: string;
  status: string; // added / removed / modified / renamed / copied / changed / unchanged
  additions: number;
  deletions: number;
  patch?: string; // 超大单文件与二进制文件不给 patch
};

// files API 的 patch 就是 unified hunk（@@ 起），包上标准头即成可解析的 diff 块：
// diffCoveredLines / truncateDiff / splitByLocatable / diffTouchedPaths 全部原样消费，下游口径不变。
// 删除文件发 +++ /dev/null——diffCoveredLines 对纯删除文件的既有语义（跳过，行内评论必 422）自动生效
export function fileToDiffBlock(file: PrFile): string {
  const oldPath = file.previous_filename ?? file.filename;
  const header = `diff --git a/${oldPath} b/${file.filename}`;
  if (!file.patch) {
    // 头行必须保留：路径仍进 diffTouchedPaths——非删除文件由 zipball 上下文（D023）兜全文；
    // 删除文件 head 快照里没有旧内容可兜（需 base 归档，不值得），上下文层会标注「不在 head 快照中」
    const tag = file.status === "removed" ? "已删除，" : "";
    return `${header}\n[diff 截断] 省略 ${file.filename}（${tag}files API 未提供 patch，+${file.additions}/-${file.deletions}）`;
  }
  return [
    header,
    file.status === "added" ? "--- /dev/null" : `--- a/${oldPath}`,
    file.status === "removed" ? "+++ /dev/null" : `+++ b/${file.filename}`,
    file.patch,
  ].join("\n");
}

async function assembleDiffViaFiles(client: Octokit, { owner, repo, pullNumber }: PrRef, changedFiles: number | undefined): Promise<string> {
  const blocks: string[] = [];
  let exhausted = false;
  for (let page = 1; page <= FILES_MAX_PAGES; page++) {
    const { data } = await client.rest.pulls.listFiles({ owner, repo, pull_number: pullNumber, per_page: FILES_PER_PAGE, page });
    for (const file of data) blocks.push(fileToDiffBlock(file as PrFile));
    if (data.length < FILES_PER_PAGE) {
      exhausted = true;
      break;
    }
  }
  // 截断判定用 meta.changed_files 对账而非「满页即超限」：恰好 3000 文件时 30 页全满但并无省略，
  // 假的「非全量」信号会诱导模型写「可能遗漏」（PR #27 自审意见）。changed_files 未知时保守给省略行；
  // 审查期间 PR 有新推送导致对账轻微失真时，方向是「多提示非全量」——宁可保守不装全量
  if (!exhausted && (changedFiles === undefined || blocks.length < changedFiles)) {
    blocks.push(`[diff 截断] 文件数超过 ${FILES_MAX_PAGES * FILES_PER_PAGE}（files API 上限），其余文件未列出`);
  }
  return blocks.join("\n");
}

const SEVERITY_ORDER = ["blocker", "major", "minor", "nit"] as const;

function summaryBody(result: ReviewResult, headSha: string, incrementalBase: string | null = null): string {
  const bySeverity = SEVERITY_ORDER.map((s) => `${s}×${result.comments.filter((c) => c.severity === s).length}`)
    .filter((s) => !s.endsWith("×0"))
    .join(" / ");
  return [
    `🤖 pr-review-agent 审查意见（共 ${result.comments.length} 条${bySeverity ? `：${bySeverity}` : ""}）`,
    // 增量审查（D032）人工可读行：与隐藏标记互为印证（标记 base: 键记录同一信息）
    incrementalBase ? `增量区间 \`${incrementalBase.slice(0, 7)}..${headSha.slice(0, 7)}\`（此前 SHA 已审，仅审区间 diff）` : "",
    reviewMarker(headSha, incrementalBase),
  ]
    .filter(Boolean)
    .join("\n");
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

// 发布门槛（D032 §二.6）：blocker/major 行内必报（可定位 → 行内线程，不可定位 → body 降级列表，现状语义）；
// minor/nit 不再逐条行内，折叠进 body `<details>` 汇总段（逐条一行、与降级意见列表同构、机器可解析）——
// 线程只留给需要人介入的信号，resolve 闭环负担不随噪音增长；全量/增量统一生效，不为增量单开一支。
// 层位在发布层不进 prompt：模型 schema 照常全量输出全部 severity，promptHash 红线零接触。
// REQUEST_CHANGES 判定收窄为「有 blocker/major」（D017 收窄非翻案：block 的本意就是需要人介入）
export async function postReview(
  client: Octokit,
  { owner, repo, pullNumber, commitId }: PrRef & { commitId: string },
  result: ReviewResult,
  diff: string,
  opts?: { incrementalBase?: string | null },
): Promise<{ inline: number; degraded: number; folded: number }> {
  const blocking = result.comments.filter((c) => c.severity === "blocker" || c.severity === "major");
  const minorish = result.comments.filter((c) => c.severity === "minor" || c.severity === "nit");
  const { inline, degraded } = splitByLocatable({ comments: blocking }, diff);
  const comments = inline.map(({ comment: c, path }) => ({
    path,
    line: c.line,
    side: "RIGHT" as const,
    body: `**[${c.severity}]** ${c.body}`,
  }));
  const summary = summaryBody(result, commitId, opts?.incrementalBase ?? null);
  // 折叠段与降级列表同构：逐条一行 `- \`file:line\` **[severity]** 全文`，机器可解析——
  // 意见处置口径（AGENTS.md）要求折叠段与降级列表同标准逐条核对留痕
  const foldBlock = minorish.length
    ? [
        "",
        `<details>`,
        `<summary>minor/nit ×${minorish.length}（不进线程闭环，处置口径见 AGENTS.md「意见闭环」）</summary>`,
        "",
        ...minorish.map((c) => `- \`${c.file}:${c.line}\` **[${c.severity}]** ${c.body}`),
        `</details>`,
      ].join("\n")
    : "";
  // 结构化块拼装：块间 \n\n（可选块整体缺席才不进数组，块内部的空行分隔符不受影响）
  const bodyBlocks = [summary];
  if (degraded.length) {
    bodyBlocks.push(
      [
        "> 以下意见的行号不在 diff 内，无法行内定位（无法进入意见闭环线程），处理时请对照文件：",
        ...degraded.map((c) => `- \`${c.file}:${c.line}\` **[${c.severity}]** ${c.body}`),
      ].join("\n"),
    );
  }
  if (minorish.length) bodyBlocks.push(foldBlock);
  const body = bodyBlocks.join("\n\n");
  const reviewEvent = blocking.length > 0 ? "REQUEST_CHANGES" : "COMMENT";
  // 实际落点计数：422 回落全量降级后 inline=0——日志与 pr-review status 必须反映真实落点
  // （行内意味着可闭环线程，降级意味着需人工看 body），不能沿用预定位切分；folded = 折叠进 body 的 minor/nit
  let posted = { inline: inline.length, degraded: degraded.length, folded: minorish.length };
  // 统一提交通道：REQUEST_CHANGES 被 403（无写权限）/ 422（自家 PR 不能 request changes on own pull request）拒绝时
  // 回退 COMMENT——意见不丢，只降级为不 block。dogfood（bot = PR 作者）场景恒走回退，多仓产品化时原生生效
  const createReviewWithFallback = async (event: "COMMENT" | "REQUEST_CHANGES", reviewBody: string, withComments: boolean) => {
    const payload = {
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: commitId,
      event,
      body: reviewBody,
      comments: withComments ? comments : [],
    };
    try {
      await client.rest.pulls.createReview(payload);
      return;
    } catch (err) {
      // 403 = 无写权限；422 可能是自家 PR 拒绝，也可能是行内意见行号非法（该场景回退 COMMENT 会再 422，
      // 落到外层全量降级——行为正确但日志归因到 REQUEST_CHANGES，排查时注意）。无条件回退 COMMENT：意见不丢，只降级为不 block。
      // dogfood（bot = PR 作者）场景恒走此回退，多仓产品化（bot ≠ 作者）时原生生效
      if (event === "REQUEST_CHANGES" && (isStatus(err, 403) || isStatus(err, 422))) {
        console.warn(`[github] REQUEST_CHANGES 被拒（${isStatus(err, 403) ? "403 无写权限" : "422 自家 PR 或行号非法"}），回退 COMMENT`);
        await client.rest.pulls.createReview({ ...payload, event: "COMMENT" });
        return;
      }
      throw err;
    }
  };
  try {
    await createReviewWithFallback(reviewEvent, body, true);
  } catch (err) {
    // 预定位仍有漏网（或 422 的其他原因）→ 整体降级为全部意见写进 review body，保证不丢意见
    if (!isStatus(err, 422)) throw err;
    const fallback = [
      summary,
      "",
      "> 部分意见的行号不在 diff 内，无法行内定位，全部列在下面：",
      ...result.comments.map((c) => `- \`${c.file}:${c.line}\` **[${c.severity}]** ${c.body}`),
    ].join("\n");
    // 降级只改意见落点（全部进 body），block 语义不变：有 blocker/major 仍 REQUEST_CHANGES
    await createReviewWithFallback(reviewEvent, fallback, false);
    posted = { inline: 0, degraded: result.comments.length, folded: 0 };
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

// 单 issue 拉取硬上限（D029）：任务上下文是增强不是依赖，单个 issue 不能占满 prepare 阶段墙钟
//（CONTEXT_TIMEOUT_MS 10s 同思路；逐个拉取、通常 0-1 个，5s 足够 GitHub API 正常往返）
export const ISSUE_FETCH_TIMEOUT_MS = 5_000;

// 上一轮意见的行内评论拉取（D035，best-effort）：listCommentsForReview 只含该 review 提交的
// 行内评论（本 agent 自己的产物，量级有限）。任何失败返回 []——调用方降级为只解析 review body 的
// 降级单行，绝不连垮主流程；后续 push 会让旧行内评论失去锚点（line 置空、original_line 保留原定位）
export const REVIEW_COMMENTS_FETCH_TIMEOUT_MS = 5_000;

export async function fetchReviewComments(
  client: Octokit,
  { owner, repo, pullNumber }: PrRef,
  reviewId: number,
): Promise<{ path: string; line: number | null; original_line: number | null; body: string }[]> {
  try {
    const comments = await client.paginate(client.rest.pulls.listCommentsForReview, {
      owner,
      repo,
      pull_number: pullNumber,
      review_id: reviewId,
      request: { signal: AbortSignal.timeout(REVIEW_COMMENTS_FETCH_TIMEOUT_MS) },
    });
    return comments.map((c) => ({
      path: c.path ?? "",
      line: c.line ?? null,
      original_line: c.original_line ?? null,
      body: c.body ?? "",
    }));
  } catch (err) {
    console.warn(`[findings] review ${reviewId} 行内评论拉取失败（best-effort，降级为只解析 body 降级单行）`, err);
    return [];
  }
}

// 任务上下文的 issue 拉取（D029，best-effort）：只取标题与正文（评论噪音大，spec 非目标）。
// 任何失败（网络 / 404 / 超时）返回 null 由编排层跳过该 issue——绝不连垮主流程；
// 指向 PR 的引用（issues API 对 PR 同样返回，带 pull_request 键）不是 issue，跳过防把 PR 描述当需求注入
export async function fetchIssue(
  client: Octokit,
  { owner, repo, issueNumber }: { owner: string; repo: string; issueNumber: number },
): Promise<{ number: number; title: string; body: string } | null> {
  try {
    const { data } = await client.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
      request: { signal: AbortSignal.timeout(ISSUE_FETCH_TIMEOUT_MS) },
    });
    if ("pull_request" in data) {
      console.log(`[task] #${issueNumber} 是 PR 不是 issue，跳过`);
      return null;
    }
    return { number: data.number, title: data.title ?? "", body: data.body ?? "" };
  } catch (err) {
    console.warn(`[task] issue #${issueNumber} 拉取失败（best-effort，跳过该 issue）`, err);
    return null;
  }
}
