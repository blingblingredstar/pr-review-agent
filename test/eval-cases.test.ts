import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCases } from "../evals/cases/index.ts";
import type { EvalCase } from "../evals/score.ts";

// 解析 unified diff：收集每个文件的 diff --git 声明与新侧覆盖行号，并校验每个 hunk 头声明的行数
function parseDiff(diff: string): { files: Set<string>; newLineRanges: Map<string, [number, number]>; errors: string[] } {
  const errors: string[] = [];
  const files = new Set<string>();
  const newLineRanges = new Map<string, [number, number]>();
  let currentFile = "";
  let inHunk = false;
  let newLine = 0;
  let expectOld = 0;
  let expectNew = 0;
  let countOld = 0;
  let countNew = 0;

  const mark = (line: number) => {
    const range = newLineRanges.get(currentFile);
    if (!range) newLineRanges.set(currentFile, [line, line]);
    else {
      range[0] = Math.min(range[0], line);
      range[1] = Math.max(range[1], line);
    }
  };
  const closeHunk = () => {
    if (inHunk && (countOld !== expectOld || countNew !== expectNew)) {
      errors.push(`${currentFile}: hunk 声明 -${expectOld}/+${expectNew} 行，实际 ${countOld}/${countNew} 行`);
    }
  };

  const lines = diff.split("\n");
  // 文本以 \n 结尾时 split 会多出尾部空元素，不是真实行
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      closeHunk();
      inHunk = false;
      // 路径含空格时 git 用引号包裹（core.quotePath）；无引号形式两侧都不含空格
      const m = line.match(/^diff --git "a\/.+" "b\/(.+)"$/) ?? line.match(/^diff --git a\/\S+ b\/(\S+)$/);
      if (!m) {
        errors.push(`diff --git 行格式异常: ${line}`);
        // currentFile 置空，防止后续 hunk 的行号范围错误地记到上一个文件名下
        currentFile = "";
      } else {
        currentFile = m[1];
        files.add(m[1]);
      }
      continue;
    }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      closeHunk();
      inHunk = true;
      expectOld = hunk[2] === undefined ? 1 : Number(hunk[2]);
      expectNew = hunk[4] === undefined ? 1 : Number(hunk[4]);
      countOld = 0;
      countNew = 0;
      newLine = Number(hunk[3]);
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      countNew++;
      mark(newLine);
      newLine++;
    } else if (line.startsWith("-")) {
      countOld++;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file"，不计行
    } else {
      countOld++;
      countNew++;
      mark(newLine);
      newLine++;
    }
  }
  closeHunk();
  return { files, newLineRanges, errors };
}

test("用例集：20 个、id 唯一、bug/linked 各 10", async () => {
  const cases = await loadCases();
  assert.equal(cases.length, 20, `应有 20 个用例，实际 ${cases.length}`);
  const ids = cases.map((c) => c.id);
  assert.equal(new Set(ids).size, 20, "id 有重复");
  assert.equal(cases.filter((c) => c.kind === "bug").length, 10, "bug 类应 10 个");
  assert.equal(cases.filter((c) => c.kind === "linked").length, 10, "linked 类应 10 个");
});

test("parseDiff：引号形式的含空格路径取 b 侧全路径", () => {
  const diff = [
    'diff --git "a/src/foo b/bar.ts" "b/src/foo b/bar.ts"',
    "index 1a2b3c4..5d6e7f8 100644",
    "--- a/src/foo b/bar.ts",
    "+++ b/src/foo b/bar.ts",
    "@@ -1,1 +1,2 @@",
    " const x = 1;",
    "+const y = 2;",
    "",
  ].join("\n");
  const { files, errors } = parseDiff(diff);
  assert.deepEqual(errors, []);
  assert.ok(files.has("src/foo b/bar.ts"), `实际解析到 ${[...files].join(", ")}`);
});

test("每个用例：diff 结构合法，expect 的 file/line 落在 diff 内", async () => {
  const cases = await loadCases();
  for (const c of cases) {
    assert.ok(c.description.length > 5, `${c.id} 缺 description`);
    assert.ok(c.expect.length >= 1, `${c.id} 无期望条目`);
    const { files, newLineRanges, errors } = parseDiff(c.diff);
    assert.deepEqual(errors, [], `${c.id} 的 diff hunk 行数错误：\n${errors.join("\n")}`);
    for (const e of c.expect) {
      for (const f of Array.isArray(e.file) ? e.file : [e.file]) {
        assert.ok(files.has(f), `${c.id} 期望文件 ${f} 不在 diff 中（${[...files].join(", ")}）`);
      }
      if (e.line !== null) {
        for (const f of Array.isArray(e.file) ? e.file : [e.file]) {
          const range = newLineRanges.get(f);
          assert.ok(range, `${c.id} 期望文件 ${f} 无 hunk 行号`);
          if (range) {
            assert.ok(
              e.line >= range[0] - 3 && e.line <= range[1] + 3,
              `${c.id} 期望行 ${e.line} 超出 ${f} 覆盖范围 [${range[0]}, ${range[1]}]±3`,
            );
          }
        }
      }
      assert.ok(e.mustMention.length >= 1 && e.mustMention.every((k) => k.length >= 1), `${c.id} mustMention 为空`);
    }
  }
});
