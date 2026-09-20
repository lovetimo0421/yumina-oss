import assert from "node:assert/strict";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost", pretendToBeVisual: true });
Object.defineProperty(dom.window, "matchMedia", {
  value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
});
const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  localStorage: dom.window.localStorage,
  HTMLElement: dom.window.HTMLElement,
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
  cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals)) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
const { createRoot } = await import("react-dom/client");
// Use the real toast store and renderer: mocking dismiss would miss mismatched IDs.
const { Toaster, toast } = await import("sonner");
const vite = await createServer({
  configFile: false,
  root: fileURLToPath(new URL("../..", import.meta.url)),
  appType: "custom",
  logLevel: "silent",
  resolve: { alias: { "@": fileURLToPath(new URL("..", import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  server: { middlewareMode: true, watch: null },
});
const { feedback } = await vite.ssrLoadModule("/src/lib/feedback.tsx") as typeof import("./feedback");

after(async () => {
  await vite.close();
  dom.window.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 250));

for (const explicitId of [false, true]) {
  for (const control of ["Close", "X", "Escape", "programmatic"] as const) {
    test(`persistent feedback dismisses via ${control} with ${explicitId ? "explicit" : "generated"} ID`, async () => {
      const root = createRoot(dom.window.document.getElementById("root")!);
      let actionCalls = 0;
      let dismiss = () => {};
      const text = "Memory updates cost a little — switch to free anytime in chat";
      try {
        await act(async () => root.render(createElement(Toaster)));
        await act(async () => {
          dismiss = feedback.persistent(text, { label: "Close", onClick: () => { actionCalls++; } },
            explicitId ? { id: `memory-cost-${control}` } : undefined);
          await settle();
        });
        assert.equal(dom.window.document.querySelector(".yp-pill-text")?.textContent, text);
        const pill = toast.getToasts().find((entry) => "duration" in entry && entry.duration === Infinity);
        assert.ok(pill, "the notice remains active until dismissed");
        await act(async () => {
          if (control === "programmatic") {
            dismiss();
          } else {
            const button = dom.window.document.querySelector<HTMLButtonElement>(
              control === "X" ? ".yp-pill-close" : ".yp-pill-action",
            );
            assert.ok(button);
            if (control === "Escape") {
              button.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
            } else {
              button.click();
            }
          }
          await settle();
        });
        assert.equal(toast.getToasts().some((entry) => entry.id === pill.id), false,
          "dismissal must target the ID actually stored by Sonner");
        // Sonner removes the DOM node after its exit animation.
        await act(async () => { await settle(); });
        assert.equal(dom.window.document.querySelector(".yp-pill"), null);
        assert.equal(actionCalls, control === "Close" ? 1 : 0);
      } finally {
        await act(async () => {
          for (const entry of toast.getToasts()) toast.dismiss(entry.id);
          await settle();
        });
        await act(async () => root.unmount());
      }
    });
  }
}
