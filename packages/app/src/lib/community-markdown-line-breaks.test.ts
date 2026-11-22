import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

// DOMPurify binds itself to `window` at import time, so the DOM has to exist first
const dom = new JSDOM("<div></div>");
Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: dom.window });
Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: dom.window.document });
const { renderCommunityMarkdown } = await import("./markdown");

test("a post written with Windows line breaks keeps its headings, lists and rules", () => {
  const unix = renderCommunityMarkdown("## Image\nOne line in.\n\n---\n- a\n- b\n> said");
  const windows = renderCommunityMarkdown("## Image\r\nOne line in.\r\n\r\n---\r\n- a\r\n- b\r\n> said");
  assert.match(windows, /<h2[^>]*>Image<\/h2>/);
  assert.doesNotMatch(windows, /## Image/);
  assert.equal(windows, unix);
});
