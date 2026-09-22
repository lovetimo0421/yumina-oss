import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { installMobileViewport } from "./mobile-viewport.js";
import { clearReadingPageBootstrap } from "./reading-page-canvas.js";
import { getMobileReadingPageId } from "./mobile-reading-route.js";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

function boot(url: string, mobile = true) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.matchMedia = (() => ({ matches: mobile })) as unknown as typeof dom.window.matchMedia;
  const script = dom.window.document.querySelector("#reading-page-bootstrap");
  dom.window.eval(script?.textContent ?? "");
  return dom;
}

test("every app entry paints the document before React, independently of its scroll owner", () => {
  for (const [path, mode] of [
    ["/", "wallpaper"], ["/app/hub", "wallpaper"],
    ["/app/library", "wallpaper"], ["/app/profile", "wallpaper"],
    ["/app/profile/achievements", "wallpaper"], ["/app/settings", "wallpaper"],
    ["/app/messages/123", "wallpaper"], ["/app/chat/123", "plain"],
    ["/app/preview/123", "plain"], ["/app/studio", "plain"],
    ["/app/admin", "plain"], ["/app/worlds/123/edit", "plain"],
    ["/app/worlds/create", "wallpaper"],
  ]) {
    const dom = boot(`https://yumina.io${path}`);
    try {
      const doc = dom.window.document;
      assert.equal(doc.documentElement.getAttribute("data-mobile-app-canvas"), mode, path);
      for (const selector of ["body", "#root", "#app-splash"]) {
        assert.equal(dom.window.getComputedStyle(doc.querySelector(selector)!).backgroundColor, "rgba(0, 0, 0, 0)", `${path}: ${selector}`);
      }
    } finally { dom.window.close(); }
  }
});

test("shared app canvas stays off desktop and outside the app, and clears on redirect", () => {
  for (const [url, mobile] of [["https://yumina.io/app/settings", false], ["https://creator.yumina.io/app/hub", true], ["https://yumina.io/login", true]] as const) {
    const dom = boot(url, mobile);
    try { assert.equal(dom.window.document.documentElement.hasAttribute("data-mobile-app-canvas"), false); }
    finally { dom.window.close(); }
  }
  const dom = boot("https://yumina.io/app/chat/123");
  try {
    clearReadingPageBootstrap(dom.window.document, "/login");
    assert.equal(dom.window.document.documentElement.hasAttribute("data-mobile-app-canvas"), false);
  } finally { dom.window.close(); }
});

test("the DM inbox owns document scroll while open conversations retain their keyboard viewport", () => {
  const list = boot("https://yumina.io/app/messages");
  const conversation = boot("https://yumina.io/app/messages/conversation-123");
  try {
    assert.equal(getMobileReadingPageId("/app/messages"), "dm-page-conversation-list");
    assert.equal(list.window.document.documentElement.getAttribute("data-mobile-page-scroll"), "dm-page-conversation-list");
    assert.equal(getMobileReadingPageId("/app/messages/conversation-123"), undefined);
    assert.equal(conversation.window.document.documentElement.hasAttribute("data-mobile-page-scroll"), false);
    for (const dom of [list, conversation]) {
      const doc = dom.window.document;
      assert.equal(doc.documentElement.hasAttribute("data-mobile-message-canvas"), true);
      assert.equal(dom.window.getComputedStyle(doc.body).backgroundColor, "rgba(0, 0, 0, 0)");
      assert.equal(dom.window.getComputedStyle(doc.getElementById("app-splash")!).backgroundColor, "rgba(0, 0, 0, 0)");
    }
  } finally { list.window.close(); conversation.window.close(); }
});

test("mobile reading surfaces exist before React, including homepage and deep links", () => {
  for (const [path, page] of [["/", "hub-main"], ["/app/hub?tab=following", "hub-main"], ["/app/community/threads/123", "community-main"], ["/app/library", "library-main"], ["/app/library?worldId=123", "library-detail"], ["/app/library?view=favorites", "library-favorites"], ["/app/profile", "profile-main"], ["/app/users/123", "public-profile-main"]]) {
    const dom = boot(`https://yumina.io${path}`);
    try {
      assert.equal(dom.window.document.documentElement.getAttribute("data-mobile-page-scroll"), page);
      assert.equal(dom.window.document.documentElement.hasAttribute("data-reading-boot"), true);
      assert.equal(dom.window.document.getElementById("root")!.children.length, 0, "no app mount is required");
      if (path !== "/") {
        const url = new URL(`https://yumina.io${path}`);
        assert.equal(getMobileReadingPageId(url.pathname, Object.fromEntries(url.searchParams)), page, "first paint and React must select the same scroll owner");
        clearReadingPageBootstrap(dom.window.document, url.pathname);
        assert.equal(dom.window.document.documentElement.hasAttribute("data-reading-boot"), true);
      }
    } finally { dom.window.close(); }
  }
});

test("account forms and sibling routes keep their contained viewport", () => {
  for (const path of ["/app/profile/invite-code", "/app/profile/achievements", "/app/users/123/followers", "/app/library-other", "/app/studio", "/app/chat/123"]) {
    const dom = boot(`https://yumina.io${path}`);
    try {
      assert.equal(getMobileReadingPageId(path), undefined);
      assert.equal(dom.window.document.documentElement.hasAttribute("data-mobile-page-scroll"), false);
    } finally { dom.window.close(); }
  }
});

test("Create picker uses document scroll until an editor opens at the same URL", () => {
  const dom = boot("https://yumina.io/app/worlds/create");
  try {
    assert.equal(dom.window.document.documentElement.getAttribute("data-mobile-page-scroll"), "create-picker");
    assert.equal(getMobileReadingPageId("/app/worlds/create"), "create-picker");
    assert.equal(getMobileReadingPageId("/app/worlds/create", {}, false), undefined);
    assert.equal(getMobileReadingPageId("/app/worlds/123/edit"), undefined);
  } finally { dom.window.close(); }
});

test("bootstrap leaves desktop, creator, and contained routes alone", () => {
  for (const [url, mobile] of [["https://yumina.io/app/hub", false], ["https://creator.yumina.io/", true], ["https://creator.yumina.io/app/hub", true], ["https://yumina.io/app/chat/123", true], ["https://yumina.io/app/community-other", true]] as const) {
    const dom = boot(url, mobile);
    try { assert.equal(dom.window.document.documentElement.hasAttribute("data-mobile-page-scroll"), false); }
    finally { dom.window.close(); }
  }
});

test("the initial HTML has the final browser-edge color while external stylesheets are still unavailable", () => {
  for (const path of ["/", "/app/hub", "/app/community", "/app/community/threads/123", "/app/library", "/app/profile", "/app/users/123"]) {
    // JSDOM does not fetch stylesheets here. Test the HTML response itself,
    // before the CSS/module requests that previously supplied the edge color.
    const dom = boot(`https://yumina.io${path}`);
    try {
      const doc = dom.window.document;
      const computed = (element: Element) => dom.window.getComputedStyle(element);
      const rootStyle = computed(doc.documentElement);
      assert.equal(rootStyle.getPropertyValue("--reading-canvas-color").replace(/\s/g, ""), "rgb(25,27,36)", path);
      // JSDOM incorrectly gives the baseline's `html, body, #root` rule the
      // ID selector's specificity when matching html. Inspect the parsed
      // native rule instead; browsers match each selector independently.
      const surface = doc.querySelector<HTMLStyleElement>("style#reading-page-surface")!;
      const canvasRule = [...surface.sheet!.cssRules].find((rule) =>
        "selectorText" in rule && String(rule.selectorText).includes('html[data-mobile-app-canvas="wallpaper"]') && "style" in rule && (rule as CSSStyleRule).style.getPropertyValue("background-image"),
      ) as CSSStyleRule;
      assert.equal(canvasRule.style.getPropertyValue("background-color"), "var(--reading-canvas-color)", "Safari's document background must already use the shared color");
      assert.equal(computed(doc.body).backgroundColor, "rgba(0, 0, 0, 0)", "the old body fill must not override Safari's document background");
      assert.equal(computed(doc.getElementById("root")!).backgroundColor, "rgba(0, 0, 0, 0)");
      assert.equal(computed(doc.getElementById("app-splash")!).backgroundColor, "rgba(0, 0, 0, 0)");
      assert.equal(computed(doc.getElementById("app-splash")!).position, "absolute", "loading must not reinstate the fixed black footer");
    } finally { dom.window.close(); }
  }
});

test("first-paint canvas and splash survive the critical HTML style cascade", () => {
  const dom = boot("https://yumina.io/app/community");
  try {
    const doc = dom.window.document;
    assert.ok(doc.querySelector("style#reading-page-surface"), "reading canvas must ship in the HTML, without another network request");
    const computed = (selector: string) => dom.window.getComputedStyle(doc.querySelector(selector)!);
    assert.equal(computed("#root").backgroundColor, "rgba(0, 0, 0, 0)");
    assert.equal(computed("#app-splash").backgroundColor, "rgba(0, 0, 0, 0)");
    assert.equal(computed("#app-splash").position, "absolute", "startup must not seed a fixed black browser edge");
    assert.equal(computed("html").backgroundRepeat, "repeat-y");
    assert.ok(computed("html").getPropertyValue("--reading-canvas-image").includes("libary-bg.jpg"));
  } finally { dom.window.close(); }
});

test("React adopts bootstrap without moving scroll, including rotation before mount", () => {
  for (const mobile of [true, false]) {
    const dom = boot("https://yumina.io/app/hub");
    const root = dom.window.document.documentElement;
    root.scrollTop = 640;
    dom.window.matchMedia = (() => Object.assign(new dom.window.EventTarget(), { matches: mobile })) as unknown as typeof dom.window.matchMedia;
    const cleanup = installMobileViewport(dom.window as unknown as Window, undefined, "hub-main");
    try {
      assert.equal(root.hasAttribute("data-reading-boot"), false);
      assert.equal(root.hasAttribute("data-mobile-page-scroll"), mobile);
      assert.equal(root.scrollTop, 640);
    } finally { cleanup(); dom.window.close(); }
  }
});

test("later mobile panel styles cannot fix or clip the reading document", () => {
  const dom = boot("https://yumina.io/app/community");
  const doc = dom.window.document;
  try {
    const globals = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // Activate the legacy phone/@supports rules explicitly: JSDOM does not
    // evaluate viewport media queries, but does evaluate their CSS selectors.
    const legacy = doc.createElement("style");
    legacy.textContent = [...globals.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => match[1]!.includes("html[data-mobile-viewport]"))
      .map((match) => `${match[1]}{${match[2]}}`).join("\n");
    doc.head.appendChild(legacy);
    doc.documentElement.setAttribute("data-mobile-viewport", "");
    assert.equal(dom.window.getComputedStyle(doc.body).position, "static");
    assert.equal(dom.window.getComputedStyle(doc.documentElement).overflowY, "auto");
    assert.equal(dom.window.getComputedStyle(doc.getElementById("root")!).overflow, "visible");
  } finally { dom.window.close(); }
});

test("bootstrap redirect cleanup cannot interfere after the viewport controller takes ownership", () => {
  const dom = boot("https://yumina.io/app/hub");
  const doc = dom.window.document;
  try {
    clearReadingPageBootstrap(doc, "/app/community/threads/123");
    assert.equal(doc.documentElement.hasAttribute("data-reading-boot"), true);
    clearReadingPageBootstrap(doc, "/creator");
    assert.equal(doc.documentElement.hasAttribute("data-mobile-page-scroll"), false);
    doc.documentElement.setAttribute("data-mobile-page-scroll", "hub-main");
    clearReadingPageBootstrap(doc, "/app/chat/123");
    assert.equal(doc.documentElement.getAttribute("data-mobile-page-scroll"), "hub-main");
  } finally { dom.window.close(); }
});
