import test from "node:test";
import assert from "node:assert/strict";
import {
  clampWorldTags,
  syncAudienceTags,
  MAX_WORLD_TAGS,
  AUDIENCE_TAG_MALE,
  AUDIENCE_TAG_FEMALE,
} from "../../../shared/src/types/world.js";

test("clampWorldTags caps at MAX_WORLD_TAGS, keeping the leading tags", () => {
  const input = Array.from({ length: MAX_WORLD_TAGS + 23 }, (_, i) => `tag${i}`);
  const out = clampWorldTags(input);
  assert.equal(out.length, MAX_WORLD_TAGS);
  assert.deepEqual(out, input.slice(0, MAX_WORLD_TAGS));
});

test("clampWorldTags trims, drops empties, and de-dupes case-insensitively", () => {
  const out = clampWorldTags(["  NSFW ", "nsfw", "", "  ", "Anime", "anime"]);
  assert.deepEqual(out, ["NSFW", "Anime"]);
});

test("clampWorldTags always keeps the audience tag, even when over the cap", () => {
  // MAX+2 non-audience tags + a trailing audience tag (the real-world shape:
  // CHUB dumps put 男性向 last). The audience tag must survive the trim.
  const input = [...Array.from({ length: MAX_WORLD_TAGS + 2 }, (_, i) => `t${i}`), AUDIENCE_TAG_MALE];
  const out = clampWorldTags(input);
  assert.equal(out.length, MAX_WORLD_TAGS);
  assert.ok(out.includes(AUDIENCE_TAG_MALE));
  assert.equal(out[out.length - 1], AUDIENCE_TAG_MALE);
  assert.equal(out.filter((t) => t !== AUDIENCE_TAG_MALE).length, MAX_WORLD_TAGS - 1);
});

test("syncAudienceTags adds the audience tag without exceeding the cap", () => {
  const full = Array.from({ length: MAX_WORLD_TAGS }, (_, i) => `t${i}`);
  const out = syncAudienceTags(full, "male");
  assert.equal(out.length, MAX_WORLD_TAGS);
  assert.equal(out[out.length - 1], AUDIENCE_TAG_MALE);
});

test("syncAudienceTags('all') strips a single audience tag and stays within the cap", () => {
  const out = syncAudienceTags(["a", "b", AUDIENCE_TAG_MALE], "all");
  assert.deepEqual(out, ["a", "b"]);
});

test("syncAudienceTags('all') preserves both audience tags for either individual filter", () => {
  const out = syncAudienceTags(["原创", AUDIENCE_TAG_MALE, AUDIENCE_TAG_FEMALE], "all");
  assert.deepEqual(out, ["原创", AUDIENCE_TAG_MALE, AUDIENCE_TAG_FEMALE]);
});

test("syncAudienceTags normalizes both audience tags before preserving them", () => {
  const out = syncAudienceTags([
    "  原创  ", ` ${AUDIENCE_TAG_MALE} `, "", AUDIENCE_TAG_FEMALE, AUDIENCE_TAG_MALE,
  ], "all");
  assert.deepEqual(out, ["原创", AUDIENCE_TAG_MALE, AUDIENCE_TAG_FEMALE]);
});

for (const [audience, expectedTag] of [
  ["male", AUDIENCE_TAG_MALE],
  ["female", AUDIENCE_TAG_FEMALE],
] as const) {
  test(`syncAudienceTags explicitly switching to ${audience} replaces both audience tags`, () => {
    const out = syncAudienceTags(["原创", AUDIENCE_TAG_MALE, AUDIENCE_TAG_FEMALE], audience);
    assert.deepEqual(out, ["原创", expectedTag]);
  });
}

test("syncAudienceTags('all') reserves two slots for both audience tags at the cap", () => {
  const leadingTags = Array.from({ length: MAX_WORLD_TAGS }, (_, i) => `t${i}`);
  const out = syncAudienceTags([...leadingTags, AUDIENCE_TAG_MALE, AUDIENCE_TAG_FEMALE], "all");
  assert.equal(out.length, MAX_WORLD_TAGS);
  assert.deepEqual(out, [
    ...leadingTags.slice(0, MAX_WORLD_TAGS - 2), AUDIENCE_TAG_MALE, AUDIENCE_TAG_FEMALE,
  ]);
});
