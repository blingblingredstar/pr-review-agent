import { normalizePath } from "./score.ts";

// 合并规则共享模块（#127 抽出）：跨模型交叉合并（D036）与按方面拆分（#127）共用同一套判据与两套合并策略——
// 单一实现源，两边 import，防止「不新写」的约束被复制粘贴绕开。原始出处 = analyze-cross-review.ts（issue #81）。

export type Sev = "blocker" | "major" | "minor" | "nit";
export type RawComment = { file: string; line: number; severity: Sev; body: string };

export const SEV_RANK: Record<Sev, number> = { blocker: 3, major: 2, minor: 1, nit: 0 };
export const isSev = (s: string): s is Sev => s === "blocker" || s === "major" || s === "minor" || s === "nit";
export const isMajorPlus = (c: RawComment): boolean => c.severity === "blocker" || c.severity === "major";

// ---------------------------------------------------------------- 词重叠判据（课程 §八移植 + 本数据再校准）

// token = 拉丁词（小写、长度>3，吃进代码标识符）+ CJK 字符 bigram（中文没有词边界，bigram 是最小可靠单元）。
// 课程原版判据是词集交并比（Jaccard，阈值 0.4/0.5 为英文校准）；本脚本用同批数据实测：
// Jaccard 在中文意见对上完全失效（同发现对 median 0.15，无一达到 0.4）——阈值 0.4/0.5 保持课程原值不变，
// 度量换为重叠系数 |A∩B|/min(|A|,|B|)（对称，课程「双向」校验在对称度量下退化为单值），
// 校准轮（GLM 15-38-18 × DS high，同文件对）同发现对捕获 38% / 异发现对误配 2%。
export function tokens(body: string): Set<string> {
  const out = new Set<string>();
  const lower = body.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_]+/g)) if (m[0].length > 3) out.add(m[0]);
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) {
      out.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

export function overlap(a: string, b: string): number {
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size);
}

export const sameFile = (a: RawComment, b: RawComment): boolean => normalizePath(a.file) === normalizePath(b.file);

// ---------------------------------------------------------------- 合并策略一：课程四步（docs/plans/ai-code-review-course.md §四/§八）

export function mergeCourse4(A: RawComment[], B: RawComment[]): RawComment[] {
  const out: RawComment[] = [];
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  // ① 双模型一致（同文件 + 词重叠>0.4）：保留更详细一条（body 更长视为更详细）
  for (let i = 0; i < A.length; i++) {
    let matched = -1;
    for (let j = 0; j < B.length; j++) {
      if (usedB.has(j)) continue;
      if (sameFile(A[i], B[j]) && overlap(A[i].body, B[j].body) > 0.4) {
        matched = j;
        break;
      }
    }
    if (matched >= 0) {
      usedA.add(i);
      usedB.add(matched);
      out.push(A[i].body.length >= B[matched].body.length ? A[i] : B[matched]);
    }
  }
  // ② 有界召回兜底：每模型最多补 1 条对方没有的 major/blocker
  const aExtra = A.find((c, i) => !usedA.has(i) && isMajorPlus(c));
  if (aExtra) out.push(aExtra);
  const bExtra = B.find((c, j) => !usedB.has(j) && isMajorPlus(c));
  if (bExtra) out.push(bExtra);
  // ③ severity floor：课程 low 级全丢 → 本项目四级映射为丢 minor/nit
  const floored = out.filter(isMajorPlus);
  // ④ 激进去重：词重叠>0.5（同文件）去重，保留先出现者
  const kept: RawComment[] = [];
  for (const c of floored) {
    if (!kept.some((k) => sameFile(k, c) && overlap(k.body, c.body) > 0.5)) kept.push(c);
  }
  return kept;
}

// ---------------------------------------------------------------- 合并策略二：保守合并（pr-agent 口径，issue #74 设计要点）

// 合并对 = 完全同 file:line + 词重叠>0.4；severity 取更严（pr-agent「merged verdict is deliberately never
// less alarming than the worst chunk」——本 schema 意见无 security 独立字段，security 任一报忧则忧退化为
// severity 取更严，tie 时保留更详细 body）；不激进去重：未配对意见原样并集保留，无 severity floor（minor/nit 留存）。
export function mergeConservative(A: RawComment[], B: RawComment[]): RawComment[] {
  const out: RawComment[] = [];
  const usedB = new Set<number>();
  for (const a of A) {
    let matched = -1;
    for (let j = 0; j < B.length; j++) {
      if (usedB.has(j)) continue;
      if (sameFile(a, B[j]) && a.line === B[j].line && overlap(a.body, B[j].body) > 0.4) {
        matched = j;
        break;
      }
    }
    if (matched >= 0) {
      usedB.add(matched);
      const b = B[matched];
      if (SEV_RANK[a.severity] !== SEV_RANK[b.severity]) {
        out.push(SEV_RANK[a.severity] > SEV_RANK[b.severity] ? a : b);
      } else {
        out.push(a.body.length >= b.body.length ? a : b);
      }
    } else {
      out.push(a);
    }
  }
  for (let j = 0; j < B.length; j++) if (!usedB.has(j)) out.push(B[j]);
  return out;
}
