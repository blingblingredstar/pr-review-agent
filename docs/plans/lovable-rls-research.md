# Lovable 数据泄漏研究：RLS 缺失作为 AI 生成应用的系统性缺陷（Crissy Field 报告转述快照）

> 2026-11-15 整理。一手研究出自德国安全研究方 Crissy Field，首发经 Handelsblatt（2026-11-02，付费墙未直接核对）；本文数字为 Sifted / Techzine / dev.to 转述口径，多源一致处采信、存疑处标注。

## 一、报告要点

2026-11 初，Crissy Field 发布对 AI 应用生成平台 Lovable 生态的数据泄漏研究：从 Common Crawl 网页存档抓取 2025-12 至 2026-09 间公开可达的 159,041 个 Lovable 项目，其中 34,545 个以 Supabase 为后端；**24,664 个应用在页面加载时即返回数据库记录、无需登录**——未认证访客可直接读库。已确认暴露的数据类型包括用户记录、护照号码、支付信息与私聊消息；媒体报道的最大单例泄露为 28 万封客户邮件；单个德国论坛案例暴露 8 万+ 条用户记录。研究方强调全程未利用漏洞或零日——数据本身公开可读，根因是各应用自身的数据库访问控制配置缺失，不是平台被攻破。

Lovable 安全负责人回应承认根因是行级安全（RLS）不足，称这正是其扫描机制设计要拦截的问题；Supabase 方面指出这是应用开发者的数据库配置问题而非 Supabase 被攻破，修复是标准安全实践。

## 二、根因：为什么 AI 生成的应用是 RLS 缺失重灾区

Lovable 型应用的默认架构 = 前端直连 Supabase（supabase-js + 公开 anon key）+ 数据库访问控制完全交给 RLS/policy。这条架构下 **RLS 是匿名访问的唯一防线**——建表迁移没启用 RLS、或 policy 写成放行全部，等价于整表对互联网裸奔。

AI 生成链路的系统性倾向放大了缺口：

- **「可用即完成」**：AI 优先实现功能路径（建表 + 前端查询），RLS/policy 是不可见的安全配置，不在「能跑起来」的验收面内
- **建表迁移由 AI 直接生成**：`CREATE TABLE` 不附带 `ENABLE ROW LEVEL SECURITY` 与配套 policy，用户往往逐字接受
- **policy 形式合规实质放行**：即使写了 policy 也常是 `using (true)` 全放行
- **用户侧无感**：应用演示一切正常，泄漏只在有人拿公开 anon key 直查时显形

## 三、对 PR 审查器的映射

缺陷信号落在 diff 内，满足 aspect 接入准入判据（D044 同款：无 diff 外上下文依赖）：

- **正信号**：迁移文件 `CREATE TABLE` 无配套 `ENABLE ROW LEVEL SECURITY` / `CREATE POLICY`（缺失型，与浅测试检测的「分支缺用例」同形态）；policy 存在但 `using (true)` 放行全部
- **直连迹象**：同 diff 出现前端 supabase-js + 公开 anon key（`VITE_SUPABASE_ANON_KEY` 类）+ `.from("<table>")` 直查
- **否定面（FP 控制）**：纯服务端持有连接（service role key / 服务端连接池）的表不要求 RLS；迁移只加列不改表；policy 已按角色收紧

检测形态是**清单式检查**（信号在不在），不是推理深发型——与 corr 组已定性的推理深度缺口（D046）不同族，预期落在单遍 prompt 可达能力面内。单遍维持是既定决策（D042：按方面拆分无召回增益、precision 反降、成本 3.3×），本项不加新遍、不加 agent。

## 四、接入设计（D044 模式）

1. 单遍 prompt 一条规则，**否定面显式化**（#138 首版压制干扰教训）：正信号报出 + 客户端直连迹象不存在时不适用 + 「其他问题照常按其他规则报」——落在 `prompts/review.md` 数据库访问控制条
2. 用例对进 synthetic 能力口径（aspect 价值必须被能力线度量）：rls-01 正例（客户端直连表无 RLS，锚迁移建表行）+ rls-02 负例（服务端持连接表无 RLS 不应报，`expectClean` 考 precision）
3. 全量回归闸门（D044 方法论）：promptHash 换代 + 两轮微平均落在基线方差带内 + 逐用例对账确认既有组零压制
4. 立项与裁定记录：GitHub roadmap issue + `docs/decisions.md` D049

## 五、出处

- [Sifted：Lovable apps expose sensitive user data, researchers find（2026-11-03）](https://sifted.eu/articles/lovable-apps-expose-sensitive-user-data-researchers-find)
- [Techzine：Thousands of Lovable apps are leaking personal data](https://www.techzine.eu/news/security/145550/thousands-of-lovable-apps-are-leaking-personal-data)
- [dev.to：Lovable Data Leak 2026 — 24,664 AI Apps Exposed 80,000+ User Records via Supabase](https://dev.to/yashvikothari/lovable-data-leak-2026-24664-ai-apps-exposed-80000-user-records-via-supabase-2l7a)
- Handelsblatt 首发（2026-11-02，付费墙）：经上述转述引用
