import type { EvalCase } from "../score.ts";

// 来源：withmartian/code-review-benchmark offline golden 集（D040 自标偏差校验，#107）。
// golden comment 人工核验：锚点定位到 diff 内新增行，机制词转译为中文并剔除 diff 字面词
//（#44 判分纪律）；核验中弃用的 golden 见 docs/journal.md 当日条目。
export default {
  id: "real-16-calcom-delete-non-sms",
  kind: "bug",
  source: "real",
  description: "来源 cal.com#14943（withmartian offline golden 集人工核验转译）：deleteMany OR 分支缺 method 过滤，误删非 SMS 提醒 + retryCount 读改写竞态",
  diff: `diff --git a/packages/features/ee/workflows/api/scheduleSMSReminders.ts b/packages/features/ee/workflows/api/scheduleSMSReminders.ts
index 299d9bac639..a6d7f46740d 100644
--- a/packages/features/ee/workflows/api/scheduleSMSReminders.ts
+++ b/packages/features/ee/workflows/api/scheduleSMSReminders.ts
@@ -28,10 +28,19 @@ async function handler(req: NextApiRequest, res: NextApiResponse) {
   //delete all scheduled sms reminders where scheduled date is past current date
   await prisma.workflowReminder.deleteMany({
     where: {
-      method: WorkflowMethods.SMS,
-      scheduledDate: {
-        lte: dayjs().toISOString(),
-      },
+      OR: [
+        {
+          method: WorkflowMethods.SMS,
+          scheduledDate: {
+            lte: dayjs().toISOString(),
+          },
+        },
+        {
+          retryCount: {
+            gt: 1,
+          },
+        },
+      ],
     },
   });
 
@@ -44,8 +53,11 @@ async function handler(req: NextApiRequest, res: NextApiResponse) {
         lte: dayjs().add(7, "day").toISOString(),
       },
     },
-    select,
-  })) as PartialWorkflowReminder[];
+    select: {
+      ...select,
+      retryCount: true,
+    },
+  })) as (PartialWorkflowReminder & { retryCount: number })[];
 
   if (!unscheduledReminders.length) {
     res.json({ ok: true });
@@ -163,9 +175,26 @@ async function handler(req: NextApiRequest, res: NextApiResponse) {
               referenceId: scheduledSMS.sid,
             },
           });
+        } else {
+          await prisma.workflowReminder.update({
+            where: {
+              id: reminder.id,
+            },
+            data: {
+              retryCount: reminder.retryCount + 1,
+            },
+          });
         }
       }
     } catch (error) {
+      await prisma.workflowReminder.update({
+        where: {
+          id: reminder.id,
+        },
+        data: {
+          retryCount: reminder.retryCount + 1,
+        },
+      });
       console.log(\`Error scheduling SMS with error \${error}\`);
     }
   }
diff --git a/packages/prisma/migrations/20240508134359_add_retry_count_to_workflow_reminder/migration.sql b/packages/prisma/migrations/20240508134359_add_retry_count_to_workflow_reminder/migration.sql
new file mode 100644
index 00000000000..58e4124a58d
--- /dev/null
+++ b/packages/prisma/migrations/20240508134359_add_retry_count_to_workflow_reminder/migration.sql
@@ -0,0 +1,2 @@
+-- AlterTable
+ALTER TABLE "WorkflowReminder" ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0;
diff --git a/packages/prisma/schema.prisma b/packages/prisma/schema.prisma
index e2ab07595af..1085d72dfb9 100644
--- a/packages/prisma/schema.prisma
+++ b/packages/prisma/schema.prisma
@@ -997,6 +997,7 @@ model WorkflowReminder {
   cancelled           Boolean?
   seatReferenceId     String?
   isMandatoryReminder Boolean?        @default(false)
+  retryCount          Int             @default(0)
 
   @@index([bookingUid])
   @@index([workflowStepId])
`,
  expect: [
    {
        file: "packages/features/ee/workflows/api/scheduleSMSReminders.ts",
        // line null 文件级：首读数实证评审锚位天然漂移（模型贴 OR 数组开头行 33，距机制行 39 差 6 行），
        // 同缺陷多锚位合理；内容由 mustMention 守（bot minor：单行锚会系统性记假 miss，PR #158 审查）
        line: null,
        mustMention: [
            "误删",
            "删掉",
            "误伤",
            "波及",
            "Email",
            "WhatsApp",
            "其他类型",
            "未限定"
        ]
    },
    {
        file: "packages/features/ee/workflows/api/scheduleSMSReminders.ts",
        line: 184,
        mustMention: [
            "并发",
            "竞态",
            "原子",
            "increment",
            "丢失",
            "覆盖",
            "旧值"
        ]
    }
],
} satisfies EvalCase;
