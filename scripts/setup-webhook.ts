// 创建/更新仓库 webhook 指向部署 URL，免浏览器手动配置（PAT 需 repo scope，见 D008）。
// 用法：npm run setup:webhook -- owner/repo https://<deployment>/api/webhook
// WEBHOOK_SECRET 缺失时生成随机值并追加到 .env。
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { getOctokit } from "../src/github.ts";

const [ref = "", url = ""] = process.argv.slice(2);
const [owner, repo] = ref.split("/");
if (!owner || !repo || !url.startsWith("https://") || !url.endsWith("/api/webhook")) {
  console.error("用法：npm run setup:webhook -- owner/repo https://<deployment>/api/webhook");
  process.exit(1);
}

let secret = process.env.WEBHOOK_SECRET;
if (!secret) {
  secret = randomBytes(32).toString("hex");
  const envPath = new URL("../.env", import.meta.url);
  if (existsSync(envPath) && /^WEBHOOK_SECRET=/m.test(readFileSync(envPath, "utf8"))) {
    // 清掉所有同名键再写一行（历史版本 append 可能留下多行，dotenv 取值依实现而定）
    const envText = readFileSync(envPath, "utf8");
    const stripped = envText.replace(/^WEBHOOK_SECRET=.*(?:\n|$)/gm, "");
    const needsNewline = stripped.length > 0 && !stripped.endsWith("\n");
    writeFileSync(envPath, `${stripped}${needsNewline ? "\n" : ""}WEBHOOK_SECRET=${secret}\n`);
    console.log("WEBHOOK_SECRET 已重新生成并覆盖 .env 原值");
  } else {
    appendFileSync(envPath, `\nWEBHOOK_SECRET=${secret}\n`);
    console.log("WEBHOOK_SECRET 已生成并写入 .env");
  }
}

const client = getOctokit();
const config = { url, content_type: "json" as const, secret, insecure_ssl: "0" as const };
const events = ["pull_request"];
const hooks = await client.rest.repos.listWebhooks({ owner, repo });
const existing = hooks.data.find((h) => (h.config as { url?: string } | null)?.url === url);
const hook = existing
  ? await client.rest.repos.updateWebhook({
      owner,
      repo,
      hook_id: existing.id,
      active: true,
      events,
      config,
    })
  : await client.rest.repos.createWebhook({ owner, repo, name: "web", active: true, events, config });
console.log(`webhook 就绪（id=${hook.data.id}，events=pull_request → ${url}）`);
