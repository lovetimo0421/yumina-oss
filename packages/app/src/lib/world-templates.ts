import type { WorldDefinition, WorldEntry } from "@yumina/engine";
import { deriveSectionDefaults, OFFICIAL_PRESETS } from "@yumina/engine";
import i18n from "@/lib/i18n";

export interface WorldTemplate {
  id: string;
  name: string;
  description: string;
  archetype: "chat" | "world";
  /** What's included — shown on the picker card */
  summary: { entries: number; variables: number; components: number; rules: number };
  build: () => WorldDefinition;
}

/** Shorthand for reading from the templates-content namespace at build time */
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
  return OFFICIAL_PRESETS.map((preset) => {
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
      // Greeting keeps its real content — first message is the one piece of
      // template text that should be a real default (creators tweak it, not
      // replace it from scratch).
      entry({
        name: t("chat.entries.greeting.name"),
        content: t("chat.entries.greeting.content"),
        role: "greeting",
        alwaysSend: true,
        keywords: [],
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
      // Greeting keeps real content.
      entry({
        name: t("world.entries.greeting.name"),
        content: t("world.entries.greeting.content"),
        role: "greeting",
        alwaysSend: true,
        keywords: [],
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
