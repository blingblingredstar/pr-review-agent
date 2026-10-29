import assert from "node:assert/strict";
import { test } from "node:test";
import { severityLabels, splitByLocatable } from "../src/github.ts";
import type { ReviewResult } from "../src/review.ts";

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
