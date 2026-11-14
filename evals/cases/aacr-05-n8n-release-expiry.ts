import type { EvalCase } from "../score.ts";

// 来源：alibaba/aacr-bench v1（Apache-2.0，HF Alibaba-Aone/aacr-bench）外部 golden 人工核验转译（#157）。
// golden comment 人工核验：锚点定位到 diff 内机制行（AACR 参考行号与机制行逐条对位，无漂移），
// 机制词中文转译并尽量剔除 diff 字面词（#44 判分纪律）；provenance 随 description 必填。
export default {
  id: "aacr-05-n8n-release-expiry",
  kind: "bug",
  source: "aacr",
  description: "来源 n8n-io/n8n PR#13323（AACR-Bench v1 人工核验转译，AI golden 专家确认）：SIX_WEEKS_IN_MS 超 setTimeout 2^31-1 上限 + 已过期路径未置 enabled=false + CI build-args 内 $(date) 不展开",
  diff: `diff --git a/.github/workflows/release-publish.yml b/.github/workflows/release-publish.yml
index 06bc4e446578..5054e76c7903 100644
--- a/.github/workflows/release-publish.yml
+++ b/.github/workflows/release-publish.yml
@@ -103,6 +103,7 @@ jobs:
           context: ./docker/images/n8n
           build-args: |
             N8N_VERSION=\${{ needs.publish-to-npm.outputs.release }}
+            N8N_RELEASE_DATE=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
           platforms: linux/amd64,linux/arm64
           provenance: false
           push: true
diff --git a/docker/images/n8n/Dockerfile b/docker/images/n8n/Dockerfile
index 10720c63f20e..8b258d157bec 100644
--- a/docker/images/n8n/Dockerfile
+++ b/docker/images/n8n/Dockerfile
@@ -4,15 +4,18 @@ FROM n8nio/base:\${NODE_VERSION}
 ARG N8N_VERSION
 RUN if [ -z "$N8N_VERSION" ] ; then echo "The N8N_VERSION argument is missing!" ; exit 1; fi
 
+ARG N8N_RELEASE_DATE
 LABEL org.opencontainers.image.title="n8n"
 LABEL org.opencontainers.image.description="Workflow Automation Tool"
 LABEL org.opencontainers.image.source="https://github.com/n8n-io/n8n"
 LABEL org.opencontainers.image.url="https://n8n.io"
 LABEL org.opencontainers.image.version=\${N8N_VERSION}
+LABEL org.opencontainers.image.created=\${N8N_RELEASE_DATE}
 
 ENV N8N_VERSION=\${N8N_VERSION}
 ENV NODE_ENV=production
 ENV N8N_RELEASE_TYPE=stable
+ENV N8N_RELEASE_DATE=\${N8N_RELEASE_DATE}
 RUN set -eux; \\
 	npm install -g --omit=dev n8n@\${N8N_VERSION} --ignore-scripts && \\
 	npm rebuild --prefix=/usr/local/lib/node_modules/n8n sqlite3 && \\
diff --git a/packages/@n8n/config/src/configs/generic.config.ts b/packages/@n8n/config/src/configs/generic.config.ts
index f6960b24156e..133d62ee2946 100644
--- a/packages/@n8n/config/src/configs/generic.config.ts
+++ b/packages/@n8n/config/src/configs/generic.config.ts
@@ -9,6 +9,9 @@ export class GenericConfig {
 	@Env('N8N_RELEASE_TYPE')
 	releaseChannel: 'stable' | 'beta' | 'nightly' | 'dev' = 'dev';
 
+	@Env('N8N_RELEASE_DATE')
+	releaseDate?: Date;
+
 	/** Grace period (in seconds) to wait for components to shut down before process exit. */
 	@Env('N8N_GRACEFUL_SHUTDOWN_TIMEOUT')
 	gracefulShutdownTimeout: number = 30;
diff --git a/packages/@n8n/config/src/decorators.ts b/packages/@n8n/config/src/decorators.ts
index 57eb1500e26a..d9da07740d9e 100644
--- a/packages/@n8n/config/src/decorators.ts
+++ b/packages/@n8n/config/src/decorators.ts
@@ -55,6 +55,13 @@ export const Config: ClassDecorator = (ConfigClass: Class) => {
 					} else {
 						console.warn(\`Invalid boolean value for \${envName}: \${value}\`);
 					}
+				} else if (type === Date) {
+					const timestamp = Date.parse(value);
+					if (isNaN(timestamp)) {
+						console.warn(\`Invalid timestamp value for \${envName}: \${value}\`);
+					} else {
+						config[key] = new Date(timestamp);
+					}
 				} else if (type === String) {
 					config[key] = value;
 				} else {
diff --git a/packages/@n8n/config/test/config.test.ts b/packages/@n8n/config/test/config.test.ts
index 834963bcfdea..36f39e1ce7e7 100644
--- a/packages/@n8n/config/test/config.test.ts
+++ b/packages/@n8n/config/test/config.test.ts
@@ -8,9 +8,12 @@ jest.mock('fs');
 const mockFs = mock<typeof fs>();
 fs.readFileSync = mockFs.readFileSync;
 
+const consoleWarnMock = jest.spyOn(console, 'warn').mockImplementation(() => {});
+
 describe('GlobalConfig', () => {
 	beforeEach(() => {
 		Container.reset();
+		jest.clearAllMocks();
 	});
 
 	const originalEnv = process.env;
@@ -18,10 +21,6 @@ describe('GlobalConfig', () => {
 		process.env = originalEnv;
 	});
 
-	// deepCopy for diff to show plain objects
-	// eslint-disable-next-line n8n-local-rules/no-json-parse-json-stringify
-	const deepCopy = <T>(obj: T): T => JSON.parse(JSON.stringify(obj));
-
 	const defaultConfig: GlobalConfig = {
 		path: '/',
 		host: 'localhost',
@@ -314,7 +313,7 @@ describe('GlobalConfig', () => {
 	it('should use all default values when no env variables are defined', () => {
 		process.env = {};
 		const config = Container.get(GlobalConfig);
-		expect(deepCopy(config)).toEqual(defaultConfig);
+		expect(structuredClone(config)).toEqual(defaultConfig);
 		expect(mockFs.readFileSync).not.toHaveBeenCalled();
 	});
 
@@ -327,9 +326,10 @@ describe('GlobalConfig', () => {
 			DB_LOGGING_MAX_EXECUTION_TIME: '0',
 			N8N_METRICS: 'TRUE',
 			N8N_TEMPLATES_ENABLED: '0',
+			N8N_RELEASE_DATE: '2025-02-17T13:54:15Z',
 		};
 		const config = Container.get(GlobalConfig);
-		expect(deepCopy(config)).toEqual({
+		expect(structuredClone(config)).toEqual({
 			...defaultConfig,
 			database: {
 				logging: defaultConfig.database.logging,
@@ -358,6 +358,10 @@ describe('GlobalConfig', () => {
 				...defaultConfig.templates,
 				enabled: false,
 			},
+			generic: {
+				...defaultConfig.generic,
+				releaseDate: new Date('2025-02-17T13:54:15.000Z'),
+			},
 		});
 		expect(mockFs.readFileSync).not.toHaveBeenCalled();
 	});
@@ -370,7 +374,7 @@ describe('GlobalConfig', () => {
 		mockFs.readFileSync.calledWith(passwordFile, 'utf8').mockReturnValueOnce('password-from-file');
 
 		const config = Container.get(GlobalConfig);
-		expect(deepCopy(config)).toEqual({
+		expect(structuredClone(config)).toEqual({
 			...defaultConfig,
 			database: {
 				...defaultConfig.database,
@@ -382,4 +386,26 @@ describe('GlobalConfig', () => {
 		});
 		expect(mockFs.readFileSync).toHaveBeenCalled();
 	});
+
+	it('should handle invalid numbers', () => {
+		process.env = {
+			DB_LOGGING_MAX_EXECUTION_TIME: 'abcd',
+		};
+		const config = Container.get(GlobalConfig);
+		expect(config.database.logging.maxQueryExecutionTime).toEqual(0);
+		expect(consoleWarnMock).toHaveBeenCalledWith(
+			'Invalid number value for DB_LOGGING_MAX_EXECUTION_TIME: abcd',
+		);
+	});
+
+	it('should handle invalid timestamps', () => {
+		process.env = {
+			N8N_RELEASE_DATE: 'abcd',
+		};
+		const config = Container.get(GlobalConfig);
+		expect(config.generic.releaseDate).toBeUndefined();
+		expect(consoleWarnMock).toHaveBeenCalledWith(
+			'Invalid timestamp value for N8N_RELEASE_DATE: abcd',
+		);
+	});
 });
diff --git a/packages/cli/src/commands/base-command.ts b/packages/cli/src/commands/base-command.ts
index 930acceb1c96..b0ecf104dc65 100644
--- a/packages/cli/src/commands/base-command.ts
+++ b/packages/cli/src/commands/base-command.ts
@@ -63,6 +63,7 @@ export abstract class BaseCommand extends Command {
 	async init(): Promise<void> {
 		this.errorReporter = Container.get(ErrorReporter);
 
+		const { releaseDate } = this.globalConfig.generic;
 		const { backendDsn, n8nVersion, environment, deploymentName } = this.globalConfig.sentry;
 		await this.errorReporter.init({
 			serverType: this.instanceSettings.instanceType,
@@ -70,6 +71,7 @@ export abstract class BaseCommand extends Command {
 			environment,
 			release: n8nVersion,
 			serverName: deploymentName,
+			releaseDate,
 		});
 		initExpressionEvaluator();
 
diff --git a/packages/core/src/errors/error-reporter.ts b/packages/core/src/errors/error-reporter.ts
index 3c0bffcd4ba7..ed9189511c74 100644
--- a/packages/core/src/errors/error-reporter.ts
+++ b/packages/core/src/errors/error-reporter.ts
@@ -15,6 +15,7 @@ type ErrorReporterInitOptions = {
 	release: string;
 	environment: string;
 	serverName: string;
+	releaseDate?: Date;
 	/**
 	 * Function to allow filtering out errors before they are sent to Sentry.
 	 * Return true if the error should be filtered out.
@@ -22,8 +23,14 @@ type ErrorReporterInitOptions = {
 	beforeSendFilter?: (event: ErrorEvent, hint: EventHint) => boolean;
 };
 
+const SIX_WEEKS_IN_MS = 6 * 7 * 24 * 60 * 60 * 1000;
+const RELEASE_EXPIRATION_WARNING =
+	'Error tracking disabled because this release is older than 6 weeks.';
+
 @Service()
 export class ErrorReporter {
+	private enabled = true;
+
 	/** Hashes of error stack traces, to deduplicate error reports. */
 	private seenErrors = new Set<string>();
 
@@ -66,11 +73,25 @@ export class ErrorReporter {
 		release,
 		environment,
 		serverName,
+		releaseDate,
 	}: ErrorReporterInitOptions) {
 		process.on('uncaughtException', (error) => {
 			this.error(error);
 		});
 
+		if (releaseDate) {
+			const releaseExpiresInMs = releaseDate.getTime() + SIX_WEEKS_IN_MS - Date.now();
+			if (releaseExpiresInMs <= 0) {
+				this.logger.warn(RELEASE_EXPIRATION_WARNING);
+				return;
+			}
+			// Once this release expires, reject all events
+			setTimeout(() => {
+				this.enabled = false;
+				this.logger.warn(RELEASE_EXPIRATION_WARNING);
+			}, releaseExpiresInMs);
+		}
+
 		if (!dsn) return;
 
 		// Collect longer stacktraces
@@ -118,6 +139,8 @@ export class ErrorReporter {
 	}
 
 	async beforeSend(event: ErrorEvent, hint: EventHint) {
+		if (!this.enabled) return null;
+
 		let { originalException } = hint;
 
 		if (!originalException) return null;
`,
  expect: [
    {
      file: "packages/core/src/errors/error-reporter.ts",
      line: 89,
      mustMention: ["上限", "溢出", "2^31", "2147483647", "24.8", "立即触发", "最大延迟", "提前到期"],
    },
    {
      file: "packages/core/src/errors/error-reporter.ts",
      line: 84,
      mustMention: ["未禁用", "仍会", "照常", "没有设置", "未设置", "提前返回", "未关闭", "语义不符"],
    },
    {
      file: ".github/workflows/release-publish.yml",
      line: 106,
      mustMention: ["字面", "不展开", "不会执行", "不执行", "替换", "literal", "shell", "原样"],
    },
  ],
} as EvalCase;
