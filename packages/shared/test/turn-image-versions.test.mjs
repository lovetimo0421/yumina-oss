import assert from "node:assert/strict";
import test from "node:test";
import {
  TURN_IMAGE_VERSION_CAP,
  addTurnImageVersion,
  readTurnImageVersions,
  selectTurnImageVersion,
} from "../dist/index.js";

const key = (name) => Buffer.from(`users/u1/turn-images/${name}.jpg`).toString("base64url");
const drawn = (name, alt = "scene") => `[image:/cdn/key/${key(name)}|alt=${alt}]`;

test("a reply drawn before versions existed reads as one version, unchanged", () => {
  const old = drawn("a", "Mira");
  assert.deepEqual(readTurnImageVersions(old), { keys: [key("a")], index: 0, options: ["alt=Mira"] });
  // Selecting the only version writes the embed back exactly as it was.
  assert.equal(selectTurnImageVersion(old, 0), old);
});

test("a redraw keeps the old picture and shows the new one", () => {
  const first = drawn("a");
  const second = addTurnImageVersion(first, drawn("b", "Mira"));
  assert.equal(second, `[image:/cdn/key/${key("b")}|alt=Mira|versions=${key("a")},${key("b")}]`);
  const third = addTurnImageVersion(second, drawn("c"));
  assert.deepEqual(readTurnImageVersions(third), { keys: [key("a"), key("b"), key("c")], index: 2, options: ["alt=scene"] });
});

test("the first picture of a reply is just the drawn embed", () => {
  assert.equal(addTurnImageVersion(null, drawn("a")), drawn("a"));
  assert.equal(addTurnImageVersion("", drawn("a")), drawn("a"));
});

test("picking an older version shows it and keeps the whole list", () => {
  const three = addTurnImageVersion(addTurnImageVersion(drawn("a"), drawn("b")), drawn("c"));
  const back = selectTurnImageVersion(three, key("a"));
  assert.ok(back);
  assert.ok(back.startsWith(`[image:/cdn/key/${key("a")}|`));
  assert.deepEqual(readTurnImageVersions(back), { keys: [key("a"), key("b"), key("c")], index: 0, options: ["alt=scene"] });
  // By position too, and a redraw after stepping back still appends at the end.
  assert.equal(selectTurnImageVersion(three, 0), back);
  const fourth = addTurnImageVersion(back, drawn("d"));
  assert.deepEqual(readTurnImageVersions(fourth)?.keys, [key("a"), key("b"), key("c"), key("d")]);
  assert.equal(readTurnImageVersions(fourth)?.index, 3);
});

test("a version that isn't there is refused", () => {
  const two = addTurnImageVersion(drawn("a"), drawn("b"));
  assert.equal(selectTurnImageVersion(two, key("zzz")), null);
  assert.equal(selectTurnImageVersion(two, 2), null);
  assert.equal(selectTurnImageVersion(two, -1), null);
  assert.equal(selectTurnImageVersion("[image:https://example.com/a.png]", 0), null);
});

test("past the cap the oldest pictures drop", () => {
  assert.equal(TURN_IMAGE_VERSION_CAP, 10);
  let embed = drawn("v0");
  for (let i = 1; i < 13; i++) embed = addTurnImageVersion(embed, drawn(`v${i}`));
  const versions = readTurnImageVersions(embed);
  assert.equal(versions?.keys.length, 10);
  assert.equal(versions?.keys[0], key("v3"));
  assert.equal(versions?.keys[9], key("v12"));
  assert.equal(versions?.index, 9);
  // A smaller cap, as the parameter allows.
  assert.deepEqual(readTurnImageVersions(addTurnImageVersion(embed, drawn("x"), 2))?.keys, [key("v12"), key("x")]);
});

test("a malformed list is cleaned, and the shown picture is always in it", () => {
  const messy = `[image:/cdn/key/${key("b")}|alt=s|versions=${key("a")},,not/a/key,${key("a")}]`;
  assert.deepEqual(readTurnImageVersions(messy), { keys: [key("a"), key("b")], index: 1, options: ["alt=s"] });
});
