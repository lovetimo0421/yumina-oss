import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import * as headerMotion from "./scroll-away-header.js";

function harness(t: test.TestContext) {
  const dom = new JSDOM('<header><button>Menu</button><input type="search"></header><main><textarea></textarea><div id="nested"></div></main>', { pretendToBeVisual: true });
  const win = dom.window;
  const doc = win.document;
  doc.documentElement.setAttribute("data-mobile-page-scroll", "hub-main");
  const bar = doc.querySelector("header")!;
  const timers = new Map<number, () => void>();
  const frames = new Map<number, FrameRequestCallback>();
  let nextId = 0;
  let hidden = false;
  const changes: boolean[] = [];
  win.setTimeout = ((callback: () => void) => { timers.set(++nextId, callback); return nextId; }) as typeof win.setTimeout;
  win.clearTimeout = (id) => { if (id !== undefined) timers.delete(id); };
  win.requestAnimationFrame = (callback) => { frames.set(++nextId, callback); return nextId; };
  win.cancelAnimationFrame = (id) => { frames.delete(id); };
  const frame = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((cb) => cb(0)); };
  Object.defineProperty(win, "scrollY", { value: 0, writable: true });
  Object.defineProperty(win, "innerWidth", { value: 440, writable: true });
  Object.defineProperty(doc.documentElement, "scrollHeight", { value: 5000 });
  Object.defineProperty(doc.documentElement, "clientHeight", { value: 800 });
  const vv = Object.assign(new win.EventTarget(), { scale: 1 });
  Object.defineProperty(win, "visualViewport", { value: vv });
  assert.equal(typeof headerMotion.installScrollAwayHeader, "function");
  const cleanup = headerMotion.installScrollAwayHeader(win as unknown as Window, bar, (value) => { hidden = value; changes.push(value); });
  t.after(() => { cleanup(); dom.window.close(); });
  return {
    win, doc, bar, timers, vv, changes, cleanup, frame,
    hidden: () => hidden,
    scroll(y: number, paint = true) { Object.defineProperty(win, "scrollY", { value: y, writable: true }); win.dispatchEvent(new win.Event("scroll")); if (paint) frame(); },
    settle() { const pending = [...timers.values()]; timers.clear(); pending.forEach((cb) => cb()); },
  };
}

test("the whole header hides on downward intent, stays hidden at rest, and returns on upward intent", (t) => {
  const h = harness(t);
  h.scroll(3);
  assert.equal(h.hidden(), false, "tiny viewport noise must not hide controls");
  h.scroll(120);
  assert.equal(h.hidden(), true);
  h.scroll(200);
  assert.equal(h.timers.size, 0, "stopping must not schedule an unwanted reveal");
  assert.deepEqual(h.changes, [true], "no React update per scroll frame");
  h.settle();
  assert.equal(h.hidden(), true);
  h.scroll(180);
  assert.equal(h.hidden(), false, "upward scrolling reveals navigation immediately");
  h.scroll(230);
  assert.equal(h.hidden(), true);
  h.scroll(0);
  assert.equal(h.hidden(), false, "the top of the page always exposes navigation");
});

test("rapid direction changes publish only the latest intent for a rendered frame", (t) => {
  const h = harness(t);
  h.scroll(120, false);
  h.scroll(100, false);
  h.scroll(160, false);
  assert.deepEqual(h.changes, [], "events between frames must not restart the transition repeatedly");
  h.frame();
  assert.deepEqual(h.changes, [true]);
  h.scroll(140, false);
  h.scroll(170, false);
  h.frame();
  assert.deepEqual(h.changes, [true], "a transient reversal must not restart the existing animation");
  h.scroll(140, false);
  h.doc.dispatchEvent(new h.win.KeyboardEvent("keydown", { key: "Tab" }));
  assert.equal(h.hidden(), false, "keyboard navigation reveals immediately");
  h.cleanup();
  h.frame();
  assert.deepEqual(h.changes, [true, false]);
});

test("touch hold and momentum cannot make the bar pop back mid-gesture", (t) => {
  const h = harness(t);
  h.doc.dispatchEvent(new h.win.Event("touchstart"));
  h.scroll(400);
  h.settle();
  assert.equal(h.hidden(), true);
  h.doc.dispatchEvent(new h.win.Event("touchend"));
  h.scroll(480);
  assert.equal(h.hidden(), true);
  h.settle();
  assert.equal(h.hidden(), true, "stopping after momentum must retain the downward state");
  h.scroll(460);
  assert.equal(h.hidden(), false);
});

test("small reversals and bottom rubber-band rebound do not flicker the controls", (t) => {
  const h = harness(t);
  h.scroll(400);
  h.scroll(397);
  h.scroll(399);
  h.scroll(396);
  assert.equal(h.hidden(), true, "alternating noise is not accumulated into upward intent");
  h.scroll(380);
  assert.equal(h.hidden(), false);
  h.scroll(4200);
  h.scroll(4260);
  h.scroll(4230);
  h.scroll(4200);
  assert.equal(h.hidden(), true, "returning from elastic overscroll is not scrolling up the page");
  h.scroll(4180);
  assert.equal(h.hidden(), false);
});

test("search, reply typing, keyboard navigation and open menus keep controls stable", (t) => {
  const h = harness(t);
  h.doc.querySelector("input")!.focus();
  h.scroll(200);
  assert.equal(h.hidden(), false);
  h.doc.querySelector("textarea")!.focus();
  h.scroll(400);
  assert.equal(h.hidden(), false);
  h.doc.querySelector("textarea")!.blur();
  h.bar.querySelector("button")!.setAttribute("aria-expanded", "true");
  h.scroll(600);
  assert.equal(h.hidden(), false);
  h.bar.querySelector("button")!.setAttribute("aria-expanded", "false");
  h.scroll(800);
  assert.equal(h.hidden(), true);
  h.doc.dispatchEvent(new h.win.KeyboardEvent("keydown", { key: "Tab" }));
  assert.equal(h.hidden(), false, "Tab must reveal controls before moving focus");
  h.bar.querySelector("button")!.focus();
  h.scroll(950);
  assert.equal(h.hidden(), false, "keyboard focus may not be hidden or made inert");
});

test("browser toolbar height changes cannot reveal the header during an active swipe", (t) => {
  const h = harness(t);
  h.doc.dispatchEvent(new h.win.Event("touchstart"));
  h.scroll(400);
  Object.defineProperty(h.win, "innerHeight", { value: 900, writable: true });
  h.win.dispatchEvent(new h.win.Event("resize"));
  assert.equal(h.hidden(), true, "collapsing Safari chrome is still part of the swipe");
  h.scroll(500);
  h.settle();
  assert.equal(h.hidden(), true, "the height resize must not clear the held-touch guard");
  h.doc.dispatchEvent(new h.win.Event("touchend"));
  h.settle();
  assert.equal(h.hidden(), true, "height-only resizing and idle must not change direction");
  h.scroll(480);
  assert.equal(h.hidden(), false);
});

test("native-only scoping, nested scrolling, zoom, resize and resume never leave controls hidden", (t) => {
  const h = harness(t);
  h.doc.getElementById("nested")!.dispatchEvent(new h.win.Event("scroll", { bubbles: true }));
  assert.deepEqual(h.changes, []);
  h.scroll(400);
  Object.defineProperty(h.win, "innerWidth", { value: 1000, writable: true });
  h.win.dispatchEvent(new h.win.Event("resize"));
  assert.equal(h.hidden(), false);
  h.scroll(500);
  assert.equal(h.hidden(), false);
  Object.defineProperty(h.win, "innerWidth", { value: 440, writable: true });
  h.vv.scale = 2;
  h.scroll(600);
  assert.equal(h.hidden(), false);
  h.vv.scale = 1;
  h.scroll(700);
  assert.equal(h.hidden(), true);
  h.win.dispatchEvent(new h.win.Event("pageshow"));
  assert.equal(h.hidden(), false);
  h.doc.documentElement.removeAttribute("data-mobile-page-scroll");
  h.scroll(900);
  assert.equal(h.hidden(), false);
});

test("cleanup cancels callbacks without writing scroll or viewport geometry", (t) => {
  const h = harness(t);
  h.scroll(600);
  h.cleanup();
  assert.equal(h.timers.size, 0);
  assert.equal(h.hidden(), false);
  assert.equal(h.win.scrollY, 600);
  assert.equal(h.doc.documentElement.style.cssText, "");
  assert.equal(h.bar.style.cssText, "");
  const count = h.changes.length;
  h.scroll(700);
  h.settle();
  assert.equal(h.changes.length, count);
});

test("hidden header preserves layout and supports reduced motion without new capsules", () => {
  const css = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8");
  const hidden = css.match(/\.topbar-shell\[data-scroll-hidden\] \{([^}]+)\}/)?.[1] ?? "";
  assert.match(hidden, /transform: translateY\(/);
  assert.match(hidden, /visibility: hidden/);
  assert.doesNotMatch(hidden, /opacity:/, "search and account controls must not have a second fade timeline");
  assert.doesNotMatch(hidden, /(?:height|margin|padding|display):/);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?\.topbar-shell[\s\S]*?transition: none/);
  assert.doesNotMatch(css, /rgba\(22, 25, 33, 0\.8\)/, "the rejected capsule styling must stay removed");
  const visible = css.match(/html\[data-mobile-page-scroll\] \.topbar-shell \{([^}]+)\}/)?.[1] ?? "";
  assert.doesNotMatch(visible, /(?:mask-image|opacity):/, "a mask must never clip the search and controls separately");
});
