import type { EvalCase } from "../score.ts";

// 来源：alibaba/aacr-bench v1（Apache-2.0）外部 golden 人工核验转译（#157 续批）。
// 锚点定位到机制行；mustMention 逐词过「不在 diff 中出现」检查（#44 + PR #166 教训）。
export default {
  id: "aacr-07-gemini-runcommand-spawn",
  kind: "bug",
  source: "aacr",
  description: "来源 google-gemini/gemini-cli PR#9177（AACR-Bench v1 人工核验转译，human + AI golden）：runCommand 未校验 setup 已调用（testDir 未初始化）+ 子进程无 error 监听 spawn 失败时 promise 永不 settle + Buffer 隐式拼接字符串",
  diff: `diff --git a/integration-tests/extensions-install.test.ts b/integration-tests/extensions-install.test.ts
new file mode 100644
index 00000000000..cdd6ebfc98b
--- /dev/null
+++ b/integration-tests/extensions-install.test.ts
@@ -0,0 +1,53 @@
+/**
+ * @license
+ * Copyright 2025 Google LLC
+ * SPDX-License-Identifier: Apache-2.0
+ */
+
+import { expect, test } from 'vitest';
+import { TestRig } from './test-helper.js';
+import { rmSync, writeFileSync } from 'node:fs';
+import { join } from 'node:path';
+
+const rig = new TestRig();
+const extension = \`{
+  "name": "test-extension",
+  "version": "0.0.1"
+}\`;
+
+const extensionUpdate = \`{
+  "name": "test-extension",
+  "version": "0.0.2"
+}\`;
+
+test('installs a local extension, verifies a command, and updates it', async () => {
+  rig.setup('extension install test');
+  const testServerPath = join(rig.testDir!, 'gemini-extension.json');
+  writeFileSync(testServerPath, extension);
+  try {
+    await rig.runCommand(['extensions', 'uninstall', 'test-extension']);
+  } catch {
+    /* empty */
+  }
+
+  const result = await rig.runCommand(
+    ['extensions', 'install', \`--path=\${rig.testDir!}\`],
+    { stdin: 'y\\n' },
+  );
+  expect(result).toContain('test-extension');
+
+  const listResult = await rig.runCommand(['extensions', 'list']);
+  expect(listResult).toContain('test-extension');
+  writeFileSync(testServerPath, extensionUpdate);
+  const updateResult = await rig.runCommand([
+    'extensions',
+    'update',
+    \`test-extension\`,
+  ]);
+  expect(updateResult).toContain('0.0.2');
+
+  await rig.runCommand(['extensions', 'uninstall', 'test-extension']);
+
+  await rig.cleanup();
+  rmSync(rig.testDir!, { recursive: true, force: true });
+});
diff --git a/integration-tests/test-helper.ts b/integration-tests/test-helper.ts
index f86b72d7872..bfdc8dd6a9e 100644
--- a/integration-tests/test-helper.ts
+++ b/integration-tests/test-helper.ts
@@ -306,6 +306,57 @@ export class TestRig {
     return promise;
   }
 
+  runCommand(
+    args: string[],
+    options: { stdin?: string } = {},
+  ): Promise<string> {
+    const commandArgs = [this.bundlePath, ...args];
+
+    const child = spawn('node', commandArgs, {
+      cwd: this.testDir!,
+      stdio: 'pipe',
+    });
+
+    let stdout = '';
+    let stderr = '';
+
+    if (options.stdin) {
+      child.stdin!.write(options.stdin);
+      child.stdin!.end();
+    }
+
+    child.stdout!.on('data', (data: Buffer) => {
+      stdout += data;
+      if (env.KEEP_OUTPUT === 'true' || env.VERBOSE === 'true') {
+        process.stdout.write(data);
+      }
+    });
+
+    child.stderr!.on('data', (data: Buffer) => {
+      stderr += data;
+      if (env.KEEP_OUTPUT === 'true' || env.VERBOSE === 'true') {
+        process.stderr.write(data);
+      }
+    });
+
+    const promise = new Promise<string>((resolve, reject) => {
+      child.on('close', (code: number) => {
+        if (code === 0) {
+          this._lastRunStdout = stdout;
+          let result = stdout;
+          if (stderr) {
+            result += \`\\n\\nStdErr:\\n\${stderr}\`;
+          }
+          resolve(result);
+        } else {
+          reject(new Error(\`Process exited with code \${code}:\\n\${stderr}\`));
+        }
+      });
+    });
+
+    return promise;
+  }
+
   readFile(fileName: string) {
     const filePath = join(this.testDir!, fileName);
     const content = readFileSync(filePath, 'utf-8');
`,
  expect: [
    {
      file: "integration-tests/test-helper.ts",
      line: 316,
      mustMention: ["未初始化", "未调用", "初始化之前", "前置校验", "为空"],
    },
    {
      file: "integration-tests/test-helper.ts",
      line: 343,
      mustMention: ["error", "失败时", "监听", "永不", "挂起", "ENOENT"],
    },
    {
      file: "integration-tests/test-helper.ts",
      line: 329,
      mustMention: ["隐式", "拼接", "转换", "toString", "乱码", "显式"],
    },
  ],
} as EvalCase;
