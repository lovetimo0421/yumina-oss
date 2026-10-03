import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { getMetaForPath, injectMeta } from "./seo.js";

const template = readFileSync(new URL("../../../app/index.html", import.meta.url), "utf8");

// Owner-authored copy (2026-09-30). These assertions pin the exact words.
const PAGES: Array<[string, string, string]> = [
  ["/", "Yumina", "Open-source world engine and community turning entertainment interactive."],
  ["/app/hub", "Discover", "Find your favorite stories and become part of what happens."],
  ["/app/community", "Community", "Make friends here and share whatever you want."],
  ["/app/bundles", "Bundles", "Download or share community made resource packs to help you build your worlds easier!"],
  ["/app/worlds", "Create", "Turn your story into a playable world, and invite us in."],
  ["/login", "Sign in", "Welcome back to Yumina - hope to make you happy today."],
  ["/register", "Create account", "Join Yumina and find a world you feel at home in, or make the one you've been looking for."],
];

test("site pages carry the owner's titles and descriptions, word for word", async () => {
  for (const [path, title, description] of PAGES) {
    const meta = await getMetaForPath(path);
    assert.equal(meta.title, title, path);
    assert.equal(meta.description, description, path);
    const html = injectMeta(template, meta);
    assert.ok(html.includes(`<title>${title}</title>`), `${path} tab title`);
    assert.ok(html.includes(`<meta property="og:title" content="${title}" />`), `${path} share title`);
    assert.ok(html.includes(`<meta name="description" content="${description}" />`), `${path} description`);
  }
});

test("no page title ends in a brand suffix", async () => {
  for (const [path] of PAGES) {
    const meta = await getMetaForPath(path);
    assert.doesNotMatch(meta.title, /[-·|]\s*Yumina$/);
  }
});

test("the template's own defaults match the home page", () => {
  assert.ok(template.includes("<title>Yumina</title>"));
  assert.ok(template.includes('content="Open-source world engine and community turning entertainment interactive."'));
  assert.ok(template.includes('content="A burning anchor, in watercolor, above the word Yumina."'));
});

test("a page's language reaches the html tag; no language leaves the default", () => {
  const base = { title: "x", description: "y", url: "https://yumina.io/x" };
  assert.match(injectMeta(template, { ...base, lang: "zh" }), /<html lang="zh"/);
  assert.match(injectMeta(template, base), /<html lang="en"/);
});

test("private areas stay hidden from search", async () => {
  for (const path of ["/app/chat/abc", "/app/settings", "/app/admin/users", "/app/plans"]) {
    const meta = await getMetaForPath(path);
    assert.equal(meta.noindex, true, path);
    assert.equal(meta.title, "Yumina", path);
  }
});

test("quotes and angle brackets in a title cannot break the tag", () => {
  const html = injectMeta(template, { title: 'Say "hi" <now>', description: "d", url: "https://yumina.io/t" });
  assert.ok(html.includes('<title>Say "hi" &lt;now&gt;</title>'));
  assert.ok(html.includes('<meta property="og:title" content="Say &quot;hi&quot; \\u003cnow&gt;" />'));
});
