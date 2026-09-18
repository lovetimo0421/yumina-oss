import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getPageScrollTop, getPageTargetTop, scrollPageTo } from "./page-scroll.js";

function fixture(t: test.TestContext) {
  const dom = new JSDOM('<header class="topbar-shell"></header><div data-scroll-restoration-id="hub-main"><div id="results"></div></div>');
  t.after(() => dom.window.close());
  const win = dom.window;
  const scroller = win.document.querySelector<HTMLElement>("[data-scroll-restoration-id]")!;
  const target = win.document.getElementById("results")!;
  const calls: ScrollToOptions[] = [];
  win.scrollTo = scroller.scrollTo = ((options: ScrollToOptions) => calls.push(options)) as typeof win.scrollTo;
  win.matchMedia = (() => ({ matches: false })) as unknown as typeof win.matchMedia;
  scroller.scrollTop = 300;
  Object.defineProperty(win, "scrollY", { value: 700 });
  scroller.getBoundingClientRect = () => ({ top: 80 }) as DOMRect;
  target.getBoundingClientRect = () => ({ top: 480 }) as DOMRect;
  win.document.querySelector<HTMLElement>("header")!.getBoundingClientRect = () => ({ bottom: 90 }) as DOMRect;
  return { win, scroller, target, calls };
}

test("Discover actions use the document on phones and its panel on desktop", (t) => {
  const { win, scroller, target, calls } = fixture(t);
  assert.equal(getPageScrollTop(scroller), 300);
  assert.equal(getPageTargetTop(scroller, target), 700);
  scrollPageTo(scroller, 700);
  win.document.documentElement.setAttribute("data-mobile-page-scroll", "hub-main");
  assert.equal(getPageScrollTop(scroller), 700);
  assert.equal(getPageTargetTop(scroller, target), 1090);
  scrollPageTo(scroller, 1090);
  assert.deepEqual(calls, [
    { top: 700, left: 0, behavior: "smooth" },
    { top: 1090, left: 0, behavior: "smooth" },
  ]);
});

test("scroll controls respect reduced motion without changing their destination", (t) => {
  const { win, scroller, calls } = fixture(t);
  win.matchMedia = (() => ({ matches: true })) as unknown as typeof win.matchMedia;
  scrollPageTo(scroller, 250);
  assert.deepEqual(calls, [{ top: 250, left: 0, behavior: "auto" }]);
});
