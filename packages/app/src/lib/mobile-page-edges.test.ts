import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { getMobileReadingPageId } from "./mobile-reading-route.js";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const globals = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8");
const styles = (html.match(/<style id="reading-page-surface">([\s\S]*?)<\/style>/)?.[1] ?? "")
  + globals.slice(globals.indexOf("/* Mobile reading pages"));

test("settings, AI, admin and Create start with Discover's document scroll owner", () => {
  for (const [path, id] of [
    ["/app/settings#ai-config", "settings-main"],
    ["/app/admin", "admin-main"],
    ["/app/admin/users", "admin-main"],
    ["/app/worlds/create", "create-picker"],
  ]) {
    const dom = new JSDOM(html, { url: `https://yumina.io${path}`, runScripts: "outside-only" });
    try {
      dom.window.matchMedia = (() => ({ matches: true })) as unknown as typeof dom.window.matchMedia;
      dom.window.eval(dom.window.document.querySelector("#reading-page-bootstrap")!.textContent!);
      assert.equal(getMobileReadingPageId(dom.window.location.pathname), id, path);
      assert.equal(dom.window.document.documentElement.getAttribute("data-mobile-page-scroll"), id, path);
    } finally { dom.window.close(); }
  }
  assert.equal(getMobileReadingPageId("/app/admin/world-inspect/123"), undefined);
  assert.equal(getMobileReadingPageId("/app/messages/123"), undefined);
});

test("mobile page wrappers release their clipped height without releasing dialogs", (t) => {
  const dom = new JSDOM(`<style>
    .pane { height: 100%; overflow: hidden; }
    .dialog { height: 300px; overflow: auto; }
    ${styles}
    </style><div class="app-shell-root"><main class="app-shell-main">
    <div class="pane"><div class="dialog"></div></div></main></div>`);
  t.after(() => dom.window.close());
  const doc = dom.window.document;
  const pane = doc.querySelector(".pane")!;
  for (const [id, classNames] of [
    ["settings-main", ["settings-page", "settings-layout", "settings-nav-scroll", "settings-content"]],
    ["admin-main", ["admin-workspace", "aw-main-shell", "aw-scroll"]],
    ["create-picker", ["create-shell", "create-col"]],
  ] as const) {
    doc.documentElement.setAttribute("data-mobile-page-scroll", id);
    for (const className of classNames) {
      pane.className = `pane ${className}`;
      assert.equal(dom.window.getComputedStyle(pane).height, "auto", `${id}: ${className}`);
      assert.equal(dom.window.getComputedStyle(pane).overflow, "visible", `${id}: ${className}`);
    }
    assert.equal(dom.window.getComputedStyle(doc.querySelector(".dialog")!).overflow, "auto");
  }
  doc.documentElement.removeAttribute("data-mobile-page-scroll");
  assert.equal(dom.window.getComputedStyle(pane).height, "100%", "desktop/editor keep their pane");
});

test("admin document keeps its workspace color instead of inheriting Discover wallpaper", (t) => {
  const dom = new JSDOM(`<style>${styles}</style>`);
  t.after(() => dom.window.close());
  const root = dom.window.document.documentElement;
  root.setAttribute("data-mobile-app-canvas", "plain");
  root.setAttribute("data-mobile-page-scroll", "admin-main");
  const style = dom.window.getComputedStyle(root);
  assert.equal(style.getPropertyValue("--reading-canvas-color").trim(), "#111214");
  assert.equal(style.backgroundImage, "none");
});

test("mobile inbox has no tinted pane ending above the document safe area", (t) => {
  const dom = new JSDOM(`<style>
    .dm-page-frame, .dm-page-sidebar { background: rgba(16,17,22,.22); box-shadow: 0 0 64px black; backdrop-filter: blur(4px); }
    ${styles}
    </style><div class="dm-page-frame"><div class="dm-page-sidebar"></div></div>`);
  t.after(() => dom.window.close());
  dom.window.document.documentElement.setAttribute("data-mobile-page-scroll", "dm-page-conversation-list");
  for (const pane of dom.window.document.querySelectorAll(".dm-page-frame, .dm-page-sidebar")) {
    const style = dom.window.getComputedStyle(pane);
    assert.equal(style.backgroundColor, "rgba(0, 0, 0, 0)");
    assert.equal(style.boxShadow, "none");
    assert.equal(style.getPropertyValue("backdrop-filter"), "none");
  }
});
