// Vercel function 薄壳：只做 raw body 读取与响应，逻辑全在 src/worker.ts（D026 阶段机续链入口）。
// maxDuration 300 与 webhook 一致 = Vercel Hobby 上限（Fluid compute）；每阶段独立函数调用、独立 300s 预算。
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleWorker } from "../src/worker.ts";

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
      res.end("payload too large", () => req.destroy()); // 先确保 413 送达再断开
      return;
    }
    const outcome = handleWorker(req.headers, rawBody);
    res.statusCode = outcome.status;
    res.end(outcome.note);
  } catch (err) {
    console.error("[worker] handler error", err);
    res.statusCode = 500;
    res.end("internal error");
  }
}

// 签名校验必须用原始字节，不能碰 req.body（@vercel/node 的惰性解析会消费流）
// 上限十进制 4.5MB = Vercel 请求体上限（信封中间态按 DIFF+CONTEXT 预算默认 ~400KB，预算调错时平台闸兜底）；
// 自设闸压在平台闸之内，413「先送达再断开」分支才实际可达（自审 minor：4.5×1024×1024 是 4.5MiB 口径，永远排不进平台闸前面）
const MAX_BODY_BYTES = 4_500_000;
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
