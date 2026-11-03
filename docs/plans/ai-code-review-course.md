# 调研：DeepLearning.AI《AI Code Review》短课（Qodo）——评测判据还原与结合点

> 2026-11-03 调研（会话 33）。课程：[AI Code Review](https://www.deeplearning.ai/courses/ai-code-review/)，
> 约 1h04m，讲师 Nnenna Ndukwe（Qodo），吴恩达出镜介绍。8 节课 transcript 全量抓取；
> 课程 lab 的 `src/` 全套实现源码与评测数据已完整还原（平台静态加密，经 lab 内核运行时导出）。
> 本文自包含：关键判据与 prompt 全文内嵌，不依赖外部材料。

## 一、课程主张一览

主线：AI 生成代码的速度超过人工审查能力 → 审查也要 agentic 化。三段论：

1. **上下文质量 > 模型本身**（L5）：diff-only 审查抓不到「违反代码库既有约定」类问题
2. **选择性检索 > 全量塞入**（L6）：context engine（AST chunk → embed → 向量检索）胜过全库 dump
3. **专项 ensemble > 单通用 agent**（L7）：Security + Pattern 双 agent 并行合并

## 二、评测体系还原（L5–L7 的数字从哪来）

### 设计

- 15 个**合成 PR**（`pr_001_auth_bypass` … `pr_015_unvalidated_redirect`，按植入漏洞类型命名）
- 每个 PR 恰好 **2 条 expected issues**：1 条植入漏洞（措辞如「violates mandatory `Depends(get_current_user)` authentication pattern」）+ 1 条缺模式/需求缺口
- 每个 PR 自带预制 `task_context`（仿 Jira ticket，**明说该遵循哪个 pattern**，如「Follow the `@limiter.limit()` pattern used on all auth endpoints」）和 `context` 字段
- 指标：micro-average precision / recall / F1（TP/FN 按 expected issues 计，FP 按未匹配上的 findings 计）

### 匹配判据（`src/utils/matching.py`）——宽松，不要求定位

三重判定任一命中即算 match：

| 方法 | 判据 | 说明 |
|---|---|---|
| 关键词重叠 | 词长>3 的词集交集 ÷ expected 词集 **≥ 0.3** | expected 提到一次「authentication」而 finding 也提到 → 1.0 命中 |
| 子串 | 任一方向包含 → 记 0.7 | "SQL injection" in "SQL Injection Vulnerability" |
| 语义 | text-embedding-3-small cosine **≥ 0.45** | 仅当关键词分 < 阈值时兜底 |

**不要求文件/行号定位**，一对一贪心（每个 finding 只能匹配一条 expected，防止重复计分）。

### 对照组公平性

- **L5**：diff-only vs context+task_context，同一 prompt 模板只换填充（同模型同参数）——对照本身干净
- **L6**：no/full/selective 三组；**full context = 全库 99 chunks 一次性拼好、15 个 PR 复用同一份**（约 31k 字符）；selective = 每 PR 检索 top-15（约 3.5k 字符，省 88.9%）
- **L7**：general vs ensemble 共享同一份检索上下文，只换 prompt 档位；成本表诚实标注 2× 调用为「simulated proxy」，Quality per $ = F1/2

### 数字

| 实验 | 对照 | 结果 |
|---|---|---|
| L5 | diff-only → +context+task | precision +17.5%，**recall +43.3%**，F1 +25.4%；样本 PR 上 diff-only 0/2 命中、context-aware 2/2 |
| L6 | no / full / selective | selective 三指标全面最优，full 反而劣于 selective |
| L7 | general → ensemble | **F1 60.6% → 71.1%**，precision 升、recall 微降 |

## 三、可信度分析（打几折）

1. **评测措辞的循环性（最重要）**：expected issues 的措辞直接借用上下文词汇（`Depends(get_current_user)`、`FOR UPDATE`、`hmac.compare_digest`…）。context-aware 的回答天然复述这些词（context 里就有），关键词/embedding 匹配等于白送；diff-only 结构性不可能知道约定叫什么名字。task_context 更直白地把答案写在题面。**+43.3% recall 方向性成立，但幅度是评测构造方式决定的上界。**
2. **模型是 gpt-4o-mini**（temperature=0，max_tokens=800）：「context > model」只在一个便宜模型上验证，不可外推到强模型场景。
3. **L6 对照组偏弱**：全库 dump 每个 PR 塞一份是稻草人——真实系统不会这么做；本仓库 D023「触及文件全文 + 文件树」本来就比它合理。
4. **玩具库**：25 文件 / 1126 行 / 99 chunks，AST chunker 只支持 Python（`.py` 文件、函数/类/`test_` 前缀，不递归嵌套函数）——多语言真实仓库会碎。

**结论**：课程三组实验内部逻辑干净、控制变量正确（这点值得学），但数字是「方向性演示」不是基准。可借鉴的是实验方法与工程手法，不是具体百分数。

## 四、Ensemble 机制拆解（最有价值的发现）

`src/review_agents/specialized.py` 的合并策略，四步全是**噪音抑制工程**：

1. **一致性优先**：双 agent 都报的发现（双向词重叠 > 0.4）作为核心信号，保留更详细的一条
2. **有界召回兜底**：每个专项最多补 **1 条**独有的 high/medium 发现——docstring 原话承认专项 agent 会「speculatively report tangential issues」，全收会「flood the result with noise and tank precision」
3. **severity floor**：low 级一律丢弃
4. **激进去重**：词重叠 > 0.5 判重

**解读：71.1% vs 60.6% 的差距主要来自这四招，不是「两个领域专家覆盖更广」。** 其中 severity floor、去重合并、限制投机发现三招**不需要多 agent 架构**，改 prompt 措辞即可在单 agent 里获得。多 agent 分发不进路线图的决策（D028 备注口径）不变，但其可拆解部分可以低成本吸收。

## 五、对本项目的结合点（对照现行 5 项路线图）

### 已有等价物，不动

- 独立审查 harness（生成/审查分离）＝ 本项目本体；pre-PR 自审 ＝ code-review skill
- severity 分级 triage ＝ blocker/major/minor/nit + REQUEST_CHANGES 闸门（D017）+ has-blocker/has-major 标签
- 「规则沉淀回写」素材 ＝ resolve-threads 纪录与 flip-flop 裁定口径（L4 的 review→judge→codify→reuse 闭环）

### 可低成本做

> 勘误（会话 33 内）：本条原写「eval 加 precision 口径、现打分 recall 导向」——**错误**。`evals/score.ts` 一直同时算 recall 与 precision（precision = 命中任一期望的意见 / 总意见），`compare.ts` 做跨轮微平均对比，Day 6 报告（`evals/report.md`）就是「prompt 迭代 → 双指标提升」的消融报告。本仓库 eval 框架先于课程调研即已完整，且行级锚点（file + 行±3 + mustMention）比课程判据更严格。

1. **消融矩阵形态参考**（配合路线图「路由消融对照」）：课程实验的组织方式是「同数据集 × 配置开关」（no/full/selective context、general/ensemble），输出 approach × P/R/F1 汇总表 + per-case 胜负表（F1 per case + wins/ties，`build_per_pr_table`）+ 成本列。`compare.ts` 目前按 promptHash 分组比 prompt 版本；将来扩展配置消融（context on/off、fileReader on/off、plan on/off）时可参考这个表结构。成本列用本仓库真 usage 日志（PR #22），优于课程的「simulated proxy」。
2. **prompt 措辞实验**：`prompts/review.md` 加「同因发现合并为一条、低置信的 minor 宁可不发」类措辞——吸收 §四的可移植部分，现有 eval 即可回归验证，零架构变化。Day 6 报告 v3 的负结果（「缺陷指向性」与「外调确认类问题照报」的张力）提示这类措辞实验要按 severity 分层设计，粗粒度措辞会此消彼长。
3. **ticket 注入**（预处理类子项，与「增量审查」正交）：PR body 的 `Closes #N` → prepare 阶段拉 issue 正文（小独立预算）拼进 prompt。课程证据：所有「需求缺口」类发现全靠 task_context 才可测。
4. **context-aware eval 集的设计模板**（远期，D019 契约内）：课程「每个 PR = 1 条植入漏洞 + 1 条违反代码库约定（diff-only 不可见）」的双联用例形状，正是「度量上下文注入价值」的用例设计——当前 eval 路径不注入 context（eval 红线），无法度量 D023/D027 的增益；若将来立项 context-aware eval 集，这个双联模式 + 约定集中、违规藏进 diff 的合成仓库是直接模板。与路线图「对抗 fixture 扩充」（考注入）不同题，别混进同一批用例。

### 维持不做（记录数据点，不翻案）

- **多 agent ensemble**：F1 增益机制已拆解为噪音抑制（§四），可移植部分走 prompt；多 agent 本体维持不进路线图。
- **embedding / 向量检索**：见 §六。
- **照搬课程技术栈**（Chroma + OpenAI embeddings）：玩具库结论，部署形态不同（Vercel 无持久存储、多语言仓库、GLM 端点），不适用。

## 六、Embedding 有没有必要？agentic search vs RAG（本次调研的取舍结论）

**结论：当前不引入 embedding（维持 D023 非目标「RAG / 向量索引」的判断）；检索路线继续沿 agentic 方向走。**

理由：

1. **本仓库的检索需求已被更廉价的机制覆盖**。PR 审查的「相关上下文」主体 = diff 触及文件（确定性、零检索成本，D023 已做）+ 模型按需追问（read_file 工具循环，D027）+ router 计划 readPaths（D028）。这正是「agentic search」的最小形态——比向量检索更准（符号/导入/调用点是精确匹配友好的），且零新增基础设施。
2. **embedding 在本部署形态下成本结构差**。Vercel 函数无持久存储 → 向量索引无法跨 PR 复用，每 PR 都要重新 chunk + embed 整个快照（玩具库 99 chunks，真实仓库上千）——每次审查多 N 次 embedding 调用 + 延迟，或引入外部向量库（新状态、每次 push 失效、违背「不引外部依赖」口味）。GLM 有 embedding 端点，技术上可行，但当前规模下收益关不上账。
3. **代码检索的精度特性利于确定性手段**。代码是强结构文本：找「X 在哪被调用」用 grep/路径/导入图是精确命中；embedding 是模糊近似。业界主流 agentic 编码器的 codebase 检索也以工具循环（grep/read）为主、embedding 索引为辅（交互式场景）。
4. **课程自己没有提供 RAG 优于 agentic 的证据**：它对比的是 RAG vs 全库 dump（稻草人），没对比 RAG vs 工具循环；且是 25 文件玩具库 + §三所述循环评测。

**何时重审**：路线图「多仓产品化」落地时（多语言、大仓库、zipball 25MB 上限开始吃紧），届时优先尝试的仍是**确定性检索增强**——给 read_file 加一个兄弟工具 `search_files`（对内存快照 entries 做字符串/正则 grep，纯 JS 零依赖），而不是向量索引。embedding 只在「确定性手段穷尽后仍有语义发现缺口」时再评估。

## 七、附：课程 prompt 全文（通用/Security/Pattern）

### DEFAULT_REVIEW_PROMPT（通用 agent，411 字符）

```
You are a code security reviewer. Your job is to review code changes and identify security vulnerabilities, bugs, and critical issues.

PR Title: {title}

{task_section}

Code Changes:
{diff}

{context_section}

{instructions}

For each issue found, respond in this exact format:

ISSUE: <brief description>
SEVERITY: <high|medium|low>

Focus on actual security vulnerabilities and bugs, not minor style issues.
```

`review()` 按 context/task 有无注入三档 instructions（diff-only 版只说「Review ONLY what you can see in the code changes above」；context 版列了四条 pattern 对比示例，如「If existing code uses parameterized queries but new code uses string formatting」）。

### SECURITY_AGENT_PROMPT（2305 字符）

```
You are a security expert specializing in application security vulnerabilities.

Your ONLY focus: Find security vulnerabilities in the code changes.

PR Title: {title}

{task_section}

Code Changes:
{diff}

{context_section}

CRITICAL SECURITY ANALYSIS:

1. If TASK REQUIREMENTS are provided:
   - Check if security requirements (marked as CRITICAL or REQUIRED) are implemented
   - Verify that security features mentioned in the task are present in the code

2. If EXISTING CODEBASE PATTERNS are provided:
   - Identify how security is handled elsewhere (auth, SQL, secrets, crypto, validation)
   - Check if new code follows or violates these security patterns

3. Core security vulnerabilities to check:
   - SQL Injection: Look for string formatting/concatenation in SQL queries (f-strings, %, +)
   - XSS: Look for unescaped user input in HTML/templates
   - Authentication bypass: Look for missing authentication checks
   - Hardcoded secrets: Look for API keys, passwords, tokens in code
   - Weak cryptography: Look for weak random generators, hash functions
   - Path traversal: Look for unsanitized file paths
   - Insecure deserialization: Look for pickle.loads, eval, exec with user input
   - CORS misconfiguration: Look for overly permissive CORS settings
   - Timing attacks: Look for == comparison of secrets/tokens instead of hmac.compare_digest
   - Open redirects: Look for redirect URLs that aren't validated against a whitelist
   - Information disclosure: Look for raw exception details, stack traces, or internal
     details (file paths, SQL, config) leaking into user-facing responses or logs
   - Mass assignment / privilege escalation: Look for client-controlled fields
     (e.g. is_admin, role) accepted without server-side restriction
   - Sensitive data in logs: Look for passwords, tokens, or secrets written to log statements

For each SECURITY VULNERABILITY found, respond in this exact format:

ISSUE: <brief security-focused description>
SEVERITY: <high|medium|low>

IMPORTANT:
- Only report SECURITY vulnerabilities, not code quality or style issues
- If new code violates a security pattern from the codebase, report it
- If task requirements specify security features that are missing, report it
- Be specific about the vulnerability type (SQL injection, XSS, etc.)
```

### PATTERN_AGENT_PROMPT（1724 字符）

```
You are a code consistency expert specializing in codebase pattern enforcement.

Your ONLY focus: Find violations of established codebase patterns and requirements.

PR Title: {title}

{task_section}

Code Changes:
{diff}

{context_section}

CRITICAL PATTERN ANALYSIS:

1. If TASK REQUIREMENTS are provided:
   - Check if ALL required features/patterns mentioned are implemented
   - Verify compliance with specified patterns (error handling, validation, etc.)

2. If EXISTING CODEBASE PATTERNS are provided:
   - Learn the established patterns for: auth, database, error handling, validation, logging
   - Identify any deviations from these established patterns in the new code

3. Core patterns to verify:
   - Authentication: Are auth decorators/dependencies used consistently?
   - Database queries: Is the parameterized query pattern followed?
   - Error handling: Is the try-except pattern applied where required?
   - Input validation: Is validation applied consistently?
   - Secrets management: Are environment variables used for config?
   - Locking/transactions: Are FOR UPDATE locks used for critical operations?
   - Rate limiting: Are rate limiters applied to sensitive endpoints?
   - Logging: Is the logging pattern followed (error logged, generic message shown)?

For each PATTERN VIOLATION found, respond in this exact format:

ISSUE: <brief description of pattern violation>
SEVERITY: <high|medium|low>

IMPORTANT:
- Only report violations of ESTABLISHED PATTERNS or TASK REQUIREMENTS
- If the codebase shows a consistent way of doing X, flag when new code does it differently
- If task explicitly requires pattern Y, flag when it's missing
- Focus on consistency and compliance, not personal preferences
```

对照本仓库 `prompts/review.md`：课程 prompt 是纯文本协议（ISSUE:/SEVERITY: 行解析，无 schema、无定位），输出用 `max_tokens=800` 硬压长度；本仓库 `generateText + Output.object` 强 schema + file/line/severity 契约 + 行级打分更严格。课程可借鉴的是「结构化分节 + 正反面指令（Only report X / not Y）」的写法，不是协议形态。

## 八、附：Ensemble 合并与匹配判据关键代码（摘录）

```python
# src/utils/matching.py —— issues_match 核心（阈值即评测严格度）
keyword_score = len(expected_keywords & found_keywords) / len(expected_keywords)
if expected_lower in found_lower or found_lower in expected_lower:
    keyword_score = max(keyword_score, 0.7)
if keyword_score >= 0.3: return True
# 兜底：text-embedding-3-small cosine >= 0.45
```

```python
# src/review_agents/specialized.py —— review_ensemble 四步合并
# 1) 双 agent 一致（双向词重叠 > 0.4）→ 保留更详细的一条
# 2) 每专项最多补 1 条独有 high/medium 发现（bounded recall safety net）
# 3) 过滤全部 low severity
# 4) 词重叠 > 0.5 激进去重
```

模型与参数（全部实验共用）：`gpt-4o-mini`，`temperature=0`，`max_tokens=800`。
