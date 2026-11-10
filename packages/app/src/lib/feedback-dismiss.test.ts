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

test("save failures keep the complete reason until closed or retired after saving", async () => {
  const root = createRoot(dom.window.document.getElementById("root")!);
  const { WorldSavePayloadTooLargeError, worldSaveExceptionMessage } = await vite.ssrLoadModule("/src/lib/world-save-payload.ts") as typeof import("./world-save-payload");
  const reason = worldSaveExceptionMessage(new WorldSavePayloadTooLargeError(5.1 * 1024 * 1024, 5 * 1024 * 1024));
  let retries = 0;
  const show = (text: string) => feedback.error(text, { label: "Retry", onClick: () => { retries++; } },
    { expanded: true, id: "world-save-error" });
  try {
    await act(async () => root.render(createElement(Toaster)));
    await act(async () => { show(reason); await settle(); });
    assert.equal(dom.window.document.querySelector(".yp-pill-text")?.textContent, reason);
    assert.match(reason, /5\.1 MB.*5\.0 MB/);
    assert.ok(dom.window.document.querySelector('[data-expanded="true"]'));
    const errorToast = toast.getToasts().find(entry => entry.id === "world-save-error");
    assert.ok(errorToast && "duration" in errorToast);
    assert.equal(errorToast.duration, Infinity);
    // Reading/selecting the diagnostic must not dismiss it.
    await act(async () => { dom.window.document.querySelector<HTMLElement>(".yp-pill-text")!.click(); await settle(); });
    assert.equal(toast.getToasts().some(entry => entry.id === "world-save-error"), true);
    // An autosave updates the existing error, retaining every validation line.
    const fields = "World title: shorten to 50 characters.\nDescription: shorten to 10000 characters.";
    await act(async () => { show(fields); await settle(); });
    assert.equal(toast.getToasts().filter(entry => entry.id === "world-save-error").length, 1);
    assert.equal(dom.window.document.querySelector(".yp-pill-text")?.textContent, fields);
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".yp-pill-action")!.click(); await settle(); });
    assert.equal(retries, 1);
    assert.equal(toast.getToasts().some(entry => entry.id === "world-save-error"), true);
    await act(async () => { await settle(); show(reason); await settle(); });
    await act(async () => { dom.window.document.querySelector<HTMLButtonElement>(".yp-pill-close")!.click(); await settle(); });
    assert.equal(toast.getToasts().some(entry => entry.id === "world-save-error"), false);
    assert.equal(retries, 1);
  } finally {
    await act(async () => { toast.dismiss(); await settle(); root.unmount(); });
  }
});

test("a retry that fails immediately keeps the full save diagnostic visible", async () => {
  const root = createRoot(dom.window.document.getElementById("root")!);
  const reason = "World source exceeds the 10.0 MB save limit. Move embedded images into the Asset Library.";
  let retries = 0;
  const show = () => feedback.error(reason, {
    label: "Retry",
    onClick: () => {
      retries++;
      // The serialized save starts in a microtask; local validation can fail
      // before Sonner's queued dismissal and exit animation have finished.
      void Promise.resolve().then(show);
    },
  }, { expanded: true, id: "world-save-error" });
  try {
    await act(async () => root.render(createElement(Toaster)));
    await act(async () => { show(); await settle(); });
    await act(async () => {
      dom.window.document.querySelector<HTMLButtonElement>(".yp-pill-action")!.click();
      await settle();
    });
    // Sonner leaves a removed toast mounted for its exit animation, so checking
    // just the store or immediately after clicking would miss this regression.
    await act(async () => { await settle(); await settle(); });
    assert.equal(retries, 1);
    assert.equal(dom.window.document.querySelector(".yp-pill-text")?.textContent, reason);
    assert.notEqual(dom.window.document.querySelector("[data-sonner-toast]")?.getAttribute("data-removed"), "true");
  } finally {
    await act(async () => { toast.dismiss("world-save-error"); await settle(); root.unmount(); });
  }
});

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
