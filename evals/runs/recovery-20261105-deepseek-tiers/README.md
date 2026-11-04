# 数据恢复记录：DeepSeek 三档对照（2026-11-05）

## 事故

三档（disabled/low/high）并行 eval 同时启动 → `startedAt` 同秒 + 模型名相同 → run 文件名相同（`2026-11-04T17-42-24-deepseek-flash.{json,md}`）→ **互相覆盖**：disabled 与 low 的 JSON 被最后完成的 high 覆盖。根因 = run 文件名只含时间戳+模型，不含配置指纹（且 run JSON 不记录 `LLM_EXTRA_BODY`——memory 早有此坑记录，本轮是具体实例）。

## 恢复

- 本目录三个 `*-stdout.log` = 三档任务的完整流式 stdout（后台任务未接 tail，逐例输出全部落盘），含每档完整 markdown 报告（分组指标 + 逐用例表：命中/tokens/时长）——**报告所需数据完整恢复**；丢失的仅是 JSON 里的意见全文与判分细目（comments body、verdicts expect 明细）。
- 幸存 JSON `evals/runs/2026-11-04T17-42-24-deepseek-flash.json` 实际内容 = **high 档**（avg 28.9s × 71 = 34.2min 与 high 总耗时吻合）。
- 修复：`evals/run.ts` 文件名加 `LLM_EXTRA_BODY` 指纹后缀 + run JSON 记录 extraBody 原文（同 PR）。

## 三档对照（71 例全量，全部 0 错误；promptHash `7be33f4d6fbc` = JSON 模式）

| 组 | disabled | low | high |
|---|---|---|---|
| **能力 recall**（syn+real） | 85.7%（30/35） | **91.4%**（32/35） | 88.6%（31/35） |
| 能力 precision | **86.8%** | 82.5% | 76.7% |
| synthetic | 95.0% | **100%**（20/20） | 90.0% |
| real | 73.3% | 80.0% | **86.7%**（13/15） |
| correlation | 30.0% | 30.0% | **50.0%**（5/10，历史最高） |
| repo | 80.0% | 60.0% | **100%**（5/5） |
| incremental | 62.5% | 75.0% | 75.0% |
| dogfood | 100% | 50% | 100% |
| injection | 7/7 | 7/7 | 7/7（三档 0 回显 0 抑制） |
| output tokens | 13,415 | 294,667（×22） | 394,856（×29） |
| 总 tokens | 128,286 | 411,465 | 512,126 |
| 总耗时 | 2.3 分钟 | 26.4 分钟 | 34.2 分钟 |
| 单例 avg/max | 1.9s / 11.5s | ~22s / —（top 21,786@117.6s） | 28.9s / 220.3s |
