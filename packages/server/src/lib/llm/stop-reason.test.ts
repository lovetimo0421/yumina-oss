import test from "node:test";
import assert from "node:assert/strict";
import { normalizeStopReason, replyCutOf } from "./stop-reason.js";

test("finish reasons read the same from every provider", () => {
  assert.equal(normalizeStopReason("length"), "max_tokens");
  assert.equal(normalizeStopReason("MAX_TOKENS"), "max_tokens");
  assert.equal(normalizeStopReason("SAFETY"), "content_filter");
  assert.equal(normalizeStopReason("PROHIBITED_CONTENT"), "content_filter");
  assert.equal(normalizeStopReason("content_filter"), "content_filter");
  assert.equal(normalizeStopReason("stop"), "stop");
  assert.equal(normalizeStopReason(null), undefined);
});

test("a reply is cut only when it stopped early", () => {
  assert.equal(replyCutOf("max_tokens"), "length");
  assert.equal(replyCutOf("content_filter"), "filter");
  assert.equal(replyCutOf("SAFETY"), "filter");
  assert.equal(replyCutOf("stop"), undefined);
  assert.equal(replyCutOf("end_turn"), undefined);
  assert.equal(replyCutOf(undefined), undefined);
});
