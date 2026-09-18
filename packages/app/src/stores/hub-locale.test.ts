import assert from "node:assert/strict";
import test from "node:test";
import i18n from "@/lib/i18n";
import { currentTagLocale } from "@/lib/hub-tag-locale";
import { TAG_VOCABULARY, tagLabel } from "@yumina/shared";

test("Discover renders tags before the asynchronous language initialization finishes", () => {
  const original = i18n.language;
  try {
    i18n.language = undefined as unknown as string;
    const tag = TAG_VOCABULARY.find((entry) => entry.official)!;
    assert.equal(currentTagLocale(), "en");
    assert.equal(tagLabel(tag.canonical, currentTagLocale()), tag.labels.en);
    i18n.language = "zh-Hant";
    assert.equal(currentTagLocale(), "zh-Hant");
  } finally {
    i18n.language = original;
  }
});
