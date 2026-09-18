import test from "node:test";
import assert from "node:assert/strict";
import {
  GENDER_LINE_RE,
  getGenderFromContent,
  setGenderInContent,
  resolveGenderLocale,
  detectContentLocale,
} from "./gender-line";

test("parses the legacy Chinese line (full-width colon)", () => {
  assert.equal(getGenderFromContent("性别：女\nAsreth is a fantasy world."), "female");
  assert.equal(getGenderFromContent("性别：男"), "male");
  assert.equal(getGenderFromContent("性别: 其他"), "other");
});

test("parses every locale variant it can write", () => {
  assert.equal(getGenderFromContent("Gender: Female\nbody"), "female");
  assert.equal(getGenderFromContent("Género: Hombre"), "male");
  assert.equal(getGenderFromContent("性別：女性\n本文"), "female"); // ja
  assert.equal(getGenderFromContent("性別：その他"), "other"); // ja
  assert.equal(getGenderFromContent("性別：女"), "female"); // zh-Hant
  assert.equal(getGenderFromContent("gender: male"), "male"); // case-insensitive latin
});

test("does not match mid-prose mentions", () => {
  assert.equal(getGenderFromContent("Her gender: female is noted in the file."), null);
  assert.equal(getGenderFromContent("性别是女这件事"), null);
});

test("only the FIRST line is ever read — hand-written lines below are invisible", () => {
  const authored = "An elven ranger.\nGender: Female\nHeight: 170cm";
  assert.equal(getGenderFromContent(authored), null);
  // …and never touched: toggling a gender on prepends, leaving the statblock intact.
  assert.equal(
    setGenderInContent(authored, "male", "en"),
    "Gender: Male\nAn elven ranger.\nGender: Female\nHeight: 170cm",
  );
});

test("a label with the value on the next line is NOT a gender line", () => {
  const stat = "Gender:\nFemale\nrest of the stat block";
  assert.equal(getGenderFromContent(stat), null);
  assert.equal(setGenderInContent(stat, null, "en"), stat); // toggle-off is a no-op
});

test("toggle-off with no picker line never rewrites content (blank lines survive)", () => {
  const spaced = "intro\n\n\n\nact two";
  assert.equal(setGenderInContent(spaced, null, "en"), spaced);
});

test("legacy Chinese first line + hand-written line below: clear removes only the first", () => {
  const both = "性别：女\nbio\nGender: Male";
  assert.equal(getGenderFromContent(both), "female");
  const cleared = setGenderInContent(both, null, "en");
  assert.equal(cleared, "bio\nGender: Male");
  assert.equal(getGenderFromContent(cleared), null); // picker state actually clears
});

test("en card gets an English line, not Chinese", () => {
  const out = setGenderInContent("A slave market world.", "female", "en");
  assert.equal(out, "Gender: Female\nA slave market world.");
  assert.equal(getGenderFromContent(out), "female");
});

test("zh card keeps the Chinese form", () => {
  const out = setGenderInContent("正文", "male", "zh");
  assert.equal(out, "性别：男\n正文");
});

test("ja / es / zh-Hant serialize in their own language", () => {
  assert.equal(setGenderInContent("", "female", "ja"), "性別：女性");
  assert.equal(setGenderInContent("", "other", "es"), "Género: Otro");
  assert.equal(setGenderInContent("", "male", "zh-Hant"), "性別：男");
});

test("card language wins over UI locale; UI locale is the fallback", () => {
  assert.equal(setGenderInContent("", "female", "en", "zh"), "Gender: Female");
  assert.equal(setGenderInContent("", "female", null, "zh"), "性别：女");
  assert.equal(setGenderInContent("", "female", null, undefined), "Gender: Female"); // final fallback en
});

test("null card language sniffs the content before trusting the UI locale", () => {
  // Legacy zh card (language column null) viewed with an EN UI must NOT get
  // an English line injected into Chinese prose.
  assert.equal(setGenderInContent("她是一位剑士。", "female", null, "en"), "性别：女\n她是一位剑士。");
  assert.equal(setGenderInContent("彼女は剣士です。", "female", null, "en"), "性別：女性\n彼女は剣士です。");
  // No CJK signal → UI locale decides.
  assert.equal(setGenderInContent("A swordswoman.", "female", null, "en"), "Gender: Female\nA swordswoman.");
  assert.equal(detectContentLocale("plain latin text"), null);
});

test("replaces an existing legacy Chinese line in place on an en card", () => {
  const legacy = "性别：女\nAsreth is a fantasy world.";
  const out = setGenderInContent(legacy, "male", "en");
  assert.equal(out, "Gender: Male\nAsreth is a fantasy world.");
});

test("toggle-off removes the line whatever locale it was written in", () => {
  assert.equal(setGenderInContent("Gender: Female\nbody", null, "en"), "body");
  assert.equal(setGenderInContent("性别：女\n正文", null, "en"), "正文");
  assert.equal(setGenderInContent("no line here", null, "en"), "no line here");
});

test("CRLF content still round-trips the first line", () => {
  assert.equal(getGenderFromContent("Gender: Female\r\nbody"), "female");
});

test("language tag variants normalize (zh-CN, zh-TW, zh-MO, es-MX, unknown)", () => {
  assert.equal(resolveGenderLocale("zh-CN").label, "性别");
  assert.equal(resolveGenderLocale("zh-TW").label, "性別");
  assert.equal(resolveGenderLocale("zh-MO").label, "性別"); // Macau → Traditional, same as clampLanguage
  assert.equal(resolveGenderLocale("es-MX").label, "Género");
  assert.equal(resolveGenderLocale("pt").label, "Gender"); // unsupported → en
});

test("regex matches exactly one full line", () => {
  assert.equal(GENDER_LINE_RE.test("prefix Gender: Female"), false);
  assert.equal(GENDER_LINE_RE.test("Gender: Female suffix"), false);
  assert.equal(GENDER_LINE_RE.test("Gender: Female"), true);
  assert.equal(GENDER_LINE_RE.test("x\nGender: Female\ny"), false); // no m flag — callers test a single line
});
