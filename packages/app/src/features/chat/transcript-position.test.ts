import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { trackTranscriptPosition, restoreTranscriptPosition, setTranscriptActive, trackCustomTranscriptPositions } from "../../../sandbox/chat/transcript-position";
import { isScrollIntent } from "../../../sandbox/chat/scroll-intent";

test("resume restores bottom and message anchors, honors input, and cleans up", async () => {
  const dom = new JSDOM('<div id="viewport"><div id="list"><div id="stack"><div data-mid="a"></div><div data-mid="b"></div></div></div></div><textarea></textarea>', { url: "https://example.test" });
  const win = dom.window;
  const previous = new Map(["window", "document", "CustomEvent", "ResizeObserver", "HTMLElement"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: win, document: win.document, CustomEvent: win.CustomEvent, HTMLElement: win.HTMLElement });
  const callbacks = new Set<() => void>();
  class Observer { constructor(public callback: () => void) { callbacks.add(callback); } observe() {} disconnect() { callbacks.delete(this.callback); } }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: Observer });
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  win.requestAnimationFrame = (callback) => { frames.set(++nextId, callback); return nextId; };
  win.cancelAnimationFrame = (id) => { frames.delete(id); };
  const flush = () => { for (let n = 0; frames.size && n < 8; n++) { const batch = [...frames.values()]; frames.clear(); batch.forEach((callback) => callback(0)); } };
  const viewport = win.document.getElementById("viewport")!;
  const list = win.document.getElementById("list")!;
  let height = 2000, top = 1500, hidden = false, shift = 0, expanded = false;
  Object.defineProperties(viewport, { scrollHeight: { get: () => height }, clientHeight: { get: () => 500 }, offsetHeight: { get: () => 500 }, scrollTop: { get: () => top, set: (value) => { top = Math.max(0, Math.min(value, height - 500)); } } });
  Object.defineProperty(win.document, "hidden", { configurable: true, get: () => hidden });
  viewport.getBoundingClientRect = () => ({ top: 0, height: 500 } as DOMRect);
  const [a, b] = list.querySelectorAll<HTMLElement>("[data-mid]");
  a!.getBoundingClientRect = () => ({ top: shift - top, bottom: shift + 1000 - top } as DOMRect);
  b!.getBoundingClientRect = () => ({ top: shift + 1000 - top, bottom: shift + 2000 - top } as DOMRect);
  const tracker = trackTranscriptPosition({ sessionId: "s1", list, viewport: () => viewport,
    setTop: (element, value) => { element.scrollTop = value; }, expanded: () => expanded,
    reveal: (position) => { expanded = position.expanded; }, releaseInitial: () => {},
  });
  const visibility = (value: boolean) => { hidden = value; win.document.dispatchEvent(new win.Event("visibilitychange")); };
  try {
    flush();
    height = 2200;
    viewport.dispatchEvent(new win.Event("scroll")); callbacks.forEach((callback) => callback()); flush();
    visibility(true);
    height = 3000;
    visibility(false); flush();
    assert.equal(top, 2500, "UA scroll/layout before hiding must not overwrite latest intent");
    height = 3500; callbacks.forEach((callback) => callback()); flush();
    assert.equal(top, 3000, "late content layout settles at bottom");

    viewport.dispatchEvent(new win.WheelEvent("wheel", { bubbles: true, deltaY: -1 }));
    top = 1200; viewport.dispatchEvent(new win.Event("scroll")); flush();
    visibility(true); shift = 700; height = 4200; visibility(false); flush();
    assert.equal(top, 1900, "partly clipped message b retains its -200px offset");
    tracker.changed(); flush();
    assert.equal(top, 1900, "same-count refresh retains the reading anchor");

    viewport.dispatchEvent(new win.Event("touchmove", { bubbles: true }));
    top = 1100; viewport.dispatchEvent(new win.Event("scroll")); flush();
    height = 5000; callbacks.forEach((callback) => callback()); flush();
    assert.equal(top, 1100, "user scrolling cancels restore");
    setTranscriptActive(false); top = 0; setTranscriptActive(true); flush();
    assert.equal(top, 1100, "CSS route hide/return uses explicit activation");
    win.document.querySelector("textarea")!.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
    height = 6000; tracker.changed(); flush();
    assert.equal(top, 1100, "new composer interaction cannot revive the old resume policy");
    tracker.stop();
    // Parent may finish its rendered handshake before MessageList mounts.
    restoreTranscriptPosition({ version: 1, sessionId: "s2", mode: "reading", anchorId: "b",
      offset: -200, top: 1200, expanded: true, loadedCount: 400 });
    top = 0; shift = 0;
    const reopened = trackTranscriptPosition({ sessionId: "s2", list, viewport: () => viewport,
      setTop: (element, value) => { element.scrollTop = value; }, expanded: () => expanded,
      reveal: () => {}, releaseInitial: () => {},
    });
    flush();
    assert.equal(top, 1200, "checkpoint arriving before tracker mount restores the saved row");
    restoreTranscriptPosition({ version: 1, sessionId: "old-session", mode: "latest", anchorId: null,
      offset: 0, top: 0, expanded: false, loadedCount: 2 });
    flush();
    assert.equal(top, 1200, "other-session checkpoint cannot move this transcript");
    reopened.stop();
    restoreTranscriptPosition({ version: 1, sessionId: "slow", mode: "reading", anchorId: "missing",
      offset: 0, top: 800, expanded: true, loadedCount: 400 });
    const pending: { finish: () => void; signal: AbortSignal }[] = [];
    const slow = trackTranscriptPosition({ sessionId: "slow", list, viewport: () => viewport,
      setTop: (element, value) => { element.scrollTop = value; }, expanded: () => true,
      reveal: (_position, signal) => new Promise<void>((finish) => { pending.push({ finish, signal }); }),
      releaseInitial: () => {},
    });
    flush();
    win.document.querySelector("textarea")!.dispatchEvent(new win.Event("pointerdown", { bubbles: true }));
    assert.equal(pending[0]!.signal.aborted, true);
    visibility(true); visibility(false); flush();
    assert.equal(pending.length, 2, "a new resume starts its own history request after cancellation");
    top = 100;
    pending[0]!.finish(); await Promise.resolve(); await Promise.resolve(); flush();
    assert.equal(top, 100, "the old request cannot complete the new restoration");
    pending[1]!.finish(); await Promise.resolve(); await Promise.resolve(); flush();
    assert.equal(top, 800, "an unavailable anchor falls back only after its own history request finishes");
    slow.stop();
    const stopCustom = trackCustomTranscriptPositions("custom", (element, value) => { element.scrollTop = value; });
    top = height - 500;
    viewport.dispatchEvent(new win.Event("scroll")); flush();
    visibility(true); height = 7000; visibility(false); flush();
    assert.equal(top, 6500, "handwritten interfaces restore the actual observed scroller on warm resume");
    stopCustom();
  } finally {
    tracker.stop();
    assert.equal(callbacks.size, 0);
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("history restoration fetches a missing checkpoint anchor and stops on cancellation/session change", async () => {
  const { restoreTranscriptHistory } = await import("../../../sandbox/chat/restore-transcript-history");
  const position = { version: 1 as const, sessionId: "s1", mode: "reading" as const,
    anchorId: "m100", offset: -20, top: 1000, expanded: true, loadedCount: 400 };
  let current = { sessionId: "s1", messages: [{ id: "m300" }], hasEarlierMessages: true, isLoadingEarlier: false };
  let calls = 0;
  await restoreTranscriptHistory(position, new AbortController().signal, {
    current: () => current,
    load: async () => { calls++; current = { ...current, messages: [{ id: "m100" }, ...current.messages] }; return true; },
    committed: async () => {},
  });
  assert.equal(calls, 1);
  current = { ...current, sessionId: "s2", messages: [] };
  await restoreTranscriptHistory(position, new AbortController().signal, { current: () => current, load: async () => { calls++; return true; }, committed: async () => {} });
  assert.equal(calls, 1);
  current = { ...current, sessionId: "s1" };
  const abort = new AbortController();
  await restoreTranscriptHistory(position, abort.signal, { current: () => current,
    load: async () => { calls++; abort.abort(); return true; }, committed: async () => {},
  });
  assert.equal(calls, 2);
});

test("scroll guard ignores UA/smooth scroll events and text editing, but detects reader input", () => {
  const dom = new JSDOM('<div id="viewport" tabindex="0"></div><textarea></textarea>');
  const win = dom.window;
  assert.equal(isScrollIntent(new win.Event("scroll")), false);
  assert.equal(isScrollIntent(new win.Event("scroll")), false);
  assert.equal(isScrollIntent(new win.WheelEvent("wheel", { deltaY: 0 })), false);
  assert.equal(isScrollIntent(new win.WheelEvent("wheel", { deltaY: -20 })), true);
  assert.equal(isScrollIntent(new win.Event("touchmove")), true);
  let intent = true;
  win.document.addEventListener("keydown", (event) => { intent = isScrollIntent(event); });
  win.document.querySelector("textarea")!.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, key: "Home" }));
  assert.equal(intent, false);
  win.document.getElementById("viewport")!.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, key: "PageUp" }));
  assert.equal(intent, true);
  dom.window.close();
});
