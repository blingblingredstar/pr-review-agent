// 路径归一化纯工具（自 context.ts 抽出，PR #30 自审 minor：review.ts ↔ context.ts 循环依赖靠 ESM 提升巧合成立，
// 抽独立小模块后两侧单向依赖）。trim + 剥 `./` 前缀；含反斜杠或 `..` 段返回 null（非法）
export function normalizeSnapshotPath(raw: string): string | null {
  let p = raw.trim();
  while (p.startsWith("./")) p = p.slice(2);
  if (!p || p.includes("\\") || p.split("/").includes("..")) return null;
  // 目录键（zip 条目带尾斜杠，如 src/）不是文件：伪命中会解码出 0 字符「全文」，模型收不到纠正信号
  if (p.endsWith("/")) return null;
  return p;
}
