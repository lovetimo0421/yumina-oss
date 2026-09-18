import test from "node:test";
import assert from "node:assert/strict";
import type { WorldEntry } from "@yumina/engine";
import { buildCreatedEntry, mapEntryUpdates } from "./entry-tool-helpers";

function makeBaseEntry(): WorldEntry {
  return {
    id: "base-entry",
    name: "Base Entry",
    content: "Base content",
    role: "lore",
    position: 0,
    alwaysSend: false,
    keywords: [],
    conditions: [],
    conditionLogic: "all",
    enabled: true,
    matchWholeWords: false,
    secondaryKeywords: [],
    secondaryKeywordLogic: "AND_ANY",
    preventRecursion: false,
    excludeRecursion: false,
    section: "system-presets",
  };
}

test("buildCreatedEntry creates an advanced lore entry with full matching metadata", () => {
  const entry = buildCreatedEntry(makeBaseEntry(), {
    id: "faction-secret",
    name: "Faction Secret",
    content: "The Ember Court hides a second throne.",
    role: "lore",
    position: 5,
    keywords: ["ember court"],
    conditions: [{ variable_id: "court-rank", operator: "gte", value: 3 }],
    condition_logic: "all",
    match_whole_words: true,
    secondary_keywords: ["archive", "vault"],
    secondary_keyword_logic: "AND_ANY",
    prevent_recursion: true,
    exclude_recursion: false,
  });

  assert.deepEqual(entry.conditions, [
    { variableId: "court-rank", operator: "gte", value: 3 },
  ]);
  assert.equal(entry.matchWholeWords, true);
  assert.deepEqual(entry.secondaryKeywords, ["archive", "vault"]);
  assert.equal(entry.preventRecursion, true);
  assert.equal(entry.excludeRecursion, false);
});

test("mapEntryUpdates maps advanced lore update fields", () => {
  const updates = mapEntryUpdates({
    content: "Updated lore text",
    conditions: [{ variable_id: "knowledge", operator: "eq", value: true }],
    secondary_keywords: ["sigil"],
    secondary_keyword_logic: "NOT_ANY",
    exclude_recursion: true,
  });

  assert.deepEqual(updates, {
    content: "Updated lore text",
    conditions: [{ variableId: "knowledge", operator: "eq", value: true }],
    secondaryKeywords: ["sigil"],
    secondaryKeywordLogic: "NOT_ANY",
    excludeRecursion: true,
  });
});

test("partial updates preserve existing advanced lore fields when applied", () => {
  const original = buildCreatedEntry(makeBaseEntry(), {
    keywords: ["throne"],
    conditions: [{ variable_id: "rank", operator: "gte", value: 2 }],
    match_whole_words: true,
    secondary_keywords: ["crown"],
    secondary_keyword_logic: "AND_ALL",
    prevent_recursion: true,
    exclude_recursion: true,
  });

  const updated = {
    ...original,
    ...mapEntryUpdates({
      content: "Only the prose changed.",
    }),
  };

  assert.equal(updated.content, "Only the prose changed.");
  assert.deepEqual(updated.conditions, original.conditions);
  assert.equal(updated.matchWholeWords, true);
  assert.deepEqual(updated.secondaryKeywords, ["crown"]);
  assert.equal(updated.secondaryKeywordLogic, "AND_ALL");
  assert.equal(updated.preventRecursion, true);
  assert.equal(updated.excludeRecursion, true);
});
