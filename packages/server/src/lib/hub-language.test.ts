import assert from "node:assert/strict";
import test from "node:test";
// Import the leaf module, not recommendations.js — the latter pulls in the DB
// pool and Redis, which keeps the test process alive forever after the
// assertions pass.
import { hubLanguageChain, normalizeEditorialLanguage, normalizeHubLanguage, normalizeWorldLanguage, resolveHubLanguageScope, variantLanguages } from "./world-language.js";

// ── Traditional/Simplified Chinese card-sharing guarantee ───────────────────
// Traditional Chinese (`zh-Hant`) is a UI-only locale that shares the Simplified
// (`zh`) Discover catalog. That sharing rests ENTIRELY on these two normalizers
// collapsing every Traditional form down to `zh`:
//   - normalizeHubLanguage clamps the viewer's `lang` query param → the hub the
//     viewer browses. zh-Hant → zh means a Traditional viewer sees zh cards.
//   - normalizeWorldLanguage normalizes a world's stored `language` on write.
//     zh-Hant → zh means a Traditional creator's card lands in the zh pool.
// If either regressed (e.g. someone promoted "zh-Hant" to a distinct
// HubLanguage), the two Chinese audiences would silently split into separate
// catalogs — exactly what this feature exists to prevent.

test("normalizeHubLanguage collapses every Traditional form to the zh hub", () => {
  for (const form of ["zh-Hant", "zh-hant", "zh-TW", "zh-tw", "zh-HK", "zh-MO", "zh_TW"]) {
    assert.equal(normalizeHubLanguage(form), "zh", `${form} should browse the zh hub`);
  }
});

test("normalizeHubLanguage leaves Simplified + the other hubs intact", () => {
  assert.equal(normalizeHubLanguage("zh"), "zh");
  assert.equal(normalizeHubLanguage("zh-CN"), "zh");
  assert.equal(normalizeHubLanguage("zh-Hans"), "zh");
  assert.equal(normalizeHubLanguage("en"), "en");
  assert.equal(normalizeHubLanguage("ja"), "ja");
  assert.equal(normalizeHubLanguage("es"), "es");
  assert.equal(normalizeHubLanguage("ko"), "ko");
  assert.equal(normalizeHubLanguage("ko-KR"), "ko");
  assert.equal(normalizeHubLanguage("id"), "id");
  assert.equal(normalizeHubLanguage("id-ID"), "id");
  assert.equal(normalizeHubLanguage("ru"), "ru");
  assert.equal(normalizeHubLanguage("ru-RU"), "ru");
  assert.equal(normalizeHubLanguage("fr"), null); // unsupported → no hub scope
  assert.equal(normalizeHubLanguage(null), null);
});

test("resolveHubLanguageScope only removes the language limit when explicitly enabled", () => {
  assert.equal(resolveHubLanguageScope("ja"), "ja");
  assert.equal(resolveHubLanguageScope("zh-Hant", false), "zh");
  assert.equal(resolveHubLanguageScope("en", true), null);
  assert.equal(resolveHubLanguageScope("ja", true), null);
  assert.equal(resolveHubLanguageScope("ko"), "ko");
  assert.equal(resolveHubLanguageScope("id"), "id");
  assert.equal(resolveHubLanguageScope("ru"), "ru");
  assert.equal(resolveHubLanguageScope("fr"), "en");
  assert.equal(resolveHubLanguageScope("ko", true), null);
  assert.equal(resolveHubLanguageScope(null), null);
  assert.equal(resolveHubLanguageScope(""), null);
});

test("normalizeWorldLanguage stores every Traditional form as zh", () => {
  for (const form of ["zh-Hant", "zh-TW", "zh-HK", "zh_TW"]) {
    assert.equal(normalizeWorldLanguage(form), "zh", `${form} should be stored as zh`);
  }
  assert.equal(normalizeWorldLanguage("zh"), "zh");
  assert.equal(normalizeWorldLanguage("en-US"), "en");
  assert.equal(normalizeWorldLanguage("ko"), "ko"); // non-hub languages preserved
});

test("the Korean hub shows Korean cards only", () => {
  assert.deepEqual(hubLanguageChain("ko"), ["ko"]);
  assert.deepEqual(hubLanguageChain("ja"), ["ja"]);
  assert.deepEqual(hubLanguageChain("zh"), ["zh"]);
});

test("the Indonesian hub shows Indonesian cards first, then English ones", () => {
  assert.deepEqual(hubLanguageChain("id"), ["id", "en"]);
});

test("the Russian hub shows Russian cards first, then English ones", () => {
  assert.deepEqual(hubLanguageChain("ru"), ["ru", "en"]);
});

test("editorial and community surfaces show Korean viewers the English lineup", () => {
  assert.equal(normalizeEditorialLanguage("ko"), "en");
  assert.equal(normalizeEditorialLanguage("id"), "en");
  assert.equal(normalizeEditorialLanguage("ru"), "en");
  assert.equal(normalizeEditorialLanguage("ja"), "ja");
  assert.equal(normalizeEditorialLanguage("zh-Hant"), "zh");
});

test("editorial picks show a Korean viewer the card's Korean version when it has one", () => {
  assert.deepEqual(variantLanguages("ko", "en"), ["ko", "en"]);
  assert.deepEqual(variantLanguages("id", "en"), ["id", "en"]);
  assert.deepEqual(variantLanguages("ru", "en"), ["ru", "en"]);
  assert.deepEqual(variantLanguages("en", "en"), ["en"]);
  assert.deepEqual(variantLanguages("zh-Hant", "zh"), ["zh"]);
  assert.deepEqual(variantLanguages(null, "en"), ["en"]);
});
