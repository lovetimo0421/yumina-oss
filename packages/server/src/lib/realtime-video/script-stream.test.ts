import assert from "node:assert/strict";
import test from "node:test";
import { scriptBeats, scriptValue } from "./script-stream.js";

const full = JSON.stringify({
  state: "The gym, sunlit. Gondo at the board.",
  states: { S1: "The gym {with braces} and \"quotes\"", S2: "A forest at dawn." },
  newCast: [{ name: "Gondo", look: "male, 40s, gray suit" }],
  beats: [
    { passage: "He writes.", transition: "continue", scene: "S1", take: "new", shot: "Gondo writes 「規則」 on the board." },
    { passage: "Mist.", transition: "continue", scene: "S1", take: "same", shot: "Mist pours in [slowly]." },
    { passage: "Dirt.", transition: "cut", scene: "S2", sheet: "Forest", take: "new", shot: "Hard cut to: the forest." },
  ],
});

test("beats come out one by one as their closing brace arrives", () => {
  const seen: number[] = [];
  for (let n = 1; n <= full.length; n++) {
    const count = scriptBeats(full.slice(0, n)).length;
    if (count !== (seen.at(-1) ?? 0)) seen.push(count);
  }
  assert.deepEqual(seen, [1, 2, 3]);
  const beats = scriptBeats(full);
  assert.equal(beats[0]!.shot, "Gondo writes 「規則」 on the board.");
  assert.equal(beats[1]!.shot, "Mist pours in [slowly].");
  assert.equal(beats[2]!.scene, "S2");
});

test("a beat cut off mid-string is not taken", () => {
  const cut = full.slice(0, full.indexOf("Mist pours") + 5);
  assert.equal(scriptBeats(cut).length, 1);
});

test("states and the new cast are read once complete, braces inside strings and all", () => {
  const partial = full.slice(0, full.indexOf('"S2"'));
  assert.equal(scriptValue(partial, "states"), undefined);
  assert.deepEqual(scriptValue(full, "states"), { S1: "The gym {with braces} and \"quotes\"", S2: "A forest at dawn." });
  assert.deepEqual(scriptValue(full, "newCast"), [{ name: "Gondo", look: "male, 40s, gray suit" }]);
  assert.equal(scriptValue(full, "state"), "The gym, sunlit. Gondo at the board.");
});

test("a script with no beats yet has none", () => {
  assert.deepEqual(scriptBeats('{"state":"x","states":{'), []);
  assert.deepEqual(scriptBeats('{"beats":['), []);
});

test("a trailing comma inside a beat is repaired", () => {
  assert.equal(scriptBeats('{"beats":[{"shot":"a","take":"new",}, {"shot":"b"').length, 1);
});
