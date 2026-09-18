import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { JSDOM } from "jsdom";
import { installMobileNotificationPage } from "./mobile-notification-page";

function setup(t: TestContext) {
  const dom = new JSDOM('<div id="root"><div data-scroll-restoration-id="hub-main"></div></div><div id="panel"><div class="notification-panel-controls"></div></div>', { url: "https://yumina.io/app/hub" });
  t.after(() => dom.window.close());
  const win = dom.window;
  const root = win.document.documentElement;
  root.setAttribute("data-mobile-page-scroll", "hub-main");
  Object.defineProperty(win, "scrollY", { value: 725, writable: true });
  win.scrollTo = ((p: ScrollToOptions) => { Object.defineProperty(win, "scrollY", { value: p.top ?? 0, writable: true }); }) as typeof win.scrollTo;
  let disconnected = false;
  t.mock.method(globalThis, "ResizeObserver", function () { return { observe() {}, disconnect() { disconnected = true; } }; } as never);
  const restore = installMobileNotificationPage(win as unknown as Window, win.document.getElementById("panel")!);
  return { win, root, restore, disconnected: () => disconnected };
}

// Node has no layout observer; its lifecycle is exercised here, geometry in WebKit/Chromium.
Object.defineProperty(globalThis, "ResizeObserver", { value: class {}, configurable: true, writable: true });

test("notification reading surface restores the mounted page and scroll exactly once", (t) => {
  const h = setup(t);
  assert.equal(h.win.scrollY, 0);
  assert.equal(h.root.hasAttribute("data-mobile-notification-page"), true);
  assert.equal(h.win.document.getElementById("root")!.inert, true);
  h.restore();
  assert.equal(h.root.hasAttribute("data-mobile-notification-page"), false);
  assert.equal(h.win.scrollY, 725);
  assert.equal(h.win.document.getElementById("root")!.inert, false);
  h.win.scrollTo({ top: 140 });
  h.restore();
  assert.equal(h.win.scrollY, 140);
  assert.equal(h.disconnected(), true);
});

test("notification close never restores an old offset onto a newly navigated route", (t) => {
  const h = setup(t);
  h.win.history.pushState({}, "", "/app/community");
  h.restore();
  assert.equal(h.win.scrollY, 0);
});

test("rotation restores to the desktop pane instead of the notification document offset", (t) => {
  const h = setup(t);
  h.root.removeAttribute("data-mobile-page-scroll");
  h.win.scrollTo({ top: 2000 });
  h.restore();
  assert.equal(h.win.document.querySelector<HTMLElement>('[data-scroll-restoration-id="hub-main"]')!.scrollTop, 725);
});
