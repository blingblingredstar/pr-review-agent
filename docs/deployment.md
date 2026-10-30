# 部署指南

从零把 PR Review Agent 跑起来：本地验证 → Vercel 部署 → webhook 配置 → 全链路验证。架构与组件见 [architecture.md](./architecture.md)，本文只讲部署动作与实测踩过的坑。

## 前置条件

- 一个 OpenAI 兼容的 LLM 端点及 API key（任意厂商，`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` 三值即可切换）
- GitHub PAT（repo scope：拉 diff、发 review、写 commit status；审查私有仓库必需）
- Vercel 账号（Hobby 免费档即可，函数上限 300s）
- Node 22 本地环境

## 第一步：本地先验证

部署前把核心链路在本地跑通——问题留在本地，定位成本远低于在 Vercel 上排障：

```bash
npm install
cp .env.example .env   # 填 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL / GITHUB_TOKEN
npm test               # 单测全过
npm run review:local   # hardcode 样例 diff 冒烟（验证 LLM 端点连通）
npm run review:pr -- owner/repo#N   # 真实 PR 试跑（默认只打印不回帖）
```

## 第二步：生成 webhook secret

`WEBHOOK_SECRET` 是 HMAC-SHA256 验签密钥，本地 `.env` 与 Vercel 环境变量必须同值：

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

把输出填进 `.env` 的 `WEBHOOK_SECRET=`。第四步的 setup 脚本会读它写进 GitHub webhook 配置。

## 第三步：部署到 Vercel

Git 集成（Vercel 控制台导入仓库，push main 自动部署）或 CLI（`npx vercel link && npx vercel env add <VAR> production` 逐个配置后 `npx vercel --prod`）均可。环境变量（项目 Settings → Environment Variables）：

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_BASE_URL` | ✅ | OpenAI 兼容端点地址 |
| `LLM_API_KEY` | ✅ | 唯一实际成本所在；只在服务端，不出网 |
| `LLM_MODEL` | ✅ | 模型名，换模型只改配置 |
| `GITHUB_TOKEN` | ✅ | PAT：拉 diff + 回帖 + commit status |
| `WEBHOOK_SECRET` | ✅ | 与本地 `.env` 同值（第二步生成） |
| `LLM_TIMEOUT_MS` | 可选 | 默认 270000，Hobby 300s 上限留回帖余量（D011） |
| `LLM_EXTRA_BODY` | 可选 | 端点扩展参数 JSON；GLM 等 thinking 模型建议 `{"thinking":{"type":"disabled"}}` 控延迟（D012） |
| `DIFF_MAX_CHARS` | 可选 | diff 截断预算，默认 300000（D018） |
| `REVIEW_TRIGGER_USERS` | 可选 | 触发白名单：逗号分隔 GitHub 用户名，仅名单内 PR 作者触发审查；未设置 = 所有人，`*` 全放行（D021）。单人自用建议设为自己的用户名，他人 PR / fork 贡献不再消耗 LLM 额度 |

`vercel.json` 已内置两个关键配置，无需手动改：

- `maxDuration: 300`——Vercel Hobby 函数上限（Fluid compute），给审查留足时间
- `includeFiles: "prompts/**"`——**必配**：Vercel 打包不携带未被 import 的 `prompts/*.md`，缺了 `loadPrompt()` 运行时才挂

## 第四步：配置 webhook

```bash
npm run setup:webhook -- owner/repo https://<your-app>.vercel.app/api/webhook
```

脚本一次做三件事：读取 `.env` 的 `WEBHOOK_SECRET`、在目标仓库创建（或更新）订阅 `pull_request` 事件的 webhook、把 secret 写进 webhook 配置。此后只有 GitHub 用该 secret 签名的请求才能触发审查。

## 第五步：全链路验证

1. 在配置了 webhook 的仓库开一个 PR
2. PR 的 commit 上先出现 `pr-review` status（pending「审查进行中」）
3. 端点已关 thinking（见第三步 `LLM_EXTRA_BODY` 建议）时典型 20 秒级出结果——thinking 模型不关则首跑等来的可能是 270s 超时降级通知（D011）而非审查结果：无意见 → status success；有意见 → 行内评论 + `REQUEST_CHANGES`（合并按钮原生禁用，处理完重审自动解除，D017）
4. 同一 commit 重复触发（webhook 重投）幂等跳过、不产生重复评论（D010）

## 安全模型：谁能消耗你的 LLM 额度

webhook URL 公网可达，但审查只可能被合法事件触发：

- 签名校验（HMAC-SHA256 + `timingSafeEqual`）发生在 JSON 解析、GitHub API 调用、LLM 调用**之前**——无有效签名的请求一律 401，零 token 消耗
- 伪造签名需要 `WEBHOOK_SECRET`（32 字节随机数，只存于你的 `.env` 与 GitHub webhook 配置）
- 第三方仓库把自己的 webhook 指向这个 URL 无效：它们的 secret 与你的不同，验签不过
- 同 SHA 重放被幂等去重吸收（D010），不产生第二次审查
- 触发白名单（D021）：`REVIEW_TRIGGER_USERS` 配置后，名单外作者（含 fork 贡献者、Dependabot 等机器人）的 PR 事件在调度前即被忽略——零 GitHub API、零 LLM token

陌生人扫到的最大代价是 Vercel 函数调用次数（免费额度内可忽略），LLM key 不出服务端；配置白名单后，合法 GitHub 事件也要名单内作者才会触发审查。残余风险：名单内用户自己高频推 commit 仍会逐次调用（无频次限额），兜底靠 LLM 端点控制台的消费告警。

## 排障分层

出问题按层定位，别上来就读编排代码：

1. **模型层**：`curl $LLM_BASE_URL/chat/completions` 单测连通性
2. **编排层**：AI SDK 报错、schema 校验失败看 Vercel 函数日志（`npx vercel logs`）
3. **集成层**：GitHub API（diff 拉取、回帖权限）、webhook 签名——GitHub 仓库 Settings → Webhooks → Recent Deliveries 看每次投递的请求与响应码
4. **平台层**：Vercel waitUntil 生命周期、300s 函数超时、环境变量漏配

实测踩过的坑：

- thinking 模型延迟数分钟 → `LLM_EXTRA_BODY={"thinking":{"type":"disabled"}}` 请求级关闭（D012）
- webhook 重投 REST 端点要带 `/attempts` 后缀，不带 404
- 401 连片 → 检查 Vercel 环境变量与 GitHub webhook 两处 secret 是否同值
