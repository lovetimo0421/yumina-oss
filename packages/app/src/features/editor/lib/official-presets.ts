import {
  deriveSectionDefaults,
  isOfficialPresetContent,
  OFFICIAL_PRESET_LANGUAGES,
  OFFICIAL_PRESETS,
  officialPresetsFor,
  type OfficialPreset,
  type WorldEntry,
} from "@yumina/engine";
import { clampLanguage } from "@/lib/language-clamp";

/**
 * Which of the card's entries are still exactly the official preset they were
 * born as — the scaffolding a template puts in, that the author has not
 * touched.
 *
 * Lives here rather than under the canvas because both editors fold on it, and
 * "did the author write this" is not a thing two editors may disagree about.
 */
const presetById = new Map(OFFICIAL_PRESETS.map((preset) => [preset.presetId, preset]));

/** These defaults are materialized by the schema when a saved card is loaded. */
const optionalDefaults = {
  matchWholeWords: false,
  secondaryKeywords: [],
  secondaryKeywordLogic: "AND_ANY",
  preventRecursion: false,
  excludeRecursion: false,
  variableBound: false,
  audience: "both",
  sessionEditPolicy: "locked",
} as const;

/**
 * A collapsed status must never conceal an author's changes. Compare the real
 * preset identity and all authorable fields, not just its tag or display name.
 * Unknown fields also stay visible, so future activation/ownership metadata
 * cannot silently inherit the treatment intended for untouched scaffolding.
 */
export function getUnmodifiedOfficialPresetIds(entries: readonly WorldEntry[]): Set<string> {
  const ids = new Set<string>();
  const copies = new Map<string, number>();
  for (const entry of entries) {
    if (entry.presetId) copies.set(entry.presetId, (copies.get(entry.presetId) ?? 0) + 1);
  }
  for (const entry of entries) {
    const preset = entry.presetId ? presetById.get(entry.presetId) : undefined;
    if (!preset || copies.get(preset.presetId) !== 1) continue;
    const expected: Record<string, unknown> = {
      id: entry.id,
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
      ...optionalDefaults,
    };
    const actual: Record<string, unknown> = { ...optionalDefaults, ...entry };
    // Templates localize the preset's display name and number positions per
    // section, so neither says anything about whether the author touched the
    // scaffolding. Only the text the AI reads and its delivery settings do.
    for (const layoutKey of ["name", "position"]) {
      delete expected[layoutKey];
      delete actual[layoutKey];
    }
    // A card is born with the presets in its creator's language; any shipped
    // translation is still untouched scaffolding.
    if (typeof entry.content === "string" && isOfficialPresetContent(preset.presetId, entry.content)) {
      expected.content = entry.content;
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    if ([...keys].every((key) => JSON.stringify(actual[key]) === JSON.stringify(expected[key]))) {
      ids.add(entry.id);
    }
  }
  return ids;
}

/**
 * The official presets in the language this card's presets are already in, so
 * restoring or re-adding one does not drop an English block into a Chinese
 * card. A card with no untouched preset follows the editor's language.
 */
export function officialPresetsForCard(entries: readonly WorldEntry[], uiLanguage: string): OfficialPreset[] {
  for (const language of OFFICIAL_PRESET_LANGUAGES) {
    const presets = officialPresetsFor(language);
    if (entries.some((entry) => presets.some((preset) => preset.presetId === entry.presetId && preset.content === entry.content))) {
      return presets;
    }
  }
  return officialPresetsFor(clampLanguage(uiLanguage));
}
