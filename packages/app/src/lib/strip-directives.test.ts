import assert from "node:assert/strict";
import test from "node:test";
import { stripDirectives, stripDirectivesForSandbox } from "./strip-directives";

// Both are the engine's cleanDisplayText (the parser's own clean text, trimmed
// at the end), so what streams matches what the server saves.

test("stripDirectives removes a completed speaker tag like any other directive", () => {
  assert.equal(stripDirectives("[speaker: Balder] The forge roars. [hp: -1]"), "The forge roars.");
});

test("stripDirectivesForSandbox keeps the leading speaker tag and strips the rest", () => {
  assert.equal(
    stripDirectivesForSandbox("[speaker: Balder]  \nThe forge roars. [hp: -1]"),
    "[speaker: Balder]\nThe forge roars.",
  );
  assert.equal(stripDirectivesForSandbox("[speaker: Mia Chen] Hi."), "[speaker: Mia Chen]\nHi.");
});

test("stripDirectivesForSandbox holds a partial leading tag instead of leaking it", () => {
  for (const partial of ["[", "[s", "[spea", "[speaker", "[speaker:", "[speaker: Bal"]) {
    assert.equal(stripDirectivesForSandbox(partial), partial, partial);
  }
});

test("stripDirectivesForSandbox is the plain stripper when there is no tag", () => {
  assert.equal(stripDirectivesForSandbox("Plain prose. [gold: +5]"), "Plain prose.");
  assert.equal(stripDirectivesForSandbox("Text first. [speaker: Mia]"), "Text first.");
});

test("stripDirectives hides dot-path tags whose key has a middle dot, and bare-scalar merges", () => {
  assert.equal(stripDirectives("她笑了。[relations.艾丝·华伦斯坦: +20]"), "她笑了。");
  assert.equal(stripDirectives("他点头。[relations.韦尔夫·克罗佐: merge 20]"), "他点头。");
  assert.equal(stripDirectives('好。[relations: merge {"莉莉露卡·厄德": 30}]'), "好。");
});

test("stripDirectives hides dot-path tags whose key has spaces, but keeps bracketed prose", () => {
  assert.equal(stripDirectives("She nods. [relations.Riveria Ljos Alf: +1]"), "She nods.");
  assert.equal(stripDirectives("Asiente. [relations.Bell Cranel: merge 20]"), "Asiente.");
  assert.equal(stripDirectives("[Chapter One: Begin] The road."), "[Chapter One: Begin] The road.");
});

test("stripDirectives hides directives written with a placeholder prefix", () => {
  assert.equal(stripDirectives('她冷笑。[variable: mood: set "angry"][var: location: set "奖品陈列室"]'), "她冷笑。");
  assert.equal(stripDirectives("Hit. [Variable: hp: -10]"), "Hit.");
  assert.equal(stripDirectives('Ok.\n[variableId: game-state.location: set "客厅"]'), "Ok.");
  assert.equal(stripDirectives("[var: set 3] ok"), "ok");
  assert.equal(stripDirectivesForSandbox('[speaker: Mia] Hi. [variable: tone: set "tense"]'), "[speaker: Mia]\nHi.");
});

test("stripDirectives hides bookkeeping wrappers, whole or still arriving", () => {
  assert.equal(stripDirectives("Hi.<directive>\n\n</directive>"), "Hi.");
  assert.equal(stripDirectives('Hi.<directive>\n[mood: set "calm"]\n</directive>'), "Hi.");
  assert.equal(stripDirectives("Hi.<rationale>\nHer Guard drops [guard: -10].\n</rationale>"), "Hi.");
  assert.equal(stripDirectives("Hi.<rationale>\nHer Guard dr"), "Hi.");
  assert.equal(stripDirectives("好。[state-changes]\n\n[/state-changes]"), "好。");
  assert.equal(stripDirectives("好。[state-changes]\n\n</state-changes>"), "好。");
  assert.equal(stripDirectives("好。[state-changes]\n"), "好。");
  for (const partial of ["<rati", "</direct", "[state-ch", "<state-changes", "[/state"]) {
    assert.equal(stripDirectives(`Hi.${partial}`), "Hi.", partial);
  }
  assert.equal(stripDirectives("<inner>想逃</inner> <options>1. 留下</options>"), "<inner>想逃</inner> <options>1. 留下</options>");
});

test("stripDirectives hides malformed state lines by the line rule, keeps card display lines", () => {
  const ids = ["events", "location", "min_jun"];
  assert.equal(stripDirectives('门开了。\n[state: {"location": "x", "mood": "y"}]'), "门开了。");
  assert.equal(stripDirectives('门开了。\n[events: set "Patient_Discharged" true]'), "门开了。");
  assert.equal(stripDirectives('门开了。\n[min_jun: "vanished" forever]', ids), "门开了。");
  assert.equal(stripDirectives('门开了。\n[min_jun: "vanished" forever]'), '门开了。\n[min_jun: "vanished" forever]');
  assert.equal(stripDirectives("门开了。\n[Day 3: Morning]\n[时间：清晨]", ids), "门开了。\n[Day 3: Morning]\n[时间：清晨]");
  assert.equal(stripDirectives("门开了。\n[image: /cdn/key/abc]", ids), "门开了。\n[image: /cdn/key/abc]");
});

test("host streaming cleanup preserves authored display blocks and the leading speaker", () => {
  const rules = [{ id: "display", match: { pattern: "\\[mood \\|[^\\]]*\\]" }, hide: false }];
  assert.equal(stripDirectives("Story.\n[mood | calm]\n[hp: -1]", ["mood", "hp"], rules), "Story.\n[mood | calm]");
  assert.equal(stripDirectivesForSandbox("[speaker: Mia]\nStory.\n[mood | calm]", ["mood"], rules), "[speaker: Mia]\nStory.\n[mood | calm]");
});
