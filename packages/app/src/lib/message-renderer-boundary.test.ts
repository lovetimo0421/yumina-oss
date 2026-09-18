import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { MessageRendererBoundary } from "../../sandbox/chat/message-renderer-boundary";

test("a broken custom message renderer falls back and retries after its inputs change", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>");
  const globalKeys = [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Node",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const previousDescriptors = new Map(
    globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const installGlobal = (key: (typeof globalKeys)[number], value: unknown) => {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };

  installGlobal("window", dom.window);
  installGlobal("document", dom.window.document);
  installGlobal("navigator", dom.window.navigator);
  installGlobal("HTMLElement", dom.window.HTMLElement);
  installGlobal("Node", dom.window.Node);
  installGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);
  const originalConsoleError = console.error;
  console.error = () => {};

  const BrokenRenderer = ({ broken }: { broken: boolean }) => {
    if (broken) {
      return createElement("div", null, { nested: true } as unknown as React.ReactNode);
    }
    return createElement("div", null, "custom renderer recovered");
  };

  const renderBoundary = (broken: boolean, version: number) => (
    createElement(
      MessageRendererBoundary,
      {
        fallback: createElement("p", null, "safe markdown fallback"),
        resetKeys: [version],
      },
      createElement(BrokenRenderer, { broken }),
    )
  );

  try {
    await act(async () => root.render(renderBoundary(true, 1)));
    assert.equal(container.textContent, "safe markdown fallback");

    await act(async () => root.render(renderBoundary(false, 2)));
    assert.equal(container.textContent, "custom renderer recovered");
  } finally {
    console.error = originalConsoleError;
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of globalKeys) {
      const descriptor = previousDescriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
