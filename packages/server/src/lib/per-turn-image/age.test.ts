import assert from "node:assert/strict";
import test from "node:test";
import { isExplicitMoment, negativeFor, normalizeTags } from "./age.js";

test("sexualised youth tags are dropped", () => {
  const tags = normalizeTags("1girl, loli, lolita fashion, shota, black hair");
  assert.doesNotMatch(tags, /loli|shota/i);
});

test("everyone is anchored as an adult and loses youth tags", () => {
  const tags = normalizeTags("1girl, child, young girl, teenage, silver hair");
  assert.match(tags, /^1girl, adult/);
  assert.doesNotMatch(tags, /\bchild\b|young girl|teen/);
});

test("a look with no head count gets one", () => {
  assert.match(normalizeTags("short hair, son"), /^1boy/);
  assert.match(normalizeTags("short hair"), /^1girl/);
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

test("negative always pushes youth away", () => {
  const neg = negativeFor();
  assert.match(neg, /\bloli\b/);
  assert.match(neg, /\bchild\b/);
  assert.doesNotMatch(neg, /\bnude\b/);
});

test("a checkpoint's own short negative still keeps loli/shota and the age guards", () => {
  const neg = negativeFor(true, "worst quality, low quality, watermark");
  assert.match(neg, /^worst quality, low quality, watermark, loli, shota, child/);
  assert.match(neg, /nsfw/);
  assert.equal(negativeFor(false, "bad, loli, shota"), "bad, loli, shota, child, aged down, petite child");
});
