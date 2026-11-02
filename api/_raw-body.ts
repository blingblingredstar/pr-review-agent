// api 薄壳共享的 raw body 读取（自 api/webhook.ts 抽出，PR #29 自审 minor：两副本会漂移）。
// 签名校验必须用原始字节，不能碰 req.body（@vercel/node 的惰性解析会消费流）；超 maxBytes 返回 null 由调用方 413。
// 下划线前缀目录不被 Vercel 当作 serverless function，仅作模块被两个薄壳导入
import type { IncomingMessage } from "node:http";

export async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
