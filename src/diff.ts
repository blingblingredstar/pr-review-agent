// diff 解析纯函数 + 截断策略（D030 自 review.ts 机械搬移，行为字节级不变）：
// 路径解析（pathVariants / unquoteGitPath / diffHeaderPath）、触及文件与行号覆盖（diffTouchedPaths /
// diffCoveredLines）、截断预算与生成物过滤（diffMaxChars / isNoisePath / truncateDiff）。

// 模型可能带 git 的 a/ b/ 前缀，返回可能的路径变体（原样、剥 a/、剥 b/）供对照
export function pathVariants(file: string): string[] {
  return [file, file.replace(/^a\//, ""), file.replace(/^b\//, "")];
}

// git quotePath 把非 ASCII 编成八进制转义（UTF-8 字节）；输入可能带引号包裹（已剥引号也要能解码），无转义时原样返回
export function unquoteGitPath(p: string): string {
  const body = p.startsWith('"') && p.endsWith('"') && p.length >= 2 ? p.slice(1, -1) : p;
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\" && /[0-7]/.test(body[i + 1] ?? "")) {
      let j = i + 1;
      let oct = "";
      while (j < body.length && oct.length < 3 && /[0-7]/.test(body[j])) oct += body[j++];
      bytes.push(parseInt(oct, 8));
      i = j - 1;
    } else if (ch === "\\") {
      const next = body[i + 1] ?? "";
      bytes.push(...Buffer.from(next === "n" ? "\n" : next === "t" ? "\t" : next, "utf8"));
      i++;
    } else {
      bytes.push(...Buffer.from(ch, "utf8"));
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

// diff --git 头行的 b 侧路径：引号包裹、八进制转义、rename 两侧引号需求不一致的四种组合都试
export function diffHeaderPath(line: string): string | null {
  const m =
    /^diff --git "a\/(?:[^"\\]|\\.)*" "(b\/(?:[^"\\]|\\.)*)"$/.exec(line) ??
    /^diff --git "a\/(?:[^"\\]|\\.)*" b\/(\S+)$/.exec(line) ??
    /^diff --git a\/\S+ "(b\/(?:[^"\\]|\\.)*)"$/.exec(line) ??
    /^diff --git a\/\S+ b\/(\S+)$/.exec(line);
  return m ? unquoteGitPath(m[1]).replace(/^b\//, "") : null;
}

// diff 触及的文件路径（b 侧，出现顺序去重）：仓库上下文（D023）按它选快照里的全文。
// 吃完整原始 diff——被 truncateDiff 丢掉的文件也纳入，上下文正好补 D018/D020 的截断盲区
export function diffTouchedPaths(diff: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const raw of diff.split("\n")) {
    if (!raw.startsWith("diff --git ")) continue;
    const path = diffHeaderPath(raw);
    if (path && !seen.has(path)) {
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

// 解析 unified diff，返回每个文件被 hunk 覆盖的新侧行号集合。
// 用于行内评论的预定位：只有行号落在 diff 内的意见才能行内发（GitHub 对 hunk 外行号返回 422）。
export function diffCoveredLines(diff: string): Map<string, Set<number>> {
  const covered = new Map<string, Set<number>>();
  let file = "";
  let inHunk = false;
  let line = 0;
  // hunk 头声明的新侧行数计数：扫描用尽即结束当前 hunk——真实 diff 以换行结尾，split 出的
  // 尾部空字符串若被当上下文行会 mark 出「最后一行 +1」的幻影行号，行内发帖必然 422 回落全量降级
  let remain = 0;
  const mark = () => {
    if (!file) return;
    let set = covered.get(file);
    if (!set) covered.set(file, (set = new Set()));
    set.add(line);
  };
  for (const raw of diff.split("\n")) {
    // hunk 内容行（+/ /-）自带前缀，不会以下面的文件头形态开头；先处理文件头判定
    if (raw.startsWith("diff --git ")) {
      file = diffHeaderPath(raw) ?? "";
      inHunk = false;
      remain = 0;
      continue;
    }
    if (inHunk) {
      const nextHunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/.exec(raw);
      if (nextHunk) {
        // 声明行数未用尽就出现 @@：畸形 diff——直接按新 hunk 头接管（起始行号与新侧行数都取自该头）
        line = Number(nextHunk[1]);
        remain = Number(nextHunk[2] ?? 1);
        continue;
      }
      if (raw.startsWith("\\")) continue; // "\ No newline at end of file" 不是内容行，不占声明行数
      if (raw.startsWith("-")) continue; // 旧侧删除行不占新侧行数，不消耗 remain
      if (remain <= 0) {
        // 新侧声明行数已用尽：hunk 结束（尾部空字符串行等伪影在此被拒之门外）
        inHunk = false;
      } else {
        remain--;
        mark();
        line++;
      }
      continue;
    }
    if (raw.startsWith("+++ ") && raw.slice(4).trim() === "/dev/null") {
      // 纯删除文件新侧不存在，任何行内评论必然 422——跳过以免坏意见拖累同 review 的好意见。
      // 精确比较：仓库里真有路径含 "/dev/null" 字样的文件（如 fixture）时 includes 会误伤
      file = "";
      inHunk = false;
      remain = 0;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))?/.exec(raw);
    if (hunk) {
      inHunk = true;
      line = Number(hunk[1]);
      remain = Number(hunk[2] ?? 1);
    }
  }
  return covered;
}

// diff 截断预算（字符）：超大 diff 全量进 prompt 浪费 token 甚至超模型上下文；默认 300_000 留足余量
export function diffMaxChars(): number {
  const raw = process.env.DIFF_MAX_CHARS;
  if (!raw) return 300_000;
  const parsed = Number(raw);
  // 小数（如 0.5）会得到所有块都装不下的预算、返回纯省略列表——与非法值一并回退
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    console.warn(`DIFF_MAX_CHARS="${raw}" 不是正整数，回退默认 300000`);
    return 300_000;
  }
  return parsed;
}

// 生成物识别名单（D020）：故意短而高精度——漏判只是让该文件回退 D018 的大小贪心（软失败），不比现状差。
// 直接清单（package.json / requirements.txt）不进名单：体积小贪心本来保留，且依赖版本变动正是要人审的内容
const NOISE_FILENAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb",
  "Cargo.lock", "poetry.lock", "uv.lock", "pdm.lock", "Pipfile.lock",
  "Gemfile.lock", "composer.lock", "go.sum", "mix.lock", "gradle.lockfile",
  "packages.lock.json", "Paket.lock", "conan.lock", "flake.lock",
]);
// 目录段分两类（PR #18 自审意见）：通用名（dist/build/out/target）只认顶层首段——src/build/、
// infra/out/ 这类嵌套同名词多是真实源码，误标「生成物」是带误导标签的静默排除而非软失败；
// 约定成俗的（node_modules/vendor/coverage/.next）任意层级都认（monorepo 里 node_modules 必然嵌套）
const NOISE_TOP_SEGMENTS = new Set(["dist", "build", "out", "target"]);
const NOISE_SEGMENTS = new Set(["node_modules", "vendor", "coverage", ".next"]);
const NOISE_SUFFIXES = [".min.js", ".min.css", ".map", ".snap"];

function isNoisePath(path: string): boolean {
  const segments = path.split("/");
  const base = segments[segments.length - 1]!;
  if (NOISE_FILENAMES.has(base)) return true;
  if (NOISE_SUFFIXES.some((s) => base.endsWith(s))) return true;
  return segments.slice(0, -1).some((s) => NOISE_SEGMENTS.has(s)) || (segments.length > 1 && NOISE_TOP_SEGMENTS.has(segments[0]!));
}

// 超预算时整文件块丢弃（D018）：切 hunk 破坏行号定位、分批多次调用翻倍延迟，都不取——
// 按块大小升序贪心保留，保留块按原顺序字节级重组，丢弃文件附省略行让模型知道看到的不是全量。
// 生成物前置过滤（D020）：名单/横幅/长行占优命中的块不进预算竞争、恒省略并标注，预算让给真实代码；
// 省略行标注「新建文件」——D018 把「大」当噪声信号，新建大源码文件是最值得审却被最先丢的内容。
export function truncateDiff(diff: string, budget: number = diffMaxChars()): string {
  if (diff.length <= budget) return diff;
  const blocks: {
    lines: string[]; path: string; adds: number; dels: number; size: number; binary: boolean; pseudo?: true;
    isNew: boolean; generated: boolean; contentChars: number; longChars: number; noise: boolean;
  }[] = [];
  let cur: (typeof blocks)[number] | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      cur = {
        lines: [line], path: diffHeaderPath(line) ?? "(无法解析路径的文件)", adds: 0, dels: 0, size: 0, binary: false,
        isNew: false, generated: false, contentChars: 0, longChars: 0, noise: false,
      };
      blocks.push(cur);
    } else if (!cur) {
      // 畸形 diff 首个文件头之前的散落内容：不是文件，被丢弃时不产出省略行（伪路径会误导模型）
      cur = {
        lines: [line], path: "(diff 头之前的内容)", adds: 0, dels: 0, size: 0, binary: false, pseudo: true,
        isNew: false, generated: false, contentChars: 0, longChars: 0, noise: false,
      };
      blocks.push(cur);
    } else {
      cur.lines.push(line);
      cur.contentChars += line.length;
      if (line.length >= 500) cur.longChars += line.length;
      if (line.startsWith("new file mode ")) cur.isNew = true;
      // 二进制负载行（GIT binary patch 的 base64 / Binary files 摘要之后）可能以 +/- 开头，停止计数；
      // 标记置位后不重置——git 输出中二进制段后不再有文本 hunk，手工拼接的混合 diff 会漏记（输入来源仅 GitHub 标准 diff，接受）
      if (line === "GIT binary patch" || line.startsWith("Binary files ")) cur.binary = true;
      else if (!cur.binary) {
        if (line.startsWith("+") && !line.startsWith("+++")) {
          cur.adds++;
          // 生成物横幅只认文件头部（前 10 个新增行）：中后段的 do not edit 多是普通注释，全块扫会误伤
          if (cur.adds <= 10 && /@generated|do not edit/i.test(line)) cur.generated = true;
        } else if (line.startsWith("-") && !line.startsWith("---")) cur.dels++;
      }
    }
  }
  // 块大小为近似值：join 长度 + 1 个块间换行分隔符（末块无尾换行时多记 1 字符）；预算是软约束，不追求精确
  for (const b of blocks) b.size = b.lines.join("\n").length + 1;
  // 长行占优是压缩/混淆产物的跨生态结构信号，不依赖文件名；500/4000 阈值容忍源码里偶发的长字符串行
  for (const b of blocks) {
    b.noise = !b.pseudo && (isNoisePath(b.path) || b.generated || (b.longChars > 4000 && b.longChars * 2 > b.contentChars));
  }
  // 装不下就跳过继续试更小的（continue 而非 break），保留集按原顺序输出；生成物块不参与竞争
  const order = blocks.map((_, i) => i).filter((i) => !blocks[i].noise).sort((a, b) => blocks[a].size - blocks[b].size);
  const keep = new Set<number>();
  let used = 0;
  for (const i of order) {
    if (used + blocks[i].size > budget) continue;
    keep.add(i);
    used += blocks[i].size;
  }
  // 新建文件 hunk 级部分保留（D018 缺口修复，2026-11-05）：整块装不下的新建文件原样整块省略 =
  // 审查盲区（大新建源码文件恰是最值得审的内容）。新建文件全为 + 行、hunk 头自带新文件行号起点，
  // 前缀保留的行号锚点完整性不受影响；修改文件的 hunk 与上下文/-行交错，维持整块语义（D018 本体不动）。
  // 预算内装不下 header+首 hunk 时仍走整块省略行（原行为）；按块原顺序分配剩余预算（确定性）。
  const splitNewFileHunks = (b: (typeof blocks)[number]): { header: string[]; hunks: string[][] } | null => {
    if (!b.isNew || b.noise || b.binary || b.pseudo) return null;
    const header: string[] = [];
    const hunks: string[][] = [];
    let cur: string[] | null = null;
    for (const line of b.lines) {
      if (line.startsWith("@@ ")) {
        cur = [line];
        hunks.push(cur);
      } else if (cur) cur.push(line);
      else header.push(line);
    }
    return hunks.length > 0 ? { header, hunks } : null;
  };
  const partials = new Map<number, { lines: string[]; kept: number; total: number }>();
  let usedWithPartials = used;
  // 标注行（「仅保留前 K/N 个 hunk…」）自身占 60-90 字符，预算判定按 100 上限预留——
  // 不预留则多个部分保留块叠加时标注行漏记、最终输出漂出预算（自审 minor：守恒缺口）
  const MARKER_ALLOWANCE = 100;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!;
    if (keep.has(i)) continue;
    const split = splitNewFileHunks(b);
    if (!split) continue;
    let size = split.header.join("\n").length + 1;
    if (size + MARKER_ALLOWANCE > budget - usedWithPartials) continue;
    let keptHunks = 0;
    for (const h of split.hunks) {
      const hunkSize = h.join("\n").length + 1;
      if (size + MARKER_ALLOWANCE + hunkSize > budget - usedWithPartials) break;
      size += hunkSize;
      keptHunks++;
    }
    if (keptHunks === 0) continue;
    const lines = [...split.header, ...split.hunks.slice(0, keptHunks).flat()];
    const marker = `[diff 截断] 本文件超出预算：仅保留前 ${keptHunks}/${split.hunks.length} 个 hunk（新建文件全文 +${b.adds} 行，其余内容未经审查）`;
    lines.push(marker);
    size += marker.length;
    partials.set(i, { lines, kept: keptHunks, total: split.hunks.length });
    usedWithPartials += size;
  }
  const kept = blocks.filter((_, i) => keep.has(i));
  // 非文件的 pseudo 块被丢弃时不产出省略行、不进汇总计数；部分保留的块不进省略行（已带自身截断标注）
  const omitTargets = blocks.filter((b, i) => !keep.has(i) && !b.pseudo && !partials.has(i));
  const out: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    if (keep.has(i)) out.push(...blocks[i]!.lines);
    else if (partials.has(i)) out.push(...partials.get(i)!.lines);
  }
  const omitLines = omitTargets.map((b) => {
    // 标注让模型分清「预算丢的普通文件」「规则跳过的生成物」「没看到内容的新建文件」——最后者是审查盲区，最值得人工补看
    const tag = b.noise ? "生成物" : b.isNew ? "新建文件" : "";
    return `[diff 截断] 省略 ${b.path}${tag ? `（${tag}）` : ""} (+${b.adds}/-${b.dels})`;
  });
  // 省略行自身也占输出：丢弃文件极多时会反噬预算——超了就压缩成一行汇总（总量有界，无条件核对）。
  // 压缩会让逐条标注消失，汇总行带各类计数把「生成物/新建文件」信号保留给模型（PR #18 自审意见）
  if (usedWithPartials + omitLines.join("\n").length + 1 > budget) {
    const adds = omitTargets.reduce((s, b) => s + b.adds, 0);
    const dels = omitTargets.reduce((s, b) => s + b.dels, 0);
    const noise = omitTargets.filter((b) => b.noise).length;
    const fresh = omitTargets.filter((b) => !b.noise && b.isNew).length;
    out.push(
      `[diff 截断] 省略 ${omitTargets.length} 个文件（超出 ${budget} 字符预算，合计 +${adds}/-${dels}` +
        (noise + fresh > 0 ? `，其中生成物 ${noise}、新建文件 ${fresh}` : "") +
        `）`,
    );
  } else {
    out.push(...omitLines);
  }
  const noiseCount = blocks.filter((b) => b.noise).length;
  console.log(
    `[truncateDiff] 预算 ${budget} 字符：${blocks.length} 个文件块保留 ${kept.length} 个、省略 ${blocks.length - kept.length} 个` +
      (noiseCount > 0 ? `，其中生成物按规则跳过 ${noiseCount} 个` : "") +
      (partials.size > 0
        ? `；新建文件 hunk 级截断 ${partials.size} 个（${[...partials.values()].map((p) => `${p.kept}/${p.total} hunk`).join("、")}）`
        : ""),
  );
  return out.join("\n");
}
