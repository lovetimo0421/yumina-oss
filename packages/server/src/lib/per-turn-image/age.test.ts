import assert from "node:assert/strict";
import test from "node:test";
import { isExplicitMoment, negativeFor, normalizeTags, stripExplicit } from "./age.js";

test("a minor keeps their age: no adult anchor, child tags kept", () => {
  const tags = normalizeTags("1girl, child, young girl, brown hair, twintails, yellow dress", true);
  assert.match(tags, /\bchild\b/);
  assert.match(tags, /young girl/);
  assert.doesNotMatch(tags, /\badult\b/);
});

test("a minor never carries an adult or mature tag even if the tagger wrote one", () => {
  assert.doesNotMatch(normalizeTags("1girl, mature, child", true), /\bmature\b/);
});

test("sexualised youth tags are dropped at every age", () => {
  for (const minor of [true, false]) {
    const tags = normalizeTags("1girl, loli, lolita fashion, shota, black hair", minor);
    assert.doesNotMatch(tags, /loli|shota/i);
  }
});

test("an adult is anchored as an adult and loses youth tags", () => {
  const tags = normalizeTags("1girl, child, silver hair", false);
  assert.match(tags, /^1girl, adult/);
  assert.doesNotMatch(tags, /\bchild\b/);
});

test("a look with no head count gets one", () => {
  assert.match(normalizeTags("child, short hair, son", true), /^1boy/);
  assert.match(normalizeTags("child, short hair", true), /^1girl/);
});

test("explicit = the tagger's flag or explicit tags in its own prompt", () => {
  assert.equal(isExplicitMoment(true, "", ""), true);
  assert.equal(isExplicitMoment(false, "eating, smiling", "kitchen"), false);
  // Tagger dropped the flag but still wrote sexual tags: still explicit.
  assert.equal(isExplicitMoment(false, "nude, lying on bed", "bedroom"), true);
  assert.equal(isExplicitMoment(false, "sitting", "see-through clothes"), true);
});

test("ordinary daily-life tags are not explicit", () => {
  for (const t of ["holding spoon, eating, smiling", "hugging, happy, father and daughter", "school bag, walking, sunny", "sleeping, blanket, pajamas"]) {
    assert.equal(isExplicitMoment(false, t), false, t);
  }
});

test("stripExplicit removes suggestive tags and keeps the rest", () => {
  assert.equal(stripExplicit("sitting, cleavage, smiling, underwear, park"), "sitting, smiling, park");
});

test("negative: a minor on screen gets the clothed/no-suggestion set, not the anti-child set", () => {
  const minor = negativeFor(true);
  assert.match(minor, /\bnude\b/);
  assert.match(minor, /suggestive/);
  assert.match(minor, /\bloli\b/);
  assert.doesNotMatch(minor, /\bchild\b/);
  const adult = negativeFor(false);
  assert.match(adult, /\bchild\b/);
  assert.doesNotMatch(adult, /\bnude\b/);
});

test("a checkpoint's own short negative still keeps loli/shota and the age guards", () => {
  const neg = negativeFor(false, true, "worst quality, low quality, watermark");
  assert.match(neg, /^worst quality, low quality, watermark, loli, shota, child/);
  assert.match(neg, /nsfw/);
  assert.equal(negativeFor(false, false, "bad, loli, shota"), "bad, loli, shota, child, aged down, petite child");
});
