import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { clientDom } from "@/lib/feed-beacon.test-helpers";
import { useCropViewport } from "./use-crop-viewport";

test("crop media refits after controls resize the viewport or artwork changes aspect", async () => {
  let resize = () => {};
  let disconnected = 0;
  const env = clientDom({ ResizeObserver: class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() { disconnected++; }
  } });
  let width = 500, height = 300;
  Object.defineProperties(env.dom.window.HTMLElement.prototype, {
    clientWidth: { get: () => width }, clientHeight: { get: () => height },
  });
  function Harness({ aspect }: { aspect: number | null }) {
    const { viewportRef, mediaWidth } = useCropViewport(aspect);
    return createElement("div", { ref: viewportRef }, mediaWidth);
  }
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(document.getElementById("root")!);
  const actual = () => Number(document.getElementById("root")!.textContent);
  try {
    await act(async () => root.render(createElement(Harness, { aspect: null })));
    assert.equal(actual(), 300);
    await act(async () => root.render(createElement(Harness, { aspect: 0.6 })));
    assert.equal(actual(), 180);
    height = 180;
    await act(async () => resize());
    assert.equal(actual(), 108, "tab/hint height changes must shrink the image too");
    await act(async () => root.render(createElement(Harness, { aspect: 3 })));
    assert.equal(actual(), 500, "wide images must fit the available width");
    width = 240;
    await act(async () => resize());
    assert.equal(actual(), 240);
    height = 0;
    await act(async () => resize());
    assert.equal(actual(), 0, "a hidden viewport must not retain a stale oversized image");
  } finally {
    await act(async () => root.unmount());
    assert.equal(disconnected, 3, "observers are released on aspect changes and unmount");
    env.restore();
  }
});
