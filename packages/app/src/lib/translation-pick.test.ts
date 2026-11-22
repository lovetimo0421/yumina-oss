import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLang, pickTranslatedContent, pickTranslatedIntroduction, pickTranslatedTitle } from "./translation-pick";

// Korean, Indonesian and Russian translations exist only for content from
// 2026-11-07 on. Older content has none, and those readers keep seeing the
// English translation they saw before rather than the untranslated source.

test("each UI language reads its own translation, zh-Hant reading zh", () => {
  assert.equal(normalizeLang("ko"), "ko");
  assert.equal(normalizeLang("id"), "id");
  assert.equal(normalizeLang("ru"), "ru");
  assert.equal(normalizeLang("zh-Hant"), "zh");
  assert.equal(normalizeLang("fr"), "en");
  assert.equal(normalizeLang(undefined), "en");
});

test("a Korean reader gets the Korean translation when it exists", () => {
  const thread = { translatedContent_en: "English", translatedContent_ko: "한국어", translatedTitle_en: "Title", translatedTitle_ko: "제목" };
  assert.equal(pickTranslatedContent(thread, "ko"), "한국어");
  assert.equal(pickTranslatedTitle(thread, "ko"), "제목");
  assert.equal(pickTranslatedContent(thread, "en"), "English");
});

test("newer-language readers fall back to English, older ones do not", () => {
  const old = { translatedContent_en: "English", translatedContent_ja: null, translatedIntroduction_en: "Intro" };
  assert.equal(pickTranslatedContent(old, "ru"), "English");
  assert.equal(pickTranslatedContent(old, "id"), "English");
  assert.equal(pickTranslatedIntroduction(old, "ko"), "Intro");
  // A Japanese reader never had an English fallback: no translation means the original.
  assert.equal(pickTranslatedContent(old, "ja"), null);
  // An English source has no English row, so there is nothing to fall back to.
  assert.equal(pickTranslatedContent({ translatedContent_zh: "中文" }, "ko"), null);
});
