import type { EvalCase } from "../score.ts";

// 来源：alibaba/aacr-bench v1（Apache-2.0，HF Alibaba-Aone/aacr-bench）外部 golden 人工核验转译（#157）。
// golden comment 人工核验：锚点定位到 diff 内机制行（AACR 参考行号与机制行逐条对位，无漂移），
// 机制词中文转译并尽量剔除 diff 字面词（#44 判分纪律）；provenance 随 description 必填。
export default {
  id: "aacr-02-react-single-state-hook",
  kind: "bug",
  source: "aacr",
  description: "来源 facebook/react PR#33059（AACR-Bench v1 人工核验转译，human golden）：单 state hook 表单组件的 memoized state 被 next 判空条件忽略",
  diff: `diff --git a/packages/react-dom/src/__tests__/ReactDOMForm-test.js b/packages/react-dom/src/__tests__/ReactDOMForm-test.js
index 93edccf9bcef..f4a9355b102c 100644
--- a/packages/react-dom/src/__tests__/ReactDOMForm-test.js
+++ b/packages/react-dom/src/__tests__/ReactDOMForm-test.js
@@ -1670,6 +1670,48 @@ describe('ReactDOMForm', () => {
     expect(divRef.current.textContent).toEqual('Current username: acdlite');
   });
 
+  it.only('multiple form submissions in rapid succession do not throw', async () => {
+    const submitFormTwiceButtonRef = React.createRef();
+    let actionCounter = 0;
+    function App() {
+      const formRef = React.createRef();
+      // Submits the form twice in quick succession
+      // This simulates a user clicking a button twice in rapid succession
+      async function submitFormTwice() {
+        formRef.current.requestSubmit();
+        await new Promise(res => setTimeout(res, 1));
+        formRef.current.requestSubmit();
+      }
+
+      // This is a userspace action. it must take a non-zero amount of time to
+      // allow the form to be submitted again before the first one finishes.
+      // Otherwise, the form transitions will be batched and will not run concurrently.
+      async function submitForm() {
+        actionCounter++;
+        return new Promise(res => setTimeout(res, 1));
+      }
+
+      return (
+        <>
+          <form ref={formRef} action={submitForm}>
+            <button type="submit">Submit</button>
+          </form>
+          <button ref={submitFormTwiceButtonRef} onClick={submitFormTwice}>
+            Submit twice
+          </button>
+        </>
+      );
+    }
+
+    const root = ReactDOMClient.createRoot(container);
+    await act(() => root.render(<App />));
+
+    await act(async () => {
+      submitFormTwiceButtonRef.current.click();
+    });
+    expect(actionCounter).toBe(2);
+  });
+
   it(
     'requestFormReset works with inputs that are not descendants ' +
       'of the form element',
diff --git a/packages/react-reconciler/src/ReactFiberHooks.js b/packages/react-reconciler/src/ReactFiberHooks.js
index 967be9be94fa..e92801f5fc1a 100644
--- a/packages/react-reconciler/src/ReactFiberHooks.js
+++ b/packages/react-reconciler/src/ReactFiberHooks.js
@@ -3261,7 +3261,7 @@ export function startHostTransition<F>(
 
 function ensureFormComponentIsStateful(formFiber: Fiber) {
   const existingStateHook: Hook | null = formFiber.memoizedState;
-  if (existingStateHook !== null) {
+  if (existingStateHook !== null && existingStateHook.next !== null) {
     // This fiber was already upgraded to be stateful.
     return existingStateHook;
   }
`,
  expect: [
    {
      file: "packages/react-reconciler/src/ReactFiberHooks.js",
      line: 3264,
      mustMention: ["单个", "只有一个", "唯一", "忽略", "不复用", "重复", "已有状态", "next", "丢失"],
    },
  ],
} as EvalCase;
