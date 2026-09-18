import test from "node:test";
import assert from "node:assert/strict";
import { stripHtml, sanitizeContent } from "./sanitize.js";

// Regression: stripHtml used /<\/?[^>]+(>|$)/g which deleted ANY angle-bracket
// span, mangling legitimate roleplay/markdown text on DMs, posts and reviews.
// It should remove real HTML (and script/style payloads) but leave prose alone.

test("stripHtml keeps roleplay angle-bracket words like <sighs>", () => {
  assert.equal(stripHtml("She pauses *<sighs>* softly"), "She pauses *<sighs>* softly");
});

test("stripHtml keeps the <3 emoticon", () => {
  assert.equal(stripHtml("love this <3"), "love this <3");
});

test("stripHtml keeps math/comparison angle brackets", () => {
  assert.equal(stripHtml("if a < b and b > c then ok"), "if a < b and b > c then ok");
});

test("stripHtml removes a <script> block including its payload", () => {
  assert.equal(stripHtml("hi <script>alert(1)</script> there"), "hi  there");
});

test("stripHtml removes a <style> block including its payload", () => {
  assert.equal(stripHtml("a <style>body{color:red}</style> b"), "a  b");
});

test("stripHtml removes real HTML formatting tags", () => {
  assert.equal(stripHtml("<div class='x'>hello</div>"), "hello");
  assert.equal(stripHtml("<b>bold</b> and <i>italic</i>"), "bold and italic");
});

test("stripHtml removes an iframe tag", () => {
  assert.equal(stripHtml('<iframe src="evil"></iframe>x'), "x");
});

test("sanitizeContent preserves roleplay text while trimming/collapsing", () => {
  assert.equal(sanitizeContent("  *<grins>* yes <3\n\n\n\nok  "), "*<grins>* yes <3\n\nok");
});
