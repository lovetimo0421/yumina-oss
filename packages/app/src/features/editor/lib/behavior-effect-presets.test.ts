import assert from "node:assert/strict";
import test from "node:test";
import type { ReactionEffect } from "@yumina/engine";
import { extractFieldValues, getDoPresets, identifyPreset, parseSmartValue, switchableScenarios } from "./behavior-effect-presets";

const presets = getDoPresets((key: string) => key);

/**
 * Opening a behavior in the editor runs identifyPreset → extractFieldValues →
 * (the author edits nothing) → build. If that round trip is not the identity,
 * merely looking at a behavior and saving rewrites what its author wrote —
 * silently, because the UI shows the preset it guessed, not the effect on disk.
 */
const ROUND_TRIP: { name: string; effect: ReactionEffect; presetId: string }[] = [
  { name: "a numeric variable change", presetId: "change-var",
    effect: { type: "set", path: "hp", value: 10, operation: "subtract" } },
  { name: "a variable change that reads another variable", presetId: "change-var",
    effect: { type: "set", path: "hp", value: 0, operation: "add", valueRef: "bonus" } },
  { name: "a boolean variable change", presetId: "change-var",
    effect: { type: "set", path: "hasKey", value: true, operation: "set" } },
  { name: "a string variable change", presetId: "change-var",
    effect: { type: "set", path: "location", value: "mine", operation: "set" } },
  { name: "turning a variable on", presetId: "toggle-variable",
    effect: { type: "set", path: "@vars.enabled.route", value: true, operation: "set" } },
  { name: "turning a variable off", presetId: "toggle-variable",
    effect: { type: "set", path: "@vars.enabled.route", value: false, operation: "set" } },
  { name: "switching a scenario on", presetId: "toggle-scenario",
    effect: { type: "set", path: "@worldbooks.on.attic", value: true, operation: "set" } },
  { name: "switching a scenario off", presetId: "toggle-scenario",
    effect: { type: "set", path: "@worldbooks.on.attic", value: false, operation: "set" } },
  { name: "telling the AI something", presetId: "tell-ai",
    effect: { type: "set", path: "@prompt.context", value: "The lamp goes out.", operation: "set" } },
  { name: "enabling an entry", presetId: "enable-entry",
    effect: { type: "set", path: "@prompt.entry.lore-1", value: true, operation: "set" } },
  { name: "disabling an entry", presetId: "disable-entry",
    effect: { type: "set", path: "@prompt.entry.lore-1", value: false, operation: "set" } },
  { name: "playing music", presetId: "play-music",
    effect: { type: "set", path: "@audio.bgm", value: "track-1", operation: "set" } },
  { name: "playing a sound effect", presetId: "play-sfx",
    effect: { type: "set", path: "@audio.sfx", value: "door", operation: "set" } },
  { name: "stopping audio", presetId: "stop-audio",
    effect: { type: "set", path: "@audio.stop", value: "track-1", operation: "set" } },
  { name: "notifying the player", presetId: "notify",
    effect: { type: "emit", event: { type: "ui:notification", message: "Found a key", style: "success" } } },
  { name: "turning a behavior off", presetId: "toggle-behavior",
    effect: { type: "set", path: "@rules.disabled.rule-1", value: true, operation: "set" } },
  { name: "turning a behavior on", presetId: "toggle-behavior",
    effect: { type: "set", path: "@rules.disabled.rule-1", value: false, operation: "set" } },
];

for (const { name, effect, presetId } of ROUND_TRIP) {
  test(`${name} survives being opened and saved`, () => {
    const identified = identifyPreset(effect, presets);
    assert.equal(identified?.id, presetId, "identifyPreset chose a different preset");
    assert.deepEqual(identified!.build(extractFieldValues(effect, identified)), effect);
  });
}

test("every preset's own output identifies back as itself", () => {
  // The reverse of the cases above: nothing the editor can *create* may be
  // unrecognisable to the editor that reopens it.
  const inputs: Record<string, Record<string, string>> = {
    "change-var": { variableId: "hp", operation: "add", value: "5" },
    "toggle-variable": { variableId: "route", enabled: "true" },
    "toggle-scenario": { worldbookId: "attic", on: "false" },
    "tell-ai": { content: "Something happens." },
    "enable-entry": { entryId: "lore-1" },
    "disable-entry": { entryId: "lore-1" },
    "play-music": { trackId: "track-1" },
    "play-sfx": { trackId: "door" },
    "stop-audio": { trackId: "track-1" },
    notify: { message: "Hello", style: "info" },
    moment: { title: "First light", message: "Hello", image: "assets/dawn.png", collect: "moments" },
    "toggle-behavior": { ruleId: "rule-1", enabled: "false" },
  };
  assert.deepEqual(presets.map(p => p.id).sort(), Object.keys(inputs).sort(),
    "a preset was added or removed without a case here");
  for (const p of presets) {
    assert.equal(identifyPreset(p.build(inputs[p.id]!), presets)?.id, p.id, `${p.id} did not identify back`);
  }
});

test("an effect the editor no longer offers stays unrecognised rather than mislabelled", () => {
  // These runtime systems were removed. Falling through to null is what makes
  // the raw-effect display appear so a creator can see and delete them; matching
  // some other preset would quietly rewrite a legacy card on save.
  for (const path of ["@ai.request", "@timer.start", "@timer.cancel"]) {
    assert.equal(identifyPreset({ type: "set", path, value: "x", operation: "set" }, presets), null, path);
  }
  // Legacy stop-tell-ai — a directive path with `false` — is deliberately not
  // tell-ai, because the tell-ai form would save it back as a string.
  assert.equal(identifyPreset({ type: "set", path: "@prompt.directive.d1", value: false, operation: "set" }, presets), null);
  // …but a legacy directive that still carries text is editable as tell-ai.
  assert.equal(identifyPreset({ type: "set", path: "@prompt.directive.d1", value: "text", operation: "set" }, presets)?.id, "tell-ai");
});

test("a legacy directive keeps its text when opened as tell-ai", () => {
  // Its path is not @prompt.context, so build() cannot reproduce the effect —
  // but the author's words must still reach the form, not "[object Object]".
  const legacy: ReactionEffect = { type: "set", path: "@prompt.directive.d1", value: "Remember the key.", operation: "set" };
  const identified = identifyPreset(legacy, presets)!;
  assert.equal(extractFieldValues(legacy, identified).content, "Remember the key.");
  const wrapped: ReactionEffect = { type: "set", path: "@prompt.context", value: { content: "Wrapped" } as never, operation: "set" };
  assert.equal(extractFieldValues(wrapped, identifyPreset(wrapped, presets)!).content, "Wrapped");
});

test("extractFieldValues returns nothing when no preset matched", () => {
  assert.deepEqual(extractFieldValues({ type: "set", path: "@timer.start", value: 1, operation: "set" }, null), {});
});

test("parseSmartValue keeps text that only looks like a number or a boolean", () => {
  assert.equal(parseSmartValue("10"), 10);
  assert.equal(parseSmartValue("-2.5"), -2.5);
  assert.equal(parseSmartValue("true"), true);
  assert.equal(parseSmartValue("false"), false);
  assert.equal(parseSmartValue(""), "");
  assert.equal(parseSmartValue("mine"), "mine");
  // A typed space is text, not 0 (Number(" ") === 0).
  assert.equal(parseSmartValue(" "), " ");
  // Pinned because it surprises people, not because it is obviously right: a
  // zero-padded code typed into a value field comes back as a number, so a room
  // called "007" becomes 7. Changing it is a data decision, not a refactor.
  assert.equal(parseSmartValue("007"), 7);
});

test("a behaviour switches scenarios, not the AIs that live in them", () => {
  const books = [
    { id: "attic", name: "阁楼" },
    { id: "cat", name: "店猫", host: "card", station: { kind: "narrator" } },
    { id: "guide", name: "引路人", host: "attic", station: { kind: "narrator" } },
  ];
  assert.deepEqual(switchableScenarios(books), [{ value: "attic", label: "阁楼" }]);
  assert.deepEqual(switchableScenarios(undefined), []);
});
