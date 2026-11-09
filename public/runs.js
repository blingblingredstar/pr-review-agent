"use strict";
// 运行观测面板渲染（#122 / D041）。
// 渲染硬约束（P0-2，存储型 XSS 唯一防线）：一律 createElement + textContent，禁用 innerHTML /
// insertAdjacentHTML；数据经 fetch + JSON.parse，绝不内联进 HTML（CSP script-src 'self' 为第二道闸）。
// GitHub 链接逐段 encodeURIComponent；本页不做任何富文本渲染——findings.body 是 PR 作者可控内容
// 经 LLM 回显的存储快照，按纯文本 pre-wrap 展示。
// v1 不调 GitHub API（connect-src 'self'）；resolve/reactions 留在 PR 页面看。

const SEVERITIES = ["blocker", "major", "minor", "nit"];

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child === undefined || child === null) continue;
    node.append(child);
  }
  return node;
}

function ghPrUrl(repo, pr) {
  const [owner, name] = String(repo).split("/");
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pull/${pr}`;
}

function fmtNum(n) {
  return typeof n === "number" && Number.isFinite(n) ? String(n) : "—";
}

function fmtTime(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function sevBadge(severity) {
  return el("span", { class: `badge sev-${severity}`, text: severity });
}

function findingRow(f) {
  const line = el("span", { class: "mono muted", text: `${f.file}:${f.line}` });
  const body = el("div", { class: "finding-body", text: f.body });
  const conf = f.confidence ? el("span", { class: "muted", text: `conf=${f.confidence}` }) : null;
  const head = el("div", { class: "finding-head" }, [sevBadge(f.severity), line, conf]);
  return el("div", { class: `finding sev-${f.severity}` }, [head, body]);
}

function showError(message) {
  const box = document.getElementById("error");
  box.textContent = message;
  box.hidden = false;
}

function renderSummary(runs) {
  const sum = (pick) => runs.reduce((acc, r) => acc + (typeof pick(r) === "number" ? pick(r) : 0), 0);
  const counts = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const r of runs) for (const f of r.findings ?? []) if (counts[f.severity] !== undefined) counts[f.severity] += 1;
  const summary = document.getElementById("summary");
  summary.append(
    el("span", { class: "stat" }, [`runs ${el("b", { text: String(runs.length) }).textContent}`]),
    el("span", { class: "stat" }, [`tokens in ${fmtNum(sum((r) => r.tokens?.input))} / out ${fmtNum(sum((r) => r.tokens?.output))} / total ${fmtNum(sum((r) => r.tokens?.total))}`]),
    el("span", { class: "stat" }, [
      `findings blocker ${counts.blocker} · major ${counts.major} · minor ${counts.minor} · nit ${counts.nit}`,
    ]),
  );
}

function renderFindings(runs) {
  const container = document.getElementById("findings");
  const counter = document.getElementById("findings-count");
  const textFilter = document.getElementById("filter-text");
  const boxes = Array.from(document.querySelectorAll("input.sev"));
  const all = [];
  for (const r of runs) for (const f of r.findings ?? []) all.push({ run: r, finding: f });

  function apply() {
    const allowed = new Set(boxes.filter((b) => b.checked).map((b) => b.value));
    const needle = textFilter.value.trim().toLowerCase();
    container.replaceChildren();
    let shown = 0;
    for (const { run, finding } of all) {
      if (!allowed.has(finding.severity)) continue;
      if (needle && !`${finding.body}\n${finding.file}`.toLowerCase().includes(needle)) continue;
      shown += 1;
      const repoLink = el("a", {
        href: ghPrUrl(run.repo, run.pr),
        target: "_blank",
        rel: "noopener noreferrer",
        text: `${run.repo}#${run.pr}`,
      });
      container.append(
        el("div", { class: "finding-wrap" }, [
          el("div", { class: "finding-meta" }, [
            repoLink,
            el("span", { class: "mono muted", text: `@${String(run.headSha).slice(0, 7)}` }),
            el("span", { class: "muted", text: fmtTime(run.finishedAt) }),
          ]),
          findingRow(finding),
        ]),
      );
    }
    counter.textContent = `${shown} / ${all.length} 条`;
    if (all.length > 0 && shown === 0) container.append(el("p", { class: "muted", text: "无匹配（调整 severity 勾选或过滤词）" }));
  }

  for (const b of boxes) b.addEventListener("change", apply);
  textFilter.addEventListener("input", apply);
  apply();
}

function renderHierarchy(runs) {
  const container = document.getElementById("hierarchy");
  // 分组：repo → PR → run（按 finishedAt 降序已在 main 排好）
  const byRepo = new Map();
  for (const r of runs) {
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, new Map());
    const byPr = byRepo.get(r.repo);
    if (!byPr.has(r.pr)) byPr.set(r.pr, []);
    byPr.get(r.pr).push(r);
  }
  if (byRepo.size === 0) {
    container.append(el("p", { class: "muted", text: "暂无 run 记录（生产审查一个 PR 后出现）" }));
    return;
  }
  for (const [repo, byPr] of byRepo) {
    const repoDetails = el("details", { open: "" });
    repoDetails.append(
      el("summary", {}, [
        el("b", { text: repo }),
        el("span", { class: "muted", text: ` ${Array.from(byPr.keys()).length} 个 PR` }),
      ]),
    );
    for (const [pr, prRuns] of byPr) {
      const prDetails = el("details", {});
      const prLink = el("a", { href: ghPrUrl(repo, pr), target: "_blank", rel: "noopener noreferrer", text: `PR #${pr}` });
      prDetails.append(
        el("summary", {}, [prLink, el("span", { class: "muted", text: ` ${prRuns.length} run` })]),
      );
      for (const r of prRuns) {
        const counts = r.outcome ?? {};
        prDetails.append(
          el("div", { class: "run-row" }, [
            el("span", { class: "mono", text: `@${String(r.headSha).slice(0, 7)}` }),
            el("span", { class: "muted", text: fmtTime(r.finishedAt) }),
            el("span", { class: "muted", text: `tokens ${fmtNum(r.tokens?.total)}（in ${fmtNum(r.tokens?.input)} / out ${fmtNum(r.tokens?.output)}）` }),
            el("span", { class: "muted", text: `行内 ${fmtNum(counts.inline)} / 降级 ${fmtNum(counts.degraded)} / 折叠 ${fmtNum(counts.folded)}` }),
            r.incrementalBase ? el("span", { class: "badge badge-delta", text: `增量 ${String(r.incrementalBase).slice(0, 7)}..` }) : el("span", { class: "badge badge-full", text: "全量" }),
          ]),
        );
        const list = el("div", { class: "run-findings" });
        for (const f of r.findings ?? []) list.append(findingRow(f));
        if ((r.findings ?? []).length === 0) list.append(el("p", { class: "muted", text: "无意见" }));
        prDetails.append(list);
      }
      repoDetails.append(prDetails);
    }
    container.append(repoDetails);
  }
}

async function main() {
  let data;
  try {
    const res = await fetch("/api/runs");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch {
    showError("数据加载失败：/api/runs 不可用（未登录、RUNS_API_ENABLED 未配置，或服务异常）");
    return;
  }
  const runs = (Array.isArray(data?.runs) ? data.runs : [])
    .filter((r) => r && r.v === 1)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
  renderSummary(runs);
  renderFindings(runs);
  renderHierarchy(runs);
}

main();
