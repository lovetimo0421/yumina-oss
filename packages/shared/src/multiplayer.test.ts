import { test } from "node:test";
import assert from "node:assert/strict";
import { normaliseMultiplayer, readMultiplayer } from "./multiplayer.js";

test("off unless enabled", () => {
  assert.equal(normaliseMultiplayer(undefined), null);
  assert.equal(normaliseMultiplayer({ enabled: false, mode: "story" }), null);
  assert.equal(normaliseMultiplayer({ roomId: "sea-1" }), null, "the Krew sea is not this feature");
});

test("defaults and clamps seats", () => {
  const m = normaliseMultiplayer({ enabled: true })!;
  assert.deepEqual([m.mode, m.minSeats, m.maxSeats], ["story", 2, 6]);
  const c = normaliseMultiplayer({ enabled: true, minSeats: 1, maxSeats: 40 })!;
  assert.deepEqual([c.minSeats, c.maxSeats], [2, 12]);
  const flip = normaliseMultiplayer({ enabled: true, minSeats: 8, maxSeats: 4 })!;
  assert.deepEqual([flip.minSeats, flip.maxSeats], [8, 8]);
});

test("legacy rules cards count as on and keep aiModel", () => {
  const m = readMultiplayer({ schema: { settings: { multiplayer: { mode: "rules", rulesFile: "rules.js", minSeats: 5, maxSeats: 10, aiModel: "x/y" } } } })!;
  assert.deepEqual([m.mode, m.rulesFile, m.minSeats, m.maxSeats, m.ai.model], ["rules", "rules.js", 5, 10, "x/y"]);
});

test("roles: story only, deduped, required only when roles exist", () => {
  const m = normaliseMultiplayer({ enabled: true, roles: [{ id: "a", name: "蝙蝠侠" }, { id: "a", name: "dup" }, { id: "b", name: "" }], rolesRequired: true })!;
  assert.deepEqual(m.roles, [{ id: "a", name: "蝙蝠侠" }]);
  assert.equal(m.rolesRequired, true);
  assert.equal(normaliseMultiplayer({ enabled: true, rolesRequired: true })!.rolesRequired, false);
  assert.deepEqual(normaliseMultiplayer({ enabled: true, mode: "rules", roles: [{ id: "a", name: "x" }] })!.roles, []);
});
