import type { EvalCase } from "../score.ts";

// 来源：alibaba/aacr-bench v1（Apache-2.0，HF Alibaba-Aone/aacr-bench）外部 golden 人工核验转译（#157）。
// golden comment 人工核验：锚点定位到 diff 内机制行（AACR 参考行号与机制行逐条对位，无漂移），
// 机制词中文转译并尽量剔除 diff 字面词（#44 判分纪律）；provenance 随 description 必填。
export default {
  id: "aacr-03-cline-checkpoint-unhandled",
  kind: "bug",
  source: "aacr",
  description: "来源 cline PR#5177（AACR-Bench v1 人工核验转译，human golden）：checkpoint commit 改为非阻塞后无错误处理，未捕获的 promise rejection",
  diff: `diff --git a/src/core/task/index.ts b/src/core/task/index.ts
index 16cf2225bc9..801b57a9518 100644
--- a/src/core/task/index.ts
+++ b/src/core/task/index.ts
@@ -1315,19 +1315,23 @@ export class Task {
 
 			// Create a checkpoint commit and update clineMessages with a commitHash
 			if (this.checkpointTracker) {
-				const commitHash = await this.checkpointTracker.commit()
-				if (commitHash) {
-					await this.say("checkpoint_created")
-					const lastCheckpointMessageIndex = findLastIndex(
-						this.messageStateHandler.getClineMessages(),
-						(m) => m.say === "checkpoint_created",
-					)
-					if (lastCheckpointMessageIndex !== -1) {
-						await this.messageStateHandler.updateClineMessage(lastCheckpointMessageIndex, {
-							lastCheckpointHash: commitHash,
-						})
+				// We are letting this run in a non-blocking way so that the UI doesn't freeze when creating checkpoints.
+				// We show that a checkpoint is created in the chatview, then in the background run the git operation (which can take multiple seconds for large shadow git repos), and once that's been completed update the previous checkpoint message with the newly created hash to be associated with.
+				// NOTE: the attempt completion flow is different in that it requires the latest checkpoint hash to be present before determining if it can present the 'see new changes' button. In ToolExecutor, when we call saveCheckpoint(true), we must make sure that the checkpoint hash is present in the last completion_result message before returning, since it is always followed by a addNewChangesFlagToLastCompletionResultMessage(), which calls doesLatestTaskCompletionHaveNewChanges() that uses the latest message hash to determine if there any changes since the last attempt_completion checkpoint.
+				await this.say("checkpoint_created")
+				this.checkpointTracker.commit().then(async (commitHash) => {
+					if (commitHash) {
+						const lastCheckpointMessageIndex = findLastIndex(
+							this.messageStateHandler.getClineMessages(),
+							(m) => m.say === "checkpoint_created",
+						)
+						if (lastCheckpointMessageIndex !== -1) {
+							await this.messageStateHandler.updateClineMessage(lastCheckpointMessageIndex, {
+								lastCheckpointHash: commitHash,
+							})
+						}
 					}
-				}
+				})
 			} // silently fails for now
 
 			//
`,
  expect: [
    {
      file: "src/core/task/index.ts",
      line: 1322,
      mustMention: ["未处理", "未捕获", "catch", "失败", "reject", "异常"],
    },
  ],
} as EvalCase;
