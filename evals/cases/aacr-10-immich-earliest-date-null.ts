import type { EvalCase } from "../score.ts";

// 来源：alibaba/aacr-bench v1（Apache-2.0）外部 golden 人工核验转译（#157 续批）。
// 锚点定位到机制行；mustMention 逐词过「不在 diff 中出现」检查（#44 + PR #166 教训）。
export default {
  id: "aacr-10-immich-earliest-date-null",
  kind: "bug",
  source: "aacr",
  description: "来源 immich-app/immich PR#14874（AACR-Bench v1 人工核验转译，AI golden 专家确认）：earliestDate 比较假定 fileModifiedAt/fileCreatedAt 均为非空 Date",
  diff: `diff --git a/docs/package-lock.json b/docs/package-lock.json
index ca80d15fd00267..c9ae86bec9f2e5 100644
--- a/docs/package-lock.json
+++ b/docs/package-lock.json
@@ -28,7 +28,6 @@
       },
       "devDependencies": {
         "@docusaurus/module-type-aliases": "~3.5.2",
-        "@tsconfig/docusaurus": "^2.0.2",
         "prettier": "^3.2.4",
         "typescript": "^5.1.6"
       },
@@ -3458,12 +3457,6 @@
         "node": ">=10.13.0"
       }
     },
-    "node_modules/@tsconfig/docusaurus": {
-      "version": "2.0.3",
-      "resolved": "https://registry.npmjs.org/@tsconfig/docusaurus/-/docusaurus-2.0.3.tgz",
-      "integrity": "sha512-3l1L5PzWVa7l0691TjnsZ0yOIEwG9DziSqu5IPZPlI5Dowi7z42cEym8Y35GHbgHvPcBfNxfrbxm7Cncn4nByQ==",
-      "dev": true
-    },
     "node_modules/@types/acorn": {
       "version": "4.0.6",
       "resolved": "https://registry.npmjs.org/@types/acorn/-/acorn-4.0.6.tgz",
diff --git a/server/src/services/metadata.service.spec.ts b/server/src/services/metadata.service.spec.ts
index 390f18b777b56d..619023a1c7663e 100644
--- a/server/src/services/metadata.service.spec.ts
+++ b/server/src/services/metadata.service.spec.ts
@@ -274,6 +274,40 @@ describe(MetadataService.name, () => {
       });
     });
 
+    it('should take the file modification date when missing exif and earliest than creation date', async () => {
+      const fileCreatedAt = new Date('2022-01-01T00:00:00.000Z');
+      const fileModifiedAt = new Date('2021-01-01T00:00:00.000Z');
+      assetMock.getByIds.mockResolvedValue([{ ...assetStub.image, fileCreatedAt, fileModifiedAt }]);
+      mockReadTags();
+
+      await sut.handleMetadataExtraction({ id: assetStub.image.id });
+      expect(assetMock.getByIds).toHaveBeenCalledWith([assetStub.image.id], { faces: { person: false } });
+      expect(assetMock.upsertExif).toHaveBeenCalledWith(expect.objectContaining({ dateTimeOriginal: fileModifiedAt }));
+      expect(assetMock.update).toHaveBeenCalledWith({
+        id: assetStub.image.id,
+        duration: null,
+        fileCreatedAt: fileModifiedAt,
+        localDateTime: fileModifiedAt,
+      });
+    });
+
+    it('should take the file creation date when missing exif and earliest than modification date', async () => {
+      const fileCreatedAt = new Date('2021-01-01T00:00:00.000Z');
+      const fileModifiedAt = new Date('2022-01-01T00:00:00.000Z');
+      assetMock.getByIds.mockResolvedValue([{ ...assetStub.image, fileCreatedAt, fileModifiedAt }]);
+      mockReadTags();
+
+      await sut.handleMetadataExtraction({ id: assetStub.image.id });
+      expect(assetMock.getByIds).toHaveBeenCalledWith([assetStub.image.id], { faces: { person: false } });
+      expect(assetMock.upsertExif).toHaveBeenCalledWith(expect.objectContaining({ dateTimeOriginal: fileCreatedAt }));
+      expect(assetMock.update).toHaveBeenCalledWith({
+        id: assetStub.image.id,
+        duration: null,
+        fileCreatedAt,
+        localDateTime: fileCreatedAt,
+      });
+    });
+
     it('should account for the server being in a non-UTC timezone', async () => {
       process.env.TZ = 'America/Los_Angeles';
       assetMock.getByIds.mockResolvedValue([assetStub.sidecar]);
diff --git a/server/src/services/metadata.service.ts b/server/src/services/metadata.service.ts
index e0566c84b72d25..311b3be790c8af 100644
--- a/server/src/services/metadata.service.ts
+++ b/server/src/services/metadata.service.ts
@@ -450,14 +450,14 @@ export class MetadataService extends BaseService {
         }
       } else {
         const motionAssetId = this.cryptoRepository.randomUUID();
-        const createdAt = asset.fileCreatedAt ?? asset.createdAt;
+        const dates = this.getDates(asset, tags);
         motionAsset = await this.assetRepository.create({
           id: motionAssetId,
           libraryId: asset.libraryId,
           type: AssetType.VIDEO,
-          fileCreatedAt: createdAt,
-          fileModifiedAt: asset.fileModifiedAt,
-          localDateTime: createdAt,
+          fileCreatedAt: dates.dateTimeOriginal,
+          fileModifiedAt: dates.modifyDate,
+          localDateTime: dates.localDateTime,
           checksum,
           ownerId: asset.ownerId,
           originalPath: StorageCore.getAndroidMotionPath(asset, motionAssetId),
@@ -589,9 +589,18 @@ export class MetadataService extends BaseService {
     let dateTimeOriginal = dateTime?.toDate();
     let localDateTime = dateTime?.toDateTime().setZone('UTC', { keepLocalTime: true }).toJSDate();
     if (!localDateTime || !dateTimeOriginal) {
-      this.logger.warn(\`Asset \${asset.id} has no valid date, falling back to asset.fileCreatedAt\`);
-      dateTimeOriginal = asset.fileCreatedAt;
-      localDateTime = asset.fileCreatedAt;
+      // When a file is copied (but not moved) before being uploaded to immich, the target file creation
+      // date is set at the current timestamp, while the modification date remains untouched, so if the
+      // user copied the asset while he did not modified the file (like cropping, rotating and more), then
+      // we use the modification timestamp as it's still the original date. If the user modified the asset,
+      // then there is no other solution except a further manual fix.
+      this.logger.warn(
+        \`No valid date found in exif tags from asset \${asset.id}, falling back to earliest timestamp between file creation and file modification\`,
+      );
+      // eslint-disable-next-line unicorn/prefer-math-min-max
+      const earliestDate = asset.fileModifiedAt < asset.fileCreatedAt ? asset.fileModifiedAt : asset.fileCreatedAt;
+      dateTimeOriginal = earliestDate;
+      localDateTime = earliestDate;
     }
 
     this.logger.verbose(\`Asset \${asset.id} has a local time of \${localDateTime.toISOString()}\`);
`,
  expect: [
    {
      file: "server/src/services/metadata.service.ts",
      line: 600,
      mustMention: ["可空", "为空", "未定义", "null", "缺省值", "保护"],
    },
  ],
} as EvalCase;
