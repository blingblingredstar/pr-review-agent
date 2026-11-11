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

test("用例集：87 个、id 唯一、synthetic 20（bug/linked 各 10）+ real 15 + dogfood 2 + injection 9 + repo 7 + correlation 10 + incremental 10 + framing 9 + ctxpair 5", async () => {
  const cases = await loadCases();
  assert.equal(cases.length, 87, `应有 87 个用例，实际 ${cases.length}`);
  const ids = cases.map((c) => c.id);
  assert.equal(new Set(ids).size, 87, "id 有重复");
  const synthetic = cases.filter((c) => (c.source ?? "synthetic") === "synthetic");
  assert.equal(synthetic.length, 20, "synthetic 应 20 个");
  assert.equal(synthetic.filter((c) => c.kind === "bug").length, 10, "synthetic bug 类应 10 个");
  assert.equal(synthetic.filter((c) => c.kind === "linked").length, 10, "synthetic linked 类应 10 个");
  assert.equal(cases.filter((c) => c.source === "real").length, 15, "real 应 15 个");
  assert.equal(cases.filter((c) => c.source === "dogfood").length, 2, "dogfood 应 2 个");
  assert.equal(cases.filter((c) => c.source === "injection").length, 9, "injection 应 9 个");
  assert.equal(cases.filter((c) => c.source === "repo").length, 7, "repo 应 7 个");
  assert.equal(cases.filter((c) => c.source === "correlation").length, 10, "correlation 应 10 个");
  assert.equal(cases.filter((c) => c.source === "incremental").length, 10, "incremental 应 10 个");
  assert.equal(cases.filter((c) => c.source === "framing").length, 9, "framing 应 9 个");
  assert.equal(cases.filter((c) => c.source === "ctxpair").length, 5, "ctxpair 应 5 个");
  // 增量对照组（D032 开放问题②）：full/delta 成对（5 fixture × 2 口径）；id 前缀防漏写；
  // repo 快照必带（head 态模拟生产 zipball，两口径共用同一快照——对照的唯一变量是 diff 区间）
  const incIds = cases.filter((c) => c.source === "incremental").map((c) => c.id);
  for (const base of ["inc-01-samefile-guard", "inc-02-contract-units", "inc-03-rename-old-field", "inc-04-const-dry", "inc-05-clean-helper"]) {
    assert.ok(incIds.includes(`${base}-full`) && incIds.includes(`${base}-delta`), `${base} 缺 full/delta 成对用例`);
  }
  // source 必须显式声明：real/dogfood 漏写会静默混进 synthetic 污染能力评估
  for (const c of cases) {
    assert.ok(c.source, `${c.id} 未显式声明 source`);
    if (c.source === "dogfood") assert.ok(c.id.startsWith("dogfood-"), `${c.id} source=dogfood 但 id 前缀不符`);
    if (c.source === "real") assert.ok(c.id.startsWith("real-"), `${c.id} source=real 但 id 前缀不符`);
    // 注入组（D024）：必须带载荷特征串（noEcho 空列表 = 回显断言形同虚设）；id 前缀防漏写 source 混进 synthetic
    if (c.source === "injection") {
      assert.ok(c.id.startsWith("inj-"), `${c.id} source=injection 但 id 前缀不符`);
      assert.ok(c.noEcho && c.noEcho.length >= 1 && c.noEcho.every((n) => n.length >= 6), `${c.id} noEcho 缺失或特征串过短（易误命中普通措辞）`);
      // taskContext 是注入通路（D029，inj-07 首用）：能力组带任务块即破坏裸路径红线；framing 组（#99）经同通路换措辞
      if (c.taskContext !== undefined) {
        assert.ok(typeof c.taskContext === "string" && c.taskContext.length > 0, `${c.id} taskContext 必须是非空字符串`);
      }
      // previousFindings 是 inj-08/inj-09 专属通路（D035 v1/v2）：同款裸路径红线
      if (c.previousFindings !== undefined) {
        assert.ok(typeof c.previousFindings === "string" && c.previousFindings.length > 0, `${c.id} previousFindings 必须是非空字符串`);
      }
    } else if ((c.source as string) === "framing") {
      // framing 组（#99）：taskContext 是组的自变量（三变体全带），非空校验同 injection 款；previousFindings 仍为 injection 专属
      assert.ok(typeof c.taskContext === "string" && c.taskContext.length > 0, `${c.id} taskContext 必带且须为非空字符串（framing 组自变量）`);
      assert.equal(c.previousFindings, undefined, `${c.id} framing 用例不得携带 previousFindings（裸路径红线）`);
    } else {
      assert.equal(c.taskContext, undefined, `${c.id} 非 injection/framing 用例不得携带 taskContext（能力组裸路径红线）`);
      assert.equal(c.previousFindings, undefined, `${c.id} 非 injection 用例不得携带 previousFindings（裸路径红线）`);
    }
    // repo fixture 组（D031）：source=repo ⇔ repo 字段成对出现，id 前缀防漏写
    if (c.source === "repo") {
      assert.ok(c.id.startsWith("repo-"), `${c.id} source=repo 但 id 前缀不符`);
      assert.ok(c.repo && Object.keys(c.repo).length > 0, `${c.id} source=repo 但缺 repo fixture`);
    } else if (c.source !== "incremental" && (c.source as string) !== "framing" && c.source !== "ctxpair") {
      assert.equal(c.repo, undefined, `${c.id} 非 repo/incremental/framing/ctxpair 组不得携带 repo fixture（裸路径红线）`);
    }
    // 增量对照组：repo 必带（head 态快照是两口径共用的前提，缺快照 delta 用例退化为裸路径、对照失效）
    if (c.source === "incremental") {
      assert.ok(c.id.startsWith("inc-"), `${c.id} source=incremental 但 id 前缀不符`);
      assert.ok(c.repo && Object.keys(c.repo).length > 0, `${c.id} source=incremental 但缺 repo fixture`);
    }
    // framing 组（#99）：id 前缀防漏写；repo 复用原 repo 用例快照、必带（缺快照则对照退化为裸路径）
    if ((c.source as string) === "framing") {
      assert.ok(c.id.startsWith("framing-"), `${c.id} source=framing 但 id 前缀不符`);
      assert.ok(c.repo && Object.keys(c.repo).length > 0, `${c.id} framing 用例缺 repo fixture（须复用原 repo 用例快照）`);
    }
    // ctxpair 双联组（#80）：repo 快照必带（EVAL_CONTEXT 臂的上下文原料；bare 臂不注入工具由 run.ts caseOpts 保证）。
    // 双联断言：expect ≥2、kind 标注覆盖 structural + convention 各 ≥1、其余条目标注合法；
    // 防循环性机械弱断言：convention 条目的 mustMention 词不得在快照任何 markdown 文档逐字出现
    //（约定文档与 mustMention 是同义异措的两套词汇——expected 措辞复用 context 文档原词会给上下文臂白送命中，
    // 课程 §三循环性教训，#80 闸门 3）。逐字判定的盲区（同义改写、词表穷尽）由各用例文件头的人工核对注释兜底
    if (c.source === "ctxpair") {
      assert.ok(c.id.startsWith("ctx-"), `${c.id} source=ctxpair 但 id 前缀不符`);
      assert.ok(c.repo && Object.keys(c.repo).length > 0, `${c.id} source=ctxpair 但缺 repo fixture`);
      assert.ok(c.expect.length >= 2, `${c.id} 双联用例 expect 应 ≥2 条（structural + convention 双联）`);
      const kinds = c.expect.map((e) => e.kind);
      for (const e of c.expect) {
        assert.ok(e.kind === "structural" || e.kind === "convention", `${c.id} 双联用例每条 expect 须标 kind: structural | convention`);
      }
      assert.ok(kinds.includes("structural"), `${c.id} 缺 structural 标注条目`);
      assert.ok(kinds.includes("convention"), `${c.id} 缺 convention 标注条目`);
      const mdText = Object.entries(c.repo!)
        .filter(([p]) => p.endsWith(".md"))
        .map(([, v]) => v.toLowerCase())
        .join("\n");
      assert.ok(mdText.length > 0, `${c.id} 快照缺 markdown 约定文档（约定须落在非触及文件里）`);
      for (const e of c.expect) {
        if (e.kind !== "convention") continue;
        for (const w of e.mustMention) {
          assert.ok(
            !mdText.includes(w.toLowerCase()),
            `${c.id} convention 条目 mustMention「${w}」在快照 markdown 文档中逐字出现（防循环性红线，#80 闸门 3——expected 措辞不得复用约定文档原词）`,
          );
        }
      }
    }
    // 对抗性关联组（路线图第 1 项）：id 前缀防漏写；describe 里的 provenance（引入/修复 commit）随 description 必填，
    // 防止「手写想当然用例」混进组里（D015 教训：底料必须可追溯到真实仓库配对）
    if (c.source === "correlation") {
      assert.ok(c.id.startsWith("corr-"), `${c.id} source=correlation 但 id 前缀不符`);
      assert.ok(/#\d+/.test(c.description), `${c.id} description 缺配对 PR 号（provenance 必填）`);
    }
    // expectClean（D031）：与 expect 二选一——零意见期望必须且只能靠该标记声明
    if (c.expectClean === true) {
      assert.equal(c.expect.length, 0, `${c.id} expectClean 与非空 expect 互斥`);
    } else {
      assert.ok(c.expect.length >= 1, `${c.id} 无期望条目（考能力的用例必须声明 expect 或 expectClean）`);
    }
  }
});

test("repo/incremental/framing/ctxpair 组 fixture 结构：diff 触及文件都在快照中（head 态）、非 diff 文件 ≥2（答案文件 + 诱饵）", async () => {
  const cases = (await loadCases()).filter((c) => c.source === "repo" || c.source === "incremental" || (c.source as string) === "framing" || c.source === "ctxpair");
  assert.ok(cases.length >= 6, "repo/incremental/framing/ctxpair 组应有足够用例");
  for (const c of cases) {
    const repo = c.repo!;
    const { files } = parseDiff(c.diff);
    for (const f of files) {
      assert.ok(repo[f] !== undefined, `${c.id} diff 触及文件 ${f} 不在 repo 快照中（快照是 head 态，触及文件必须在场）`);
    }
    const nonDiff = Object.keys(repo).filter((p) => !files.has(p));
    assert.ok(
      nonDiff.length >= 2,
      `${c.id} 非 diff 文件仅 ${nonDiff.length} 个——至少要有答案文件（漏改/被重复方）+ 诱饵文件（路径名像答案但不含答案，防路径名泄底）`,
    );
  }
});

test("framing 组（#99）：fixture 三变体成对（-a/-b/-c），同 fixture 的 diff/kind/expect/expectClean/repo 组内一致（只差 taskContext 措辞）", async () => {
  const cases = (await loadCases()).filter((c) => (c.source as string) === "framing");
  assert.equal(cases.length, 9, "framing 应 9 个");
  const byBase = new Map<string, EvalCase[]>();
  for (const c of cases) {
    const base = c.id.replace(/-(a|b|c)$/, "");
    assert.notEqual(base, c.id, `${c.id} id 缺 -a/-b/-c 变体后缀`);
    byBase.set(base, [...(byBase.get(base) ?? []), c]);
  }
  const all = await loadCases();
  for (const [base, trio] of byBase) {
    assert.equal(trio.length, 3, `${base} 变体数应为 3（a/b/c），实际 ${trio.length}`);
    const [a, b, c] = trio;
    // 同 diff 同快照同 verdicts 是组间可比的前提（#99）：防改漏一例
    assert.deepEqual([a.diff, a.kind, a.expect, a.expectClean, a.repo], [b.diff, b.kind, b.expect, b.expectClean, b.repo], `${base} a/b 字段漂移`);
    assert.deepEqual([a.diff, a.kind, a.expect, a.expectClean, a.repo], [c.diff, c.kind, c.expect, c.expectClean, c.repo], `${base} a/c 字段漂移`);
    assert.equal(new Set(trio.map((x) => x.taskContext)).size, 3, `${base} 三变体 taskContext 应互不相同（全同则对照退化）`);
    // 与原 repo 用例的一致性（对照的有效性前提）：原用例修订时 framing 副本必须跟随，否则对照静默失效。
    // framing id = 原 id 去 repo- 前缀，故映射回 repo-*
    const origin = all.find((x) => x.id === base.replace(/^framing-/, "repo-"));
    assert.ok(origin, `${base} 找不到原 repo 用例`);
    if (origin) {
      assert.deepEqual([a.diff, a.kind, a.expect, a.expectClean, a.repo], [origin.diff, origin.kind, origin.expect, origin.expectClean, origin.repo], `${base} 与原用例 ${origin.id} 漂移（原用例修订后 framing 副本未跟随）`);
    }
  }
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
    assert.ok(c.expect.length >= 1 || c.expectClean === true, `${c.id} 无期望条目且未声明 expectClean`);
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
