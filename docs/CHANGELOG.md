# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [Unreleased]

### Added

- git 仓库初始化：`PLAN.md` 交接文档、`.gitignore`
- Harness 式文档体系（D007）：`AGENTS.md`、`docs/architecture.md`、`docs/decisions.md`、`docs/journal.md`、本文件
- ponytail skill 项目级安装：6 个 skill 复制到 `.zcode/skills/`，随仓库版本化（D009）

### Changed

- `PLAN.md` 迁移至 `docs/plans/PLAN.md`；后续阶段性计划/规格统一归档 `docs/plans/`（D010）
- 全部文档按真实项目定位修订表述
- 提交身份改为 `blingblingredstar <564447023@qq.com>`，既有提交作者已重写
- LLM 接入按 OpenAI 兼容端点抽象（`LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`），文档与配置不绑定具体厂商；GLM 为当前实例（D011）

### Added（续）

- GitHub 远端：`blingblingredstar/pr-review-agent`（private），main 已推送并设跟踪
- 选装 mattpocock/skills 3 个工程技能：`code-review` / `tdd` / `diagnosing-bugs`（D012）

### Changed（续）

- skills 目录迁移：`.zcode/skills/` → `.agents/skills/`（git mv，删除空 `.zcode/`），去特定工具目录依赖，ZCode / dsh 双端原生识别（D013）
