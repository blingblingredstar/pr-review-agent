# Spec：仓库上下文注入——第一阶段（确定性注入）

> 路线图第 4 项「上下文增强」的第一阶段。2026-11-03 立项，决策记录见 `docs/decisions.md` D023。
> 第二阶段（工具循环）不在本 spec 范围，见文末「后续」。

## 一、问题与目标

当前审查只看 diff：hunk ±3 行的局部上下文让模型看不到 getter/被调函数的语义（real-02 类短板），
也看不到仓库里还有什么（关联问题无线索）；diff 截断（D018/D020）丢弃的新建大源码文件更是整块盲区。

**目标**：生产 webhook 路径审查时，给模型注入仓库级上下文——
diff 触及文件的全文 + 仓库文件树——让它「看得见 diff 之外的项目」。

**非目标（本阶段不做）**：

- 工具循环（`read_file` 按需读取）——改输入契约，eval 集需另设计（D019），等本阶段生产数据再立项
- /tmp 缓存（zipball 下载 1-2s，无必要不做）
- RAG / 向量索引（全量已在手上，索引无增量价值）
- `prompts/review.md` 改动——上下文块自描述，保 eval promptHash 不变

## 二、方案

### 数据流（生产路径）

```
fetchPr 拉 diff ──► buildRepoContext(headRepo, headSha, diff)      [src/context.ts，best-effort]
                        │ GET /repos/{headRepo}/zipball/{headSha}    （1 个 API 请求，302 手动跟进重发凭证）
                        │ fflate 内存解压（不落 /tmp，不依赖 git 二进制）
                        ▼
                    触及文件全文（diff 顺序，逐文件全有或全无）+ 文件树（字母序）
                        │ 任何失败 → null
                        ▼
reviewDiff(diff, context?) ──► prompt = context ? `${context}\n\n[diff 开始]\n${truncateDiff(diff)}` : truncateDiff(diff)
```

### 关键设计（沿用仓库既有决策口味）

1. **diff 字节级不动**：`diffCoveredLines`（D016 行号定位）与行内发帖继续吃原始 diff；上下文只加不改。
2. **确定性选择，零模糊判断**：触及文件清单由 diff 头解析（`diffTouchedPaths`，复用 `diffHeaderPath` 口径），
   全文按 diff 顺序、逐文件全有或全无；装不下留一行说明。D020 否决运行时模糊过滤的理由直接适用——
   非确定性撞 eval 回归与 synchronize 重审一致性。
3. **独立预算**：`CONTEXT_MAX_CHARS`（默认 100_000 字符，数值 0 = 显式关闭作为生产总闸），与 `DIFF_MAX_CHARS` 分离。
   合计最坏情形 ≈ 300k 字符 diff + 100k 字符上下文 ≈ 11 万 token，200k 窗口模型内安全。
4. **best-effort 失败语义**：下载超时（10s 硬上限）/ 超大仓库（zipball 压缩 > 25MB）/ API 错误 / 解压失败
   → 一律返回 null，审查照旧。上下文增强绝不连垮主流程。
5. **fork 正确性**：zipball 按 `pull_request.head.repo.full_name` 取（fork PR 的 head 快照在 fork 仓库），
   payload 缺字段回退 base 仓库。
6. **触及文件含被截断文件**：选择基于完整原始 diff（fetchPr 输出），D018/D020 丢掉的新建大文件正好由上下文补上。

### 已知取舍（v1 明确接受）

- **新建文件全文与 diff 重复 spend**：new file 的 diff 就是全文，上下文再给一遍是冗余；
  换取确定性（不追踪 truncateDiff 的保留集），预算有界，接受。
- **逐文件全有或全无**：单个超大触及文件可能整体出局（留说明）。按 diff 顺序而非大小贪心——
  触及文件全都有价值，D020 的教训是「大 ≠ 噪声」，不在此复制大小排序。
- **文件树殿后**：预算紧张时树先被截断。树是「知道什么存在」的线索，触及文件全文才是语义主体，优先级如此。

## 三、测试与验收

- `test/context.test.ts`（7 条）：预算语义（默认/0 关闭/非法回退）、`diffTouchedPaths` 顺序去重、
  zipball 下载（剥根目录段、302 重发凭证、错误路径抛错）、上下文拼装（顺序/缺失/二进制/超预算/树截断）、
  `buildRepoContext` 失败返回 null。
- 全量 `npm test` 71 绿；`npm run typecheck` 过。
- **eval 红线**：eval 路径不传 context → prompt 字节级不变 → promptHash（`d399f9d4ed17`）不变；
  recall 不低于基线 run（2026-11-01，96.3%）。分支上跑一轮 eval 对照。
- 生产观测：`[context]` 日志行（触及数/快照数/字符数）；usage 日志（PR #22）对照注入前后的 inputTokens。

## 四、后续（不在本阶段）

- **第二阶段：工具循环**——`read_file(path)` 让模型按需读仓库（上下文自主扫描的完全体）。
  前置：本阶段生产数据证明确定性注入不够用；eval 集按工具行为另设计（D019 的契约约束）。
- **超大 PR diff 拉取缺口**（会话 25 记录的 20k 行 406）：zipball 管道为「list files 分页拼 diff」
  铺了半条路，修复时复用本模块的下载与解压。

## 五、平台依据（Vercel，2026-11-02 核实）

- 运行时无 git 二进制（Lambda 精简镜像）→ 纯 JS 解压（fflate），不 child_process git。
- 文件系统只读、/tmp 不跨调用持久 → 干脆不落盘，内存解压（25MB 压缩上限保护）。
- 300s 墙钟：上下文步硬上限 10s，挤占可忽略（LLM 实测 20s 级 vs 270s 预算，余量 ~10 倍）。
