#!/bin/zsh
# AACR-Bench 外部基准对照：钉版本拉取 aacr-bench harness，以 prra reviewer 跑本 bot。
# 形态：数据零复制（harness 首次运行自动下载 + sha256 校验缓存），harness/数据/judge 全钉版本，
# 上游更新 = 显式改本文件的 PIN 再重跑（lockfile 语义）。
# 用法：scripts/aacr-bench.sh [limit=2] [seed=42] [mode=preview|mock|real]
#   preview = 验机械（clone/checkout/结果文件/judge mock，零 LLM 成本）
#   mock    = 真评审 + mock judge（花评审 token，judge 分数无意义）
#   real    = 真评审 + 真 judge（GLM 端点；limit>20 需 FORCE=1——全量 40 PR 约 1.5-2.5M tokens）
set -euo pipefail

# ---- 钉版本（上游更新时改这里）----
AACR_SHA="c6486859e14b686b3c2aa0176ac8376cc9b72e07"   # alibaba/aacr-bench @ 2026-11-11
DATASET_VER="v1"                                       # v1 = 1,505 正例全量（v2 是 944 子集）

LIMIT="${1:-2}"
SEED="${2:-42}"
MODE="${3:-preview}"

PRRA_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AACR_HOME="${AACR_HOME:-$HOME/Developments/.aacr-bench}"
BENCH="$AACR_HOME/aacr-bench"
EV="$BENCH/evaluation"

# zsh 三连坑（canary-patrol 教训）：nvm 内部 unbound 变量、glob 无匹配即中止——不用 glob
set +u; source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 24 >/dev/null; set -u

case "$MODE" in
  preview|mock|real) ;;
  *) echo "mode 须为 preview|mock|real，收到：$MODE"; exit 1 ;;
esac
if [[ "$MODE" == "real" && "$LIMIT" -gt 20 && "${FORCE:-0}" != "1" ]]; then
  echo "real + limit>20 全量成本约 1.5-2.5M tokens；确认跑请 FORCE=1"; exit 1
fi

# ---- 1) 钉版本 clone ----
if [[ ! -d "$BENCH/.git" ]]; then
  git clone -q https://github.com/alibaba/aacr-bench.git "$BENCH"
fi
git -C "$BENCH" fetch -q origin main
git -C "$BENCH" checkout -q "$AACR_SHA"
git -C "$BENCH" reset -q --hard "$AACR_SHA"   # 每次重置到钉版，防止上一轮补丁残留歧义

# ---- 2) 注册 prra：补丁 + 适配器（reset 后必为未打状态，直接应用）----
git -C "$BENCH" apply "$PRRA_DIR/scripts/aacr/pipeline-prra.patch"
cp "$PRRA_DIR/scripts/aacr/prra.py" "$EV/reviewers/prra.py"

# ---- 3) venv（uv；钉版 clone 的 requirements 即锁版本）----
if [[ ! -d "$EV/.venv" ]]; then
  (cd "$EV" && uv venv .venv --python 3.11 && uv pip install -r requirements.txt --python .venv/bin/python)
fi

# ---- 4) 数据：converter 全量跑一次（触发自动下载+校验），再过滤 TS/JS 子集 ----
RAW="$EV/benchmark/AACR-Bench/$DATASET_VER/positive_samples.json"
TSJS="$EV/benchmark/AACR-Bench/$DATASET_VER/positive_samples.tsjs.json"
DATASET="data/aacr_bench_tsjs.jsonl"
cd "$EV"
source .venv/bin/activate
[[ -f "$RAW" ]] || python -m converters.aacr_bench --validate   # 仅触发下载，产物 data/aacr_bench.jsonl 弃用
python3 - "$RAW" "$TSJS" <<'EOF'
import json, sys
rows = json.load(open(sys.argv[1]))  # 按 PR 分组：githubPrUrl / project_main_language / comments[]
tsjs = [r for r in rows if r.get("project_main_language") in ("TypeScript", "JavaScript")]
json.dump(tsjs, open(sys.argv[2], "w"), ensure_ascii=False)
print(f"TS/JS 正例：{sum(len(r['comments']) for r in tsjs)} 条意见 / {len(tsjs)} 个 PR")
EOF
python -m converters.aacr_bench --input "$TSJS" --output "$DATASET" --limit "$LIMIT" --seed "$SEED" --validate

# ---- 5) judge 配置（evaluate 自动读 evaluation/.env；从本仓 .env 安全取值——不 source 防 LLM_EXTRA_BODY 花括号坑）----
envget() { grep -m1 "^$1=" "$PRRA_DIR/.env" | cut -d= -f2-; }
JUDGE_USE_MOCK_VAL="true"
[[ "$MODE" == "real" ]] && JUDGE_USE_MOCK_VAL="false"
cat > "$EV/.env" <<EOF
export JUDGE_BASE_URL="$(envget LLM_BASE_URL)"
export JUDGE_API_KEY="$(envget LLM_API_KEY)"
export JUDGE_MODEL="$(envget LLM_MODEL)"
export JUDGE_USE_MOCK="$JUDGE_USE_MOCK_VAL"
export JUDGE_CONCURRENCY="3"
EOF

# ---- 6) 跑（reviewer 的 LLM 配置由桥接 CLI 经 node --env-file 自取）----
export PRRA_REPO_DIR="$PRRA_DIR"
RUN_ID="prra-${MODE}-$(date +%Y%m%d_%H%M%S)"
PREVIEW_FLAG=""
[[ "$MODE" == "preview" ]] && PREVIEW_FLAG="--preview"
python -m pipeline run --stage all --reviewer prra --dataset "$DATASET" \
  --run-id "$RUN_ID" --concurrency 2 --timeout-minutes 10 $PREVIEW_FLAG

echo "\n指标目录：$EV/metrics/aacr_bench_tsjs/prra/$RUN_ID/"
