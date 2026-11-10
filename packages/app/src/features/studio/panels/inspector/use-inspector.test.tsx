import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useInspector, type InspectorState } from "./use-inspector";

test("the inspector restores source selection inside the preserved shadow root after a preview recompile", async () => {
  const dom = new JSDOM('<div id="react"></div><div id="preview"><div id="shadow"></div></div>');
  const callbacks = new Map<number, FrameRequestCallback>();
  let nextRaf = 0;
  const globals = {
    window: dom.window, document: dom.window.document, Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement, ShadowRoot: dom.window.ShadowRoot,
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (cb: FrameRequestCallback) => { callbacks.set(++nextRaf, cb); return nextRaf; },
    cancelAnimationFrame: (id: number) => callbacks.delete(id),
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const preview = document.getElementById("preview")!;
  const shadow = document.getElementById("shadow")!.attachShadow({ mode: "open" });
  const source = "components/Hero.tsx:2";
  const replace = (src: string) => {
    shadow.innerHTML = `<div data-yc-frame><div data-yc-src="${src}">Title</div></div>`;
    return shadow.querySelector("[data-yc-src]")!;
  };
  const old = replace(source);
  const ref = { current: preview };
  let inspector!: InspectorState;
  function Probe() { inspector = useInspector(ref, ref); return null; }
  const root = createRoot(document.getElementById("react")!);
  const frame = () => act(async () => {
    const pending = [...callbacks.values()]; callbacks.clear();
    for (const cb of pending) cb(0);
  });
  try {
    await act(async () => root.render(createElement(Probe)));
    await act(async () => inspector.select(old));
    const replacement = replace(source);
    assert.equal(preview.querySelector("[data-yc-frame]"), null, "the real preview places its frame inside Shadow DOM");
    await frame();
    assert.equal(inspector.selected, replacement);
    assert.equal(inspector.chain.at(-1), replacement);
    replace("components/Other.tsx:2");
    await frame();
    assert.equal(inspector.selected, null, "a deleted source element must not select an unrelated replacement");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
