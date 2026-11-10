import assert from "node:assert/strict";
import test from "node:test";
import { simpleArchetypeLabelOf, simpleArchetypeOf } from "./simple-archetype";

const character = { role: "character" };
const preset = { role: "character", presetId: "official-narrator" };
const lore = { role: "lore" };

test("a blank project makes no claim about what kind of card it is", () => {
  assert.equal(simpleArchetypeLabelOf([]), null);
  // Official presets and non-character entries are not the card's characters.
  assert.equal(simpleArchetypeLabelOf([preset, lore]), null);
  // It still lays out as the chat form, which is where a blank card starts.
  assert.equal(simpleArchetypeOf([]), "chat");
});

test("an AI's own character is not one of the card's cast", () => {
  const ai = { role: "character", worldbookId: "upstairs" };
  const books = [{ id: "upstairs", station: { kind: "narrator" } }];
  assert.equal(simpleArchetypeOf([character, ai], books), "chat");
  assert.equal(simpleArchetypeLabelOf([ai], books), null);
  assert.equal(simpleArchetypeOf([character, ai]), "world", "without the frames it counts as any character");
});

test("one character is a character chat, two or more is a world", () => {
  assert.equal(simpleArchetypeLabelOf([character, lore]), "chat");
  assert.equal(simpleArchetypeOf([character, lore]), "chat");
  assert.equal(simpleArchetypeLabelOf([character, character]), "world");
  assert.equal(simpleArchetypeOf([character, preset, character]), "world");
});
