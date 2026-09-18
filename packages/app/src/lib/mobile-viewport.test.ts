import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";
import { calculateSoftKeyboardInset, hasTextEntryFocus } from "./mobile-viewport";
import * as mobileViewport from "./mobile-viewport";

const topBarSource = readFileSync(
  new URL("../components/layout/top-bar.tsx", import.meta.url),
  "utf8",
);

test("mobile shell sizing uses the viewport once and native pages fill its minimum height", () => {
  const css = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8");
  assert.ok(css.includes("height: var(--mobile-vh)"));
  assert.ok(css.includes("min-height: var(--mobile-vh)"));
  assert.equal(css.includes("height: calc(100dvh - var(--keyboard-inset, 0px))"), false);
});

test("Home Screen sizing fills the idle window and recovers after keyboard, resume, and rotation", (t) => {
  const h = viewportHarness(t, undefined, true, true);
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "844px");
  const input = h.win.document.querySelector("input")!;
  input.focus();
  h.vv.height = 500;
  h.vv.dispatchEvent(new h.win.Event("resize"));
  h.frame();
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "500px");
  input.blur();
  h.frame();
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "844px");
  h.height(393);
  h.vv.height = 393;
  h.win.dispatchEvent(new h.win.Event("orientationchange"));
  h.settle();
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "393px");
  h.visibility("hidden");
  h.height(852);
  h.vv.height = 793;
  h.visibility("visible");
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "852px");
  h.vv.scale = 2;
  h.height(426);
  h.vv.dispatchEvent(new h.win.Event("resize"));
  h.frame();
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "852px");
  h.vv.scale = 1;
  h.height(852);
  h.displayMode.matches = false;
  h.displayMode.dispatchEvent(new h.win.Event("change"));
  h.frame();
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "");
  Object.defineProperty(h.win.navigator, "standalone", { value: true });
  h.win.dispatchEvent(new h.win.Event("pageshow"));
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "852px");
  h.cleanup();
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "");
  h.displayMode.dispatchEvent(new h.win.Event("change"));
  assert.equal(h.frames.size, 0);
});

test("Home Screen native reading pages fill the window without following keyboard panning", (t) => {
  const h = viewportHarness(t, "community-main", false, true);
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "844px");
  h.win.document.querySelector("input")!.focus();
  h.vv.height = 500;
  h.vv.offsetTop = 60;
  h.vv.dispatchEvent(new h.win.Event("resize"));
  h.frame();
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "844px");
  assert.equal(h.root.style.getPropertyValue("--mobile-viewport-top"), "");
  assert.equal(h.root.style.getPropertyValue("--keyboard-inset"), "0px");
});
test("browser chrome expansion is not mistaken for the soft keyboard", () => {
  assert.equal(
    calculateSoftKeyboardInset({
      layoutHeight: 844,
      visualHeight: 719,
      visualOffsetTop: 0,
      safeAreaBottom: 0,
      scale: 1,
      hasTextEntryFocus: true,
    }),
    0,
  );
});

test("a real keyboard still shortens the shell while a text field is focused", () => {
  assert.equal(
    calculateSoftKeyboardInset({
      layoutHeight: 844,
      visualHeight: 524,
      visualOffsetTop: 0,
      safeAreaBottom: 0,
      scale: 1,
      hasTextEntryFocus: true,
    }),
    320,
  );
});

test("keyboard subtraction uses the CSS viewport, not a larger standalone innerHeight", () => {
  const measurement = {
    layoutHeight: 844,
    cssViewportHeight: 780,
    visualHeight: 524,
    visualOffsetTop: 0,
    safeAreaBottom: 34,
    scale: 1,
    hasTextEntryFocus: true,
  };
  const inset = calculateSoftKeyboardInset(measurement);
  assert.equal(measurement.cssViewportHeight - inset, 524);

  // A browser that already shrinks dvh must not lose the keyboard height twice.
  assert.equal(calculateSoftKeyboardInset({ ...measurement, cssViewportHeight: 524 }), 0);
  assert.equal(calculateSoftKeyboardInset({ ...measurement, visualOffsetTop: 40 }), 216);
});

test("a retained home-indicator inset cannot leave the composer behind the keyboard", () => {
  assert.equal(calculateSoftKeyboardInset({
    layoutHeight: 844,
    visualHeight: 524,
    visualOffsetTop: 0,
    safeAreaBottom: 34,
    scale: 1,
    hasTextEntryFocus: true,
  }), 320);
});

test("closing the standalone keyboard restores the full CSS viewport", () => {
  assert.equal(calculateSoftKeyboardInset({
    layoutHeight: 844,
    cssViewportHeight: 844,
    visualHeight: 810,
    visualOffsetTop: 0,
    safeAreaBottom: 34,
    scale: 1,
    hasTextEntryFocus: true,
  }), 0);
});

test("viewport changes without a text-entry focus never create a keyboard inset", () => {
  assert.equal(
    calculateSoftKeyboardInset({
      layoutHeight: 844,
      visualHeight: 524,
      visualOffsetTop: 0,
      safeAreaBottom: 0,
      scale: 1,
      hasTextEntryFocus: false,
    }),
    0,
  );
});

test("page zoom and invalid viewport measurements never create a keyboard inset", () => {
  const keyboardSizedViewport = {
    layoutHeight: 844,
    visualHeight: 524,
    visualOffsetTop: 0,
    safeAreaBottom: 0,
    hasTextEntryFocus: true,
  };

  assert.equal(calculateSoftKeyboardInset({ ...keyboardSizedViewport, scale: 1.25 }), 0);
  assert.equal(
    calculateSoftKeyboardInset({
      ...keyboardSizedViewport,
      layoutHeight: Number.NaN,
      scale: 1,
    }),
    0,
  );
  assert.equal(
    calculateSoftKeyboardInset({
      ...keyboardSizedViewport,
      visualHeight: keyboardSizedViewport.layoutHeight,
      scale: 1,
    }),
    0,
  );
});

test("phone landscape keeps browser chrome below the keyboard threshold", () => {
  assert.equal(
    calculateSoftKeyboardInset({
      layoutHeight: 390,
      visualHeight: 290,
      visualOffsetTop: 0,
      safeAreaBottom: 0,
      scale: 1,
      hasTextEntryFocus: true,
    }),
    0,
  );
  assert.equal(
    calculateSoftKeyboardInset({
      layoutHeight: 390,
      visualHeight: 200,
      visualOffsetTop: 0,
      safeAreaBottom: 0,
      scale: 1,
      hasTextEntryFocus: true,
    }),
    190,
  );
});

test("text inputs and sandbox iframes can own a soft keyboard, buttons cannot", () => {
  const dom = new JSDOM(`
    <input id="search" type="search">
    <input id="readonly" readonly>
    <input id="disabled" disabled>
    <textarea id="textarea"></textarea>
    <button id="button">Menu</button>
    <div id="editable"></div>
    <iframe id="sandbox"></iframe>
  `);
  const document = dom.window.document;
  const editable = document.querySelector("#editable");
  Object.defineProperty(editable, "isContentEditable", { value: true });

  assert.equal(hasTextEntryFocus(document.querySelector("#search")), true);
  assert.equal(hasTextEntryFocus(document.querySelector("#readonly")), false);
  assert.equal(hasTextEntryFocus(document.querySelector("#disabled")), false);
  assert.equal(hasTextEntryFocus(document.querySelector("#textarea")), true);
  assert.equal(hasTextEntryFocus(document.querySelector("#button")), false);
  assert.equal(hasTextEntryFocus(editable), true);
  assert.equal(hasTextEntryFocus(document.querySelector("#sandbox")), true);
});

test("the mobile navigation trigger replaces the native touch focus outline", () => {
  assert.match(
    topBarSource,
    /data-mobile-nav-trigger[\s\S]*?className="[^"]*focus:outline-none[^"]*focus-visible:ring-2[^"]*"/,
  );
});

function viewportHarness(t: test.TestContext, pageScrollId?: import("./mobile-reading-route").MobileReadingPageId, messageCanvas = false, standalone = false) {
  const dom = new JSDOM('<input id="input"><div id="feed"></div>', { pretendToBeVisual: true });
  const win = dom.window;
  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, () => void>();
  let nextId = 0;
  win.requestAnimationFrame = (callback) => { frames.set(++nextId, callback); return nextId; };
  win.cancelAnimationFrame = (id) => { frames.delete(id); };
  win.setTimeout = ((callback: () => void) => { timers.set(++nextId, callback); return nextId; }) as typeof win.setTimeout;
  win.clearTimeout = (id) => { if (id !== undefined) timers.delete(id); };
  const vv = Object.assign(new win.EventTarget(), { height: 719, offsetTop: 0, scale: 1 });
  Object.defineProperty(win, "visualViewport", { value: vv });
  Object.defineProperty(win, "innerHeight", { value: 844, writable: true });
  const mobileQuery = Object.assign(new win.EventTarget(), { matches: true });
  const displayMode = Object.assign(new win.EventTarget(), { matches: standalone });
  win.matchMedia = ((query: string) => query.includes("display-mode") ? displayMode : mobileQuery) as unknown as typeof win.matchMedia;
  const root = win.document.documentElement;
  t.after(() => dom.window.close());
  assert.equal(typeof mobileViewport.installMobileViewport, "function", "the shell must install lifecycle-aware viewport recovery");
  const recoveries: mobileViewport.ViewportRecovery[] = [];
  const cleanup = mobileViewport.installMobileViewport(win as unknown as Window, (recovery) => recoveries.push(recovery), pageScrollId, messageCanvas);
  t.after(cleanup);
  return {
    win, vv, root, cleanup, frames, timers, recoveries, mobileQuery, displayMode,
    height(value: number) { Object.defineProperty(win, "innerHeight", { value, writable: true }); },
    frame() {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(0));
    },
    settle() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((callback) => callback());
      this.frame();
    },
    visibility(state: "hidden" | "visible") {
      Object.defineProperty(win.document, "visibilityState", { configurable: true, value: state });
      win.document.dispatchEvent(new win.Event("visibilitychange"));
    },
  };
}

test("DM conversations paint mobile browser edges without becoming a document scroller", (t) => {
  const h = viewportHarness(t, undefined, true);
  assert.ok(h.root.hasAttribute("data-mobile-message-canvas"));
  assert.ok(!h.root.hasAttribute("data-mobile-page-scroll"));
  (h.win.document.querySelector("input") as HTMLInputElement).focus();
  h.vv.height = 524;
  h.vv.dispatchEvent(new h.win.Event("resize"));
  h.frame();
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "524px");
  h.mobileQuery.matches = false;
  h.mobileQuery.dispatchEvent(new h.win.Event("change"));
  assert.ok(!h.root.hasAttribute("data-mobile-message-canvas"));
  h.mobileQuery.matches = true;
  h.mobileQuery.dispatchEvent(new h.win.Event("change"));
  assert.ok(h.root.hasAttribute("data-mobile-message-canvas"));
  h.cleanup();
  assert.ok(!h.root.hasAttribute("data-mobile-message-canvas"));
});

test("idle shell uses native CSS sizing and a focused field uses the visible viewport", (t) => {
  const h = viewportHarness(t);
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "");
  (h.win.document.querySelector("input") as HTMLInputElement).focus();
  h.vv.height = 524;
  h.vv.dispatchEvent(new h.win.Event("resize"));
  h.frame();
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "524px");
  assert.equal(h.root.style.getPropertyValue("--keyboard-inset"), "320px");
});

test("resume remeasures the shell even without a resize event and preserves feed position", (t) => {
  const h = viewportHarness(t);
  const feed = h.win.document.querySelector("#feed")!;
  feed.scrollTop = 350;
  h.visibility("hidden");
  h.height(900);
  h.visibility("visible");
  h.frame();
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "");
  assert.equal(feed.scrollTop, 350);
  // iOS can publish its final measurement after pageshow without another resize.
  h.win.dispatchEvent(new h.win.Event("pageshow"));
  h.frame();
  h.height(880);
  h.settle();
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "");
});

test("focus loss clears a stale keyboard inset even when the browser skips resize", (t) => {
  const h = viewportHarness(t);
  const input = h.win.document.querySelector("input")!;
  input.focus();
  h.vv.height = 524;
  h.vv.dispatchEvent(new h.win.Event("resize"));
  h.frame();
  input.blur();
  h.frame();
  assert.equal(h.root.style.getPropertyValue("--keyboard-inset"), "0px");
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "");
});

test("viewport events coalesce and background/zoom measurements cannot crop the shell", (t) => {
  const h = viewportHarness(t);
  for (let i = 0; i < 10; i++) h.vv.dispatchEvent(new h.win.Event("scroll"));
  assert.equal(h.frames.size, 1);
  h.visibility("hidden");
  assert.equal(h.frames.size, 0);
  h.height(0);
  h.vv.height = 0;
  h.win.dispatchEvent(new h.win.Event("resize"));
  h.frame();
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "");
  h.height(844);
  h.vv.height = 400;
  h.vv.scale = 2;
  h.visibility("visible");
  h.frame();
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "");
  h.cleanup();
  assert.equal(h.frames.size, 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "");
  h.win.dispatchEvent(new h.win.Event("pageshow"));
  assert.equal(h.frames.size, 0);
});

test("resume restores an accidentally scrolled outer shell without moving the feed", (t) => {
  const h = viewportHarness(t);
  h.win.document.body.insertAdjacentHTML("beforeend", '<div class="app-shell-root"></div>');
  const shell = h.win.document.querySelector(".app-shell-root")!;
  const feed = h.win.document.querySelector("#feed")!;
  shell.scrollTop = 100;
  h.root.scrollTop = 100;
  feed.scrollTop = 600;
  h.win.dispatchEvent(new h.win.Event("pageshow"));
  h.frame();
  h.frame();
  assert.equal(shell.scrollTop, 0);
  assert.equal(h.root.scrollTop, 0);
  assert.equal(feed.scrollTop, 600);
});

test("outer scroll recovery leaves active typing and touch gestures alone", (t) => {
  const h = viewportHarness(t);
  h.root.scrollTop = 100;
  h.win.document.querySelector("input")!.focus();
  h.win.dispatchEvent(new h.win.Event("pageshow"));
  h.frame();
  h.frame();
  assert.equal(h.root.scrollTop, 100);
  h.win.document.querySelector("input")!.blur();
  h.win.dispatchEvent(new h.win.Event("touchstart"));
  h.frame();
  h.frame();
  assert.equal(h.root.scrollTop, 100);
});

test("a late outer scroll is repaired without a resume event and records the correction", (t) => {
  const h = viewportHarness(t);
  h.root.scrollTop = 110;
  h.root.dispatchEvent(new h.win.Event("scroll"));
  h.frame();
  h.frame();
  assert.equal(h.root.scrollTop, 0);
  assert.ok(h.recoveries.some((recovery) =>
    "reason" in recovery && recovery.reason === "outer_scroll" &&
    "previousScrollTop" in recovery && recovery.previousScrollTop === 110));
});

test("outer scroll during a touch waits until release while feed scroll schedules no work", (t) => {
  const h = viewportHarness(t);
  const feed = h.win.document.querySelector("#feed")!;
  feed.scrollTop = 600;
  feed.dispatchEvent(new h.win.Event("scroll"));
  assert.equal(h.frames.size, 0);
  h.win.dispatchEvent(new h.win.Event("touchstart"));
  h.root.scrollTop = 110;
  h.root.dispatchEvent(new h.win.Event("scroll"));
  h.frame();
  h.frame();
  assert.equal(h.root.scrollTop, 110);
  h.win.dispatchEvent(new h.win.Event("touchend"));
  h.frame();
  h.frame();
  assert.equal(h.root.scrollTop, 0);
  assert.equal(feed.scrollTop, 600);
});

test("outer scroll recovery skips moving offsets and zoom, and detaches on cleanup", (t) => {
  const h = viewportHarness(t);
  h.root.scrollTop = 100;
  h.root.dispatchEvent(new h.win.Event("scroll"));
  h.frame();
  h.root.scrollTop = 120;
  h.frame();
  assert.equal(h.root.scrollTop, 120);
  h.vv.scale = 2;
  h.root.dispatchEvent(new h.win.Event("scroll"));
  h.frame();
  h.frame();
  assert.equal(h.root.scrollTop, 120);
  h.cleanup();
  h.root.dispatchEvent(new h.win.Event("scroll"));
  assert.equal(h.frames.size, 0);
});

test("keyboard panning changes shell position, never its visible height", (t) => {
  const h = viewportHarness(t);
  h.win.document.querySelector("input")!.focus();
  h.vv.height = 340;
  h.vv.offsetTop = 190;
  h.vv.dispatchEvent(new h.win.Event("resize"));
  h.frame();
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "340px");
  assert.equal(h.root.style.getPropertyValue("--mobile-viewport-top"), "190px");
  h.vv.offsetTop = 250;
  h.vv.dispatchEvent(new h.win.Event("scroll"));
  h.frame();
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "340px");
  assert.equal(h.root.style.getPropertyValue("--mobile-viewport-top"), "250px");
});

test("backgrounding clears keyboard-sized geometry before the next resume paint", (t) => {
  const h = viewportHarness(t);
  h.win.document.querySelector("input")!.focus();
  h.vv.height = 340;
  h.vv.offsetTop = 80;
  h.vv.dispatchEvent(new h.win.Event("resize"));
  h.frame();
  h.visibility("hidden");
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "");
  assert.equal(h.root.style.getPropertyValue("--mobile-viewport-top"), "");
  assert.equal(h.root.style.getPropertyValue("--keyboard-inset"), "0px");
});

test("resume repairs a stale document scroll before animation frames or timers", (t) => {
  const h = viewportHarness(t);
  h.visibility("hidden");
  h.root.scrollTop = 100;
  h.visibility("visible");
  assert.equal(h.root.scrollTop, 0);
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "");
});

test("community reply stays visible as the keyboard opens without scrolling the document", (t) => {
  const h = viewportHarness(t);
  h.win.document.body.insertAdjacentHTML("beforeend", '<div data-keyboard-scroll><textarea>unsent reply</textarea></div>');
  const scroller = h.win.document.querySelector<HTMLElement>("[data-keyboard-scroll]")!;
  const textarea = scroller.querySelector("textarea")!;
  // Geometry after keyboard resize: reply was visible in the old 719px view,
  // but now lies below the bottom of its 340px scrollport.
  scroller.getBoundingClientRect = () => ({ top: 72, bottom: 340 } as DOMRect);
  textarea.getBoundingClientRect = () => ({ top: 480, bottom: 560, height: 80 } as DOMRect);
  scroller.scrollTop = 600;
  textarea.focus();
  h.vv.height = 340;
  h.vv.dispatchEvent(new h.win.Event("resize"));
  h.frame();
  assert.equal(scroller.scrollTop, 832);
  assert.equal(h.root.scrollTop, 0);
  assert.equal(h.win.document.activeElement, textarea);
  assert.equal(textarea.value, "unsent reply");
  // A normal scroll with an open keyboard must leave the reader in control.
  scroller.scrollTop = 700;
  h.vv.dispatchEvent(new h.win.Event("scroll"));
  h.frame();
  assert.equal(scroller.scrollTop, 700);
});

test("community focus reveal waits for touch release instead of losing the pending adjustment", (t) => {
  const h = viewportHarness(t);
  h.win.document.body.insertAdjacentHTML("beforeend", '<div data-keyboard-scroll><textarea></textarea></div>');
  const scroller = h.win.document.querySelector<HTMLElement>("[data-keyboard-scroll]")!;
  const textarea = scroller.querySelector("textarea")!;
  scroller.getBoundingClientRect = () => ({ top: 72, bottom: 340 } as DOMRect);
  textarea.getBoundingClientRect = () => ({ top: 480, bottom: 560, height: 80 } as DOMRect);
  h.win.dispatchEvent(new h.win.Event("touchstart"));
  textarea.focus();
  h.vv.height = 340;
  h.vv.dispatchEvent(new h.win.Event("resize"));
  h.frame();
  assert.equal(scroller.scrollTop, 0);
  h.win.dispatchEvent(new h.win.Event("touchend"));
  h.frame();
  assert.equal(scroller.scrollTop, 232);
});

test("a large community editor already spanning the scrollport keeps its caret scroll", (t) => {
  const h = viewportHarness(t);
  h.win.document.body.insertAdjacentHTML("beforeend", '<div data-keyboard-scroll><textarea></textarea></div>');
  const scroller = h.win.document.querySelector<HTMLElement>("[data-keyboard-scroll]")!;
  const textarea = scroller.querySelector("textarea")!;
  scroller.getBoundingClientRect = () => ({ top: 72, bottom: 340 } as DOMRect);
  textarea.getBoundingClientRect = () => ({ top: -100, bottom: 600, height: 700 } as DOMRect);
  scroller.scrollTop = 500;
  textarea.focus();
  h.vv.height = 340;
  h.vv.dispatchEvent(new h.win.Event("resize"));
  h.frame();
  assert.equal(scroller.scrollTop, 500);
});

test("keyboard dismissal and orientation changes update focus geometry without double subtraction", (t) => {
  const h = viewportHarness(t);
  h.win.document.querySelector("input")!.focus();
  h.vv.height = 340;
  h.vv.offsetTop = 80;
  h.vv.dispatchEvent(new h.win.Event("resize"));
  h.frame();
  // Android resizes both viewports; iOS may retain input focus after dismissal.
  h.height(390);
  h.vv.height = 200;
  h.vv.offsetTop = 0;
  h.win.dispatchEvent(new h.win.Event("orientationchange"));
  h.frame();
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "200px");
  h.height(844);
  h.vv.height = 719;
  h.vv.dispatchEvent(new h.win.Event("resize"));
  h.frame();
  assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "719px");
  assert.equal(h.root.style.getPropertyValue("--keyboard-inset"), "0px");
  assert.equal(h.root.style.getPropertyValue("--mobile-viewport-top"), "0px");
  h.cleanup();
  assert.equal(h.root.hasAttribute("data-mobile-viewport"), false);
  assert.equal(h.root.style.getPropertyValue("--mobile-viewport-top"), "");
});

test("native mobile pages never chase keyboard geometry or reset reading position on resume", (t) => {
  const h = viewportHarness(t, "community-main");
  assert.equal(h.root.getAttribute("data-mobile-page-scroll"), "community-main");
  h.root.scrollTop = 650;
  h.win.document.querySelector<HTMLInputElement>("#input")!.focus();
  for (const [height, top] of [[560, 60], [430, 180], [340, 240], [500, 120], [719, 0]]) {
    h.vv.height = height!;
    h.vv.offsetTop = top!;
    h.vv.dispatchEvent(new h.win.Event("resize"));
    h.frame();
    assert.equal(h.root.style.getPropertyValue("--mobile-vh"), "");
    assert.equal(h.root.style.getPropertyValue("--mobile-viewport-top"), "");
    assert.equal(h.root.scrollTop, 650);
  }
  h.win.document.querySelector<HTMLInputElement>("#input")!.blur();
  h.win.dispatchEvent(new h.win.Event("pageshow"));
  h.settle();
  h.frame();
  assert.equal(h.root.scrollTop, 650);
  assert.deepEqual(h.recoveries, []);
  h.cleanup();
  assert.equal(h.root.hasAttribute("data-mobile-page-scroll"), false);
});

test("changing the mobile breakpoint transfers the reading position between scroll owners", (t) => {
  const h = viewportHarness(t, "hub-main");
  const feed = h.win.document.getElementById("feed")!;
  feed.setAttribute("data-scroll-restoration-id", "hub-main");
  Object.defineProperty(h.win, "scrollY", { configurable: true, writable: true, value: 750 });
  h.win.scrollTo = (({ top }: ScrollToOptions) => {
    Object.defineProperty(h.win, "scrollY", { configurable: true, value: top ?? 0 });
  }) as typeof h.win.scrollTo;
  h.mobileQuery.matches = false;
  h.mobileQuery.dispatchEvent(new h.win.Event("change"));
  assert.equal(h.root.hasAttribute("data-mobile-page-scroll"), false);
  assert.equal(feed.scrollTop, 750);
  assert.equal(h.win.scrollY, 0);
  feed.scrollTop = 950;
  h.mobileQuery.matches = true;
  h.mobileQuery.dispatchEvent(new h.win.Event("change"));
  assert.equal(h.root.getAttribute("data-mobile-page-scroll"), "hub-main");
  assert.equal(feed.scrollTop, 0);
  assert.equal(h.win.scrollY, 950);
});

test("Library rotation transfers to the detail element that replaces the mobile markup", (t) => {
  const h = viewportHarness(t, "library-detail");
  const feed = h.win.document.getElementById("feed")!;
  feed.setAttribute("data-scroll-restoration-id", "library-detail");
  Object.defineProperty(h.win, "scrollY", { configurable: true, value: 750 });
  h.win.scrollTo = (({ top }: ScrollToOptions) => {
    Object.defineProperty(h.win, "scrollY", { configurable: true, value: top ?? 0 });
  }) as typeof h.win.scrollTo;
  h.mobileQuery.matches = false;
  h.mobileQuery.dispatchEvent(new h.win.Event("change"));
  const replacement = feed.cloneNode() as HTMLElement;
  feed.replaceWith(replacement);
  assert.equal(replacement.scrollTop, 0);
  h.win.dispatchEvent(new h.win.Event("orientationchange"));
  h.frame();
  assert.equal(replacement.scrollTop, 750, "orientation settling must not cancel the replacement transfer");
  assert.equal(h.win.scrollY, 0);
  replacement.scrollTop = 950;
  h.mobileQuery.matches = true;
  h.mobileQuery.dispatchEvent(new h.win.Event("change"));
  replacement.replaceWith(feed);
  h.frame();
  assert.equal(h.win.scrollY, 950, "returning to the document survives another markup swap");
});
