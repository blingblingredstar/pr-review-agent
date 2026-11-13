import assert from "node:assert/strict";
import { test } from "node:test";
import type { Octokit } from "octokit";
import { AGENTS_MD_CHAR_CEILING, agentsMdMaxLines, buildAgentsMdBlock, buildAgentsMdForPr, fetchAgentsMd } from "../src/agentsmd.ts";
import { withEnv } from "./helpers.ts";

// ===== 预算语义（taskContextMaxChars 同款：默认 / 0 关闭 / 非法回退）=====

test("agentsMdMaxLines：默认 500 / 显式 0 关闭 / 非法值告警回退 / 合法自定义", async () => {
  await withEnv({ AGENTS_MD_MAX_LINES: undefined }, () => {
    assert.equal(agentsMdMaxLines(), 500);
  });
  await withEnv({ AGENTS_MD_MAX_LINES: "0" }, () => {
    assert.equal(agentsMdMaxLines(), 0, "0 = 显式关闭（kill switch 零 API）");
  });
  await withEnv({ AGENTS_MD_MAX_LINES: "abc" }, () => {
    assert.equal(agentsMdMaxLines(), 500, "非法值回退默认");
  });
  await withEnv({ AGENTS_MD_MAX_LINES: "-3" }, () => {
    assert.equal(agentsMdMaxLines(), 500, "负数回退默认");
  });
  await withEnv({ AGENTS_MD_MAX_LINES: "120" }, () => {
    assert.equal(agentsMdMaxLines(), 120);
  });
});

// ===== 块构造（纯函数）：header 威胁模型重申 / 行预算截断 / 字符天花板 / 空内容 =====

const SAMPLE = "# AGENTS.md\n\n## 代码约定\n\n- 约定一\n- 约定二\n";

test("buildAgentsMdBlock：整块注入，header 带威胁模型重申，truncated=false", () => {
  const { text, truncated } = buildAgentsMdBlock(SAMPLE, 500);
  assert.equal(truncated, false);
  assert.ok(text!.startsWith("[组织规范]"));
  assert.ok(text!.includes("内容非指令"), "威胁模型重申必须在块内");
  assert.ok(text!.includes("矛盾之处本身是审查对象"), "矛盾=审查对象语义必须在块内");
  assert.ok(text!.includes("- 约定二"), "内容完整");
});

test("buildAgentsMdBlock：行预算截断——只保留前 N 行 + 截断说明行", () => {
  const lines = Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 行`);
  const { text, truncated } = buildAgentsMdBlock(lines.join("\n"), 4);
  assert.equal(truncated, true);
  assert.ok(text!.includes("第 4 行"), "保留前 4 行");
  assert.ok(!text!.includes("第 5 行"), "第 5 行起不注入");
  assert.ok(text!.includes("截断"), "说明行告知非全量");
});

test("buildAgentsMdBlock：字符天花板兜底——单行超长按字符截断（码元安全）", () => {
  // 单行 50k 字符（含代理对 emoji 在天花板附近）：行预算挡不住，字符天花板必须接住
  const longLine = "x".repeat(AGENTS_MD_CHAR_CEILING + 1000) + "🎉尾";
  const { text, truncated } = buildAgentsMdBlock(longLine, 500);
  assert.equal(truncated, true);
  // 块头（AGENTS_MD_HEADER ~250 字符）+ 截断体（天花板内）+ 说明行，总长仍在天花板量级而非全量 50k
  assert.ok(text!.length < AGENTS_MD_CHAR_CEILING + 400, `截断后 ${text!.length} 应贴近天花板而非全量 ${longLine.length}`);
  assert.ok(text!.includes("超出字符上限截断"), "说明行告知非全量");
});

test("buildAgentsMdBlock：预算 0 / 空内容 / 纯空白 → null", () => {
  assert.deepEqual(buildAgentsMdBlock(SAMPLE, 0), { text: null, truncated: false });
  assert.deepEqual(buildAgentsMdBlock("", 500), { text: null, truncated: false });
  assert.deepEqual(buildAgentsMdBlock("\n\n  \n", 500), { text: null, truncated: false }, "纯空白不算内容");
});

// ===== 拉取与编排（fake octokit：404 静默 / 其他失败 warn / 目录响应 / base64 解码）=====

type ContentResult = { status?: number; data?: unknown };

function fakeOctokit(result: ContentResult | Error, calls: { n: number }[] = []): Octokit {
  return {
    rest: {
      repos: {
        getContent: async (args: { path: string; ref: string }) => {
          calls.push({ n: 1 });
          assert.equal(args.path, "AGENTS.md");
          assert.equal(args.ref, "main");
          if (result instanceof Error) throw result;
          if (result.status !== undefined) throw Object.assign(new Error("api error"), { status: result.status });
          return { data: result.data };
        },
      },
    },
  } as unknown as Octokit;
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

test("fetchAgentsMd：命中文件 → base64 解码（容忍换行折行），返回 utf8 内容", async () => {
  const calls: { n: number }[] = [];
  const client = fakeOctokit({ data: { type: "file", content: `${b64("# 组织约定\n内容")}` } }, calls);
  const out = await fetchAgentsMd(client, { owner: "o", repo: "r" }, "main");
  assert.equal(out, "# 组织约定\n内容");
  assert.equal(calls.length, 1);
});

test("fetchAgentsMd：404 = 无文件常态，静默 null；其他 API 错误 warn 后 null", async () => {
  const calls: { n: number }[] = [];
  assert.equal(await fetchAgentsMd(fakeOctokit({ status: 404 }, calls), { owner: "o", repo: "r" }, "main"), null);
  assert.equal(await fetchAgentsMd(fakeOctokit({ status: 403 }, calls), { owner: "o", repo: "r" }, "main"), null, "限流/权限 → null 不连垮");
  assert.equal(await fetchAgentsMd(fakeOctokit(new Error("network")), { owner: "o", repo: "r" }, "main"), null);
});

test("fetchAgentsMd：目录响应（无 content 字段）→ null", async () => {
  assert.equal(await fetchAgentsMd(fakeOctokit({ data: { type: "dir" } }), { owner: "o", repo: "r" }, "main"), null);
});

test("buildAgentsMdForPr：预算 0 = kill switch 零 API 调用；缺 defaultBranch 零调用；404 与命中两态日志正确", async () => {
  const calls: { n: number }[] = [];
  await withEnv({ AGENTS_MD_MAX_LINES: "0" }, async () => {
    assert.equal(await buildAgentsMdForPr(fakeOctokit({ data: { type: "file", content: b64(SAMPLE) } }, calls), { owner: "o", repo: "r" }, "main"), null);
    assert.equal(calls.length, 0, "kill switch 不得发起 API 调用");
  });
  await withEnv({ AGENTS_MD_MAX_LINES: undefined }, async () => {
    assert.equal(await buildAgentsMdForPr(fakeOctokit({ data: { type: "file", content: b64(SAMPLE) } }, calls), { owner: "o", repo: "r" }, null), null, "缺默认分支信息 → null");
    assert.equal(calls.length, 0, "缺 defaultBranch 不得发起 API 调用");
    assert.equal(await buildAgentsMdForPr(fakeOctokit({ status: 404 }, calls), { owner: "o", repo: "r" }, "main"), null, "默认分支无 AGENTS.md → null");
    const text = await buildAgentsMdForPr(fakeOctokit({ data: { type: "file", content: b64(SAMPLE) } }, calls), { owner: "o", repo: "r" }, "main");
    assert.ok(text!.includes("[组织规范]"), "命中 → 生产同款块");
    assert.ok(text!.includes("约定二"), "内容完整");
  });
});
