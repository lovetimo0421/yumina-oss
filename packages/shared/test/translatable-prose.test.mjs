import assert from "node:assert/strict";
import test from "node:test";
import {
  TRANSLATION_PENDING_WINDOW_MS,
  hasTranslatableProse,
  isTranslationPending,
} from "../dist/index.js";

const NOW = Date.parse("2026-08-30T12:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();

test("invite-code replies carry no prose a translator could act on", () => {
  // Verbatim from the invite-code thread, where every one of these sat on
  // "translating..." forever because the server had already closed them out.
  assert.equal(hasTranslatableProse("PN9399J4 ^_^"), false);
  assert.equal(hasTranslatableProse("8DZX5MZL"), false);
  assert.equal(hasTranslatableProse("9QS32Q2M 🙏🙏"), false);
  assert.equal(hasTranslatableProse("8CBJ3BMH🙏🙏"), false);
  assert.equal(hasTranslatableProse("+1"), false);
  assert.equal(hasTranslatableProse("https://yumina.io/invite/32PHLWQ7"), false);
});

test("a code with a thank-you attached still has prose to translate", () => {
  assert.equal(hasTranslatableProse("2XQU58BQ 谢谢🙏"), true);
  assert.equal(hasTranslatableProse("ZLWSEGYM 麻煩了"), true);
  assert.equal(hasTranslatableProse("", "📌 邀请码互助专楼｜分享邀请码请来这里～"), true);
});

test("prose-free sources are never pending, however fresh", () => {
  assert.equal(isTranslationPending("PN9399J4 ^_^", undefined, ago(0), NOW), false);
  assert.equal(isTranslationPending("8DZX5MZL", undefined, ago(1000), NOW), false);
});

test("a real reply is pending inside the window and settled after it", () => {
  assert.equal(isTranslationPending("hello everyone", undefined, ago(60_000), NOW), true);
  assert.equal(
    isTranslationPending("hello everyone", undefined, ago(TRANSLATION_PENDING_WINDOW_MS + 1), NOW),
    false,
  );
});

test("an unknown or unparseable timestamp keeps the old always-pending behavior", () => {
  assert.equal(isTranslationPending("hello everyone", undefined, undefined, NOW), true);
  assert.equal(isTranslationPending("hello everyone", undefined, null, NOW), true);
  assert.equal(isTranslationPending("hello everyone", undefined, "not a date", NOW), true);
});

test("a title with prose keeps a body of pure emoji pending", () => {
  // Matches the server, which hashes title and body together before deciding.
  assert.equal(isTranslationPending("🙏🙏", "求助：这张卡怎么开局", ago(60_000), NOW), true);
});
