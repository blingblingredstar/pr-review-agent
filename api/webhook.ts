// Vercel function 薄壳：只做 raw body 读取与响应，逻辑全在 src/webhook.ts。
// maxDuration 300 = Vercel Hobby 上限（Fluid compute，见 docs/decisions.md D011）。
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleWebhook } from "../src/webhook.ts";

export const config = { maxDuration: 300 };

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const rawBody = await readRawBody(req);
    const outcome = handleWebhook(req.headers, rawBody);
    res.statusCode = outcome.status;
    res.end(outcome.note);
  } catch (err) {
    console.error("[webhook] handler error", err);
    res.statusCode = 500;
    res.end("internal error");
  }
}

// 签名校验必须用原始字节，不能碰 req.body（@vercel/node 的惰性解析会消费流）
async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
