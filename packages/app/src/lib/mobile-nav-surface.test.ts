import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { JSDOM } from "jsdom";

const css = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
// JSDOM doesn't evaluate viewport media queries; select the actual phone rules.
const start = css.indexOf("@media (max-width: 767px) {");
const open = css.indexOf("{", start);
let end = open + 1;
let depth = 1;
for (; end < css.length && depth; end++) {
  if (css[end] === "{") depth++;
  if (css[end] === "}") depth--;
}
const phoneCSS = css.slice(open + 1, end - 1);
const readingCSS = html.match(/<style id="reading-page-surface">([\s\S]*?)<\/style>/)?.[1] ?? "";

test("opening and closing the phone menu retains the reading color and scroll lock without filtered viewport overlays", (t) => {
  const dom = new JSDOM(`<style>${phoneCSS}${readingCSS}${css.slice(css.indexOf("/* Mobile reading pages"))}</style>
    <button class="mobile-nav-backdrop mobile-nav-backdrop--closed"></button>
    <aside class="mobile-nav-drawer mobile-nav-drawer--closed"></aside>
    <div class="app-shell-content"><div role="banner" class="topbar-shell"></div></div>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const backdrop = doc.querySelector("button")!;
  const drawer = doc.querySelector("aside")!;
  const style = (element: Element) => dom.window.getComputedStyle(element);
  for (const page of ["hub-main", "community-main", "library-main", "profile-main"]) {
    doc.documentElement.setAttribute("data-mobile-page-scroll", page);
    for (const opened of [false, true, false]) {
      const state = opened ? "open" : "closed";
      backdrop.className = `mobile-nav-backdrop mobile-nav-backdrop--${state}`;
      drawer.className = `mobile-nav-drawer mobile-nav-drawer--${state}`;
      // Filtered viewport overlays send WebKit's fixed-edge sampling through
      // its multiple-colors path, even when the underlying header is solid.
      for (const element of [backdrop, drawer]) {
        assert.equal(style(element).getPropertyValue("backdrop-filter"), "none");
        assert.equal(style(element).visibility, opened ? "visible" : "hidden");
        assert.equal(style(element).pointerEvents, opened ? "auto" : "none");
      }
      assert.equal(style(backdrop).backgroundColor, "rgba(5, 5, 8, 0.62)", "menu still dims the page");
      assert.equal(style(drawer).backgroundColor, "rgb(17, 17, 20)", "preserve the approved menu surface");
      assert.equal(style(doc.querySelector('[role="banner"]')!).backgroundColor, "rgba(0, 0, 0, 0)");
      assert.equal(style(doc.documentElement).overflowY, opened ? "hidden" : "auto", "closing must restore document scrolling");
    }
  }
});
