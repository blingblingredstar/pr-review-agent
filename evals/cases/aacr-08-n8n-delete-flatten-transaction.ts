import type { EvalCase } from "../score.ts";

// 来源：alibaba/aacr-bench v1（Apache-2.0）外部 golden 人工核验转译（#157 续批）。
// 锚点定位到机制行；mustMention 逐词过「不在 diff 中出现」检查（#44 + PR #166 教训）。
export default {
  id: "aacr-08-n8n-delete-flatten-transaction",
  kind: "bug",
  source: "aacr",
  description: "来源 n8n-io/n8n PR#15057（AACR-Bench v1 人工核验转译，AI golden 专家确认）：flattenAndArchive 与 deleteFolder 两步无事务包裹（部分成功留中间态）+ PROJECT_ROOT 传入 parentFolderIds 过滤疑误包含",
  diff: `diff --git a/packages/cli/src/controllers/folder.controller.ts b/packages/cli/src/controllers/folder.controller.ts
index b66a89b7402d..ef59a19b7f76 100644
--- a/packages/cli/src/controllers/folder.controller.ts
+++ b/packages/cli/src/controllers/folder.controller.ts
@@ -27,12 +27,14 @@ import { NotFoundError } from '@/errors/response-errors/not-found.error';
 import { AuthenticatedRequest } from '@/requests';
 import type { ListQuery } from '@/requests';
 import { FolderService } from '@/services/folder.service';
+import { WorkflowService } from '@/workflows/workflow.service';
 import { EnterpriseWorkflowService } from '@/workflows/workflow.service.ee';
 
 @RestController('/projects/:projectId/folders')
 export class ProjectController {
 	constructor(
 		private readonly folderService: FolderService,
+		private readonly workflowService: WorkflowService,
 		private readonly enterpriseWorkflowService: EnterpriseWorkflowService,
 	) {}
 
@@ -104,6 +106,12 @@ export class ProjectController {
 		const { projectId, folderId } = req.params;
 
 		try {
+			await this.folderService.findFolderInProjectOrFail(folderId, projectId);
+
+			if (!payload.transferToFolderId) {
+				await this.workflowService.flattenAndArchive(req.user, folderId, projectId);
+			}
+
 			await this.folderService.deleteFolder(folderId, projectId, payload);
 		} catch (e) {
 			if (e instanceof FolderNotFoundError) {
diff --git a/packages/cli/src/databases/repositories/workflow.repository.ts b/packages/cli/src/databases/repositories/workflow.repository.ts
index 3f6c8e8621f7..e1b4e11399ac 100644
--- a/packages/cli/src/databases/repositories/workflow.repository.ts
+++ b/packages/cli/src/databases/repositories/workflow.repository.ts
@@ -297,6 +297,22 @@ export class WorkflowRepository extends Repository<WorkflowEntity> {
 		return [enrichedWorkflowsAndFolders, count] as const;
 	}
 
+	async getAllWorkflowIdsInHierarchy(folderId: string, projectId: string): Promise<string[]> {
+		const subFolderIds = await this.folderRepository.getAllFolderIdsInHierarchy(
+			folderId,
+			projectId,
+		);
+
+		const query = this.createQueryBuilder('workflow');
+
+		this.applySelect(query, { id: true });
+		this.applyParentFolderFilter(query, { parentFolderIds: [folderId, ...subFolderIds] });
+
+		const workflowIds = (await query.getMany()).map((workflow) => workflow.id);
+
+		return workflowIds;
+	}
+
 	private getFolderIds(workflowsAndFolders: WorkflowFolderUnionRow[]) {
 		return workflowsAndFolders.filter((item) => item.resource === 'folder').map((item) => item.id);
 	}
@@ -669,4 +685,12 @@ export class WorkflowRepository extends Repository<WorkflowEntity> {
 			},
 		);
 	}
+
+	async moveToFolder(workflowIds: string[], toFolderId: string) {
+		await this.createQueryBuilder()
+			.update(WorkflowEntity)
+			.set({ parentFolder: toFolderId === PROJECT_ROOT ? null : { id: toFolderId } })
+			.where({ id: In(workflowIds) })
+			.execute();
+	}
 }
diff --git a/packages/cli/src/workflows/workflow.service.ts b/packages/cli/src/workflows/workflow.service.ts
index f248225a1eee..f9813283020b 100644
--- a/packages/cli/src/workflows/workflow.service.ts
+++ b/packages/cli/src/workflows/workflow.service.ts
@@ -418,7 +418,11 @@ export class WorkflowService {
 		return workflow;
 	}
 
-	async archive(user: User, workflowId: string): Promise<WorkflowEntity | undefined> {
+	async archive(
+		user: User,
+		workflowId: string,
+		skipArchived: boolean = false,
+	): Promise<WorkflowEntity | undefined> {
 		const workflow = await this.workflowFinderService.findWorkflowForUser(workflowId, user, [
 			'workflow:delete',
 		]);
@@ -428,6 +432,10 @@ export class WorkflowService {
 		}
 
 		if (workflow.isArchived) {
+			if (skipArchived) {
+				return workflow;
+			}
+
 			throw new BadRequestError('Workflow is already archived.');
 		}
 
@@ -477,6 +485,25 @@ export class WorkflowService {
 		return workflow;
 	}
 
+	/**
+	 * Moves all workflows in a folder to the root of the project and archives them,
+	 * flattening the folder structure.
+	 *
+	 * If any workflows were active this will also deactivate those workflows.
+	 */
+	async flattenAndArchive(user: User, folderId: string, projectId: string): Promise<void> {
+		const workflowIds = await this.workflowRepository.getAllWorkflowIdsInHierarchy(
+			folderId,
+			projectId,
+		);
+
+		for (const workflowId of workflowIds) {
+			await this.archive(user, workflowId, true);
+		}
+
+		await this.workflowRepository.moveToFolder(workflowIds, PROJECT_ROOT);
+	}
+
 	async getWorkflowScopes(user: User, workflowId: string): Promise<Scope[]> {
 		const userProjectRelations = await this.projectService.getProjectRelationsForUser(user);
 		const shared = await this.sharedWorkflowRepository.find({
diff --git a/packages/cli/test/integration/folder/folder.controller.test.ts b/packages/cli/test/integration/folder/folder.controller.test.ts
index ad5d877e259c..e0bcba6a57a0 100644
--- a/packages/cli/test/integration/folder/folder.controller.test.ts
+++ b/packages/cli/test/integration/folder/folder.controller.test.ts
@@ -757,7 +757,7 @@ describe('DELETE /projects/:projectId/folders/:folderId', () => {
 		expect(folderInDb).toBeNull();
 	});
 
-	test('should delete folder, all child folders, and contained workflows when no transfer folder is specified', async () => {
+	test('should delete folder, all child folders, and archive and move contained workflows to project root when no transfer folder is specified', async () => {
 		const project = await createTeamProject('test', owner);
 		const rootFolder = await createFolder(project, { name: 'Root' });
 		const childFolder = await createFolder(project, {
@@ -766,9 +766,8 @@ describe('DELETE /projects/:projectId/folders/:folderId', () => {
 		});
 
 		// Create workflows in the folders
-		const workflow1 = await createWorkflow({ parentFolder: rootFolder }, owner);
-
-		const workflow2 = await createWorkflow({ parentFolder: childFolder }, owner);
+		const workflow1 = await createWorkflow({ parentFolder: rootFolder, active: false }, owner);
+		const workflow2 = await createWorkflow({ parentFolder: childFolder, active: true }, owner);
 
 		await authOwnerAgent.delete(\`/projects/\${project.id}/folders/\${rootFolder.id}\`);
 
@@ -780,10 +779,24 @@ describe('DELETE /projects/:projectId/folders/:folderId', () => {
 		expect(childFolderInDb).toBeNull();
 
 		// Check workflows
-		const workflow1InDb = await workflowRepository.findOneBy({ id: workflow1.id });
-		const workflow2InDb = await workflowRepository.findOneBy({ id: workflow2.id });
-		expect(workflow1InDb).toBeNull();
-		expect(workflow2InDb).toBeNull();
+
+		const workflow1InDb = await workflowRepository.findOne({
+			where: { id: workflow1.id },
+			relations: ['parentFolder'],
+		});
+		expect(workflow1InDb).not.toBeNull();
+		expect(workflow1InDb?.isArchived).toBe(true);
+		expect(workflow1InDb?.parentFolder).toBe(null);
+		expect(workflow1InDb?.active).toBe(false);
+
+		const workflow2InDb = await workflowRepository.findOne({
+			where: { id: workflow2.id },
+			relations: ['parentFolder'],
+		});
+		expect(workflow2InDb).not.toBeNull();
+		expect(workflow2InDb?.isArchived).toBe(true);
+		expect(workflow2InDb?.parentFolder).toBe(null);
+		expect(workflow2InDb?.active).toBe(false);
 	});
 
 	test('should transfer folder contents when transferToFolderId is specified', async () => {
diff --git a/packages/frontend/editor-ui/src/plugins/i18n/locales/en.json b/packages/frontend/editor-ui/src/plugins/i18n/locales/en.json
index 38b759e0f4e6..5634efd6b7f1 100644
--- a/packages/frontend/editor-ui/src/plugins/i18n/locales/en.json
+++ b/packages/frontend/editor-ui/src/plugins/i18n/locales/en.json
@@ -949,7 +949,7 @@
 	"folder.count": "the {count} folder | the {count} folders",
 	"workflow.count": "the {count} workflow | the {count} workflows",
 	"folder.and.workflow.separator": "and",
-	"folders.delete.action": "Delete all workflows and subfolders",
+	"folders.delete.action": "Archive all workflows and delete subfolders",
 	"folders.delete.error.message": "Problem while deleting folder",
 	"folders.delete.confirmation.message": "Type \\"delete {folderName}\\" to confirm",
 	"folders.transfer.confirm.message": "Data transferred to \\"{folderName}\\"",
`,
  expect: [
    {
      file: "packages/cli/src/controllers/folder.controller.ts",
      line: 115,
      mustMention: ["事务", "原子", "一致性", "回滚", "部分成功", "中间态"],
    },
    {
      file: "packages/cli/src/databases/repositories/workflow.repository.ts",
      line: 309,
      mustMention: ["根目录", "根节点", "PROJECT_ROOT", "误包含", "占位符", "哨兵"],
    },
  ],
} as EvalCase;
