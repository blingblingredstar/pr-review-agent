import assert from "node:assert/strict";
import { test } from "node:test";
import type { Octokit } from "octokit";
import { fetchIssue, fetchPr, fetchReviewComments, fileToDiffBlock, severityLabels, splitByLocatable } from "../src/github.ts";
import type { ReviewResult } from "../src/review.ts";
import { diffCoveredLines, diffTouchedPaths } from "../src/diff.ts";

const comment = (severity: ReviewResult["comments"][number]["severity"]) => ({
  file: "a.ts",
  line: 1,
  severity,
  body: "x",
});

test("severityLabels：blocker/major 映射标签，minor/nit/空不打", () => {
  assert.deepEqual(severityLabels({ comments: [] }), []);
  assert.deepEqual(severityLabels({ comments: [comment("minor"), comment("nit")] }), []);
  assert.deepEqual(severityLabels({ comments: [comment("blocker"), comment("minor")] }), ["has-blocker"]);
  assert.deepEqual(severityLabels({ comments: [comment("major")] }), ["has-major"]);
  assert.deepEqual(
    severityLabels({ comments: [comment("blocker"), comment("major"), comment("nit")] }),
    ["has-blocker", "has-major"],
  );
});

test("splitByLocatable：行号在 diff 内行内发，变体对照命中，幻觉文件/越界行降级", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1..2 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,2 +10,3 @@",
    " ctx",
    "+added",
    " tail",
  ].join("\n");
  const comment = (file: string, line: number, body = "问题") => ({ file, line, severity: "minor" as const, body });
  const result = { comments: [comment("src/a.ts", 11), comment("a/src/a.ts", 10), comment("src/ghost.ts", 1), comment("src/a.ts", 999)] };
  const { inline, degraded } = splitByLocatable(result, diff);
  assert.deepEqual(inline.map(({ comment: c, path }) => [c.file, c.line, path]), [["src/a.ts", 11, "src/a.ts"], ["a/src/a.ts", 10, "src/a.ts"]]);
  assert.deepEqual(degraded.map((c) => [c.file, c.line]), [["src/ghost.ts", 1], ["src/a.ts", 999]]);
});

// ===== 超大 PR diff 406 兜底（D025）=====

const prFile = (over: Partial<Parameters<typeof fileToDiffBlock>[0]> = {}): Parameters<typeof fileToDiffBlock>[0] => ({
  filename: "src/a.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  patch: "@@ -10,1 +10,2 @@\n ctx\n+added",
  ...over,
});

test("fileToDiffBlock：patch 包上标准头即成可解析 diff，四类 status 口径正确", () => {
  const covered = diffCoveredLines(fileToDiffBlock(prFile()));
  assert.deepEqual([...covered.get("src/a.ts")!].sort((a, b) => a - b), [10, 11]);

  const added = diffCoveredLines(fileToDiffBlock(prFile({ filename: "n.ts", status: "added", patch: "@@ -0,0 +1,1 @@\n+new" })));
  assert.ok(added.get("n.ts")!.has(1));

  // 删除文件 +++ /dev/null → diffCoveredLines 跳过（行内评论必 422 的既有语义自动生效）
  const removed = diffCoveredLines(fileToDiffBlock(prFile({ status: "removed", additions: 0, deletions: 2, patch: "@@ -1,2 +0,0 @@\n-a\n-b" })));
  assert.equal(removed.has("src/a.ts"), false);

  const renamed = fileToDiffBlock(prFile({ filename: "new.ts", previous_filename: "old.ts", status: "renamed" }));
  assert.ok(renamed.startsWith("diff --git a/old.ts b/new.ts"));
  assert.ok(renamed.includes("--- a/old.ts") && renamed.includes("+++ b/new.ts"));
});

test("fileToDiffBlock：patch 缺失发省略块但保留路径头——路径仍进上下文触及清单", () => {
  const block = fileToDiffBlock(prFile({ filename: "big/lock.json", additions: 5000, deletions: 10, patch: undefined }));
  assert.ok(block.startsWith("diff --git a/big/lock.json b/big/lock.json"), "头行必须保留");
  assert.ok(block.includes("[diff 截断] 省略 big/lock.json"));
  assert.deepEqual(diffTouchedPaths(block), ["big/lock.json"], "zipball 上下文按此清单兜全文");
  const removedNoPatch = fileToDiffBlock(prFile({ status: "removed", additions: 0, deletions: 3, patch: undefined }));
  assert.ok(removedNoPatch.includes("省略 src/a.ts（已删除，files API 未提供 patch"), "删除类文件标注已删除——旧内容 head 快照无从兜");
  assert.equal(diffCoveredLines(block).has("big/lock.json"), false, "无 hunk 无覆盖行，不产生行内意见");
});

const error406 = () => {
  const e = new Error("too_large") as Error & { status: number };
  e.status = 406;
  return e;
};

const metaPayload = { head: { sha: "abc1234def" }, changed_files: 102, additions: 103, deletions: 0 };

function fakeClient(opts: { diffError?: Error; pages: Parameters<typeof fileToDiffBlock>[0][][]; changedFiles?: number }): Octokit & { diffCalls: () => number } {
  let diffCalls = 0;
  return {
    diffCalls: () => diffCalls,
    rest: {
      pulls: {
        get: async (params: { mediaType?: { format?: string } }) => {
          if (params.mediaType?.format === "diff") {
            diffCalls++;
            if (opts.diffError) throw opts.diffError;
            return { data: "diff --git a/x b/x\n" };
          }
          return { data: { ...metaPayload, changed_files: opts.changedFiles ?? metaPayload.changed_files } };
        },
        listFiles: async ({ page }: { page: number }) => ({ data: opts.pages[page - 1] ?? [] }),
      },
    },
  } as unknown as Octokit & { diffCalls: () => number };
}

test("fetchPr：diff 406 切 files 分页拼合；省略块路径仍进触及清单", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => prFile({ filename: `f${i}.ts`, patch: "@@ -0,0 +1,1 @@\n+x" }));
  const page2 = [prFile({ filename: "tail.ts" }), prFile({ filename: "binary.bin", patch: undefined })];
  const client = fakeClient({ diffError: error406(), pages: [page1, page2] });
  const { diff, headSha } = await fetchPr(client, { owner: "o", repo: "r", pullNumber: 1 });
  assert.equal(headSha, "abc1234def");
  assert.equal(client.diffCalls(), 1, "406 后切 files 路径，diff 形态只请求一次不重试");
  assert.ok(diff.includes("diff --git a/f0.ts b/f0.ts"), "分页拼合完整");
  assert.ok(diff.includes("diff --git a/binary.bin b/binary.bin") && diff.includes("省略 binary.bin"));
  const touched = diffTouchedPaths(diff);
  assert.equal(touched.length, 102, "100 + 2（patch 缺失的文件也算触及）");
  assert.equal(touched[touched.length - 1], "binary.bin");
});

test("fetchPr：翻满 30 页仍满页 → 附 files 上限省略行；非 406 错误原样抛出；正常路径不受影响", async () => {
  const fullPage = Array.from({ length: 100 }, (_, i) => prFile({ filename: `p${i}.ts`, patch: "@@ -0,0 +1,1 @@\n+x" }));
  const { diff } = await fetchPr(fakeClient({ diffError: error406(), changedFiles: 3100, pages: Array.from({ length: 31 }, () => fullPage) }), {
    owner: "o",
    repo: "r",
    pullNumber: 1,
  });
  assert.ok(diff.includes("文件数超过 3000"), "真超限（changed_files 对账更大）时给省略行");
  assert.equal((diff.match(/diff --git /g) ?? []).length, 3000);
  // 恰好 3000 文件：30 页全满但无省略——「满页即超限」的假信号会诱导模型写「可能遗漏」（自审意见）
  const exact = await fetchPr(fakeClient({ diffError: error406(), changedFiles: 3000, pages: Array.from({ length: 30 }, () => fullPage) }), {
    owner: "o",
    repo: "r",
    pullNumber: 1,
  });
  assert.ok(!exact.diff.includes("文件数超过 3000"), "恰好 3000 不给假省略行");
  assert.equal((exact.diff.match(/diff --git /g) ?? []).length, 3000);

  await assert.rejects(
    fetchPr(fakeClient({ diffError: Object.assign(new Error("boom"), { status: 500 }), pages: [] }), { owner: "o", repo: "r", pullNumber: 1 }),
    /boom/,
  );
  const ok = await fetchPr(fakeClient({ pages: [] }), { owner: "o", repo: "r", pullNumber: 1 });
  assert.equal(ok.diff, "diff --git a/x b/x\n");
  assert.equal(ok.headSha, "abc1234def");
});

// ===== 任务上下文的 issue 拉取（D029）=====

function issueClient(responses: Record<number, unknown>): Octokit & { calls: () => number[] } {
  const calls: number[] = [];
  return {
    calls: () => calls,
    rest: {
      issues: {
        get: async (args: { issue_number: number }) => {
          calls.push(args.issue_number);
          const res = responses[args.issue_number];
          if (res instanceof Error) throw res;
          if (typeof res === "number") throw Object.assign(new Error("err"), { status: res });
          return { data: res };
        },
      },
    },
  } as unknown as Octokit & { calls: () => number[] };
}

test("fetchIssue：取标题与正文（body null 归一空串）；PR 形响应跳过；失败/404/超时 null（best-effort）", async () => {
  const ok = issueClient({ 1: { number: 1, title: "需求标题", body: "需求正文" } });
  assert.deepEqual(await fetchIssue(ok, { owner: "o", repo: "r", issueNumber: 1 }), {
    number: 1,
    title: "需求标题",
    body: "需求正文",
  });

  const nullBody = issueClient({ 2: { number: 2, title: "t", body: null } });
  assert.equal((await fetchIssue(nullBody, { owner: "o", repo: "r", issueNumber: 2 }))!.body, "", "body null → 空串");

  const prShape = issueClient({ 3: { number: 3, title: "PR", body: "PR 描述", pull_request: { html_url: "x" } } });
  const logs: string[] = [];
  const origLog = console.log;
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    assert.equal(await fetchIssue(prShape, { owner: "o", repo: "r", issueNumber: 3 }), null, "指向 PR 的引用不是 issue");
  } finally {
    console.log = origLog;
  }
  assert.ok(logs.some((l) => l.includes("[task] #3 是 PR 不是 issue，跳过")), "跳过留日志");

  const missing = issueClient({});
  assert.equal(await fetchIssue(missing, { owner: "o", repo: "r", issueNumber: 404 }), null, "404 → null 不抛出");

  const failing = issueClient({ 5: new Error("network down") });
  assert.equal(await fetchIssue(failing, { owner: "o", repo: "r", issueNumber: 5 }), null, "网络异常 → null 不抛出");
});

// ============ 上一轮意见行内评论拉取（D035）============

function reviewCommentsClient(comments: unknown[] | Error): Octokit & { calledWith: () => number[] } {
  const reviewIds: number[] = [];
  return {
    calledWith: () => reviewIds,
    // rest.pulls.listCommentsForReview 必须存在（fetchReviewContents 以其实体引用作 paginate 首参）
    rest: { pulls: { listCommentsForReview: () => undefined } },
    paginate: async (_method: unknown, args?: { review_id?: number }) => {
      if (args?.review_id !== undefined) reviewIds.push(args.review_id);
      if (comments instanceof Error) throw comments;
      return comments;
    },
  } as unknown as Octokit & { calledWith: () => number[] };
}

test("fetchReviewComments：字段映射（line 置空走 original_line、body/path 归一空串）；失败 → [] 不抛出（best-effort）", async () => {
  const ok = reviewCommentsClient([
    { path: "src/a.ts", line: 12, original_line: 12, body: "**[major]** x" },
    { path: "src/b.ts", line: null, original_line: 40, body: "**[blocker]** 失锚" },
    { path: undefined, line: undefined, original_line: undefined, body: undefined },
  ]);
  assert.deepEqual(await fetchReviewComments(ok, { owner: "o", repo: "r", pullNumber: 1 }, 7), [
    { path: "src/a.ts", line: 12, original_line: 12, body: "**[major]** x" },
    { path: "src/b.ts", line: null, original_line: 40, body: "**[blocker]** 失锚" },
    { path: "", line: null, original_line: null, body: "" },
  ]);
  assert.deepEqual(ok.calledWith(), [7], "按 review id 拉取");

  const failing = reviewCommentsClient(new Error("boom"));
  const logs: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    assert.deepEqual(await fetchReviewComments(failing, { owner: "o", repo: "r", pullNumber: 1 }, 9), []);
  } finally {
    console.warn = origWarn;
  }
  assert.ok(logs.some((l) => l.includes("行内评论拉取失败")), "失败留日志");
});

// ===== pr-review 状态 Details 深链（#148）=====

import { panelTargetUrl, setReviewStatus } from "../src/github.ts";

test("panelTargetUrl：未配置 undefined，配置后拼接 runs.html#pr<N>，容忍尾斜杠", () => {
  delete process.env.DASHBOARD_PANEL_URL;
  assert.equal(panelTargetUrl(142), undefined);
  process.env.DASHBOARD_PANEL_URL = "https://panel.example.vercel.app";
  assert.equal(panelTargetUrl(142), "https://panel.example.vercel.app/runs.html#pr142");
  process.env.DASHBOARD_PANEL_URL = "https://panel.example.vercel.app/";
  assert.equal(panelTargetUrl(7), "https://panel.example.vercel.app/runs.html#pr7");
  delete process.env.DASHBOARD_PANEL_URL;
});

test("setReviewStatus：配置时带 target_url，未配置不带（现状不变）", async () => {
  const calls: Record<string, unknown>[] = [];
  const client = {
    rest: {
      repos: {
        createCommitStatus: async (args: Record<string, unknown>) => {
          calls.push(args);
        },
      },
    },
  } as unknown as Octokit;
  const ref = { owner: "acme", repo: "demo", pullNumber: 142, sha: "abc123" };

  delete process.env.DASHBOARD_PANEL_URL;
  await setReviewStatus(client, ref, "success", "完成");
  assert.equal("target_url" in calls[0], false, "未配置时不应带 target_url");

  process.env.DASHBOARD_PANEL_URL = "https://panel.example.vercel.app";
  await setReviewStatus(client, ref, "pending", "审查进行中");
  assert.equal(calls[1].target_url, "https://panel.example.vercel.app/runs.html#pr142");
  assert.equal(calls[1].context, "pr-review");
  assert.equal(calls[1].state, "pending");
  delete process.env.DASHBOARD_PANEL_URL;
});
