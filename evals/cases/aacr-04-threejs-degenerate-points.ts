import type { EvalCase } from "../score.ts";

// 来源：alibaba/aacr-bench v1（Apache-2.0，HF Alibaba-Aone/aacr-bench）外部 golden 人工核验转译（#157）。
// golden comment 人工核验：锚点定位到 diff 内机制行（AACR 参考行号与机制行逐条对位，无漂移），
// 机制词中文转译并尽量剔除 diff 字面词（#44 判分纪律）；provenance 随 description 必填。
export default {
  id: "aacr-04-threejs-degenerate-points",
  kind: "bug",
  source: "aacr",
  description: "来源 mrdoob/three.js PR#30750（AACR-Bench v1 人工核验转译，AI golden 专家确认）：cleanPoints 假定 points 至少 2 个，空/单点轮廓时 points[0] 未定义访问",
  diff: `diff --git a/src/geometries/ExtrudeGeometry.js b/src/geometries/ExtrudeGeometry.js
index 957d83599aaad0..1d66c03ab26bdf 100644
--- a/src/geometries/ExtrudeGeometry.js
+++ b/src/geometries/ExtrudeGeometry.js
@@ -162,14 +162,44 @@ class ExtrudeGeometry extends BufferGeometry {
 
 			}
 
+			function cleanPoints( points ) {
 
-			const faces = ShapeUtils.triangulateShape( vertices, holes );
+				const THRESHOLD = 0.0002;
+				const THRESHOLD_SQ = THRESHOLD * THRESHOLD;
+				let prevPos = points[ 0 ];
+				for ( let i = 1; i <= points.length; i ++ ) {
+
+					const currentIndex = i % points.length;
+					const currentPos = points[ currentIndex ];
+					const dx = currentPos.x - prevPos.x;
+					const dy = currentPos.y - prevPos.y;
+					const distSq = dx * dx + dy * dy;
+
+					if ( distSq <= THRESHOLD_SQ ) {
+
+						points.splice( currentIndex, 1 );
+						if ( currentIndex == 0 ) break;
+						i --;
+						continue;
+
+					}
+
+					prevPos = currentPos;
+
+				}
+
+			}
+
+			cleanPoints( vertices );
+			holes.forEach( cleanPoints );
+
+			const numHoles = holes.length;
 
 			/* Vertices */
 
 			const contour = vertices; // vertices has all points but contour has only points of circumference
 
-			for ( let h = 0, hl = holes.length; h < hl; h ++ ) {
+			for ( let h = 0; h < numHoles; h ++ ) {
 
 				const ahole = holes[ h ];
 
@@ -186,7 +216,7 @@ class ExtrudeGeometry extends BufferGeometry {
 
 			}
 
-			const vlen = vertices.length, flen = faces.length;
+			const vlen = vertices.length;
 
 
 			// Find directions for point movement
@@ -333,7 +363,7 @@ class ExtrudeGeometry extends BufferGeometry {
 			const holesMovements = [];
 			let oneHoleMovements, verticesMovements = contourMovements.concat();
 
-			for ( let h = 0, hl = holes.length; h < hl; h ++ ) {
+			for ( let h = 0, hl = numHoles; h < hl; h ++ ) {
 
 				const ahole = holes[ h ];
 
@@ -354,6 +384,8 @@ class ExtrudeGeometry extends BufferGeometry {
 
 			}
 
+			const contractedContourVertices = [];
+			const expandedHoleVertices = [];
 
 			// Loop bevelSegments, 1 for the front, 1 for the back
 
@@ -372,28 +404,36 @@ class ExtrudeGeometry extends BufferGeometry {
 					const vert = scalePt2( contour[ i ], contourMovements[ i ], bs );
 
 					v( vert.x, vert.y, - z );
+					if ( t == 0 ) contractedContourVertices.push( vert );
 
 				}
 
 				// expand holes
 
-				for ( let h = 0, hl = holes.length; h < hl; h ++ ) {
+				for ( let h = 0, hl = numHoles; h < hl; h ++ ) {
 
 					const ahole = holes[ h ];
 					oneHoleMovements = holesMovements[ h ];
-
+					const oneHoleVertices = [];
 					for ( let i = 0, il = ahole.length; i < il; i ++ ) {
 
 						const vert = scalePt2( ahole[ i ], oneHoleMovements[ i ], bs );
 
 						v( vert.x, vert.y, - z );
+						if ( t == 0 ) oneHoleVertices.push( vert );
 
 					}
 
+					if ( t == 0 ) expandedHoleVertices.push( oneHoleVertices );
+
 				}
 
 			}
 
+			const faces = ShapeUtils.triangulateShape( contractedContourVertices, expandedHoleVertices );
+
+			const flen = faces.length;
+
 			const bs = bevelSize + bevelOffset;
 
 			// Back facing vertices
`,
  expect: [
    {
      file: "src/geometries/ExtrudeGeometry.js",
      line: 169,
      mustMention: ["空", "长度", "至少两个", "不足两个", "undefined", "未定义", "越界", "退化"],
    },
  ],
} as EvalCase;
