#!/bin/zsh
# 金丝雀周巡检（2026-11-13 落地，随 D045 批次）：每周在独立 worktree 跑一次全量 eval，
# 与同 model+promptHash 最近 3 轮 run 的逐指标 median 对比能力口径（synthetic+real）recall/precision——
# 下滑 ≥10pp 或失败用例 ≥3 弹 macOS 通知。防端点静默演进。
# 告警口径换代（2026-11-18，D050）：单 prev 锚（取最新同 key run）会撞上轮间带宽的 band 顶——
# 首告警（2026-11-16，-16pp）经期望丢失重叠判别（0/10）证实为噪声：同 key 四轮 precision
# 82.1/91.5/75.5/75.0，带宽 16.5pp 远大于原阈值 6pp。改为 median-of-3 锚 + 历史不足 3 轮只记录不告警
# + 阈值 6→10pp（median 锚下实测最大噪声偏移 -7.1pp，10pp 之上视为真漂移）。
# 裁定出处：金丝雀巡检（2026-11-10）——评测集/漂移分析/面板均已存在，唯一缺口 = 周期性无改动基线巡检；
# 形态 = 零新代码本地 cron（非 Vercel、非 ZCode subagent）。
#
# 一次性安装：
#   1) ~/Library/LaunchAgents/com.blingblingredstar.prra-canary.plist：
#        ProgramArguments = [/bin/zsh, <本脚本绝对路径>]
#        StartCalendarInterval = { Weekday=1, Hour=9, Minute=0 }   # 每周一 09:00
#        StandardOutPath/StandardErrorPath = ~/.canary-patrol/launchd.log
#   2) launchctl bootstrap gui/$(id -u) <plist 路径>
#   3) 手动试跑：launchctl kickstart gui/$(id -u)/com.blingblingredstar.prra-canary
#
# 设计要点：
#   - 独立 worktree（~/.canary-patrol/pr-review-agent），主工作树零接触；每周 reset --hard origin/main
#   - node_modules 首建 APFS 克隆自主仓，其后 package-lock 指纹变化才 npm ci
#   - .env 符号链接自主仓（巡检跑生产同口径模型与 thinking 参数）
#   - patrol run 落 worktree 的 evals/runs/（不入主库）；主库已提交的历史 run 天然作对照历史
#   - PRRA_REUSE_LAST=1 跳过 eval、直接用最新既有 run 测试对比/告警链路（调试用）

set -euo pipefail
REPO="${PRRA_REPO:-/Users/liuyong/Developments/pr-review-agent}"
WT="${PRRA_WORKTREE:-$HOME/.canary-patrol/pr-review-agent}"
STATE="$HOME/.canary-patrol"
LOG="$WT/canary-patrol.log"
THRESHOLD=10         # 百分点；recall/precision 相对同 key 最近 3 轮 median 的下滑告警线（D050）
FAILED_THRESHOLD=3   # 单次 run 失败用例数告警线（与锚点无关，独立判定）

export PATH="/opt/homebrew/bin:$PATH"
export NVM_DIR="$HOME/.nvm"
set +u
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
nvm use 24 >/dev/null 2>&1 || true
set -u

note() { osascript -e "display notification \"$1\" with title \"PR 审查金丝雀\" sound name \"Sub\"" >/dev/null 2>&1 || true; }
log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

mkdir -p "$STATE"

# ---- worktree 初始化 / 每周同步 ----
git -C "$REPO" worktree prune
if [ ! -e "$WT/.git" ]; then
  git -C "$REPO" worktree add --detach "$WT" origin/main
  rm -rf "$WT/node_modules"
  cp -Rc "$REPO/node_modules" "$WT/node_modules" 2>/dev/null || cp -R "$REPO/node_modules" "$WT/node_modules"  # APFS 克隆，秒级
  ln -sf "$REPO/.env" "$WT/.env"
fi
git -C "$REPO" fetch origin main
git -C "$WT" reset --hard origin/main

# ---- 依赖漂移：package-lock 指纹变了才 npm ci ----
lockhash=$(shasum "$WT/package-lock.json" | cut -d' ' -f1)
if [ ! -e "$WT/node_modules/.package-lock.json" ] || [ "$(<"$STATE/lockhash" 2>/dev/null)" != "$lockhash" ]; then
  log "依赖重装：package-lock 指纹变化，npm ci"
  (cd "$WT" && npm ci --prefer-offline --no-fund --no-audit)
fi
printf '%s' "$lockhash" > "$STATE/lockhash"

# ---- 跑 eval（或复用最新 run 调试） ----
cd "$WT"
if [ "${PRRA_REUSE_LAST:-0}" != "1" ]; then
  if ! npm run eval; then
    log "FAIL：npm run eval 退出码非 0"
    note "巡检 eval 执行失败，详见 launchd 日志与 $LOG"
    exit 1
  fi
fi

# ---- 解析最新 run ----
# 名字排序（不按 mtime：worktree 首建会把全部已提交 run 的 mtime 统一置为创建时刻）
# 文件名前缀 = run startedAt 的 UTC 时间戳，字典序即时间序
newname=$(ls evals/runs 2>/dev/null | grep '\.json$' | sort -r | head -1 || true)
new=""
if [ -n "$newname" ]; then new="evals/runs/$newname"; fi
if [ -z "$new" ] || ! model=$(jq -r '.model' "$new" 2>/dev/null) || [ -z "$model" ] || ! hash=$(jq -r '.promptHash' "$new" 2>/dev/null) || [ -z "$hash" ]; then
  log "FAIL：run JSON 解析失败（${new:-无 run 产物}）"
  note "巡检 run 解析失败（schema 变更？），详见 $LOG"
  exit 1
fi
# summary 缺失（schema 变更）显式失败，不让 recall/precision 以空值静默走完
if ! jq -e '.summary.recall != null and .summary.precision != null' "$new" >/dev/null 2>&1; then
  log "FAIL：run JSON summary 缺 recall/precision（${new}）"
  note "巡检 run summary 解析失败（schema 变更？），详见 $LOG"
  exit 1
fi
recall=$(jq -r '(.summary.recall*10000|round)/100' "$new")
precision=$(jq -r '(.summary.precision*10000|round)/100' "$new")
failed=$(jq -r '.summary.failed // 0' "$new")

# ---- 对照：同口径 run 最近 3 轮的逐指标 median 作锚（D050，worktree 内 = 主库已提交历史 + 既往巡检 run） ----
# 文件名只含 model+promptHash+extraBody 指纹，过滤不掉 ctx/reflect/plan 臂与 EVAL_ONLY 子集 run
#（后缀 -ctx/-reflect 在 extraBody 指纹之后，EVAL_ONLY 更是不留名）——逐个开 JSON 验内容：
# 必须 evalOnly 为空、三臂全 false、summary 有 recall/precision、llmExtraBody 与本次一致（thinking 档位变了也不可比）
newextra=$(jq -c '.llmExtraBody' "$new")
hist=()
for candname in $(ls evals/runs 2>/dev/null | grep -F -- "-${model}-${hash}-" | grep '\.json$' | sort -r); do
  [ "$candname" = "$newname" ] && continue
  if jq -e --argjson extra "$newextra" \
       '(.summary.recall != null) and (.summary.precision != null) and (.evalOnly == null) and (.planArm != true) and (.contextArm != true) and (.reflectArm != true) and (.llmExtraBody == $extra)' \
       "evals/runs/$candname" >/dev/null 2>&1; then
    hist+=("evals/runs/$candname")
    [ ${#hist[@]} -ge 3 ] && break
  fi
done

alert=""
if [ "$failed" -ge "$FAILED_THRESHOLD" ] 2>/dev/null; then alert="失败用例 ${failed}"; fi

if [ ${#hist[@]} -eq 0 ]; then
  log "基线建立：model=$model prompt=$hash recall=$recall precision=$precision failed=$failed（无同 key 历史对照）"
elif [ ${#hist[@]} -lt 3 ]; then
  # 历史不足 3 轮时 median 锚不稳（实测纯噪声即可偏离 band 顶 -16pp），只记录不判漂移
  log "对照（同 key 历史 ${#hist[@]} 轮 <3 仅记录，不判漂移）：model=$model prompt=$hash recall=$recall precision=$precision failed=$failed"
else
  recs=(); pres=()
  for f in "${hist[@]}"; do
    recs+=("$(jq -r '(.summary.recall*10000|round)/100' "$f")")
    pres+=("$(jq -r '(.summary.precision*10000|round)/100' "$f")")
  done
  med_recall=$(printf '%s\n' "${recs[@]}" | sort -n | sed -n '2p')
  med_precision=$(printf '%s\n' "${pres[@]}" | sort -n | sed -n '2p')
  dr=$(awk -v a="$recall" -v b="$med_recall" 'BEGIN{printf "%.1f", a-b}')
  dp=$(awk -v a="$precision" -v b="$med_precision" 'BEGIN{printf "%.1f", a-b}')
  if awk -v d="$dr" -v t="$THRESHOLD" 'BEGIN{exit !(d < -t)}'; then alert="${alert:+$alert、}recall ${dr}pp"; fi
  if awk -v d="$dp" -v t="$THRESHOLD" 'BEGIN{exit !(d < -t)}'; then alert="${alert:+$alert、}precision ${dp}pp"; fi
  log "对照：model=$model prompt=$hash recall=$recall（锚 ${med_recall} Δ${dr}）precision=$precision（锚 ${med_precision} Δ${dp}）failed=$failed ${alert:+⚠ 漂移：$alert}"
fi

if [ -n "$alert" ]; then
  note "巡检告警（prompt $hash）：$alert —— recall $recall / precision $precision，详见 $LOG"
fi
