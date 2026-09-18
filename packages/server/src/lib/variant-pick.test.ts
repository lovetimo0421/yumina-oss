import assert from "node:assert/strict";
import test from "node:test";
import { pickViewerVariantId, pickViewerVariantIds, type VariantRow } from "./variant-pick.js";

// ── Community card embeds must not cross languages ──────────────────────────
// A thread cites one concrete world id. 89% of prod citations point at a card
// that has published siblings in another language, and 46 of 56 point at a
// non-English variant while an English one exists — so an English reader saw a
// Chinese name, cover and Play target on nearly every embed.

const G = "group-1";
const zh: VariantRow = { id: "w-zh", language: "zh", languageGroupId: G, isPrimaryVariant: true, createdAt: "2026-01-01" };
const en: VariantRow = { id: "w-en", language: "en", languageGroupId: G, isPrimaryVariant: true, createdAt: "2026-02-01" };
const enAlt: VariantRow = { id: "w-en-alt", language: "en-US", languageGroupId: G, isPrimaryVariant: false, createdAt: "2026-01-15" };
const ja: VariantRow = { id: "w-ja", language: "ja", languageGroupId: G, isPrimaryVariant: true, createdAt: "2026-03-01" };
const GROUP = [zh, en, enAlt, ja];

test("an English viewer gets the English sibling of a cited Chinese card", () => {
  assert.equal(pickViewerVariantId(zh, GROUP, "en"), "w-en");
});

test("exact language code wins over a regional form, primary wins next", () => {
  // en beats en-US even though en-US is older.
  assert.equal(pickViewerVariantId(zh, GROUP, "en"), "w-en");
  // With only the regional row available, it is still better than staying zh.
  assert.equal(pickViewerVariantId(zh, [zh, enAlt], "en"), "w-en-alt");
});

test("zh-Hant viewers resolve onto the zh pool, not away from it", () => {
  // Traditional shares the Simplified catalog everywhere else on the hub.
  assert.equal(pickViewerVariantId(en, GROUP, "zh-Hant"), "w-zh");
  assert.equal(pickViewerVariantId(zh, GROUP, "zh-TW"), "w-zh");
});

test("falls back to the cited card whenever there is nothing better", () => {
  // No viewer language.
  assert.equal(pickViewerVariantId(zh, GROUP, null), "w-zh");
  // Standalone card with no language group.
  const solo: VariantRow = { id: "solo", language: "zh", languageGroupId: null };
  assert.equal(pickViewerVariantId(solo, GROUP, "en"), "solo");
  // Group has no Spanish sibling — keep the author's card rather than guess.
  assert.equal(pickViewerVariantId(zh, GROUP, "es"), "w-zh");
  // Cited card is already in the viewer's language.
  assert.equal(pickViewerVariantId(en, GROUP, "en"), "w-en");
});

test("never picks a sibling from a different language group", () => {
  const otherGroup: VariantRow = { id: "other-en", language: "en", languageGroupId: "group-2", isPrimaryVariant: true };
  assert.equal(pickViewerVariantId(zh, [zh, otherGroup], "en"), "w-zh");
});

test("batch form maps every cited id, including untouched ones", () => {
  const solo: VariantRow = { id: "solo", language: "en", languageGroupId: null };
  const map = pickViewerVariantIds([zh, solo], GROUP, "en");
  assert.deepEqual([...map], [["w-zh", "w-en"], ["solo", "solo"]]);
});
