import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../scripts/resolve-threads.ts";

test("parseArgs：正常解析 --only / --reply / --yes", () => {
  const p = parseArgs(["acme/repo#1", "--only", "441,442", "--reply", "441=已修复", "--yes"]);
  assert.equal(p.ref, "acme/repo#1");
  assert.equal(p.yes, true);
  assert.deepEqual([...p.only].sort(), [441, 442]);
  assert.equal(p.replies.get(441), "已修复");
});

test("parseArgs：--reply 的值里含 --yes 不会被误当开关", () => {
  // 回复文本恰为 "--yes"：值位被消费，开关判定只看未消费位置
  const p = parseArgs(["acme/repo#1", "--reply", "441=--yes"]);
  assert.equal(p.yes, false);
  assert.equal(p.replies.get(441), "--yes");
  // 真开关在 --reply 之外仍生效
  const p2 = parseArgs(["acme/repo#1", "--reply", "441=--yes", "--yes"]);
  assert.equal(p2.yes, true);
});

test("parseArgs：--only 缺值 / 纯分隔符 / --reply 空文本 / 空 id 均报错", () => {
  assert.throws(() => parseArgs(["r#1", "--only"]), /--only 需要逗号分隔/);
  assert.throws(() => parseArgs(["r#1", "--only", ","]), /没有解析出任何线程 id/);
  assert.throws(() => parseArgs(["r#1", "--reply", "441="]), /非空id=非空文本/);
  assert.throws(() => parseArgs(["r#1", "--reply", "=文本"]), /非空id=非空文本/);
  assert.throws(() => parseArgs(["r#1", "--reply"]), /非空id=非空文本/);
  assert.throws(() => parseArgs(["r#1", "--reply", "abc=x"]), /不是合法的线程 databaseId/);
  assert.throws(() => parseArgs(["r#1", "--reply", "-1=x"]), /不是合法的线程 databaseId/);
});

test("parseArgs：无参数时全默认（列表模式）", () => {
  const p = parseArgs(["acme/repo#1"]);
  assert.equal(p.yes, false);
  assert.equal(p.only.size, 0);
  assert.equal(p.replies.size, 0);
});

test("parseArgs：多个 --only 合并，值位均被消费；非 id 值报错", () => {
  const p = parseArgs(["acme/repo#1", "--only", "441", "--only", "442", "--yes"]);
  assert.deepEqual([...p.only].sort((a, b) => a - b), [441, 442]);
  assert.equal(p.yes, true);
  // 第二个 --only 的值位被消费：--yes 在这里按值解析并因非 id 报错，而不是漏成开关
  assert.throws(() => parseArgs(["acme/repo#1", "--only", "441", "--only", "--yes"]), /不是合法的线程 databaseId/);
  assert.throws(() => parseArgs(["acme/repo#1", "--only", "abc"]), /不是合法的线程 databaseId/);
  assert.throws(() => parseArgs(["acme/repo#1", "--only", "441,abc"]), /不是合法的线程 databaseId/);
});

// —— #140 裁定台账 ——

import { appendRuling, buildRulingRow, rulingKey, severityFromBody } from "../scripts/resolve-threads.ts";

test("parseArgs：--verdict 合法标签解析、可多次合并、值位消费防 --yes 误判", () => {
  const p = parseArgs(["acme/repo#1", "--only", "441", "--verdict", "441=fixed", "--reply", "441=已修", "--yes"]);
  assert.equal(p.verdicts.get(441), "fixed");
  const p2 = parseArgs(["acme/repo#1", "--verdict", "441=wontfix", "--verdict", "442=false-positive"]);
  assert.equal(p2.verdicts.get(441), "wontfix");
  assert.equal(p2.verdicts.get(442), "false-positive");
  // 值恰为 "--yes" 时按值消费，不当开关
  const p3 = parseArgs(["acme/repo#1", "--verdict", "441=wontfix"]);
  assert.equal(p3.yes, false);
  // 非法标签 / 缺值 / 坏 id 报错
  assert.throws(() => parseArgs(["r#1", "--verdict", "441=maybe"]), /id=fixed\|wontfix\|false-positive/);
  assert.throws(() => parseArgs(["r#1", "--verdict"]), /id=fixed\|wontfix\|false-positive/);
  assert.throws(() => parseArgs(["r#1", "--verdict", "abc=fixed"]), /不是合法的线程 databaseId/);
  assert.throws(() => parseArgs(["r#1", "--verdict", "=fixed"]), /id=fixed\|wontfix\|false-positive/); // 空 id 走标签校验在前
  assert.throws(() => parseArgs(["r#1", "--verdict", "-1=fixed"]), /不是合法的线程 databaseId/);
});

test("parseArgs：--backfill 与写动作混用报错", () => {
  assert.throws(() => parseArgs(["r#1", "--backfill", "--yes"]), /只读列表模式/);
  assert.throws(() => parseArgs(["r#1", "--backfill", "--verdict", "441=fixed"]), /只读列表模式/);
  assert.equal(parseArgs(["r#1", "--backfill"]).backfill, true);
});

test("severityFromBody：识别 **[sev]** 前缀，非 bot 意见为 null", () => {
  assert.equal(severityFromBody("**[major]** 这里有竞态"), "major");
  assert.equal(severityBodyFromNone(), null);
  function severityBodyFromNone(): string | null {
    return severityFromBody("普通回复文本");
  }
  // 折叠/降级行格式（- `f:1` **[minor]** …）只存在于 review body，不进线程评论——此处应判 null
  assert.equal(severityFromBody("- `a.ts:1` **[minor]** 折叠行"), null);
});

test("appendRuling：追加一行、同 key 幂等跳过、坏行不阻断、续行补换行", () => {
  const row = (id: number, verdict: string) =>
    buildRulingRow({
      ts: "2026-11-12T00:00:00.000Z",
      repo: "acme/repo",
      pr: 26,
      threadCommentId: id,
      verdict: verdict as never,
      reason: "理由",
      severity: "major",
      confidence: null,
      file: "src/a.ts",
      line: 12,
      permalink: "https://github.com/acme/repo/pull/26#discussion_r1",
      source: "ruling",
    });
  const first = appendRuling("", row(441, "fixed"));
  assert.match(first, /"verdict":"fixed"/);
  assert.ok(first.endsWith("\n"), "行尾应有换行");
  // 同 (repo, pr, threadCommentId) 重复落账被跳过
  assert.equal(appendRuling(first, row(441, "wontfix")), first);
  // 不同 id 正常追加
  const two = appendRuling(first, row(442, "wontfix"));
  assert.equal(two.split("\n").filter(Boolean).length, 2);
  // 既有内容无尾换行时补上再追加（不会粘连两行 JSON）
  assert.equal(appendRuling('{"x":1}', row(443, "false-positive")).split("\n").filter(Boolean).length, 2);
  // 坏行不算已有裁定，也不抛错
  const withBad = "oops-not-json\n" + first;
  assert.equal(appendRuling(withBad, row(441, "fixed")).split("\n").filter(Boolean).length, 2);
  assert.equal(rulingKey({ repo: "acme/repo", pr: 26, threadCommentId: 441 }), "acme/repo#26/441");
});
