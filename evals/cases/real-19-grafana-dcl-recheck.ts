import type { EvalCase } from "../score.ts";

// 来源：withmartian/code-review-benchmark offline golden 集（D040 自标偏差校验，#107）。
// golden comment 人工核验：锚点定位到 diff 内新增行，机制词转译为中文并剔除 diff 字面词
//（#44 判分纪律）；核验中弃用的 golden 见 docs/journal.md 当日条目。
export default {
  id: "real-19-grafana-dcl-recheck",
  kind: "bug",
  source: "real",
  description: "来源 grafana#90939（withmartian offline golden 集人工核验转译）：双重检查锁缺锁内复查",
  diff: `diff --git a/pkg/api/webassets/webassets.go b/pkg/api/webassets/webassets.go
index 197c5f7628151..dc26b5761e6c9 100644
--- a/pkg/api/webassets/webassets.go
+++ b/pkg/api/webassets/webassets.go
@@ -8,6 +8,7 @@ import (
 	"net/http"
 	"os"
 	"path/filepath"
+	"sync"
 
 	"github.com/grafana/grafana/pkg/api/dtos"
 	"github.com/grafana/grafana/pkg/services/licensing"
@@ -31,12 +32,21 @@ type EntryPointInfo struct {
 	} \`json:"assets,omitempty"\`
 }
 
-var entryPointAssetsCache *dtos.EntryPointAssets = nil
+var (
+	entryPointAssetsCacheMu sync.RWMutex           // guard entryPointAssetsCache
+	entryPointAssetsCache   *dtos.EntryPointAssets // TODO: get rid of global state
+)
 
 func GetWebAssets(ctx context.Context, cfg *setting.Cfg, license licensing.Licensing) (*dtos.EntryPointAssets, error) {
-	if cfg.Env != setting.Dev && entryPointAssetsCache != nil {
-		return entryPointAssetsCache, nil
+	entryPointAssetsCacheMu.RLock()
+	ret := entryPointAssetsCache
+	entryPointAssetsCacheMu.RUnlock()
+
+	if cfg.Env != setting.Dev && ret != nil {
+		return ret, nil
 	}
+	entryPointAssetsCacheMu.Lock()
+	defer entryPointAssetsCacheMu.Unlock()
 
 	var err error
 	var result *dtos.EntryPointAssets
`,
  expect: [
    {
        file: "pkg/api/webassets/webassets.go",
        line: 48,
        mustMention: [
            "复查",
            "重新检查",
            "双重检查",
            "并发",
            "竞态",
            "重复",
            "其他 goroutine",
            "锁"
        ]
    }
],
} satisfies EvalCase;
