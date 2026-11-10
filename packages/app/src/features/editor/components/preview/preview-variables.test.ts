import assert from "node:assert/strict";
import test from "node:test";
import type { WorldDefinition, WorldEntry } from "@yumina/engine";
import { resolvePreviewVariables } from "./preview-variables";

const opening = (id: string, extra: Partial<WorldEntry> = {}): WorldEntry => ({
  id, name: id, content: id, role: "greeting", section: "chat-history", position: 0,
  enabled: true, alwaysSend: false, keywords: [], conditions: [], conditionLogic: "all", ...extra,
});
const world = (extra: Partial<WorldDefinition> = {}): WorldDefinition => ({
  id: "card", name: "Card", description: "", author: "", version: "1", settings: {},
  entries: [], variables: [
    { id: "hp", name: "Health", type: "number", defaultValue: 100, min: 0, max: 100 },
    { id: "location", name: "Location", type: "string", defaultValue: "Town" },
    { id: "key", name: "Has key", type: "boolean", defaultValue: true },
    { id: "inventory", name: "Inventory", type: "json", defaultValue: { items: [] } },
  ], rules: [], reactions: [], components: [], customUI: [], audioTracks: [], worldbooks: [], ...extra,
});

test("a card without openings previews declared defaults and ignores stale override IDs", () => {
  const card = world();
  const before = structuredClone(card);
  assert.deepEqual(resolvePreviewVariables(card, "deleted", { removed: 12 }), {
    hp: 100, location: "Town", key: true, inventory: { items: [] },
  });
  assert.deepEqual(card, before);
});

test("default preview uses the first enabled opening and switching openings does not retain the previous seeds", () => {
  const card = world({ entries: [
    opening("draft", { enabled: false, initialVariables: { hp: 1 } }),
    opening("town", { initialVariables: { hp: 80 } }),
    opening("mine", { initialVariables: { location: "Mine", key: false } }),
  ] });
  const before = structuredClone(card);
  assert.equal(resolvePreviewVariables(card).hp, 80);
  const mine = resolvePreviewVariables(card, "mine");
  assert.equal(mine.hp, 100, "unseeded values restart from the card defaults");
  assert.equal(mine.location, "Mine");
  assert.equal(mine.key, false);
  assert.equal(resolvePreviewVariables(card, "town").location, "Town");
  assert.deepEqual(card, before, "selection does not rewrite opening order, values or enabled state");
});

test("disabled openings can be selected and deleted or changed-role selections use the same fallback as the picker", () => {
  const card = world({ entries: [
    opening("draft", { enabled: false, initialVariables: { hp: 10 } }),
    opening("town", { initialVariables: { hp: 80 } }),
    opening("setting", { role: "custom", initialVariables: { hp: 1 } }),
  ] });
  assert.equal(resolvePreviewVariables(card, "draft").hp, 10);
  assert.equal(resolvePreviewVariables(card, "deleted").hp, 80);
  assert.equal(resolvePreviewVariables(card, "setting").hp, 80);
  const disabledCard = { ...card, entries: card.entries.map(entry => ({ ...entry, enabled: false })) };
  assert.equal(resolvePreviewVariables(disabledCard, "deleted").hp, 10);
});

test("opening seeds resolve legacy display names and clamp numeric bounds using the engine", () => {
  const card = world({ entries: [
    opening("high", { initialVariables: { Health: 150, Location: "Harbor", "Has key": false, removed: 7 } }),
    opening("low", { initialVariables: { hp: -25 } }),
  ] });
  const high = resolvePreviewVariables(card, "high");
  assert.equal(high.hp, 100);
  assert.equal(high.location, "Harbor");
  assert.equal(high.key, false);
  assert.equal(resolvePreviewVariables(card, "low").hp, 0);
  assert.deepEqual(Object.keys(high).sort(), ["hp", "inventory", "key", "location"]);
});

test("an exact variable ID wins over another variable's display name, matching session state", () => {
  const card = world({ variables: [
    { id: "hp", name: "Health", type: "number", defaultValue: 100 },
    { id: "other", name: "hp", type: "number", defaultValue: 50 },
  ], entries: [opening("town", { initialVariables: { hp: 20 } })] });
  assert.deepEqual(resolvePreviewVariables(card), { hp: 20, other: 50 });
});

test("temporary preview controls win over seeds, including zero, false, empty text and structured values", () => {
  const card = world({ entries: [opening("town", { initialVariables: { hp: 50, location: "Mine", key: true } })] });
  const overrides = { hp: 0, location: "", key: false, inventory: ["torch"] };
  const before = structuredClone({ card, overrides });
  assert.deepEqual(resolvePreviewVariables(card, "town", overrides), overrides);
  assert.equal(resolvePreviewVariables(card, "town", { hp: 150 }).hp, 150, "manual preview values preserve their existing override behavior");
  assert.deepEqual({ card, overrides }, before);
  assert.equal(resolvePreviewVariables(card, "town").hp, 50, "clearing temporary overrides restores the opening seed");
});
