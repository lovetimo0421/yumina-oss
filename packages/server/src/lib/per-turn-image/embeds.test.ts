import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTurnImages, withDrawnTurnImage, withTurnImageVersion } from "./embeds.js";

const key = (name: string, dir = "turn-images") => Buffer.from(`users/u1/${dir}/${name}.jpg`).toString("base64url");
const drawn = (name: string) => `[image:/cdn/key/${key(name)}|alt=scene]`;

test("the first picture of a reply is appended as before", () => {
  assert.equal(withDrawnTurnImage("She smiles.", drawn("a")), `She smiles.\n\n${drawn("a")}`);
});

test("a redraw keeps the earlier picture as a version and shows the new one", () => {
  const once = withDrawnTurnImage("She smiles.", drawn("a"));
  const twice = withDrawnTurnImage(once, drawn("b"));
  assert.equal(twice, `She smiles.\n\n[image:/cdn/key/${key("b")}|alt=scene|versions=${key("a")},${key("b")}]`);
  assert.equal(stripTurnImages(twice), "She smiles.");
});

test("a redraw after stepping back still lands as the newest version", () => {
  let text = withDrawnTurnImage(withDrawnTurnImage("Hi.", drawn("a")), drawn("b"));
  text = withTurnImageVersion(text, key("a"))!;
  assert.ok(text.endsWith(`[image:/cdn/key/${key("a")}|alt=scene|versions=${key("a")},${key("b")}]`));
  text = withDrawnTurnImage(text, drawn("c"));
  assert.ok(text.endsWith(`[image:/cdn/key/${key("c")}|alt=scene|versions=${key("a")},${key("b")},${key("c")}]`));
});

test("redraws past ten drop the oldest", () => {
  let text = "Hi.";
  for (let i = 0; i < 12; i++) text = withDrawnTurnImage(text, drawn(`v${i}`));
  const list = /versions=([^\]|]+)/.exec(text)![1]!.split(",");
  assert.equal(list.length, 10);
  assert.equal(list[0], key("v2"));
  assert.equal(list[9], key("v11"));
});

test("picking a version touches only the picture, and a card's own images stay", () => {
  const own = `[image:/cdn/key/${key("map", "assets")}|size=full]`;
  const text = withDrawnTurnImage(withDrawnTurnImage(`Map:\n${own}\n\nShe smiles.`, drawn("a")), drawn("b"));
  const picked = withTurnImageVersion(text, key("a"))!;
  assert.equal(picked.replace(key("a"), key("b")).replace(/\|versions=.*\]$/, ""), text.replace(/\|versions=.*\]$/, ""));
  assert.ok(picked.includes(own));
  assert.equal(withTurnImageVersion(text, key("nope")), null);
  assert.equal(withTurnImageVersion("No picture here.", key("a")), null);
});
