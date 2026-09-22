import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

// DOMPurify binds itself to `window` at import time, so the DOM has to exist
// before the renderer is loaded.
const dom = new JSDOM("<div></div>");
Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: dom.window });
Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: dom.window.document });

const { renderMessage, chatImageUrl } = await import("../../sandbox/chat/markdown");

/**
 * Every chat message — greeting included — renders through the SANDBOX
 * renderer, not `src/lib/markdown.ts`. That copy was forked before the host
 * gained markdown images, so `![](@asset:…)` in a greeting reached players as
 * literal text (live on Maid Mansion, 2026-09-20). Images are the documented
 * way creators put library pictures in an opening, so the sandbox copy has to
 * carry the same step.
 */
const ASSET_ID = "c4100969-1efb-4fb0-9850-595dcc625da7";
// Outside Vite there is no import.meta.env, so this is the production shape:
// the edge-sized picture, not the multi-megabyte original.
const CDN_SRC = `/cdn-cgi/image/width=1280,quality=85,format=auto,onerror=redirect/cdn/${ASSET_ID}`;

test("greeting markdown images resolve library assets to the CDN", () => {
  const html = renderMessage(`intro\n\n![](@asset:${ASSET_ID})\n\nrest`);

  assert.ok(html.includes(`<img src="${CDN_SRC}"`), html);
  assert.ok(!html.includes("![]("), html);
  assert.ok(!html.includes("@asset:"), html);
});

test("a bare asset uuid resolves the same way", () => {
  const html = renderMessage(`![portrait](${ASSET_ID})`);

  assert.ok(html.includes(`<img src="${CDN_SRC}"`), html);
  assert.ok(html.includes('alt="portrait"'), html);
});

/**
 * Root-relative on purpose: the sandbox iframe runs `allow-scripts` without
 * `allow-same-origin`, so `location.origin` is the string "null" in there and
 * any origin-prefixed URL would 404.
 */
test("the resolved src carries no origin prefix", () => {
  const html = renderMessage(`![](@asset:${ASSET_ID})`);

  assert.ok(!html.includes("null/cdn/"), html);
  assert.ok(!/src="https?:/.test(html), html);
});

test("non-asset image sources pass through untouched", () => {
  const remote = renderMessage("![sky](https://example.com/a.png)");
  assert.ok(remote.includes('src="https://example.com/a.png"'), remote);

  // A hand-written /cdn/ path is a library picture too and gets the same sizing.
  const alreadyCdn = renderMessage(`![](/cdn/${ASSET_ID})`);
  assert.ok(alreadyCdn.includes(`src="${CDN_SRC}"`), alreadyCdn);
});

test("image markdown inside a code block stays literal", () => {
  const html = renderMessage("```\n![](@asset:" + ASSET_ID + ")\n```");

  assert.ok(!html.includes("<img"), html);
  assert.ok(html.includes("![]("), html);
});

/**
 * `[image:https://…]` is the engine's own embed directive and owns a richer
 * card (caption, size, placement). Adding the markdown step must not steal it.
 */
test("the [image:] directive still renders its own embed", () => {
  const html = renderMessage("[image:https://example.com/a.png|alt=Scene]");

  assert.ok(html.includes("https://example.com/a.png"), html);
  assert.ok(!html.includes("[image:"), html);
});

/**
 * The shape the editor's insert button writes. It only becomes loadable once
 * the engine stops refusing `@asset:` sources AND this renderer maps them onto
 * the CDN — both halves have to be present or the author gets literal text.
 */
test("the [image:] directive resolves a library asset", () => {
  const html = renderMessage(`[image:@asset:${ASSET_ID}|alt=Hall|caption=The entry hall]`);

  assert.ok(html.includes(`src="${CDN_SRC}"`), html);
  assert.ok(!html.includes("@asset:"), html);
  assert.ok(html.includes("Hall"), html);
  assert.ok(html.includes("The entry hall"), html);
});

test("a hostile [image:] source is still refused and left as text", () => {
  for (const bad of ["javascript:alert(1)", "data:image/png;base64,AAA", "http://x/a.png"]) {
    const html = renderMessage(`[image:${bad}]`);
    assert.ok(!html.includes("<img"), `${bad} -> ${html}`);
  }
});

/**
 * The live Maid Mansion opening is a 3.4 MB PNG; the same picture through the
 * edge at 1280 wide is ~190 KB. Every library picture in a message takes that
 * path, and it must stay root-relative and carry the redirect-on-failure flag
 * so an edge that refuses a transform still serves the original.
 */
test("library pictures are edge-sized, root-relative, with the original as fallback", () => {
  const url = chatImageUrl(ASSET_ID);

  assert.ok(url.startsWith("/cdn-cgi/image/"), url);
  assert.ok(url.endsWith(`/cdn/${ASSET_ID}`), url);
  assert.ok(url.includes("width=1280"), url);
  assert.ok(url.includes("format=auto"), url);
  assert.ok(url.includes("onerror=redirect"), url);
});
