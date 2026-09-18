// The tag vocabulary's invariants. Two entries that render the same chip, or an
// alias that is also somebody else's canonical, both produce the exact bug this
// table was built to remove — a filter row with the same word twice and no way
// to tell which card set is behind which chip.
import test from "node:test";
import assert from "node:assert/strict";
import {
  TAG_VOCABULARY,
  OFFICIAL_WORLD_TAGS,
  canonicalizeTag,
  tagLabel,
  findTagEntry,
} from "../dist/index.js";

const LOCALES = ["zh", "zh-Hant", "en", "ja", "es"];

test("every entry has a non-empty label in every locale", () => {
  for (const e of TAG_VOCABULARY) {
    for (const l of LOCALES) {
      assert.equal(typeof e.labels[l], "string", `${e.canonical} missing ${l}`);
      assert.ok(e.labels[l].trim().length > 0, `${e.canonical} has an empty ${l} label`);
    }
  }
});

test("no alias collides with another entry's canonical", () => {
  const canonicals = new Map(TAG_VOCABULARY.map((e) => [e.canonical.toLowerCase(), e.canonical]));
  for (const e of TAG_VOCABULARY) {
    for (const a of e.aliases ?? []) {
      const owner = canonicals.get(a.toLowerCase());
      assert.ok(
        owner === undefined || owner === e.canonical,
        `alias "${a}" of ${e.canonical} is also the canonical of ${owner}`,
      );
    }
  }
});

test("no two entries render the same chip in any locale", () => {
  for (const l of LOCALES) {
    const seen = new Map();
    for (const e of TAG_VOCABULARY) {
      const key = e.labels[l].trim().toLowerCase();
      const prev = seen.get(key);
      assert.equal(prev, undefined, `${l}: "${e.labels[l]}" is used by both ${prev} and ${e.canonical}`);
      seen.set(key, e.canonical);
    }
  }
});

test("no tag is claimed by two entries on the write path", () => {
  const seen = new Map();
  for (const e of TAG_VOCABULARY) {
    for (const form of [e.canonical, ...(e.aliases ?? []), ...Object.values(e.labels)]) {
      const key = form.trim().toLowerCase();
      const prev = seen.get(key);
      assert.ok(prev === undefined || prev === e.canonical, `"${form}" resolves to both ${prev} and ${e.canonical}`);
      seen.set(key, e.canonical);
    }
  }
});

test("the official subset matches OFFICIAL_WORLD_TAGS", () => {
  const official = TAG_VOCABULARY.filter((e) => e.official).map((e) => e.canonical);
  assert.deepEqual([...official].sort(), [...OFFICIAL_WORLD_TAGS].sort());
});

test("canonicalizeTag folds every known form onto the stored value", () => {
  for (const e of TAG_VOCABULARY) {
    for (const form of [e.canonical, ...(e.aliases ?? []), ...Object.values(e.labels)]) {
      assert.equal(canonicalizeTag(form), e.canonical, `${form} should canonicalize to ${e.canonical}`);
      assert.equal(canonicalizeTag(` ${form.toUpperCase()} `), e.canonical, `${form} should canonicalize case- and space-insensitively`);
    }
  }
});

test("an unknown tag passes through untouched, in both directions", () => {
  assert.equal(canonicalizeTag("  某个没人用过的标签  "), "某个没人用过的标签");
  assert.equal(tagLabel("某个没人用过的标签", "ja"), "某个没人用过的标签");
  assert.equal(findTagEntry("某个没人用过的标签"), undefined);
});

test("the merges that motivated the table actually fold", () => {
  for (const [input, expected] of [
    ["Romance", "恋爱"], ["romance", "恋爱"], ["戀愛", "恋爱"],
    ["anime", "动漫"], ["Anime", "动漫"],
    ["nsfw", "NSFW"], ["Nsfw", "NSFW"],
    ["Character Card", "角色卡"], ["character", "角色卡"],
    ["搾精", "榨精"],
  ]) {
    assert.equal(canonicalizeTag(input), expected);
  }
});
