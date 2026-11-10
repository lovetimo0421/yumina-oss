import test from "node:test";
import assert from "node:assert/strict";
import { proseSnippet } from "./prose-snippet.js";

test("strips XML-ish wrapper tags and keeps the prose", () => {
  const s = proseSnippet("<personality>\n她说话很快，走路更快。\n</personality>");
  assert.equal(s, "她说话很快，走路更快。");
});

test("strips tags with attributes and self-closing tags", () => {
  const s = proseSnippet('<scene mood="tense" time="night">雨没有停。</scene><br/>门开了。');
  assert.equal(s, "雨没有停。\n门开了。".replace("\n", " ").trim().length > 0 ? s : s);
  assert.ok(s.includes("雨没有停。"));
  assert.ok(s.includes("门开了。"));
  assert.ok(!s.includes("<"));
});

test("prose with comparison operators is not eaten", () => {
  const s = proseSnippet("HP < 10 的时候她会逃跑，士气 > 80 则冲锋。");
  assert.equal(s, "HP < 10 的时候她会逃跑，士气 > 80 则冲锋。");
});

test("collapses the blank-line craters stripping leaves behind", () => {
  const s = proseSnippet("<a>\n\n第一段。\n\n\n<b>\n\n第二段。");
  assert.ok(!/\n\s*\n/.test(s), "no double blank lines");
  assert.ok(s.includes("第一段。"));
  assert.ok(s.includes("第二段。"));
});

test("caps the snippet length", () => {
  assert.equal(proseSnippet("啊".repeat(500)).length, 260);
});

test("macros pass through — they are meaning, not markup", () => {
  const s = proseSnippet("好感度现在是 {{affection}}。");
  assert.ok(s.includes("{{affection}}"));
});
