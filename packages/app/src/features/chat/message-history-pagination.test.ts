import assert from "node:assert/strict";
import test from "node:test";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import {
  executeEarlierHistoryAction,
  getEarlierHistoryAction,
  shouldAutoRequestEarlierHistory,
} from "../../../sandbox/chat/message-history-pagination";
import { makeChatT } from "../../../sandbox/chat/i18n";

test("a Verdant-sized session reveals the local window and fetches the server page together", () => {
  // Production had 239 rows: 200 loaded, 50 mounted, and 39 still on the server.
  assert.equal(getEarlierHistoryAction(200 - 50, true), "reveal-and-load");
});

test("local render window can expand without an unnecessary server request", () => {
  assert.equal(getEarlierHistoryAction(68, false), "reveal-local");
});

test("fully revealed local history still fetches the previous server page", () => {
  assert.equal(getEarlierHistoryAction(0, true), "load-server");
});

test("top-scroll auto loading requires an armed, healthy, idle history action", () => {
  const base = {
    action: "reveal-and-load" as const,
    armed: true,
    failed: false,
    loading: false,
    scrollTop: 40,
  };

  assert.equal(shouldAutoRequestEarlierHistory(base), true);
  assert.equal(shouldAutoRequestEarlierHistory({ ...base, armed: false }), false);
  assert.equal(
    shouldAutoRequestEarlierHistory({ ...base, armed: false, viewportUnderfilled: true }),
    true,
  );
  assert.equal(shouldAutoRequestEarlierHistory({ ...base, failed: true }), false);
  assert.equal(shouldAutoRequestEarlierHistory({ ...base, loading: true }), false);
  assert.equal(shouldAutoRequestEarlierHistory({ ...base, scrollTop: 120 }), false);
  assert.equal(shouldAutoRequestEarlierHistory({ ...base, action: "none" }), false);
});

test("combined history action reveals local rows and waits for the server page", async () => {
  const calls: string[] = [];
  const loaded = await executeEarlierHistoryAction("reveal-and-load", {
    revealLocal: () => calls.push("reveal"),
    loadServer: async () => {
      calls.push("load");
      return true;
    },
  });

  assert.equal(loaded, true);
  assert.deepEqual(calls, ["reveal", "load"]);
});

test("local-only history action does not call the server", async () => {
  let serverCalled = false;
  const loaded = await executeEarlierHistoryAction("reveal-local", {
    revealLocal: () => {},
    loadServer: async () => {
      serverCalled = true;
      return true;
    },
  });

  assert.equal(loaded, true);
  assert.equal(serverCalled, false);
});

test("server failures resolve false so the UI can expose retry", async () => {
  const loaded = await executeEarlierHistoryAction("load-server", {
    revealLocal: () => {},
    loadServer: async () => {
      throw new Error("offline");
    },
  });

  assert.equal(loaded, false);
});

test("history failure feedback is localized in every sandbox language", () => {
  for (const language of ["en", "zh", "ja", "es"]) {
    const message = makeChatT(language)("loadEarlierFailed");
    assert.notEqual(message, "loadEarlierFailed");
    assert.ok(message.length > 8);
  }
});

test("Verdant's nested scroll viewport reveals local history, fetches the server page, and exposes retry", async () => {
  const dom = new JSDOM("<div id=\"root\"></div>", { pretendToBeVisual: true });
  const globalKeys = [
    "window",
    "document",
    "navigator",
    "Element",
    "HTMLElement",
    "Node",
    "MutationObserver",
    "CSS",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "IntersectionObserver",
    "React",
    "IS_REACT_ACT_ENVIRONMENT",
  ] as const;
  const previousDescriptors = new Map(
    globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  const installGlobal = (key: (typeof globalKeys)[number], value: unknown) => {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };

  const css = dom.window.CSS ?? {};
  if (!("escape" in css)) {
    Object.defineProperty(css, "escape", {
      configurable: true,
      value: (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "\\$&"),
    });
  }
  installGlobal("window", dom.window);
  installGlobal("document", dom.window.document);
  installGlobal("navigator", dom.window.navigator);
  installGlobal("Element", dom.window.Element);
  installGlobal("HTMLElement", dom.window.HTMLElement);
  installGlobal("Node", dom.window.Node);
  installGlobal("MutationObserver", dom.window.MutationObserver);
  installGlobal("CSS", css);
  installGlobal("requestAnimationFrame", dom.window.requestAnimationFrame.bind(dom.window));
  installGlobal("cancelAnimationFrame", dom.window.cancelAnimationFrame.bind(dom.window));
  let intersectionCallback: IntersectionObserverCallback | undefined;
  let observedHistoryTarget: Element | undefined;
  let intersectionObserverInstances = 0;
  class TestIntersectionObserver implements IntersectionObserver {
    readonly root = null;
    readonly rootMargin = "0px";
    readonly thresholds = [0];
    constructor(callback: IntersectionObserverCallback) {
      intersectionObserverInstances += 1;
      intersectionCallback = callback;
    }
    disconnect() {}
    observe(target: Element) { observedHistoryTarget = target; }
    takeRecords(): IntersectionObserverEntry[] { return []; }
    unobserve() {}
  }
  installGlobal("IntersectionObserver", TestIntersectionObserver);
  installGlobal("React", React);
  installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value(options: ScrollToOptions) {
      this.scrollTop = typeof options === "object" ? Number(options.top ?? 0) : 0;
    },
  });

  const container = dom.window.document.getElementById("root");
  assert.ok(container);
  const root = createRoot(container);

  try {
    const [{ MessageList }, { YuminaContext, buildAPI }] = await Promise.all([
      import("../../../sandbox/chat/message-list"),
      import("../../../sandbox/sandbox-context"),
    ]);
    const messages = Array.from({ length: 60 }, (_, index) => ({
      id: `m${index + 1}`,
      sessionId: "s1",
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `message ${index + 1}`,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    }));
    let loadCalls = 0;
    let loadServer = async () => true;
    const baseApi = buildAPI({
      variables: {},
      globalVariables: {},
      worldName: "History test",
      worldCover: null,
      worldId: "w1",
      sessionId: "s1",
      currentUser: null,
      user: { name: "Player", avatar: null },
      messages,
      isStreaming: false,
      streamingContent: "",
      mode: "session",
    } as unknown as Parameters<typeof buildAPI>[0]);
    const api = {
      ...baseApi,
      hasEarlierMessages: true,
      isLoadingEarlier: false,
      loadEarlierMessages: async () => {
        loadCalls += 1;
        return loadServer();
      },
    };

    const shortApi = { ...api, messages: messages.slice(-3) };
    await act(async () => {
      root.render(
        createElement(
          YuminaContext.Provider,
          { value: shortApi },
          createElement(
            "div",
            { className: "verdant-scroll", style: { height: "700px", overflowY: "auto" } },
            createElement(MessageList, { rendererComponent: null }),
          ),
        ),
      );
    });

    assert.equal(container.querySelectorAll(".play-message-row").length, 3);
    const outerScroll = container.querySelector<HTMLElement>(".verdant-scroll");
    const messageScroll = container.querySelector<HTMLElement>(".play-message-scroll");
    assert.ok(outerScroll);
    assert.ok(messageScroll);
    messageScroll.style.overflowY = "auto";
    Object.defineProperty(messageScroll, "scrollHeight", { configurable: true, value: 300 });
    Object.defineProperty(messageScroll, "clientHeight", { configurable: true, value: 300 });
    // Verdant's fixed 700px wrapper has 75px of top padding. That layout-only
    // overflow must not make three short messages look like a filled viewport.
    Object.defineProperty(outerScroll, "scrollHeight", { configurable: true, value: 775 });
    Object.defineProperty(outerScroll, "clientHeight", { configurable: true, value: 700 });
    outerScroll.scrollTop = 0;
    assert.ok(intersectionCallback, "history sentinel must be observed independently of the nested scroll owner");
    assert.ok(observedHistoryTarget);

    const intersectionEntry = (isIntersecting: boolean) => ({
      isIntersecting,
      target: observedHistoryTarget,
    }) as IntersectionObserverEntry;

    await act(async () => {
      intersectionCallback?.([intersectionEntry(true)], {} as IntersectionObserver);
      await Promise.resolve();
    });
    assert.equal(
      loadCalls,
      1,
      "a short history must load its previous page even though no scrollbar exists",
    );

    await act(async () => {
      root.render(
        createElement(
          YuminaContext.Provider,
          { value: { ...api, messages: messages.slice(-6) } },
          createElement(
            "div",
            { className: "verdant-scroll", style: { height: "700px", overflowY: "auto" } },
            createElement(MessageList, { rendererComponent: null }),
          ),
        ),
      );
      await Promise.resolve();
    });
    assert.equal(
      loadCalls,
      2,
      "underfilled history must keep paging after the transcript grows",
    );

    Object.defineProperty(messageScroll, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(messageScroll, "clientHeight", { configurable: true, value: 400 });
    outerScroll.scrollTop = 40;
    await act(async () => {
      root.render(
        createElement(
          YuminaContext.Provider,
          { value: api },
          createElement(
            "div",
            { className: "verdant-scroll", style: { height: "700px", overflowY: "auto" } },
            createElement(MessageList, { rendererComponent: null }),
          ),
        ),
      );
    });
    assert.equal(container.querySelectorAll(".play-message-row").length, 50);
    loadServer = async () => false;

    await act(async () => {
      intersectionCallback?.([intersectionEntry(false)], {} as IntersectionObserver);
      intersectionCallback?.([intersectionEntry(true)], {} as IntersectionObserver);
      await Promise.resolve();
    });

    assert.equal(loadCalls, 3);
    assert.equal(container.querySelectorAll(".play-message-row").length, 60);
    const retry = container.querySelector<HTMLButtonElement>("button");
    assert.equal(retry?.textContent, makeChatT("en")("loadEarlierFailed"));

    loadServer = async () => true;
    await act(async () => {
      retry?.click();
      await Promise.resolve();
    });
    assert.equal(loadCalls, 4);
    assert.equal(container.textContent?.includes(makeChatT("en")("loadEarlierFailed")), false);

    let finishStaleLoad: ((loaded: boolean) => void) | undefined;
    loadServer = () => new Promise<boolean>((resolve) => { finishStaleLoad = resolve; });
    const loadAgain = container.querySelector<HTMLButtonElement>("button");
    await act(async () => {
      loadAgain?.click();
      await Promise.resolve();
    });
    assert.equal(container.textContent?.includes(makeChatT("en")("loadingEarlier")), true);

    await act(async () => {
      root.render(
        createElement(
          YuminaContext.Provider,
          { value: { ...api, sessionId: "s2" } },
          createElement(
            "div",
            { className: "verdant-scroll", style: { height: "700px", overflowY: "auto" } },
            createElement(MessageList, { rendererComponent: null }),
          ),
        ),
      );
      await Promise.resolve();
    });
    await act(async () => {
      finishStaleLoad?.(false);
      await Promise.resolve();
    });
    assert.equal(
      intersectionObserverInstances,
      1,
      "live API and session updates must not recreate the viewport observer",
    );
    assert.equal(
      container.textContent?.includes(makeChatT("en")("loadEarlierFailed")),
      false,
      "a stale failure from the previous session must not leak into the new chat",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const key of globalKeys) {
      const descriptor = previousDescriptors.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
