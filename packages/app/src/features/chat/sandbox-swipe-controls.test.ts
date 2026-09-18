import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createElement, type ComponentProps } from "react";
import { JSDOM } from "jsdom";

test("sandbox swipe controls survive hidden/visible transitions and retain the pending lock", async () => {
  const dom = new JSDOM('<div id="root"></div>');
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    React, IS_REACT_ACT_ENVIRONMENT: true,
  };
  const descriptors = Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { SwipeControls } = await import("../../../sandbox/chat/swipe-controls");
  const { YuminaContext } = await import("../../../sandbox/sandbox-context");
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  type Api = NonNullable<React.ContextType<typeof YuminaContext>>;
  let swipeCalls = 0;
  let regenerateCalls = 0;
  let finishSwipe: (() => void) | undefined;
  const api = {
    language: "en", isStreaming: false,
    swipeMessage: async () => {
      swipeCalls++;
      await new Promise<void>((resolve) => { finishSwipe = resolve; });
    },
    regenerateMessage: () => { regenerateCalls++; },
    showToast: () => assert.fail("Unexpected swipe error"),
  } as unknown as Api;
  const render = async (message: ComponentProps<typeof SwipeControls>["message"]) => {
    await act(async () => root.render(createElement(YuminaContext.Provider, { value: { ...api } }, createElement(SwipeControls, { message }))));
  };
  const greeting = { id: "greeting", swipes: [{ content: "First greeting" }] };
  const variants = { ...greeting, swipes: [...greeting.swipes, { content: "Alternate greeting" }] };
  try {
    await render(greeting);
    assert.equal(container.childElementCount, 0);
    // Hydration supplies variants for the SAME message/component, without a remount.
    await render(variants);
    assert.match(container.textContent!, /1\/2/);
    assert.equal(container.querySelectorAll("button")[0]!.disabled, true);
    const next = container.querySelectorAll("button")[1]!;
    await act(async () => next.click());
    assert.equal(swipeCalls, 1);
    assert.equal(next.disabled, true);
    await act(async () => next.click());
    assert.equal(swipeCalls, 1);
    await act(async () => finishSwipe!());
    assert.equal(next.disabled, false);
    await render({ ...variants, activeSwipeIndex: 1 });
    assert.match(container.textContent!, /2\/2/);
    assert.equal(container.querySelectorAll("button")[1]!.disabled, true);
    assert.equal(regenerateCalls, 0);
    // Removing variants must also preserve hook order (the reverse transition).
    await render(greeting);
    assert.equal(container.childElementCount, 0);
    // A model arriving later also turns the controls on without variants.
    await render({ ...greeting, model: "test-model" });
    assert.match(container.textContent!, /1\/1/);
    assert.equal(container.querySelectorAll("button")[1]!.disabled, false);
    api.isStreaming = true;
    await render({ ...greeting, model: "test-model" });
    assert.equal(container.querySelectorAll("button")[1]!.disabled, true);
    await render(greeting);
    assert.equal(container.childElementCount, 0);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
