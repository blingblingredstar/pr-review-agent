# 输出格式（JSON 模式）

把审查结果以 JSON 格式输出，只输出 JSON 本身（不要 markdown 代码块包裹，不要解释文字）。

形状（字段名、类型完全一致，不增删字段）：

{"comments": [{"file": "相对仓库根的文件路径", "line": 1, "severity": "blocker|major|minor|nit", "body": "问题 + 理由 +（可选）修法"}]}

确实没有问题时输出 {"comments": []}。
