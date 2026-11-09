// Vercel function 薄壳（同 api/webhook.ts 模式）：逻辑全在 src/runs.ts。
// fail-closed 门（RUNS_API_ENABLED）在 handleRunsApi 内——本 route 会随同仓部署出现在两个项目上，
// 只有 dashboard 项目配了该变量；主项目缺失一律 404（P0-1，验收闸门 6）。
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRunsApi } from "../src/runs.ts";

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const outcome = await handleRunsApi(req.method ?? "GET");
    res.setHeader("Content-Type", outcome.contentType);
    if (outcome.noStore) res.setHeader("Cache-Control", "no-store");
    for (const [key, value] of Object.entries(outcome.headers ?? {})) res.setHeader(key, value);
    res.statusCode = outcome.status;
    res.end(outcome.body);
  } catch (err) {
    // 失败响应不带任何数据形态细节（与门关闭的 404 同口径：面不可探测）
    console.error("[runs] handler error", err);
    res.statusCode = 500;
    res.end("internal error");
  }
}
