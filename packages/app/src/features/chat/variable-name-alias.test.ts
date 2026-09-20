import assert from "node:assert/strict";
import test from "node:test";
import { makeVariableKeyResolver } from "./variable-key";
import { withVariableNameAliases } from "../../../sandbox/variable-alias";

/** The shape that broke a real card: every id is a `crypto.randomUUID()` the
 *  editor minted, and the HUD reads `variables.<display name>`. */
const ZOMBIE_DEFS = [
  { id: "1e240cba-7709-43dd-8fd6-852e692185d4", name: "day" },
  { id: "3b0226a6-f46e-437a-8197-f1cd73bba054", name: "time" },
  { id: "f239e12a-de12-43d6-b81c-82dbd30ce22d", name: "location" },
  { id: "a8c5a685-1317-46b0-8b02-baebbfe9f042", name: "hunger" },
  { id: "ff60805a-f419-4512-8205-d1b22b912393", name: "zombieKills" },
];

/** The session state exactly as the server persists it. */
const ZOMBIE_STATE: Record<string, unknown> = {
  "1e240cba-7709-43dd-8fd6-852e692185d4": 5,
  "3b0226a6-f46e-437a-8197-f1cd73bba054": "09:40 PM",
  "f239e12a-de12-43d6-b81c-82dbd30ce22d": "Abandoned Hospital",
  "a8c5a685-1317-46b0-8b02-baebbfe9f042": 35,
  "ff60805a-f419-4512-8205-d1b22b912393": 12,
};

const idsByName = (defs: ReadonlyArray<{ id: string; name: string }>) =>
  Object.fromEntries(defs.map((d) => [d.name, d.id]));

test("a HUD reading by display name sees the live value, not its own fallback", () => {
  const vars = withVariableNameAliases(ZOMBIE_STATE, idsByName(ZOMBIE_DEFS));

  assert.equal(vars.day, 5);
  assert.equal(vars.time, "09:40 PM");
  assert.equal(vars.location, "Abandoned Hospital");
  assert.equal(vars.hunger, 35);
  // camelCase matters: the ID field force-lowercases, so `zombieKills` can only
  // ever be a display name — reading it must still work.
  assert.equal(vars.zombieKills, 12);
});

test("reading by id keeps working", () => {
  const vars = withVariableNameAliases(ZOMBIE_STATE, idsByName(ZOMBIE_DEFS));
  assert.equal(vars["a8c5a685-1317-46b0-8b02-baebbfe9f042"], 35);
});

test("enumeration is not aliased — a card rendering the whole bag sees one row per variable", () => {
  const vars = withVariableNameAliases(ZOMBIE_STATE, idsByName(ZOMBIE_DEFS));
  assert.deepEqual(Object.keys(vars).sort(), Object.keys(ZOMBIE_STATE).sort());
  assert.equal(Object.entries(vars).length, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(vars)), ZOMBIE_STATE);
  assert.deepEqual({ ...vars }, ZOMBIE_STATE);
});

test("an id always wins over another variable's display name", () => {
  // "hp" is one variable's id AND another variable's display name.
  const state = { hp: 10, "b1f0d0e2-0000-4000-8000-000000000001": 99 };
  const vars = withVariableNameAliases(state, {
    hp: "b1f0d0e2-0000-4000-8000-000000000001",
  });
  assert.equal(vars.hp, 10);
});

test("the proxy identity is stable across calls, so useMemo([api.variables]) still holds", () => {
  const names = idsByName(ZOMBIE_DEFS);
  const a = withVariableNameAliases(ZOMBIE_STATE, names);
  const b = withVariableNameAliases(ZOMBIE_STATE, names);
  assert.equal(a, b);
});

test("no alias map means the bag is handed through untouched", () => {
  assert.equal(withVariableNameAliases(ZOMBIE_STATE, undefined), ZOMBIE_STATE);
});

test("`in` follows the same resolution as a read", () => {
  const vars = withVariableNameAliases(ZOMBIE_STATE, idsByName(ZOMBIE_DEFS));
  assert.equal("hunger" in vars, true);
  assert.equal("nonsense" in vars, false);
});

test("setVariable by display name lands on the id, not a phantom key", () => {
  const resolve = makeVariableKeyResolver(ZOMBIE_DEFS);
  assert.equal(resolve("hunger"), "a8c5a685-1317-46b0-8b02-baebbfe9f042");
  assert.equal(resolve("zombieKills"), "ff60805a-f419-4512-8205-d1b22b912393");
});

test("setVariable by id is unchanged", () => {
  const resolve = makeVariableKeyResolver(ZOMBIE_DEFS);
  assert.equal(
    resolve("a8c5a685-1317-46b0-8b02-baebbfe9f042"),
    "a8c5a685-1317-46b0-8b02-baebbfe9f042",
  );
});

test("undeclared keys pass through — __lore_ flags must keep persisting", () => {
  const resolve = makeVariableKeyResolver(ZOMBIE_DEFS);
  assert.equal(resolve("__lore_secret-codex"), "__lore_secret-codex");
  assert.equal(resolve("combat_active"), "combat_active");
});

test("a card whose ids are already slugs is completely unaffected", () => {
  const defs = [{ id: "hull", name: "Hull" }, { id: "shields", name: "Shields" }];
  const state = { hull: 88, shields: 100 };
  const vars = withVariableNameAliases(state, idsByName(defs));
  assert.equal(vars.hull, 88);
  // the defensive `v.hull ?? v["Hull"]` pattern real cards ship now resolves both
  assert.equal(vars["Hull"], 88);
  assert.deepEqual(Object.keys(vars).sort(), ["hull", "shields"]);
  assert.equal(makeVariableKeyResolver(defs)("hull"), "hull");
});

test("duplicate display names resolve reads and writes to the same last definition", () => {
  const defs = [{ id: "first", name: "health" }, { id: "last", name: "health" }];
  const state = { first: 10, last: 90 };
  const read = withVariableNameAliases(state, idsByName(defs));
  const write = makeVariableKeyResolver(defs);
  assert.equal(write("health"), "last");
  assert.equal(read.health, state[write("health") as keyof typeof state]);
  assert.equal(write("first"), "first");
});
