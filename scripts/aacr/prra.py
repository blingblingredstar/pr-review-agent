"""PR Review Agent（prra）评审器：aacr-bench 统一评测框架适配层。

调用本仓库的桥接 CLI（npm run aacr:review -- --repo <path> --from <base> --to <head>），
把 reviewDiff 的产出包装成框架统一的 OCR 形状结果文件——evaluate.py 的
load_target_comments 对 claude/codex 之外的 reviewer 名一律走 OCR 解析器
（review.comments[] 的 path/start_line/end_line/content + review.summary 的 token 数），
因此无需改动评测代码。

本文件由 scripts/aacr-bench.sh 复制进钉版本 clone 的 evaluation/reviewers/；
pipeline.py 对 prra 的注册见 scripts/aacr/pipeline-prra.patch。
LLM 配置不在本层：桥接 CLI 经 node --env-file=.env 自取 PRRA_REPO_DIR 下的 .env。
"""
from __future__ import annotations

import json
import subprocess
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict

import config
from repo_utils import clean_worktree, log, prepare_repo, run_command
from schema import ReviewInstance

# 桥接 CLI 的宿主仓库（包装脚本导出）；LLM_* 由 npm script 的 node --env-file 自取
PRRA_REPO_DIR_VAR = "PRRA_REPO_DIR"


def check_env(preview: bool) -> None:
    import os

    repo_dir = os.environ.get(PRRA_REPO_DIR_VAR, "")
    if not repo_dir and not preview:
        raise SystemExit(
            f"缺少环境变量 {PRRA_REPO_DIR_VAR}（本仓库根目录路径，包装脚本应已导出）"
        )
    log(f"prra repo dir: {repo_dir or '(preview, skipped)'}")


def run_prra_review(
    repo_path: Path,
    base_commit: str,
    head_commit: str,
    prra_dir: Path,
    timeout_minutes: int,
    out_path: Path,
) -> subprocess.CompletedProcess:
    command = [
        "npm",
        "run",
        "aacr:review",
        "--",
        "--repo",
        str(repo_path),
        "--from",
        base_commit,
        "--to",
        head_commit,
        "--out",
        str(out_path),
    ]
    # 桥接 CLI 内部有自己的 270s LLM 硬超时；进程级超时按框架惯例留足余量
    return run_command(command, cwd=str(prra_dir), timeout_seconds=timeout_minutes * 60 + 300)


def save_result(
    results_dir: Path,
    instance: ReviewInstance,
    review_process: subprocess.CompletedProcess,
    started_at: str,
    duration_seconds: float,
    payload_out_path: Path,
) -> Path:
    results_dir.mkdir(parents=True, exist_ok=True)
    out_path = config.result_path(results_dir, instance.instance_id)

    # 结果从 --out 文件读：stdout 会被 npm banner 污染，不可靠。
    # 失败兜底 = 空意见 + 保留 stderr：evaluate 对失败实例按「零生成意见」计（与 ocr 失败同语义），
    # 且 review 字段必须是 dict——字符串会让 _extract_usage_from_result 崩（首跑实证）
    review_output: Any = {"comments": [], "summary": {}}
    if payload_out_path.is_file():
        try:
            loaded = json.loads(payload_out_path.read_text(encoding="utf-8"))
            if isinstance(loaded, dict):
                review_output = loaded
        except json.JSONDecodeError:
            pass
    if payload_out_path.exists():
        payload_out_path.unlink()

    payload = {
        "instance_id": instance.instance_id,
        "repo": instance.repo,
        "base_commit": instance.base_commit,
        "head_commit": instance.head_commit,
        "reviewer": "prra",
        "started_at": started_at,
        "duration_seconds": round(duration_seconds, 2),
        "prra_exit_code": review_process.returncode,
        "review": review_output,
        "stderr": review_process.stderr,
    }
    with out_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    return out_path


def review_instance(
    instance: ReviewInstance,
    repo_dir: Path,
    results_dir: Path,
    timeout_minutes: int = 30,
    preview: bool = False,
    **_: Any,
) -> Dict[str, Any]:
    """对单条样本执行 prra 审查，返回状态摘要（与 ocr.review_instance 同构）。"""
    import os

    log(f"=== [prra] Processing {instance.instance_id} ===")

    repo_path = prepare_repo(
        repo_dir=repo_dir,
        clone_url=instance.resolved_clone_url,
        repo_full_name=instance.repo,
        base_commit=instance.base_commit,
        head_commit=instance.head_commit,
    )

    started_at = datetime.now(timezone.utc).isoformat()
    start_time = time.monotonic()
    # 桥接结果文件放 results_dir 下的临时名（不占 <safe_id>.json 结果位）
    payload_out_path = results_dir / f".prra-payload-{config.safe_id(instance.instance_id)}.json"
    if preview:
        # 预览模式：只验证 clone/checkout/结果文件机械，不调 LLM（与框架 --preview 语义一致）
        review_process = subprocess.CompletedProcess(args=[], returncode=0, stdout="", stderr="")
    else:
        review_process = run_prra_review(
            repo_path=repo_path,
            base_commit=instance.base_commit,
            head_commit=instance.head_commit,
            prra_dir=Path(os.environ[PRRA_REPO_DIR_VAR]),
            timeout_minutes=timeout_minutes,
            out_path=payload_out_path,
        )
    duration_seconds = time.monotonic() - start_time

    out_path = save_result(
        results_dir=results_dir,
        instance=instance,
        review_process=review_process,
        started_at=started_at,
        duration_seconds=duration_seconds,
        payload_out_path=payload_out_path,
    )

    clean_worktree(repo_path)

    status = "preview" if preview else ("ok" if review_process.returncode == 0 else "failed")
    log(f"--- [prra] {instance.instance_id} {status} (exit={review_process.returncode}) -> {out_path}")
    return {
        "instance_id": instance.instance_id,
        "status": status,
        "exit_code": review_process.returncode,
        "result_path": str(out_path),
    }
