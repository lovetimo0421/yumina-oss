import test from "node:test";
import assert from "node:assert/strict";
import { migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";
import { buildInventory } from "./context-resolver.js";
import { installedPacks, installedPacksInventory, readPath } from "./installed-packs.js";

function world(extra: Record<string, unknown> = {}): WorldDefinition {
  return migrateWorldDefinition({
    id: "w",
    version: "1.0.0",
    name: "Pack test",
    description: "",
    author: "t",
    entries: [],
    variables: [
      { id: "voice_cfg", name: "Voice", type: "json", defaultValue: { voice: { id: "alloy", speed: 1 } } },
      { id: "avatar", name: "Avatar", type: "string", defaultValue: "@asset:11111111-1111-4111-8111-111111111111" },
    ],
    rules: [],
    reactions: [],
    components: [],
    audioTracks: [],
    customUI: [],
    settings: { maxTokens: 4000, temperature: 1, playerName: "User" },
    ...extra,
  } as unknown as WorldDefinition);
}

const pack = {
  installId: "inst-1",
  sourceBundleId: "bundle-voice",
  name: "Voice Pack",
  colorKey: "teal",
  importedAt: "2026-10-29T00:00:00Z",
  originalHash: "h",
  entryIds: [], variableIds: ["voice_cfg", "avatar"], ruleIds: [], audioTrackIds: [], folderIds: [],
  version: 3,
  settings: [
    { id: "voice", label: "Voice", type: "select", variableId: "voice_cfg", path: "voice.id", options: [{ value: "alloy", label: "Alloy" }, { value: "echo", label: "Echo" }] },
    {
      id: "model", label: "Avatar file", type: "asset", variableId: "avatar", accept: "image/*,.vrm",
      extensionRules: [{ ext: "vrm", path: "model", also: [{ path: "kind", value: "vrm" }] }],
    },
    { id: "gone", label: "Speed", type: "number", variableId: "deleted_var" },
  ],
};

test("readPath walks dots and indexes, and gives undefined for a missing step", () => {
  assert.equal(readPath({ a: { b: [{ c: 3 }] } }, "a.b[0].c"), 3);
  assert.equal(readPath({ a: 1 }, "a.b"), undefined);
  assert.deepEqual(readPath({ a: 1 }, undefined), { a: 1 });
});

test("installedPacks reads each setting's current value from its variable path", () => {
  const [summary] = installedPacks(world({ installedBundles: [pack] }));
  assert.equal(summary!.name, "Voice Pack");
  assert.equal(summary!.sourceBundleId, "bundle-voice");
  assert.equal(summary!.version, 3);
  const [voice, avatar, gone] = summary!.settings;
  assert.deepEqual([voice!.variableId, voice!.path, voice!.value], ["voice_cfg", "voice.id", "alloy"]);
  assert.deepEqual(voice!.options?.map((o) => o.value), ["alloy", "echo"]);
  assert.equal(avatar!.value, "@asset:11111111-1111-4111-8111-111111111111");
  assert.equal(avatar!.extensionRules?.[0]?.path, "model");
  assert.equal(gone!.missingVariable, true);
  assert.equal(gone!.value, undefined);
});

test("the assistant's inventory lists installed packs with their settings and how to change them", () => {
  const inv = buildInventory(world({ installedBundles: [pack, { installId: "inst-2", name: "Local Pack", colorKey: "a", importedAt: "", originalHash: "", entryIds: [], variableIds: [], ruleIds: [], audioTrackIds: [], folderIds: [] }] }), []);
  assert.match(inv, /INSTALLED PACKS \(2\)/);
  assert.match(inv, /write_variable/);
  assert.match(inv, /@asset:<id>/);
  assert.match(inv, /"Voice Pack" \(bundle bundle-voice, v3\)/);
  assert.match(inv, /- Voice \[select\] → voice_cfg\.voice\.id = "alloy" \(options: alloy \| echo\)/);
  assert.match(inv, /- Avatar file \[asset\] → avatar = "@asset:11111111-1111-4111-8111-111111111111" \(accept: image\/\*,\.vrm; by extension: vrm→model \+kind="vrm"\)/);
  assert.match(inv, /Speed \[number\] → deleted_var = \(unset\) \(VARIABLE MISSING\)/);
  assert.match(inv, /"Local Pack" \(local\) — no settings/);
});

test("no installed packs, no section", () => {
  assert.doesNotMatch(buildInventory(world(), []), /INSTALLED PACKS/);
  assert.deepEqual(installedPacks(world({ installedBundles: [] })), []);
});

test("an installed pack with a screen names the folder its interface files are in", () => {
  const [withUi, withoutUi] = installedPacks(world({ installedBundles: [
    { installId: "i1", name: "Adventurer HUD", slug: "adventurer-hud" },
    { installId: "i2", name: "Lore only" },
  ] }));
  assert.equal(withUi!.interfaceFolder, "_bundles/adventurer-hud/");
  assert.equal(withoutUi!.interfaceFolder, null);
  assert.match(installedPacksInventory(world({ installedBundles: [{ installId: "i1", name: "Adventurer HUD", slug: "adventurer-hud" }] })), /interface files in _bundles\/adventurer-hud\//);
});
