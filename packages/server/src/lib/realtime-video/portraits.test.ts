import assert from "node:assert/strict";
import test from "node:test";
import { describedCast, matchPortraits, portraitEntries } from "./portraits.js";

const schema = {
  entries: [
    { name: "德拉科妮娅·马尔福", portrait: "@asset:d", enabled: true },
    { name: "哈利·波特（你）", portrait: "@asset:h", enabled: true },
    { name: "Pansy Parkinson", portrait: "@asset:p", enabled: true },
    { name: "Blaise Zabini", enabled: true },
  ],
};

test("the player's own portrait never joins a picture, and only entries with a portrait count", () => {
  assert.deepEqual(portraitEntries(schema).map((e) => e.name), ["德拉科妮娅·马尔福", "Pansy Parkinson"]);
});

test("a Chinese entry is found through the cast name the director gave it in an English shot", () => {
  const entries = portraitEntries(schema);
  const cast = [{ name: "Draconia Malfoy", look: "a girl of 16 with long platinum hair", entry: "德拉科妮娅·马尔福" }];
  const shot = "Close-up: Pansy Parkinson laughs while Draconia Malfoy crosses her arms.";
  assert.deepEqual(matchPortraits(entries, shot, cast).map((m) => [m.entry.name, m.name]), [["Pansy Parkinson", "Pansy Parkinson"], ["德拉科妮娅·马尔福", "Draconia Malfoy"]]);
  // The given name alone counts; the family name alone does not (Lucius is a Malfoy too).
  assert.equal(matchPortraits(entries, "Draconia turns away.", cast)[0]?.name, "Draconia Malfoy");
  assert.equal(matchPortraits(entries, "Lucius Malfoy enters.", cast).length, 0);
  // Without the cast link the English shot cannot reach the Chinese entry.
  assert.equal(matchPortraits(entries, shot, []).length, 1);
});

test("the card's English names find a Chinese entry with no cast tag, and the player becomes the camera", async () => {
  const { asCamera } = await import("./portraits.js");
  const entries = portraitEntries(schema);
  const names = { "德拉科妮娅·马尔福": ["Draconia Malfoy", "Draconia"] };
  const state = "Draconia Malfoy stands in the aisle before sitting down opposite Harry.";
  assert.deepEqual(matchPortraits(entries, state, [], names).map((m) => m.name), ["Draconia Malfoy"]);
  assert.equal(asCamera(state, ["Harry Potter", "Harry"]), "Draconia Malfoy stands in the aisle before sitting down opposite you.");
  assert.equal(asCamera("Reverse shot from Harry's perspective.", ["Harry"]), "Reverse shot from your perspective.");
  assert.equal(asCamera("Harrymore waves.", ["Harry"]), "Harrymore waves.");
});

test("the cast without a portrait comes with its looks when a picture names them", () => {
  const cast = [
    { name: "Draconia Malfoy", look: "girl, platinum hair", entry: "德拉科妮娅·马尔福" },
    { name: "Moaning Myrtle", look: "ghost girl, round glasses" },
    { name: "Severus Snape", look: "man, black hair" },
  ];
  assert.deepEqual(describedCast(cast, "Myrtle drifts down beside Draconia Malfoy."), [{ name: "Moaning Myrtle", look: "ghost girl, round glasses" }]);
  assert.deepEqual(describedCast(cast, "Draconia Malfoy alone."), []);
});
