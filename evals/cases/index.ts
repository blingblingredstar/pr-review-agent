// 用例加载器：readdir + 动态 import，新增用例只加文件即可
import { readdirSync } from "node:fs";
import type { EvalCase } from "../score.ts";

export async function loadCases(): Promise<EvalCase[]> {
  const dir = new URL("./", import.meta.url);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && f !== "index.ts")
    .sort();
  const loaded = await Promise.all(files.map((f) => import(new URL(f, dir).href)));
  return loaded.map((m, i) => {
    const c = (m as { default: EvalCase }).default;
    if (!c?.id || !c.diff || !Array.isArray(c.expect)) {
      throw new Error(`用例文件 ${files[i]} 缺少 default 导出或字段不完整`);
    }
    return c;
  });
}
