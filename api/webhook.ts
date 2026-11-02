// Vercel function 薄壳：只做 raw body 读取与响应，逻辑全在 src/webhook.ts。
// maxDuration 300 = Vercel Hobby 上限（Fluid compute，见 docs/decisions.md D011）。
import type { IncomingMessage, ServerResponse } from "node:http";
import { readRawBody } from "./_raw-body.ts";
import { handleWebhook } from "../src/webhook.ts";

export const config = { maxDuration: 300 };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      res.statusCode = 405;
      res.end("method not allowed");
      return;
    }
    const rawBody = await readRawBody(req, MAX_BODY_BYTES);
    if (rawBody === null) {
      res.statusCode = 413;
      res.end("payload too large", () => req.destroy()); // 先确保 413 送达再断开
      return;
    }
    const outcome = handleWebhook(req.headers, rawBody);
    res.statusCode = outcome.status;
    res.end(outcome.note);
  } catch (err) {
    console.error("[webhook] handler error", err);
    res.statusCode = 500;
    res.end("internal error");
  }
}

// 上限 25MB = GitHub webhook payload 官方上限，超限返回 null 由调用方 413；
// 防御闸取宽松侧 25MiB：GitHub 文档口径未明（MB/MiB），取宽避免「官方照发、自闸 413」的静默丢弃区间；
// 发送侧 GitHub 自身强限，本闸正常到不了（自审 nit）。读取逻辑共享自 api/_raw-body.ts
const MAX_BODY_BYTES = 25 * 1024 * 1024;
