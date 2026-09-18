import assert from "node:assert/strict";
import test from "node:test";
import { playthroughGalleryWorldIds } from "./playthrough-scope.js";

// ── Shared-playthrough gallery scope ────────────────────────────────────────
// Two live bugs bracket this helper, and both must stay fixed:
//   - too narrow (single worldId): a share made on a same-language non-primary
//     sibling vanished from the card page, which always keys on the 主 row.
//   - too wide (whole languageGroup): the English page of IVE Simulator listed
//     a Chinese playthrough 「IVE 模拟器」 that an English reader can't read.

const EN = { id: "w-en", language: "en" };
const EN_ALT = { id: "w-en-2", language: "en-US" };
const ZH = { id: "w-zh", language: "zh" };
const ZH_HANT = { id: "w-zh-hant", language: "zh-Hant" };
const JA = { id: "w-ja", language: "ja" };
const GROUP = [EN, EN_ALT, ZH, ZH_HANT, JA];

test("English page never lists a Chinese variant's playthroughs", () => {
  const ids = playthroughGalleryWorldIds(EN, GROUP);
  assert.ok(!ids.includes(ZH.id), "zh sibling must not leak onto the en page");
  assert.ok(!ids.includes(ZH_HANT.id), "zh-Hant sibling must not leak onto the en page");
  assert.ok(!ids.includes(JA.id), "ja sibling must not leak onto the en page");
});

test("same-language siblings stay in scope (regional forms included)", () => {
  assert.deepEqual(playthroughGalleryWorldIds(EN, GROUP).sort(), ["w-en", "w-en-2"]);
  // zh-Hant shares the zh pool everywhere else on the hub; the gallery matches.
  assert.deepEqual(playthroughGalleryWorldIds(ZH, GROUP).sort(), ["w-zh", "w-zh-hant"]);
});

test("the page's own world is always in scope", () => {
  // Sibling read came back empty (replica lag / a just-created row).
  assert.deepEqual(playthroughGalleryWorldIds(EN, []), ["w-en"]);
  // Page world somehow absent from its own group read.
  assert.deepEqual(playthroughGalleryWorldIds(EN, [ZH]), ["w-en"]);
});

test("an untagged world only aggregates other untagged siblings", () => {
  const untagged = { id: "w-null", language: null };
  const untaggedSibling = { id: "w-null-2", language: null };
  const ids = playthroughGalleryWorldIds(untagged, [untagged, untaggedSibling, ZH, EN]);
  assert.deepEqual(ids.sort(), ["w-null", "w-null-2"]);
});
