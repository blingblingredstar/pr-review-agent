import type { EvalCase } from "../score.ts";

// config.ts 把默认超时从 10s 放宽到 30s，README 的配置表还是 10000（该行在上下文可见）
export default {
  id: "linked-06-doc-drift",
  kind: "linked",
  description: "默认值改动未同步 README 配置表（文档漂移）",
  diff: `diff --git a/src/config.ts b/src/config.ts
index 1f2a3b4..5b6c7d8 100644
--- a/src/config.ts
+++ b/src/config.ts
@@ -1,5 +1,5 @@
 export const MAX_RETRIES = 3;
 
-export const REQUEST_TIMEOUT_MS = 10_000;
+export const REQUEST_TIMEOUT_MS = 30_000;
 
 export const USER_AGENT = "pr-review-agent/0.1";
diff --git a/README.md b/README.md
index 6f7a8b9..0b1c2d3 100644
--- a/README.md
+++ b/README.md
@@ -17,7 +17,11 @@ 快速开始
 ## 配置
 
 | 环境变量 | 默认值 | 说明 |
 |---|---|---|
 | MAX_RETRIES | 3 | 最大重试次数 |
 | REQUEST_TIMEOUT_MS | 10000 | 请求超时（毫秒） |
 | RATE_LIMIT_PER_MIN | 60 | 每分钟限流次数 |
+
+### 部署
+
+部署在 Vercel，环境变量在项目设置里配置。
`,
  expect: [
    {
      file: ["README.md", "src/config.ts"],
      line: null,
      mustMention: ["10000", "10000？", "文档", "readme", "过时", "不一致", "同步", "没更新", "未更新"],
    },
  ],
} satisfies EvalCase;
