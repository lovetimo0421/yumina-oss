import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

test("reader switches without remounting messages, themes portals, and leaves custom chat alone", async (t) => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://yumina.test", pretendToBeVisual: true });
  const keys = ["window", "document", "navigator", "localStorage", "Element", "HTMLElement", "Node", "MutationObserver", "CustomEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "React", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const saved = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const key of keys) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true,
      value: key === "React" ? React : key === "IS_REACT_ACT_ENVIRONMENT" ? true : (dom.window as unknown as Record<string, unknown>)[key] });
  }
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  const container = document.getElementById("root")!;
  const root = createRoot(container);
  try {
    const [{ Chat }, { YuminaContext, buildAPI }, { SandboxPlatformOverlay }, { useUiStore }, { ReadingAppearanceSettings }] = await Promise.all([
      import("../../../sandbox/building-blocks/chat"), import("../../../sandbox/sandbox-context"),
      import("../../../sandbox/platform-overlay-portal"), import("../../stores/ui"),
      import("../settings/reading-appearance-settings"),
    ]);
    const api = buildAPI({ variables: {}, globalVariables: {}, worldName: "Reader", worldCover: null,
      worldId: "world", sessionId: "session", currentUser: null, user: { name: "Reader", avatar: null },
      messages: [], isStreaming: false, streamingContent: "", mode: "guest-preview",
    } as unknown as Parameters<typeof buildAPI>[0]);
    const render = async (props: React.ComponentProps<typeof Chat> = {}) => act(async () => {
      root.render(createElement(YuminaContext.Provider, { value: {
        ...api, messageButtonColor: useUiStore.getState().messageButtonColors.second ?? "default",
        playColorMode: useUiStore.getState().playColorMode,
        setPlayColorMode: useUiStore.getState().setPlayColorMode,
        greetingContent: "A quiet afternoon.",
      } }, createElement(React.Fragment, null,
        createElement("aside", null, createElement(ReadingAppearanceSettings, { labels: { title: "Play appearance", dark: "Dark", light: "Light" } })),
        createElement("main", null, createElement(Chat, props)))));
    });
    await render();
    assert.equal(container.querySelector('[data-play-color-mode]')?.getAttribute("data-play-color-mode"), "dark");
    assert.equal(container.querySelector("main [aria-label=\"Play appearance\"]"), null);
    assert.equal(container.querySelector(".play-reading-toolbar"), null);
    const transcript = container.querySelector(".play-message-scroll")!;
    assert.ok(transcript);
    transcript.scrollTop = 42;
    const light = [...container.querySelectorAll("button")].find((b) => b.textContent === "Light")!;
    await act(async () => light.click());
    await render();
    assert.equal(container.querySelector(".play-message-scroll"), transcript);
    assert.equal(transcript.scrollTop, 42);
    assert.equal(light.getAttribute("aria-pressed"), "true");
    assert.equal(JSON.parse(localStorage.getItem("yumina-ui")!).state.playColorMode, "light");

    const setButtonColor = useUiStore.getState().setMessageButtonColor;
    setButtonColor("first", "darker");
    setButtonColor("second", "lighter");
    const savedPreferences = localStorage.getItem("yumina-ui")!;
    useUiStore.setState({ messageButtonColors: {} });
    localStorage.setItem("yumina-ui", savedPreferences);
    await useUiStore.persist.rehydrate();
    assert.deepEqual(useUiStore.getState().messageButtonColors, { first: "darker", second: "lighter" });
    setButtonColor("first", "default");
    assert.deepEqual(JSON.parse(localStorage.getItem("yumina-ui")!).state.messageButtonColors, { second: "lighter" });

    // Reload hydration and invalid/legacy stored values have safe defaults.
    await act(async () => useUiStore.setState({ playColorMode: "dark" }, false));
    localStorage.setItem("yumina-ui", JSON.stringify({ state: { playColorMode: "light" }, version: 0 }));
    await act(async () => { await useUiStore.persist.rehydrate(); });
    assert.equal(useUiStore.getState().playColorMode, "light");

    await render({ appearance: "reader", children: createElement(SandboxPlatformOverlay, null, "Dialog") });
    const shadow = document.querySelector("[data-yumina-platform-overlay-host]")!.shadowRoot!;
    assert.equal(shadow.querySelector(".play-reader-surface")?.getAttribute("data-play-color-mode"), "light");
    assert.equal(shadow.querySelector(".play-reader-surface")?.getAttribute("data-message-button-color"), null);
    await render({ className: "creator-theme" });
    assert.equal(container.querySelector("[data-play-color-mode]"), null);
    assert.equal(container.querySelector('main [aria-label="Play appearance"]'), null);
    await render({ renderBubble: () => createElement("p", null, "Creator bubble") });
    assert.equal(container.querySelector("[data-play-color-mode]"), null);

    // A palette change must refresh any inline contrast repairs from dark mode.
    const { useComposerGuard } = await import("../../../sandbox/chat/composer-guard");
    const frames: FrameRequestCallback[] = [];
    let now = 1000;
    t.mock.method(performance, "now", () => now);
    Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; } });
    Object.defineProperty(globalThis, "getComputedStyle", { configurable: true, value: (el: Element) => dom.window.getComputedStyle(el) });
    function GuardFixture() {
      const card = React.useRef<HTMLDivElement>(null);
      const input = React.useRef<HTMLTextAreaElement>(null);
      useComposerGuard(card, input, true);
      return <div data-play-color-mode="dark"><div ref={card}><textarea ref={input} /></div></div>;
    }
    await act(async () => root.render(createElement(GuardFixture)));
    assert.equal(frames.length, 1);
    frames[0]!(now);
    now += 1000;
    await act(async () => container.firstElementChild!.setAttribute("data-play-color-mode", "light"));
    assert.equal(frames.length, 2, "changing reading mode schedules a fresh composer contrast pass");

    for (const value of [undefined, "invalid"]) {
      localStorage.setItem("yumina-ui", JSON.stringify({ state: { playColorMode: value }, version: 0 }));
      await act(async () => { await useUiStore.persist.rehydrate(); });
      assert.equal(useUiStore.getState().playColorMode, "dark");
    }
  } finally {
    await act(async () => root.unmount());
    for (const key of keys) {
      const descriptor = saved.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
});

test("light reader text and gold controls meet normal-text contrast", () => {
  const css = readFileSync(new URL("../../styles/play-reading-appearance.css", import.meta.url), "utf8");
  const tokens = Object.fromEntries([...css.matchAll(/--color-([\w-]+): (#[\da-f]{6});/g)].map((m) => [m[1], m[2]]));
  const luminance = (hex: string) => {
    const values = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
  };
  // Effective paper surfaces under the snippet panel and red delete-button tints.
  Object.assign(tokens, { "snippet-paper": "#c3c1bd", "delete-paper": "#cbaba9", "delete-hover-paper": "#d19c9b" });
  for (const [ink, paper] of [["foreground", "background"], ["muted-foreground", "card"], ["primary", "background"], ["primary-foreground", "primary"], ["play-danger", "play-memory"], ["play-error", "play-memory"], ["play-danger", "snippet-paper"], ["play-danger", "delete-paper"], ["play-danger", "delete-hover-paper"]]) {
    const a = luminance(tokens[ink!]!); const b = luminance(tokens[paper!]!);
    assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, `${ink} on ${paper}`);
  }
});

test("the chosen ink targets edit labels, shortcut keys and icons while leaving story content alone", () => {
  const css = readFileSync(new URL("../../styles/play-reading-appearance.css", import.meta.url), "utf8");
  const dom = new JSDOM(`<style>${css}</style><main>
    <button>Save <kbd>Ctrl+Enter</kbd><svg></svg></button>
    <p class="play-message-role">Narrator</p><textarea class="play-message-editor">Editing</textarea><textarea>Composer</textarea>
    <div data-story-content><p>Story</p><button>Story markup</button></div>
    <div class="play-custom-component-shell"><button>Creator action</button></div>
  </main>`);
  try {
    const { document } = dom.window;
    const rules = Array.from(document.styleSheets[0]!.cssRules) as CSSStyleRule[];
    const ink = rules.find(rule => rule.style?.getPropertyValue("color") === "var(--play-control-ink)")!;
    const main = document.querySelector("main")!;
    for (const color of ["lighter", "darker", "default"]) {
      main.dataset.messageButtonColor = color;
      const editorRule = rules.find(rule => rule.selectorText?.includes("textarea.play-message-editor"))!;
      assert.equal(main.querySelectorAll(editorRule.selectorText).length, color === "default" ? 0 : 1);
      for (const prop of ["color", "-webkit-text-fill-color", "caret-color"]) {
        assert.equal(editorRule.style.getPropertyValue(prop), "var(--play-control-ink)");
      }
      assert.equal(editorRule.style.getPropertyValue("background"), "");
      assert.deepEqual(Array.from(main.querySelectorAll(ink.selectorText), el => el.tagName.toLowerCase()),
        color === "default" ? [] : ["button", "kbd", "svg", "p"]);
    }
  } finally { dom.window.close(); }
});
