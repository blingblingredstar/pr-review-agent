import assert from "node:assert/strict";
import { test } from "node:test";
import { severityLabels } from "../src/github.ts";
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
