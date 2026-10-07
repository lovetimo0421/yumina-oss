import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveSectionDefaults, OFFICIAL_PRESETS, worldEntrySchema, type RootComponent, type WorldEntry } from "@yumina/engine";
import { getUnmodifiedOfficialPresetIds } from "@/features/editor/lib/official-presets";
import { isDefaultChatInterface } from "./starter-state";

/** Matches the blank-card constructor; this fixture must not use the matcher. */
const blankPresets = (): WorldEntry[] => OFFICIAL_PRESETS.map((preset) => ({
  id: `entry-${preset.presetId}`,
  name: preset.name,
  content: preset.content,
  role: "system",
  apiRole: preset.apiRole,
  alwaysSend: deriveSectionDefaults(preset.section).alwaysSend,
  keywords: [],
  conditions: [],
  conditionLogic: "all",
  enabled: true,
  position: preset.position,
  section: preset.section,
  presetId: preset.presetId,
  tags: ["Preset"],
}));

test("recognizes all five stock presets before and after schema defaults are materialized", () => {
  const entries = blankPresets();
  assert.equal(entries.length, 5);
  const expected = new Set(entries.map((entry) => entry.id));
  assert.deepEqual(getUnmodifiedOfficialPresetIds(entries), expected);
  assert.deepEqual(getUnmodifiedOfficialPresetIds(entries.map((entry) => worldEntrySchema.parse(entry))), expected);
});

test("keeps modified text, delivery, activation, and organization visible", () => {
  const original = blankPresets()[0]!;
  const changes: Partial<WorldEntry>[] = [
    { content: `${original.content}\nThe author added a rule.` },
    { role: "character" },
    { section: "post-history" },
    { apiRole: "assistant" },
    { enabled: false },
    { alwaysSend: false },
    { keywords: ["mine"] },
    { conditions: [{ variableId: "hp", operator: "gt", value: 0 }] },
    { conditionLogic: "any" },
    { variableBound: true },
    { worldbookId: "dungeon" },
    { folderId: "folder" },
    { bundleInstallId: "bundle" },
    { audience: "player" },
    { pairId: "paired-entry" },
    { depth: 2 },
    { tags: ["Preset", "edited"] },
    { matchWholeWords: true },
    { secondaryKeywords: ["boss"] },
    { secondaryKeywordLogic: "NOT_ALL" },
    { preventRecursion: true },
    { excludeRecursion: true },
    { initialVariables: { route: "mine" } },
  ];
  for (const change of changes) {
    assert.equal(getUnmodifiedOfficialPresetIds([{ ...original, ...change }]).size, 0, JSON.stringify(change));
  }
  const withFutureActivation = { ...original, activation: { mode: "manual" } };
  assert.equal(getUnmodifiedOfficialPresetIds([withFutureActivation]).size, 0);
});

test("same-named custom entries and mismatched preset identities never fold", () => {
  const original = blankPresets()[0]!;
  assert.equal(getUnmodifiedOfficialPresetIds([{ ...original, presetId: undefined }]).size, 0);
  assert.equal(getUnmodifiedOfficialPresetIds([{ ...original, presetId: "task" }]).size, 0);
  assert.equal(getUnmodifiedOfficialPresetIds([{ ...original, presetId: "custom-preset" }]).size, 0);
  const entries = blankPresets();
  entries[0] = { ...entries[0]!, content: "Custom text" };
  assert.deepEqual(getUnmodifiedOfficialPresetIds(entries), new Set(entries.slice(1).map((entry) => entry.id)));
});

test("duplicate official identities remain visible so authors can see both prompt copies", () => {
  const entries = blankPresets();
  const duplicate = { ...entries[0]!, id: "second-fiction-mode" };
  assert.deepEqual(getUnmodifiedOfficialPresetIds([...entries, duplicate]), new Set(entries.slice(1).map((entry) => entry.id)));
});

const root = (files: Record<string, string>): RootComponent => ({
  id: "root", name: "World Component", entryFile: "index.tsx", files, updatedAt: "2026-09-05T00:00:00.000Z",
});

test("only the stock chat or missing frontend gets the ready-made chat status", () => {
  assert.equal(isDefaultChatInterface({}), true);
  assert.equal(isDefaultChatInterface({ rootComponent: root({ "index.tsx": "export default function MyWorld() {\n return <Chat />;\n}" }) }), true);
  assert.equal(isDefaultChatInterface({ rootComponent: root({ "index.tsx": "export default function MyWorld() { return null; }" }) }), false);
  assert.equal(isDefaultChatInterface({ rootComponent: root({ "index.tsx": "export default function App() { return <div>Hello</div>; }" }) }), false);
  assert.equal(isDefaultChatInterface({ rootComponent: root({ "index.tsx": "export default function App({ api }) { return <Chat />; }" }) }), false);
  assert.equal(isDefaultChatInterface({ rootComponent: root({ "index.tsx": "export default function MyWorld() { return <Chat />; }", "custom.tsx": "export const Custom = () => null;" }) }), false);
  assert.equal(isDefaultChatInterface({ uiDoc: { version: 1, entryPageId: "p", pages: [{ id: "p", name: "Main", height: 812, elements: [] }] } }), false);
});

test("a localized display name or renumbered position is layout, not authorship", () => {
  const original = blankPresets()[0]!;
  assert.equal(getUnmodifiedOfficialPresetIds([{ ...original, name: "风格" }]).size, 1);
  assert.equal(getUnmodifiedOfficialPresetIds([{ ...original, position: 7 }]).size, 1);
});
