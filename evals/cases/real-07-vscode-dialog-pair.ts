import type { EvalCase } from "../score.ts";

// 真实配对 vscode#330629（引入）→ #343670（修复）：尾分隔符判断用了规范化后的 filePickBoxUri 而非用户输入 value，Windows 盘根导航失效（难例）
export default {
  id: "real-07-vscode-dialog-pair",
  kind: "bug",
  source: "real",
  description: "真实配对 vscode#330629（引入）→ #343670（修复）",
  diff: `diff --git a/src/vs/workbench/services/dialogs/browser/simpleFileDialog.ts b/src/vs/workbench/services/dialogs/browser/simpleFileDialog.ts
index f36f1665bdc94b..1bb255403b1a06 100644
--- a/src/vs/workbench/services/dialogs/browser/simpleFileDialog.ts
+++ b/src/vs/workbench/services/dialogs/browser/simpleFileDialog.ts
@@ -511,7 +511,7 @@ export class SimpleFileDialog extends Disposable implements ISimpleFileDialog {
 					this.filePickBox.validationMessage = undefined;
 					const filePickBoxUri = this.filePickBoxValue();
 					let updated: UpdateResult = UpdateResult.NotUpdated;
+					if (resources.extUriIgnorePathCase.isEqual(this.currentFolder, resources.dirname(filePickBoxUri))) {
-					if (!resources.hasTrailingPathSeparator(filePickBoxUri, this.separator) && resources.extUriIgnorePathCase.isEqual(this.currentFolder, resources.dirname(filePickBoxUri))) {
 						this.setActiveItems(value);
 						return;
 					} else if (!resources.extUriIgnorePathCase.isEqual(this.currentFolder, filePickBoxUri)) {`,
  expect: [
    {
      "file": "src/vs/workbench/services/dialogs/browser/simpleFileDialog.ts",
      "line": 514,
      "mustMention": [
        "value",
        "filepickboxuri",
        "trailing",
        "separator",
        "判断",
        "规范化",
        "尾",
        "根",
        "盘",
        "条件",
        "输入"
      ]
    }
  ],
} satisfies EvalCase;
