import assert from "node:assert/strict";
import test from "node:test";
import { deriveSectionDefaults, OFFICIAL_PRESET_LANGUAGES, OFFICIAL_PRESETS, officialPresetsFor, type WorldEntry } from "@yumina/engine";
import { getUnmodifiedOfficialPresetIds, officialPresetsForCard } from "./official-presets";

const preset = OFFICIAL_PRESETS[0]!;
const other = OFFICIAL_PRESETS[1]!;

/** An entry exactly as a template materializes it. */
function scaffolding(source = preset, id = `entry-${source.presetId}`): WorldEntry {
  return {
    id,
    name: source.name,
    content: source.content,
    role: "system",
    apiRole: source.apiRole,
    alwaysSend: deriveSectionDefaults(source.section).alwaysSend,
    keywords: [],
    conditions: [],
    conditionLogic: "all",
    enabled: true,
    position: source.position,
    section: source.section,
    presetId: source.presetId,
    tags: ["Preset"],
  } as WorldEntry;
}

const folded = (entries: WorldEntry[]) => [...getUnmodifiedOfficialPresetIds(entries)];

test("untouched scaffolding folds away", () => {
  assert.deepEqual(folded([scaffolding(), scaffolding(other)]).sort(),
    [`entry-${preset.presetId}`, `entry-${other.presetId}`].sort());
});

test("a localized name or a renumbered position is still untouched scaffolding", () => {
  // Templates translate the display name and renumber within a section. Neither
  // reaches the AI, so neither means the author edited anything.
  assert.deepEqual(folded([{ ...scaffolding(), name: "小説モード", position: 7 }]), [`entry-${preset.presetId}`]);
});

/**
 * Everything below must stay VISIBLE. A fold that hides an edited entry is the
 * bad direction of this feature: the author's own words vanish behind a
 * "Default narration" row and they cannot find them again.
 */
const EDITED: { what: string; entry: WorldEntry }[] = [
  { what: "rewritten content", entry: { ...scaffolding(), content: `${preset.content} And never mention the rain.` } },
  { what: "trimmed content", entry: { ...scaffolding(), content: "" } },
  { what: "switched off", entry: { ...scaffolding(), enabled: false } },
  { what: "no longer always sent", entry: { ...scaffolding(), alwaysSend: !deriveSectionDefaults(preset.section).alwaysSend } },
  { what: "given keywords", entry: { ...scaffolding(), keywords: ["rain"] } },
  { what: "given a condition", entry: { ...scaffolding(), conditions: [{ variableId: "hp", operator: "lt", value: 5 }] as never } },
  { what: "moved to another section", entry: { ...scaffolding(), section: "post-history" } },
  { what: "given a different api role", entry: { ...scaffolding(), apiRole: "user" } },
  { what: "moved into a module", entry: { ...scaffolding(), worldbookId: "book-1" } as WorldEntry },
  { what: "carrying an author's tag", entry: { ...scaffolding(), tags: ["Preset", "mine"] } },
];

for (const { what, entry } of EDITED) {
  test(`scaffolding with ${what} stays visible`, () => {
    assert.deepEqual(folded([entry]), []);
  });
}

test("an entry the author wrote themselves is never folded", () => {
  const own = { ...scaffolding(), id: "mine", presetId: undefined, content: "My own rule." } as WorldEntry;
  assert.deepEqual(folded([own]), []);
});

test("an unknown presetId is not scaffolding this build knows how to fold", () => {
  assert.deepEqual(folded([{ ...scaffolding(), presetId: "some-future-preset" } as WorldEntry]), []);
});

test("duplicated scaffolding stays visible, both copies", () => {
  // Two entries claiming the same presetId means one is a copy the author made.
  // Neither can be matched back to "the" preset, so neither may be hidden.
  assert.deepEqual(folded([scaffolding(preset, "a"), scaffolding(preset, "b")]), []);
});

test("a field this build has never heard of keeps the entry visible", () => {
  // Future activation/ownership metadata must not inherit the treatment meant
  // for untouched scaffolding just because the fields it does know still match.
  assert.deepEqual(folded([{ ...scaffolding(), somethingNew: true } as unknown as WorldEntry]), []);
});

test("every translation is the same five presets, only the words differ", () => {
  for (const language of OFFICIAL_PRESET_LANGUAGES) {
    const presets = officialPresetsFor(language);
    assert.deepEqual(presets.map(({ presetId, section, apiRole, position }) => ({ presetId, section, apiRole, position })),
      OFFICIAL_PRESETS.map(({ presetId, section, apiRole, position }) => ({ presetId, section, apiRole, position })), language);
    for (const [i, localized] of presets.entries()) {
      // The reply filter strips leaked blocks by tag, and {{user}} must survive.
      const tag = OFFICIAL_PRESETS[i]!.content.split(/\r?\n/)[0];
      assert.equal(localized.content.split(/\r?\n/)[0], tag, `${language} ${localized.presetId}`);
      assert.equal(localized.content.includes("{{user}}"), OFFICIAL_PRESETS[i]!.content.includes("{{user}}"), `${language} ${localized.presetId}`);
    }
  }
  assert.equal(officialPresetsFor("ko"), OFFICIAL_PRESETS);
});

test("a card born with Chinese presets is still untouched scaffolding, until a word changes", () => {
  const zh = officialPresetsFor("zh");
  assert.deepEqual(folded([scaffolding(zh[0]), scaffolding(zh[1])]).sort(),
    [`entry-${zh[0]!.presetId}`, `entry-${zh[1]!.presetId}`].sort());
  assert.deepEqual(folded([{ ...scaffolding(zh[0]), content: zh[0]!.content + "。" }]), []);
  // Another preset's text under this id is not this preset.
  assert.deepEqual(folded([{ ...scaffolding(zh[0]), content: zh[1]!.content }]), []);
});

test("restore and re-add follow the language the card's presets are in", () => {
  const ja = officialPresetsFor("ja");
  assert.equal(officialPresetsForCard([scaffolding(ja[2])], "zh")[0]!.content, ja[0]!.content);
  assert.equal(officialPresetsForCard([], "zh-Hant")[0]!.content, officialPresetsFor("zh-Hant")[0]!.content);
  assert.equal(officialPresetsForCard([{ ...scaffolding(), content: "mine" }], "es")[0]!.content, officialPresetsFor("es")[0]!.content);
});
