// Vercel function 薄壳：只做 raw body 读取与响应，逻辑全在 src/webhook.ts。
// maxDuration 300 = Vercel Hobby 上限（Fluid compute，见 docs/decisions.md D011）。
import type { IncomingMessage, ServerResponse } from "node:http";
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
    const rawBody = await readRawBody(req);
    if (rawBody === null) {
      res.statusCode = 413;
      res.end("payload too large");
      req.destroy(); // 超限即断：drain 纯耗带宽，客户端收到 413 或连接重置都是明确信号
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

// 签名校验必须用原始字节，不能碰 req.body（@vercel/node 的惰性解析会消费流）
// 上限 25MB = GitHub webhook payload 官方上限，超限返回 null 由调用方 413
const MAX_BODY_BYTES = 25 * 1024 * 1024;
async function readRawBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
