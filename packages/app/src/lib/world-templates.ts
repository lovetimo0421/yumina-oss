import type { WorldDefinition, WorldEntry } from "@yumina/engine";
import { deriveSectionDefaults, officialPresetsFor } from "@yumina/engine";
import { clampLanguage } from "@/lib/language-clamp";
import i18n from "@/lib/i18n";

export interface WorldTemplate {
  id: string;
  name: string;
  description: string;
  archetype: "chat" | "world";
  /** What's included — shown on the picker card */
  summary: { entries: number; variables: number; components: number; rules: number };
  build: (language?: string) => WorldDefinition;
}

function t(key: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (i18n as any).t(key, { ns: "templates-content" });
}

// Shared per-section position counter — presets claim first, entries continue after.
const posCounter: Record<string, number> = {};
function nextPos(section: string): number {
  const pos = posCounter[section] ?? 0;
  posCounter[section] = pos + 1;
  return pos;
}

function entry(overrides: Omit<WorldEntry, "id" | "conditions" | "conditionLogic" | "enabled" | "position" | "section"> & Partial<Pick<WorldEntry, "id" | "conditions" | "conditionLogic" | "enabled" | "section">>): WorldEntry {
  const section = overrides.section ?? (
    overrides.role === "greeting" ? "system-presets" as const :
    !overrides.alwaysSend && overrides.keywords?.length ? "chat-history" as const :
    "system-presets" as const
  );
  const defaults = deriveSectionDefaults(section);
  return {
    id: overrides.id ?? crypto.randomUUID(),
    conditions: [],
    conditionLogic: "all",
    enabled: true,
    position: nextPos(section),
    section,
    ...defaults,
    ...overrides,
  };
}

const PRESET_NAME_KEYS: Record<string, string> = {
  "fiction-mode": "presets.fictionMode",
  "task": "presets.task",
  "style": "presets.style",
  "instructions": "presets.instructions",
  "cot-bypass": "presets.cotBypass",
};

function makePresetEntries(): WorldEntry[] {
  for (const key of Object.keys(posCounter)) delete posCounter[key];
  return officialPresetsFor(clampLanguage(i18n.language)).map((preset) => {
    const defaults = deriveSectionDefaults(preset.section);
    return {
      id: crypto.randomUUID(),
      name: PRESET_NAME_KEYS[preset.presetId] ? t(PRESET_NAME_KEYS[preset.presetId]) : preset.name,
      content: preset.content,
      role: "system" as const,
      apiRole: preset.apiRole,
      alwaysSend: defaults.alwaysSend,
      keywords: [],
      conditions: [],
      conditionLogic: "all" as const,
      enabled: true,
      position: nextPos(preset.section),
      section: preset.section,
      presetId: preset.presetId,
      tags: ["Preset"],
    };
  });
}

// ─── Character Chat ──────────────────────────────────────────────────────────

function buildCharacterChat(): WorldDefinition {
  return {
    id: crypto.randomUUID(),
    version: "18.0.0",
    name: t("chat.name"),
    description: t("chat.description"),
    author: "",
    entries: [
      ...makePresetEntries(),
      entry({
        name: t("chat.entries.character.name"),
        // Content is empty by design — the placeholder shows the template
        // until the creator starts typing. See template-placeholders.ts.
        content: "",
        role: "character",
        alwaysSend: true,
        keywords: [],
        tags: ["template-content:chat-character"],
      }),
      entry({
        name: t("chat.entries.worldview.name"),
        content: "",
        role: "scenario",
        alwaysSend: true,
        keywords: [],
        tags: ["chat:worldview", "template-content:chat-worldview"],
      }),
      entry({
        name: t("chat.entries.dialogueAndStyle.name"),
        content: "",
        role: "style",
        alwaysSend: true,
        keywords: [],
        tags: ["chat:dialogue-style", "template-content:chat-dialogueAndStyle"],
      }),
      // The opening starts empty like the rest: its guidance is the grey
      // placeholder (template-content tag). As real text it was what the
      // player read first whenever the author left it — the bracketed note
      // to the author, narrated. The board's screen says it is empty.
      entry({
        name: t("chat.entries.greeting.name"),
        content: "",
        role: "greeting",
        alwaysSend: true,
        keywords: [],
        tags: ["template-content:chat-greeting"],
      }),
    ],
    variables: [],
    rules: [],
    components: [],
    audioTracks: [],
    customUI: [],
    settings: {
      maxTokens: 12000,
      maxContext: 200000,
      temperature: 1.0,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      playerName: "User",
      lorebookScanDepth: 2,
      lorebookRecursionDepth: 0,
    },
  };
}

// ─── World Simulation ───────────────────────────────────────────────────────

function buildWorldSimulation(): WorldDefinition {
  return {
    id: crypto.randomUUID(),
    version: "18.0.0",
    name: t("world.name"),
    description: t("world.description"),
    author: "",
    entries: [
      ...makePresetEntries(),
      entry({
        name: t("world.entries.worldOverview.name"),
        content: "",
        role: "scenario",
        alwaysSend: true,
        keywords: [],
        tags: ["template-content:world-overview"],
      }),
      entry({
        name: t("world.entries.systemAndPowers.name"),
        content: "",
        role: "lore",
        alwaysSend: true,
        keywords: [],
        tags: ["template-content:world-systemAndPowers"],
      }),
      entry({
        name: t("world.entries.npcA.name"),
        content: "",
        role: "character",
        alwaysSend: true,
        keywords: [],
        tags: ["template-content:world-npcA"],
      }),
      entry({
        name: t("world.entries.npcB.name"),
        content: "",
        role: "character",
        alwaysSend: true,
        keywords: [],
        tags: ["template-content:world-npcB"],
      }),
      entry({
        name: t("world.entries.narrativeStyle.name"),
        content: "",
        role: "system",
        alwaysSend: true,
        keywords: [],
        tags: ["template-content:world-narrativeStyle"],
      }),
      // The opening starts empty, its guidance a placeholder (see above).
      entry({
        name: t("world.entries.greeting.name"),
        content: "",
        role: "greeting",
        alwaysSend: true,
        keywords: [],
        tags: ["template-content:world-greeting"],
      }),
    ],
    variables: [],
    rules: [],
    components: [],
    audioTracks: [],
    customUI: [],
    settings: {
      maxTokens: 12000,
      maxContext: 200000,
      temperature: 1.0,
      topP: 1,
      frequencyPenalty: 0,
      presencePenalty: 0,
      playerName: "User",
      lorebookScanDepth: 2,
      lorebookRecursionDepth: 0,
    },
  };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

/** A new card's opening: empty, with a world's first-moment guidance as its
 *  placeholder. 空白项目 starts with it, like the templates do. */
export function defaultOpening(): { name: string; content: string; tags: string[] } {
  return { name: t("world.entries.greeting.name"), content: "", tags: ["template-content:world-greeting"] };
}

/** Whether an opening still says only what a new card started with, so the
 *  tutorial may put its own line there without overwriting anyone's words. */
export function isStarterOpening(content: string): boolean {
  const text = content.trim();
  return !text || text === t("world.entries.greeting.content").trim() || text === t("chat.entries.greeting.content").trim();
}

/** The line the first lesson writes into an empty opening to show where
 *  the story starts (「你好！Yumina」, in any language). It is the lesson's,
 *  not the author's: the board marks it unwritten and the publish list does
 *  not count it, so it never goes out as a card's opening by accident. */
export function isLessonHello(content: string | null | undefined): boolean {
  const text = (content ?? "").trim();
  if (!text) return false;
  const store = i18n.services.resourceStore?.data ?? {};
  return Object.keys(store).some((lng) => {
    const value = i18n.getResource(lng, "learning", "hello") as unknown;
    return typeof value === "string" && value.trim() === text;
  });
}

export const WORLD_TEMPLATES: WorldTemplate[] = [
  {
    id: "character-chat",
    name: "Character Chat",
    description: "One-on-one roleplay with a single character.",
    archetype: "chat",
    summary: { entries: 4, variables: 0, components: 0, rules: 0 },
    build: buildCharacterChat,
  },
  {
    id: "world-simulation",
    name: "World Simulation",
    description: "A living world with characters, locations, and systems.",
    archetype: "world",
    summary: { entries: 6, variables: 0, components: 0, rules: 0 },
    build: buildWorldSimulation,
  },
];

/** Whether a card still carries a name it was given rather than one its
 *  author chose: a template's own (「角色聊天」, 「世界模拟」) or the untitled
 *  default. Shown as an empty name field with its placeholder, so a library
 *  does not fill with cards all called 「角色聊天」. */
/** Whether a card's blurb is still the one its template wrote (in any
 *  language), which reads as the card's own on Discover. */
export function isTemplateDescription(description: string | null | undefined): boolean {
  const blurb = (description ?? "").trim();
  if (!blurb) return false;
  const store = i18n.services.resourceStore?.data ?? {};
  return Object.keys(store).some((lng) =>
    ["chat", "world"].some((template) => {
      const value = i18n.getResource(lng, "templates-content", `${template}.description`) as unknown;
      return typeof value === "string" && value.trim() === blurb;
    }),
  );
}

export function isPlaceholderCardName(name: string | undefined): boolean {
  const text = (name ?? "").trim();
  if (!text) return true;
  return text === t("chat.name") || text === t("world.name")
    || text === String(i18n.t("editor:shell.untitledWorld", { defaultValue: "Untitled World" }));
}
