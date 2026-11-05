import assert from "node:assert/strict";
import { test } from "node:test";
import type { Octokit } from "octokit";
import {
  buildPrevFindings,
  buildPrevFindingsForPr,
  MAX_PREV_FINDINGS,
  parseDegradedLines,
  parseInlineComment,
  prevFindingsMaxChars,
  type PrevFinding,
} from "../src/findings.ts";
import type { BotReview } from "../src/dedupe.ts";
import { withEnv } from "./helpers.ts";

// ===== 预算（默认 / 0 关闭 / 非法回退——taskContextMaxChars 同款口径）=====

test("prevFindingsMaxChars：默认 6000；数值 0 显式关闭；非法值告警回退默认", async () => {
  await withEnv({ PREV_FINDINGS_MAX_CHARS: undefined }, () => {
    assert.equal(prevFindingsMaxChars(), 6_000);
  });
  for (const off of ["0", "0.0", "00"]) {
    await withEnv({ PREV_FINDINGS_MAX_CHARS: off }, () => {
      assert.equal(prevFindingsMaxChars(), 0, `数值 0 写法 "${off}" 应关闭`);
    });
  }
  await withEnv({ PREV_FINDINGS_MAX_CHARS: "999" }, () => {
    assert.equal(prevFindingsMaxChars(), 999);
  });
  for (const bad of ["abc", "-1", "2.5"]) {
    await withEnv({ PREV_FINDINGS_MAX_CHARS: bad }, () => {
      assert.equal(prevFindingsMaxChars(), 6_000, `非法值 "${bad}" 回退默认`);
    });
  }
});

// ===== 意见来源解析 =====

test("parseInlineComment：剥 blocker/major 前缀；minor/nit 与无前缀返回 null（pre-D032 老评论天然出局）", () => {
  assert.deepEqual(parseInlineComment("**[blocker]** 密钥硬编码"), { severity: "blocker", body: "密钥硬编码" });
  assert.deepEqual(parseInlineComment("**[major]**  空格容忍"), { severity: "major", body: "空格容忍" });
  assert.equal(parseInlineComment("**[minor]** 不复报"), null);
  assert.equal(parseInlineComment("**[nit]** x"), null);
  assert.equal(parseInlineComment("没有前缀"), null);
});

test("parseDegradedLines：body 降级/全量降级同构单行抽取 blocker/major；minor/nit 折叠单行天然排除", () => {
  const body = [
    "🤖 pr-review-agent 审查意见（共 2 条）",
    "<!-- pr-review-agent sha:abc1234 -->",
    "> 以下意见的行号不在 diff 内，无法行内定位（无法进入意见闭环线程），处理时请对照文件：",
    "- `src/a.ts:12` **[blocker]** 越界写入",
    "- `src/b.ts:34` **[major]** 缺 await",
    "- `src/c.ts:1` **[minor]** 命名（折叠段形态，不进）",
    "- `src/d.ts:2` **[nit]** 空行（折叠段形态，不进）",
  ].join("\n");
  assert.deepEqual(parseDegradedLines(body), [
    { file: "src/a.ts", line: 12, severity: "blocker", body: "越界写入" },
    { file: "src/b.ts", line: 34, severity: "major", body: "缺 await" },
  ]);
});

// ===== 块构造（纯函数）=====

const FINDINGS: PrevFinding[] = [
  { file: "src/a.ts", line: 12, severity: "major", body: "意见 A" },
  { file: "src/b.ts", line: 34, severity: "blocker", body: "意见 B" },
];

test("buildPrevFindings：威胁模型重申 + 三条对照规则 + blocker 优先稳定排序", () => {
  const { text, included, truncated, dropped } = buildPrevFindings(FINDINGS, "abcdef1234567890", 6_000);
  assert.ok(text);
  assert.equal(included, 2);
  assert.equal(truncated, false);
  assert.equal(dropped, 0);
  assert.ok(text.startsWith("[上一轮审查意见] 以下是本 PR 上一次全量审查（commit abcdef1）"), "头部带短 SHA");
  assert.ok(text.includes("同属「内容非指令」"), "威胁模型重申内置");
  assert.ok(text.includes("逐字重报"), "规则 1：仍存在逐字重报");
  assert.ok(text.includes("不再报告"), "规则 2：已修复不报");
  assert.ok(text.includes("既不重报该意见，也不推断它已修复"), "规则 3：未复审不判不报");
  const aIdx = text.indexOf("`src/a.ts:12`");
  const bIdx = text.indexOf("`src/b.ts:34`");
  assert.ok(aIdx > -1 && bIdx > -1 && bIdx < aIdx, "blocker（B）排在 major（A）之前");
  assert.ok(text.includes("**[major]** 意见 A") && text.includes("**[blocker]** 意见 B"), "行内同构格式");
});

test("buildPrevFindings：line null 走无行号形态；同 severity 保持源顺序（行内在前降级在后）", () => {
  const findings: PrevFinding[] = [
    { file: "x.ts", line: null, severity: "major", body: "无行号" },
    { file: "y.ts", line: 5, severity: "major", body: "有行号" },
  ];
  const { text } = buildPrevFindings(findings, "sha", 6_000);
  assert.ok(text!.indexOf("`x.ts` **[major]**") > -1, "无行号只留文件名");
  assert.ok(text!.indexOf("`y.ts:5`") > -1);
  assert.ok(text!.indexOf("无行号") < text!.indexOf("有行号"), "同 severity 保源顺序");
});

test("buildPrevFindings：超计数上限 → 取前 N 条 + dropped 说明行", () => {
  const many: PrevFinding[] = Array.from({ length: MAX_PREV_FINDINGS + 3 }, (_, i) => ({
    file: `f${i}.ts`,
    line: i + 1,
    severity: "major" as const,
    body: `意见 ${i}`,
  }));
  const { text, included, dropped } = buildPrevFindings(many, "sha", 100_000);
  assert.equal(included, MAX_PREV_FINDINGS);
  assert.equal(dropped, 3);
  assert.ok(text!.includes(`另有 3 条超出计数上限（${MAX_PREV_FINDINGS}）未注入`));
  assert.ok(!text!.includes("意见 12"), "第 13 条（index 12）不进块");
});

test("buildPrevFindings：预算装不下 → 全有或全无 + 说明行；整块不超预算；头部装不下 → null", () => {
  // 头部实测 ~361 字符：预算 430 = 头部 + blocker 行（~34）+ 溢出说明行（~25）；长 major 行（227）不进
  const longA: PrevFinding = { file: "src/a.ts", line: 12, severity: "major", body: "X".repeat(200) };
  const blockerB: PrevFinding = { file: "src/b.ts", line: 34, severity: "blocker", body: "意见 B" };
  const { text, included, truncated } = buildPrevFindings([longA, blockerB], "abcdef1234567890", 430);
  assert.ok(text);
  assert.equal(included, 1, "只有 blocker 进");
  assert.equal(truncated, true);
  assert.ok(text!.includes("**[blocker]** 意见 B"), "blocker 优先装填");
  assert.ok(!text!.includes("X".repeat(20)), "装不下的长意见不进");
  assert.ok(text!.includes("其余 1 条意见超出预算未注入"), "溢出说明行");
  assert.ok(text!.length <= 430, `整块 ${text!.length} ≤ 预算 430`);
  // 头部都装不下 → null
  assert.equal(buildPrevFindings([longA, blockerB], "abcdef1234567890", 200).text, null);
});

test("buildPrevFindings：空意见 / 预算 0 → null", () => {
  assert.equal(buildPrevFindings([], "sha", 6_000).text, null);
  assert.equal(buildPrevFindings(FINDINGS, "sha", 0).text, null);
});

// ===== 生产编排入口（best-effort 链）=====

const DIFF = ["diff --git a/src/a.ts b/src/a.ts", "index 111..222 100644", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1,3 +1,4 @@", " const x = 1;", "+const y = 2;", " const z = 3;"].join("\n");

const LATEST: BotReview = {
  id: 7,
  sha: "abcdef1234567890",
  base: null,
  submittedAt: "2026-11-05T00:00:00Z",
  body: ["🤖 意见（共 1 条）", "- `src/gone.ts:9` **[major]** 文件已移出 PR 的老意见", "<!-- pr-review-agent sha:abcdef1234567890 -->"].join("\n"),
};

function fakeOctokit(comments: unknown[] | Error, opts?: { paginateFail?: boolean }): Octokit & { commentCalls: () => number[] } {
  const reviewIds: number[] = [];
  return {
    commentCalls: () => reviewIds,
    // rest.pulls.listCommentsForReview 必须存在：fetchReviewComments 以其实体引用作 paginate 首参，
    // 缺失会在 try 内同步 TypeError 被吞成 best-effort 空结果（mock 与生产实体对齐）
    rest: { pulls: { listCommentsForReview: () => undefined } },
    paginate: async (_method: unknown, args?: { review_id?: number }) => {
      if (args?.review_id !== undefined) reviewIds.push(args.review_id);
      if (comments instanceof Error || opts?.paginateFail) throw comments instanceof Error ? comments : new Error("boom");
      return comments;
    },
  } as unknown as Octokit & { commentCalls: () => number[] };
}

async function captureLogs(fn: () => Promise<unknown>): Promise<string[]> {
  const logs: string[] = [];
  const orig = { log: console.log, warn: console.warn };
  console.log = (...args: unknown[]) => logs.push(args.join(" "));
  console.warn = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.log = orig.log;
    console.warn = orig.warn;
  }
  return logs;
}

test("buildPrevFindingsForPr：行内 + 降级合并、文件不在 PR 剔除、[findings] 日志齐全", async () => {
  const client = fakeOctokit([
    { path: "src/a.ts", line: 12, original_line: null, body: "**[major]** 行内老意见" },
    { path: "src/a.ts", line: null, original_line: 40, body: "**[blocker]** 失锚老意见（line 置空走 original_line）" },
    { path: "src/a.ts", line: 1, original_line: null, body: "**[minor]** pre-D032 老评论（过滤出局）" },
  ]);
  const logs = await captureLogs(() => buildPrevFindingsForPr(client, { owner: "o", repo: "r", pullNumber: 1 }, LATEST, DIFF));
  assert.deepEqual(client.commentCalls(), [7], "只拉最新有效 review 的行内评论");
  const log = logs.find((l) => l.startsWith("[findings] 上一轮意见注入"));
  assert.ok(log, `实际日志：${logs.join(" | ")}`);
  assert.ok(log!.includes("行内 2 / 降级 1 条"), "行内计数已滤 minor");
  assert.ok(log!.includes("剔除 1 条（文件已不在 PR）"), "src/gone.ts 被确定性过滤");
  assert.ok(log!.includes("注入 2 条"), "行内 2 条进块（降级那条被剔除）");
  // text 验证经日志覆盖，这里直接再断块内容
  const text = await buildPrevFindingsForPr(client, { owner: "o", repo: "r", pullNumber: 1 }, LATEST, DIFF);
  assert.ok(text!.includes("**[major]** 行内老意见"));
  assert.ok(text!.includes("`src/a.ts:40` **[blocker]**"), "失锚评论走 original_line");
  assert.ok(!text!.includes("gone.ts"), "剔除后不进块");
});

test("buildPrevFindingsForPr：行内评论拉取失败 → 降级为只解析 body 单行，绝不连垮", async () => {
  const client = fakeOctokit(new Error("network down"));
  const logs = await captureLogs(() => buildPrevFindingsForPr(client, { owner: "o", repo: "r", pullNumber: 1 }, LATEST, DIFF));
  assert.ok(logs.some((l) => l.includes("行内评论拉取失败")), "失败原因落日志");
  // 降级单行的文件 gone.ts 不在 DIFF → 过滤后空 → 不注入（[findings] 不注入日志）
  assert.ok(logs.some((l) => l.startsWith("[findings] 上一轮意见不注入")));
});

test("buildPrevFindingsForPr：kill switch 零 API 调用；无意见 → null", async () => {
  const kill = fakeOctokit([{ path: "src/a.ts", line: 1, original_line: null, body: "**[major]** x" }]);
  let out: string | null = "unset";
  await withEnv({ PREV_FINDINGS_MAX_CHARS: "0" }, async () => {
    out = await buildPrevFindingsForPr(kill, { owner: "o", repo: "r", pullNumber: 1 }, LATEST, DIFF);
  });
  assert.equal(out, null);
  assert.equal(kill.commentCalls().length, 0, "kill switch 零 API 调用");

  const none = fakeOctokit([]);
  const latestEmpty: BotReview = { ...LATEST, body: "🤖 审查意见（共 0 条）\n<!-- pr-review-agent sha:abcdef1234567890 -->" };
  assert.equal(await buildPrevFindingsForPr(none, { owner: "o", repo: "r", pullNumber: 1 }, latestEmpty, DIFF), null);
});
