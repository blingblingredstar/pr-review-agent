"use strict";
// 运行观测面板渲染（#122 / D041；「落地即当次」交互 2026-11-10）。
// 渲染硬约束（P0-2，存储型 XSS 唯一防线）不变：一律 createElement + textContent，禁用 innerHTML；
// 数据经 fetch + JSON.parse，绝不内联进 HTML；GitHub 链接逐段 encodeURIComponent。
// View Deployment 落地即「最新 run」置顶展开（按钮 URL 由 Vercel 生成无法携带 PR 参数，
// 点击场景里最新 run = 当次）；#pr<PR号> hash 深链 + 快速定位框兜住「找指定 PR」场景；
// 30 秒自动刷新让「点按钮时 run 还在跑」的窗口自然收敛（publish 落库后面板自己长出来）。

const state = { runs: [] };

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
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/pull/${encodeURIComponent(pr)}`;
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

function runMetaRow(r) {
  const counts = r.outcome ?? {};
  return el("div", { class: "run-row" }, [
    el("span", { class: "mono", text: `@${String(r.headSha).slice(0, 7)}` }),
    el("span", { class: "muted", text: fmtTime(r.finishedAt) }),
    el("span", { class: "muted", text: `tokens ${fmtNum(r.tokens?.total)}（in ${fmtNum(r.tokens?.input)} / out ${fmtNum(r.tokens?.output)} / 命中 ${fmtNum(r.tokens?.cached)}）` }),
    el("span", { class: "muted", text: `行内 ${fmtNum(counts.inline)} / 降级 ${fmtNum(counts.degraded)} / 折叠 ${fmtNum(counts.folded)}` }),
    r.incrementalBase ? el("span", { class: "badge badge-delta", text: `增量 ${String(r.incrementalBase).slice(0, 7)}..` }) : el("span", { class: "badge badge-full", text: "全量" }),
  ]);
}

function prLink(repo, pr, text) {
  return el("a", { href: ghPrUrl(repo, pr), target: "_blank", rel: "noopener noreferrer", text: text ?? `PR #${pr}` });
}

function showError(message) {
  const box = document.getElementById("error");
  box.textContent = message;
  box.hidden = false;
}

// —— 各区块渲染（每次 load 全量重建；过滤器监听只挂一次，读 state） ——

function renderSummary(runs) {
  const box = document.getElementById("summary");
  box.replaceChildren();
  const sum = (pick) => runs.reduce((acc, r) => acc + (typeof pick(r) === "number" ? pick(r) : 0), 0);
  const counts = { blocker: 0, major: 0, minor: 0, nit: 0 };
  for (const r of runs) for (const f of r.findings ?? []) if (counts[f.severity] !== undefined) counts[f.severity] += 1;
  box.append(
    el("span", { class: "stat" }, [`runs ${String(runs.length)}`]),
    el("span", { class: "stat" }, [`tokens in ${fmtNum(sum((r) => r.tokens?.input))} / out ${fmtNum(sum((r) => r.tokens?.output))} / total ${fmtNum(sum((r) => r.tokens?.total))}`]),
    el("span", { class: "stat" }, [`findings blocker ${counts.blocker} · major ${counts.major} · minor ${counts.minor} · nit ${counts.nit}`]),
  );
}

// 最新 run 置顶展开：View Deployment 的「当次」落点。失败/在途 run 不在 Blob（设计内），
// 这里显示的就是最近一次完成的审查
function renderLatest(runs) {
  const box = document.getElementById("latest");
  box.replaceChildren();
  if (runs.length === 0) {
    box.append(el("p", { class: "muted", text: "暂无 run 记录——生产审查发布后 30 秒内自动出现在这里" }));
    return;
  }
  const r = runs[0];
  const head = el("div", { class: "finding-meta" }, [
    el("b", { text: `${r.repo}#${r.pr}` }),
    prLink(r.repo, r.pr, "在 GitHub 打开"),
    el("span", { class: "mono muted", text: `@${String(r.headSha).slice(0, 7)}` }),
    el("span", { class: "muted", text: fmtTime(r.finishedAt) }),
  ]);
  const list = el("div", { class: "run-findings" });
  const findings = r.findings ?? [];
  for (const f of findings) list.append(findingRow(f));
  if (findings.length === 0) list.append(el("p", { class: "muted", text: "无意见（review 为空，PR 上只有 status 绿灯）" }));
  box.append(el("div", { class: "latest-card" }, [head, runMetaRow(r), list]));
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
      container.append(
        el("div", { class: "finding-wrap" }, [
          el("div", { class: "finding-meta" }, [
            prLink(run.repo, run.pr, `${run.repo}#${run.pr}`),
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

  return { apply };
}

// 层级视图带快速定位：needle 匹配 `${repo}#${pr}` 或仓库名子串，命中项展开、未命中隐藏
function renderHierarchy(runs, needle) {
  const container = document.getElementById("hierarchy");
  // 用户手动展开的 PR details 跨重建保持（#131）：30s 自动刷新全量重建会把展开态折回去，
  // 重建前按 data-pr 键快照 open 态、重建后补回；needle 驱动的展开不变（重建时已带 open）
  const openKeys = new Set(
    Array.from(container.querySelectorAll("details[data-pr][open]"), (d) => d.dataset.pr),
  );
  container.replaceChildren();
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
  const n = needle.trim().toLowerCase();
  let visiblePrs = 0;
  for (const [repo, byPr] of byRepo) {
    const repoMatched = n === "" || repo.toLowerCase().includes(n);
    const repoDetails = el("details", { open: "" });
    repoDetails.append(
      el("summary", {}, [
        el("b", { text: repo }),
        el("span", { class: "muted", text: ` ${byPr.size} 个 PR` }),
      ]),
    );
    let repoHasVisible = false;
    for (const [pr, prRuns] of byPr) {
      const prMatched = repoMatched || n === "" || `${repo}#${pr}`.toLowerCase().includes(n) || String(pr).includes(n.replace(/^#/, ""));
      if (!prMatched) continue;
      repoHasVisible = true;
      visiblePrs += 1;
      const prDetails = el("details", { "data-pr": `${repo}#${pr}`, ...(n === "" ? {} : { open: "" }) });
      if (!prDetails.open && openKeys.has(`${repo}#${pr}`)) prDetails.open = true;
      prDetails.append(
        el("summary", {}, [prLink(repo, pr), el("span", { class: "muted", text: ` ${prRuns.length} run` })]),
      );
      for (const r of prRuns) {
        prDetails.append(runMetaRow(r));
        const list = el("div", { class: "run-findings" });
        const findings = r.findings ?? [];
        for (const f of findings) list.append(findingRow(f));
        if (findings.length === 0) list.append(el("p", { class: "muted", text: "无意见" }));
        prDetails.append(list);
      }
      repoDetails.append(prDetails);
    }
    if (!repoHasVisible) continue;
    container.append(repoDetails);
  }
  if (visiblePrs === 0) container.append(el("p", { class: "muted", text: `无匹配「${needle}」（输入 PR 号或仓库名）` }));
}

// —— 数据加载与刷新 ——

let inFlight = false;
let firstLoad = true;

async function load() {
  if (inFlight) return;
  inFlight = true;
  const status = document.getElementById("status");
  let failedStatus = null;
  try {
    const res = await fetch("/api/runs");
    if (!res.ok) {
      failedStatus = res.status;
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    state.runs = (Array.isArray(data?.runs) ? data.runs : [])
      .filter((r) => r && r.v === 1)
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    document.getElementById("error").hidden = true;
    renderSummary(state.runs);
    renderLatest(state.runs);
    // 重建 apply 闭包：renderFindings 在调用时捕获 runs 快照，state.runs 每次 load 换新数组，
    // 不重建的话刷新后 findings 视图停留在旧数据
    findingsView.apply = renderFindings(state.runs).apply;
    findingsView.apply();
    renderHierarchy(state.runs, document.getElementById("jump-pr").value);
    status.textContent = `最近更新 ${new Date().toLocaleTimeString()}`;
  } catch {
    if (firstLoad || state.runs.length === 0) {
      // 404 = 读取面结构性不存在（fail-closed 门：RUNS_API_ENABLED 只配在 dashboard 项目，
      // 主项目 / PR 预览域名上的本页是静态壳）——定向提示防误读成服务故障（#146）。
      // 网络错误/未登录（SSO 重定向被 CORS 拦成 TypeError）保持 failedStatus = null 走笼统文案
      showError(
        failedStatus === 404
          ? "此部署未启用读取面（/api/runs 404：RUNS_API_ENABLED fail-closed 门未开）——观测面板部署在 dashboard 项目固定域名（SSO 保护），PR 预览 / 主项目域名上的本页只是静态壳；dashboard 域名见 docs/deployment.md"
          : "数据加载失败：/api/runs 不可用（未登录、RUNS_API_ENABLED 未配置，或服务异常）",
      );
    } else {
      status.textContent = `刷新失败（${new Date().toLocaleTimeString()}），展示上次数据`;
    }
  } finally {
    firstLoad = false;
    inFlight = false;
  }
}

// 过滤器监听只挂一次；apply 读 state.runs，自动刷新后重放
const findingsView = { apply: () => {} };

function init() {
  for (const b of document.querySelectorAll("input.sev")) b.addEventListener("change", () => findingsView.apply());
  document.getElementById("filter-text").addEventListener("input", () => findingsView.apply());
  document.getElementById("jump-pr").addEventListener("input", (e) => renderHierarchy(state.runs, e.target.value));
  document.getElementById("refresh").addEventListener("click", load);
  // 深链：runs.html#pr42 → 快速定位框填 42（层级里对应 PR 展开置顶可见）。
  // hashchange 重放（#132）：页面已开时点带 hash 链接/改 URL 也重新定位——首载只读一次的话，
  // 同文档 hash 变化会静默无效。数据未到时只填框，渲染由 load() 统一走
  const applyPrHash = () => {
    const m = /^#pr(\d+)$/.exec(location.hash);
    document.getElementById("jump-pr").value = m ? m[1] : "";
    if (state.runs.length > 0) renderHierarchy(state.runs, document.getElementById("jump-pr").value);
  };
  window.addEventListener("hashchange", applyPrHash);
  applyPrHash();
  load();
  setInterval(() => {
    if (!document.hidden) load();
  }, 30_000);
}

init();
