import test from "node:test";
import assert from "node:assert/strict";
import { convertSillyTavernPreset, isSillyTavernPreset } from "./sillytavern-preset.js";

// Shaped like a real ST chat-completion preset: built-in markers, a global
// order list (100001) with some prompts switched off, one in-chat injection.
const preset = {
  temperature: 1,
  prompts: [
    { identifier: "main", name: "Main Prompt", system_prompt: true, role: "system", content: "You are {{char}}.", injection_position: 0, injection_depth: 4 },
    { identifier: "worldInfoBefore", name: "World Info (before)", system_prompt: true, marker: true },
    { identifier: "charDescription", name: "Char Description", system_prompt: true, marker: true },
    { identifier: "nsfw", name: "NSFW", system_prompt: true, role: "system", content: "Adult content is allowed." },
    { identifier: "enhanceDefinitions", name: "Enhance Definitions", system_prompt: true, role: "system", content: "Use your knowledge of the source." },
    { identifier: "chatHistory", name: "Chat History", system_prompt: true, marker: true },
    { identifier: "jailbreak", name: "Post-History Instructions", system_prompt: true, role: "system", content: "Stay in character." },
    { identifier: "abc-1", name: "Style note", role: "user", content: "Write in present tense.", injection_position: 1, injection_depth: 2 },
    { identifier: "abc-2", name: "Empty toggle", role: "system", content: "   " },
    { identifier: "abc-3", name: "Never ordered", role: "system", content: "An alternative main prompt." },
  ],
  prompt_order: [
    { character_id: 100000, order: [{ identifier: "main", enabled: true }] },
    {
      character_id: 100001,
      order: [
        { identifier: "main", enabled: true },
        { identifier: "worldInfoBefore", enabled: true },
        { identifier: "charDescription", enabled: true },
        { identifier: "nsfw", enabled: false },
        { identifier: "enhanceDefinitions", enabled: true },
        { identifier: "abc-1", enabled: true },
        { identifier: "abc-2", enabled: true },
        { identifier: "chatHistory", enabled: true },
        { identifier: "jailbreak", enabled: true },
      ],
    },
  ],
};

test("a Yumina export is not treated as a SillyTavern preset", () => {
  const yumina = { folders: [], prompts: [{ name: "x", content: "y", section: "system-presets" }] };
  assert.equal(isSillyTavernPreset(yumina), false);
  assert.equal(convertSillyTavernPreset(yumina), null);
});

test("markers and empty prompts are dropped; the rest land in one folder named after the file", () => {
  const out = convertSillyTavernPreset(preset, "My Preset.json")!;
  assert.deepEqual(out.folders, [{ id: "st-preset", name: "My Preset", enabled: true }]);
  assert.deepEqual(out.prompts.map((p) => p.name), ["Main Prompt", "NSFW", "Enhance Definitions", "Style note", "Post-History Instructions", "Never ordered"]);
  assert.ok(out.prompts.every((p) => p.folderId === "st-preset"));
});

test("on/off follows the global order list; prompts it never lists come in off", () => {
  const out = convertSillyTavernPreset(preset)!;
  const enabled = Object.fromEntries(out.prompts.map((p) => [p.name, p.enabled]));
  assert.deepEqual(enabled, {
    "Main Prompt": true,
    NSFW: false,
    "Enhance Definitions": true,
    "Style note": true,
    "Post-History Instructions": true,
    "Never ordered": false,
  });
});

test("placement: before the character, after it, in chat at depth, after chat history", () => {
  const out = convertSillyTavernPreset(preset)!;
  const by = Object.fromEntries(out.prompts.map((p) => [p.name, p]));
  assert.equal(by["Main Prompt"]!.section, "system-presets");
  assert.ok(by["Main Prompt"]!.position < 0, "above the character markers goes before the card");
  assert.equal(by["Enhance Definitions"]!.section, "system-presets");
  assert.ok(by["Enhance Definitions"]!.position > 0, "below them goes after the card");
  assert.equal(by["Style note"]!.section, "chat-history");
  assert.equal(by["Style note"]!.depth, 2);
  assert.equal(by["Style note"]!.apiRole, "user");
  assert.equal(by["Post-History Instructions"]!.section, "post-history");
  assert.equal(by["Main Prompt"]!.apiRole, null);
});

test("order is preserved within each place", () => {
  const out = convertSillyTavernPreset(preset)!;
  const system = out.prompts.filter((p) => p.section === "system-presets");
  const positions = system.map((p) => p.position);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test("without prompt_order the file order and each prompt's own enabled flag are used", () => {
  const out = convertSillyTavernPreset({
    prompts: [
      { identifier: "a", name: "A", content: "one" },
      { identifier: "b", name: "B", content: "two", enabled: false },
    ],
  })!;
  assert.deepEqual(out.prompts.map((p) => [p.name, p.enabled]), [["A", true], ["B", false]]);
  assert.equal(out.folders[0]!.name, "SillyTavern preset");
});

test("a preset with nothing usable creates no empty folder", () => {
  const out = convertSillyTavernPreset({ prompts: [{ identifier: "chatHistory", marker: true }] })!;
  assert.deepEqual(out, { folders: [], prompts: [] });
});
