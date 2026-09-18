import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

test("reopened chat follows delayed layout, stops on user input, and resets for another session", async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true });
  const keys = ["window", "document", "navigator", "Element", "HTMLElement", "Node", "MutationObserver", "CustomEvent",
    "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) {
    const value = key === "React" ? React : key === "IS_REACT_ACT_ENVIRONMENT" ? true
      : (dom.window as unknown as Record<string, unknown>)[key];
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const callbacks = new Set<() => void>();
  class TestResizeObserver {
    constructor(private callback: () => void) { callbacks.add(callback); }
    observe() {}
    disconnect() { callbacks.delete(this.callback); }
  }
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
  let height = 0;
  let contentHeight = 0;
  const positions = new WeakMap<Element, number>();
  Object.defineProperties(dom.window.Element.prototype, {
    clientHeight: { configurable: true, get() { return height; } },
    scrollHeight: { configurable: true, get() { return contentHeight; } },
    scrollTop: { configurable: true,
      get() { return positions.get(this) ?? 0; },
      set(value: number) { positions.set(this, Math.max(0, Math.min(value, contentHeight - height))); },
    },
    scrollTo: { configurable: true, value(options: ScrollToOptions) { this.scrollTop = options.top ?? 0; } },
  });
  const container = dom.window.document.getElementById("root")!;
  const root = createRoot(container);
  const resize = async (viewport: number, content: number) => {
    height = viewport;
    contentHeight = content;
    await act(async () => {
      for (const callback of callbacks) callback();
      await new Promise<void>((done) => dom.window.requestAnimationFrame(() => done()));
    });
  };
  try {
    const [{ MessageList }, { YuminaContext, buildAPI }, { isInitialTranscriptScroll }, { restoreTranscriptPosition }] = await Promise.all([
      import("../../../sandbox/chat/message-list"), import("../../../sandbox/sandbox-context"),
      import("../../../sandbox/chat/initial-message-scroll"),
      import("../../../sandbox/chat/transcript-position"),
    ]);
    const messages = Array.from({ length: 29 }, (_, index) => ({
      id: `m${index}`, sessionId: "s1", role: index % 2 ? "user" as const : "assistant" as const,
      content: `message ${index}`, createdAt: "2026-09-07T07:06:00Z",
    }));
    const api = buildAPI({ variables: {}, globalVariables: {}, worldName: "Delayed layout", worldCover: null,
      worldId: "world", sessionId: "s1", currentUser: null, user: { name: "Player", avatar: null },
      messages, isStreaming: false, streamingContent: "", mode: "session",
    } as unknown as Parameters<typeof buildAPI>[0]);
    const render = async (sessionId: string, mode = "session") => {
      await act(async () => root.render(createElement(YuminaContext.Provider,
        { value: { ...api, sessionId, mode } as typeof api }, createElement(MessageList, { rendererComponent: null }))));
    };
    await render("s1");
    const scroll = container.querySelector<HTMLElement>(".play-message-scroll")!;
    assert.ok(scroll);
    assert.equal(container.querySelectorAll(".play-message-row").length, 29);
    await resize(500, 2000);
    assert.equal(scroll.scrollTop, 1500, "late iframe sizing must reveal the latest saved message");
    await resize(400, 2400);
    assert.equal(scroll.scrollTop, 2000, "font/content and viewport changes must preserve the initial bottom");
    assert.equal(isInitialTranscriptScroll(scroll), true, "the sandbox guard must recognize restoration as programmatic");
    scroll.dispatchEvent(new dom.window.WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
    assert.equal(isInitialTranscriptScroll(scroll), false, "user intent must release both the anchor and scroll guard exemption");
    scroll.scrollTop = 1000;
    await resize(400, 2800);
    assert.equal(scroll.scrollTop, 1000, "reading older messages must not be interrupted");
    await render("s2");
    await resize(400, 3000);
    assert.equal(scroll.scrollTop, 2600, "another session starts at its own latest message");
    scroll.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "PageUp", bubbles: true }));
    scroll.scrollTop = 900;
    await resize(400, 3200);
    assert.equal(scroll.scrollTop, 900, "keyboard scrolling also releases the initial anchor");
    await render("preview", "guest-preview");
    assert.equal(callbacks.size, 0, "preview must not acquire an initial bottom anchor");

    // The RPC can resolve well before the separate messages channel renders.
    // A fixed delay must not request page 2 using page 1's stale React state.
    let loads = 0;
    let finishLoad: ((result: boolean) => void) | null = null;
    api.messages = messages.slice(-2);
    api.hasEarlierMessages = true;
    api.isLoadingEarlier = false;
    api.loadEarlierMessages = () => { loads++; return new Promise<boolean>((resolve) => { finishLoad = resolve; }); };
    restoreTranscriptPosition({ version: 1, sessionId: "s3", mode: "reading", anchorId: "m0",
      offset: -20, top: 100, expanded: true, loadedCount: 400 });
    await render("s3");
    assert.equal(loads, 1);
    await act(async () => {
      finishLoad!(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    assert.equal(loads, 1, "wait for the actual messages commit even when it takes longer than 50ms");
    api.messages = messages.slice(-4);
    await render("s3");
    assert.equal(loads, 2, "next page starts only after React receives the previous page");
    await act(async () => { finishLoad!(true); });
    api.messages = messages;
    api.hasEarlierMessages = false;
    await render("s3");
    assert.equal(loads, 2, "stop fetching once the saved anchor is present");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of keys) {
      const descriptor = saved.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
