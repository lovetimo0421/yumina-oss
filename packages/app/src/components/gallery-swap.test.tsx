import assert from "node:assert/strict";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { GallerySwap } from "./gallery-swap";

async function withDom(check: (view: { root: HTMLElement; render: (index: number, direction: 1 | -1) => Promise<void> }) => Promise<void>) {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const host = dom.window.document.getElementById("root")!;
  const root = createRoot(host);
  const render = async (index: number, direction: 1 | -1) => {
    await act(async () => root.render(createElement(GallerySwap, { index, direction, render: (n: number) => createElement("img", { alt: `pic ${n}` }) })));
  };
  try {
    await check({ root: host, render });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

const layers = (root: HTMLElement) => Array.from(root.querySelectorAll(".gallery-swap-layer")).map(el => ({ cls: el.className, alt: el.querySelector("img")?.getAttribute("alt") }));

test("a flip shows the new picture entering and the old one leaving, from the side asked for", async () => {
  await withDom(async ({ root, render }) => {
    await render(0, 1);
    assert.deepEqual(layers(root).map(l => l.alt), ["pic 0"], "first paint has no animation pair");
    assert.doesNotMatch(layers(root)[0]!.cls, /swap-in/);

    await render(1, 1);
    const pair = layers(root);
    assert.deepEqual(pair.map(l => l.alt), ["pic 0", "pic 1"]);
    assert.match(pair[0]!.cls, /gallery-swap-out-next/);
    assert.match(pair[1]!.cls, /gallery-swap-in-next/);

    // The old frame is dropped once its exit ends.
    const out = root.querySelector(".gallery-swap-out-next")!;
    await act(async () => { out.dispatchEvent(new (out.ownerDocument.defaultView!.Event)("animationend", { bubbles: true })); });
    assert.deepEqual(layers(root).map(l => l.alt), ["pic 1"]);

    await render(0, -1);
    const back = layers(root);
    assert.match(back[0]!.cls, /gallery-swap-out-prev/);
    assert.match(back[1]!.cls, /gallery-swap-in-prev/);
  });
});

test("rapid flips keep only the latest pair", async () => {
  await withDom(async ({ root, render }) => {
    await render(0, 1);
    await render(1, 1);
    await render(2, 1);
    await render(3, 1);
    assert.deepEqual(layers(root).map(l => l.alt), ["pic 2", "pic 3"]);
  });
});
