import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { LiveCanonModal } from "../../../sandbox/extensions/live-canon/live-canon-modal";
import {
  YuminaContext,
  type SandboxedYuminaAPI,
} from "../../../sandbox/sandbox-context";

test("an author-disabled story shows only the exact Lore Shift warning", async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    ShadowRoot: dom.window.ShadowRoot,
    React,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }

  const root = createRoot(dom.window.document.getElementById("root")!);
  const api = {
    language: "en",
    isStreaming: false,
    getLiveCanon: async () => ({
      ok: false,
      code: "AUTHOR_DISABLED_LIVE_CANON",
      error: "Author disabled",
    }),
  } as SandboxedYuminaAPI;

  try {
    await act(async () => {
      root.render(
        <YuminaContext.Provider value={api}>
          <LiveCanonModal open onClose={() => {}} />
        </YuminaContext.Provider>,
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    const host = dom.window.document.querySelector<HTMLElement>("[data-yumina-platform-overlay-host]");
    assert.ok(host?.shadowRoot);
    const text = host.shadowRoot.textContent ?? "";
    assert.match(text, /Lore Shift is unavailable for this story/);
    assert.match(
      text,
      /The author has disabled session lore editing\. You can keep playing, but Lore Shift cannot change this story's state or lore\./,
    );
    assert.equal(host.shadowRoot.querySelectorAll("input, textarea, select").length, 0);
    assert.doesNotMatch(text, /Save changes/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
