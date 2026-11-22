import { test } from "node:test";
import assert from "node:assert/strict";
import { readMultiplayer } from "@yumina/shared";
import {
  addAiName,
  addRole,
  clampSeatRange,
  defaultRulesFile,
  moveRole,
  multiplayerForm,
  multiplayerSetting,
  removeAiName,
  removeRole,
  roleSourceEntries,
  rulesFileChoices,
  seatRange,
  updateRole,
  type MultiplayerForm,
} from "./multiplayer-form";

const write = (raw: unknown, patch: Partial<MultiplayerForm>) => multiplayerSetting({ ...multiplayerForm(raw), ...patch }, raw);

test("a card that never touched it is off, with the defaults", () => {
  const form = multiplayerForm(undefined);
  assert.deepEqual(form, { enabled: false, mode: "story", minSeats: 2, maxSeats: 6, roles: [], rolesRequired: false, rulesFile: null, aiNames: [], aiModel: null });
  assert.equal(multiplayerSetting(form), undefined, "off and untouched writes nothing");
});

test("turned on: the setting the readers understand", () => {
  const on = write(undefined, { enabled: true });
  assert.deepEqual(on, { enabled: true, mode: "story", minSeats: 2, maxSeats: 6 });
  assert.equal(readMultiplayer({ settings: { multiplayer: on } })?.mode, "story");
  const rules = write(on, { mode: "rules", rulesFile: "rules.js", aiNames: ["Ann"], aiModel: "x/y", minSeats: 2, maxSeats: 4 });
  assert.deepEqual(rules, { enabled: true, mode: "rules", minSeats: 2, maxSeats: 4, rulesFile: "rules.js", ai: { names: ["Ann"], model: "x/y" } });
  const read = readMultiplayer({ settings: { multiplayer: rules } })!;
  assert.deepEqual([read.rulesFile, read.ai.names, read.ai.model], ["rules.js", ["Ann"], "x/y"]);
});

test("off or another mode keeps what the author set, so switching back restores it", () => {
  const roles = addRole([], { name: "Batman" });
  const story = write(undefined, { enabled: true, roles, rolesRequired: true });
  const asRules = write(story, { mode: "rules", rulesFile: "rules.js" });
  assert.deepEqual(asRules?.roles, roles, "roles kept in rules mode");
  assert.equal(readMultiplayer({ settings: { multiplayer: asRules } })!.roles.length, 0, "but rules mode has none to the readers");
  const back = multiplayerForm(write(asRules, { mode: "story" }));
  assert.deepEqual([back.roles, back.rolesRequired, back.rulesFile], [roles, true, "rules.js"]);
  const off = write(story, { enabled: false });
  assert.equal(readMultiplayer({ settings: { multiplayer: off } }), null);
  assert.deepEqual(multiplayerForm(off).roles, roles);
});

test("rolesRequired is only written with roles", () => {
  assert.equal(write(undefined, { enabled: true, rolesRequired: true })?.rolesRequired, undefined);
});

test("older shapes: a rules card without enabled reads as on, aiModel moves to ai.model, the Krew sea's roomId stays", () => {
  const legacy = { mode: "rules", rulesFile: "rules.js", minSeats: 3, maxSeats: 5, aiModel: "x/y" };
  const form = multiplayerForm(legacy);
  assert.deepEqual([form.enabled, form.mode, form.minSeats, form.maxSeats, form.aiModel], [true, "rules", 3, 5, "x/y"]);
  const saved = multiplayerSetting(form, legacy) as Record<string, unknown>;
  assert.equal(saved.aiModel, undefined);
  assert.deepEqual(saved.ai, { model: "x/y" });
  assert.equal(saved.enabled, true);
  const krew = { roomId: "sea-1" };
  assert.equal(multiplayerForm(krew).enabled, false);
  assert.equal(multiplayerSetting(multiplayerForm(krew), krew)?.enabled, false);
  assert.equal((write(krew, { enabled: true }) as Record<string, unknown>).roomId, "sea-1");
});

test("seats stay within 2..12, the one moved pushing the other", () => {
  assert.deepEqual(clampSeatRange(1, 40, "min"), { min: 2, max: 12 });
  assert.deepEqual(clampSeatRange(8, 6, "min"), { min: 8, max: 8 });
  assert.deepEqual(clampSeatRange(4, 3, "max"), { min: 3, max: 3 });
  assert.deepEqual(clampSeatRange(3.6, 5, "min"), { min: 4, max: 5 });
  assert.deepEqual(write(undefined, { enabled: true, minSeats: 9, maxSeats: 4 })?.maxSeats, 9);
  assert.equal(seatRange(2, 6), "2–6");
  assert.equal(seatRange(4, 4), "4");
});

test("roles: add by name or from an entry once, rename, note, reorder, delete", () => {
  let roles = addRole([], { name: "  Batman " });
  roles = addRole(roles, { name: "Robin", entryId: "e1" });
  roles = addRole(roles, { name: "Robin again", entryId: "e1" });
  roles = addRole(roles, { name: "   " });
  roles = addRole(roles, { name: "Joker" });
  assert.deepEqual(roles.map((r) => r.name), ["Batman", "Robin", "Joker"]);
  assert.equal(new Set(roles.map((r) => r.id)).size, 3, "ids are unique");
  assert.equal(roles[1]!.entryId, "e1");
  const [batman, robin, joker] = roles.map((r) => r.id) as [string, string, string];
  roles = updateRole(roles, batman, { name: "", note: " the lead " });
  assert.deepEqual(roles[0], { id: batman, name: "Batman", note: "the lead" }, "an emptied name keeps the old one");
  roles = updateRole(roles, batman, { note: "" });
  assert.equal(roles[0]!.note, undefined);
  roles = moveRole(roles, joker, -1);
  assert.deepEqual(roles.map((r) => r.id), [batman, joker, robin]);
  assert.deepEqual(moveRole(roles, batman, -1).map((r) => r.id), [batman, joker, robin], "the first cannot go up");
  roles = removeRole(roles, joker);
  assert.deepEqual(roles.map((r) => r.id), [batman, robin]);
});

test("role sources: the characters, or what the card always sends", () => {
  const always = (e: { alwaysSend?: boolean }) => !!e.alwaysSend;
  const entries = [
    { id: "a", name: "Kurisu", role: "character" },
    { id: "b", name: "Lab", role: "lore", alwaysSend: true },
    { id: "c", name: "Off", role: "character", enabled: false },
  ];
  assert.deepEqual(roleSourceEntries(entries, always).map((e) => e.id), ["a"]);
  assert.deepEqual(roleSourceEntries(entries.slice(1), always).map((e) => e.id), ["b"]);
});

test("rules files: JavaScript only, rules.js first and by default", () => {
  const files = { "index.tsx": "", "lib/deck.js": "", "rules.js": "", "_bundles/x/a.js": "" };
  assert.deepEqual(rulesFileChoices(files), ["rules.js", "lib/deck.js"]);
  assert.equal(defaultRulesFile(files), "rules.js");
  assert.equal(defaultRulesFile({ "index.tsx": "" }), null);
});

test("AI seat names: trimmed, no repeats, removable", () => {
  let names = addAiName([], " Ann ");
  names = addAiName(names, "Ann");
  names = addAiName(names, "Bo");
  assert.deepEqual(names, ["Ann", "Bo"]);
  assert.deepEqual(removeAiName(names, "Ann"), ["Bo"]);
});
