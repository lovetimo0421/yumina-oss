import assert from "node:assert/strict";
import test from "node:test";
import { clampLanguage, contentLanguage, SUPPORTED_LANGUAGES } from "./language-clamp.js";

// ── Traditional Chinese UI routing ──────────────────────────────────────────
// clampLanguage decides which UI locale (and translation bundle) a detected or
// stored language resolves to. `zh-Hant` is its own UI locale: the Traditional
// regions (TW/HK/MO) and the Hant script subtag route to it, while every other
// zh form stays Simplified. contentLanguage then collapses zh-Hant back onto the
// shared `zh` catalog when tagging a world's content language — so Traditional
// creators publish into the same pool Simplified creators do.

test("clampLanguage routes Traditional regions + Hant script to zh-Hant", () => {
  for (const form of ["zh-Hant", "zh-hant", "zh-TW", "zh-tw", "zh-HK", "zh-MO", "zh-Hant-TW"]) {
    assert.equal(clampLanguage(form), "zh-Hant", form);
  }
});

test("clampLanguage keeps Simplified + other zh forms on zh", () => {
  for (const form of ["zh", "zh-CN", "zh-Hans", "zh-SG", "zh-yue"]) {
    assert.equal(clampLanguage(form), "zh", form);
  }
});

test("clampLanguage handles the other UI locales and unknowns", () => {
  assert.equal(clampLanguage("en"), "en");
  assert.equal(clampLanguage("en-US"), "en");
  assert.equal(clampLanguage("ja"), "ja");
  assert.equal(clampLanguage("es-419"), "es");
  assert.equal(clampLanguage("ko"), "en"); // unsupported UI → English
  assert.equal(clampLanguage(null), "en");
  assert.equal(clampLanguage(""), "en");
});

test("contentLanguage collapses zh-Hant onto the shared zh pool", () => {
  assert.equal(contentLanguage("zh-Hant"), "zh");
  assert.equal(contentLanguage("zh-TW"), "zh");
  assert.equal(contentLanguage("zh"), "zh");
  assert.equal(contentLanguage("en"), "en");
  assert.equal(contentLanguage("ja"), "ja");
});

test("zh-Hant is a registered UI locale", () => {
  assert.ok(SUPPORTED_LANGUAGES.includes("zh-Hant"));
});
