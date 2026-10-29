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
});

test("parseArgs：无参数时全默认（列表模式）", () => {
  const p = parseArgs(["acme/repo#1"]);
  assert.equal(p.yes, false);
  assert.equal(p.only.size, 0);
  assert.equal(p.replies.size, 0);
});
