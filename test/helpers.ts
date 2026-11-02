// 测试内改环境变量后必须还原，避免污染同进程的其他用例（三处逐字副本抽出，自审 nit）
export async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// 假 OpenAI 兼容端点（reviewDiff / runReviewRouter 两形态测试用）：按响应脚本逐次返回 assistant 文本，
// 记录请求体供断言。比注入 fetch 更真实——连 response_format 有无都能断言（D027 起的手法，
// 自 review.test.ts 抽到 helpers 供 worker 编排集成用例复用）
import { createServer } from "node:http";

export type FakeLLMCall = { url?: string; body: Record<string, unknown> };

export async function startFakeLLM(
  respond: (callIndex: number, body: Record<string, unknown>) => { content: string; usage?: Record<string, number> },
): Promise<{ url: string; calls: FakeLLMCall[]; close: () => Promise<void> }> {
  const calls: FakeLLMCall[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      calls.push({ url: req.url, body });
      const { content, usage } = respond(calls.length - 1, body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: `chatcmpl-${calls.length}`,
          object: "chat.completion",
          created: 0,
          model: "fake",
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: usage ?? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    calls,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export function messagesOf(body: Record<string, unknown>): { role: string; content: string }[] {
  return body.messages as { role: string; content: string }[];
}
