import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import {
  consumeExplicitScrollRestore,
  captureRegisteredScrollPositions,
  queueExplicitScrollRestore,
  readRouteScrollSnapshot,
  restoreScrollPositions,
  suspendRouteScrollCapture,
  writeRouteScrollSnapshot,
} from "./route-scroll-restoration.js";
import type { HistoryEntryStateStorage } from "./history-entry-state.js";

class MemoryStorage implements HistoryEntryStateStorage {
  private values = new Map<string, string>();

  get length() { return this.values.size; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

test("an overlay cannot save its scroll offset into the underlying route's history", () => {
  const dom = new JSDOM('<div data-scroll-restoration-id="community-main"></div>');
  const win = dom.window;
  win.document.documentElement.setAttribute("data-mobile-page-scroll", "community-main");
  Object.defineProperty(win, "scrollY", { value: 950, configurable: true });
  Object.defineProperty(globalThis, "window", { value: win, configurable: true });
  Object.defineProperty(globalThis, "document", { value: win.document, configurable: true });
  const resume = suspendRouteScrollCapture();
  try {
    Object.defineProperty(win, "scrollY", { value: 300, configurable: true });
    const frozen = captureRegisteredScrollPositions();
    assert.equal(frozen.find((p) => p.selector === "window")?.top, 950);
    assert.equal(frozen.find((p) => p.selector.includes("community-main"))?.top, 950);
    frozen[0]!.top = 0;
    assert.equal(captureRegisteredScrollPositions()[0]!.top, 950, "callers cannot mutate the frozen snapshot");
    resume();
    assert.equal(captureRegisteredScrollPositions()[0]!.top, 300);
  } finally {
    resume();
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
    dom.window.close();
  }
});

test("keeps scroll snapshots isolated by unique router history key", () => {
  const storage = new MemoryStorage();
  writeRouteScrollSnapshot(storage, "entry-a", [
    { selector: "window", top: 250, left: 0 },
    { selector: '[data-scroll-restoration-id="community-main"]', top: 900, left: 2 },
  ]);
  writeRouteScrollSnapshot(storage, "entry-b", [
    { selector: "window", top: 10, left: 0 },
  ]);

  assert.deepEqual(readRouteScrollSnapshot(storage, "entry-a"), [
    { selector: "window", top: 250, left: 0 },
    { selector: '[data-scroll-restoration-id="community-main"]', top: 900, left: 2 },
  ]);
  assert.deepEqual(readRouteScrollSnapshot(storage, "entry-b"), [
    { selector: "window", top: 10, left: 0 },
  ]);
});

test("mobile reading positions survive old snapshots, delayed content, and desktop Back", () => {
  const dom = new JSDOM('<div class="app-shell-root"><div data-scroll-restoration-id="community-main"></div></div>');
  const win = dom.window;
  const doc = win.document;
  const root = doc.documentElement;
  const scroller = doc.querySelector<HTMLElement>("[data-scroll-restoration-id]")!;
  const selector = '[data-scroll-restoration-id="community-main"]';
  Object.defineProperty(win, "innerHeight", { value: 600 });
  Object.defineProperty(root, "scrollHeight", { configurable: true, value: 600 });
  Object.defineProperty(scroller, "clientHeight", { value: 600 });
  Object.defineProperty(scroller, "scrollHeight", { value: 1800 });
  win.scrollTo = (({ top = 0, left = 0 }: ScrollToOptions) => {
    Object.defineProperty(win, "scrollY", { configurable: true, value: top });
    Object.defineProperty(win, "scrollX", { configurable: true, value: left });
  }) as typeof win.scrollTo;
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  try {
    root.setAttribute("data-mobile-page-scroll", "community-main");
    const oldSnapshot = [{ selector: "window", top: 0, left: 0 }, { selector, top: 900, left: 0 }];
    assert.equal(restoreScrollPositions(oldSnapshot), false);
    assert.equal(win.scrollY, 0, "wait for async page content");
    Object.defineProperty(root, "scrollHeight", { configurable: true, value: 1800 });
    assert.equal(restoreScrollPositions(oldSnapshot), true);
    assert.equal(win.scrollY, 900, "legacy nested position takes precedence over old window=0");
    assert.equal(scroller.scrollTop, 0, "never scroll a non-scrolling page wrapper");
    const captured = captureRegisteredScrollPositions();
    assert.equal(captured.find((p) => p.selector === selector)?.top, 900);

    root.removeAttribute("data-mobile-page-scroll");
    Object.defineProperty(root, "scrollHeight", { configurable: true, value: 600 });
    assert.equal(restoreScrollPositions(captured), true);
    assert.equal(win.scrollY, 0, "the desktop shell stays anchored");
    assert.equal(scroller.scrollTop, 900, "desktop Back restores the same reading position");
  } finally {
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
    dom.window.close();
  }
});

test("native Library restores the old mobile shell position instead of its empty wrapper", () => {
  const dom = new JSDOM('<main data-scroll-restoration-id="app-shell-main"><div data-scroll-restoration-id="library-detail"></div></main>');
  const win = dom.window;
  const doc = win.document;
  doc.documentElement.setAttribute("data-mobile-page-scroll", "library-detail");
  Object.defineProperty(win, "innerHeight", { value: 600 });
  Object.defineProperty(doc.documentElement, "scrollHeight", { value: 2400 });
  win.scrollTo = (({ top = 0, left = 0 }: ScrollToOptions) => {
    Object.defineProperty(win, "scrollY", { configurable: true, value: top });
    Object.defineProperty(win, "scrollX", { configurable: true, value: left });
  }) as typeof win.scrollTo;
  Object.defineProperty(globalThis, "window", { configurable: true, value: win });
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  try {
    const oldSnapshot = [
      { selector: "window", top: 0, left: 0 },
      { selector: '[data-scroll-restoration-id="app-shell-main"]', top: 1100, left: 0 },
      { selector: '[data-scroll-restoration-id="library-detail"]', top: 0, left: 0 },
    ];
    assert.equal(restoreScrollPositions(oldSnapshot), true);
    assert.equal(win.scrollY, 1100);
    assert.equal(oldSnapshot[2]!.top, 0, "do not mutate stored history");
    const captured = captureRegisteredScrollPositions();
    assert.equal(captured[2]!.top, 1100);
    win.scrollTo({ top: 0 });
    assert.equal(restoreScrollPositions(captured), true);
    assert.equal(win.scrollY, 1100, "new native snapshots retain the correct named position");
  } finally {
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
    dom.window.close();
  }
});

test("explicit story positions are consumed only by the exact internal URL", () => {
  queueExplicitScrollRestore("/app/community?q=magic#results", [
    { selector: "window", top: 420, left: 0 },
  ]);
  assert.deepEqual(consumeExplicitScrollRestore("/app/library"), []);
  assert.deepEqual(consumeExplicitScrollRestore("/app/community?q=magic#results"), [
    { selector: "window", top: 420, left: 0 },
  ]);
  assert.deepEqual(consumeExplicitScrollRestore("/app/community?q=magic#results"), []);
});

test("waits for async content height instead of clamping the saved position early", () => {
  const testWindow = {
    innerHeight: 600,
    innerWidth: 800,
    scrollX: 0,
    scrollY: 0,
    scrollTo({ top, left }: { top: number; left: number }) {
      this.scrollY = top;
      this.scrollX = left;
    },
  };
  const documentElement = { scrollHeight: 600, scrollWidth: 800 };
  const body = { scrollHeight: 600 };
  const nestedScroller = {
    clientHeight: 200,
    clientWidth: 300,
    scrollHeight: 300,
    scrollWidth: 300,
    scrollLeft: 0,
    scrollTop: 0,
  };
  const testDocument = {
    body,
    documentElement,
    querySelector: (selector: string) => selector === '[data-scroll-restoration-id="feed"]'
      ? nestedScroller
      : null,
  };

  Object.defineProperty(globalThis, "window", { configurable: true, value: testWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: testDocument });
  try {
    const positions = [
      { selector: "window", top: 900, left: 0 },
      { selector: '[data-scroll-restoration-id="feed"]', top: 700, left: 0 },
    ];
    assert.equal(restoreScrollPositions(positions), false);
    assert.equal(testWindow.scrollY, 0);
    assert.equal(nestedScroller.scrollTop, 0);

    documentElement.scrollHeight = 1_600;
    body.scrollHeight = 1_600;
    nestedScroller.scrollHeight = 1_000;
    assert.equal(restoreScrollPositions(positions), true);
    assert.equal(testWindow.scrollY, 900);
    assert.equal(nestedScroller.scrollTop, 700);
  } finally {
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
  }
});
