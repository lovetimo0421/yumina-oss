import type { Variable, YuminaBundle } from "../types/index.js";
import type { AppPackDef, AppPackLanguage } from "./app-pack-types.js";
import { APP_PACK_SOURCES } from "./app-pack-sources.generated.js";
import { relations } from "./app-pack-defs/relations.js";
import { phone } from "./app-pack-defs/phone.js";
import { social } from "./app-pack-defs/social.js";
import { time } from "./app-pack-defs/time.js";
import { status } from "./app-pack-defs/status.js";
import { bag } from "./app-pack-defs/bag.js";
import { places } from "./app-pack-defs/places.js";
import { journal } from "./app-pack-defs/journal.js";
import { achievements } from "./app-pack-defs/achievements.js";

export type { AppPackLanguage } from "./app-pack-types.js";

/**
 * App packs — small in-story apps (relationships, phone, feed, time…) a card
 * gets in one click, so the AI never has to invent a mock app for every card.
 *
 * Each pack is an ordinary `YuminaBundle`, installed by the same importer as
 * any community bundle, and made of three parts:
 *   1. ONE json variable holding the app's data (`app_<id>`).
 *   2. That variable's `behaviorRules`: the data's shape and when to change
 *      it. The engine already teaches the directive syntax and shows the
 *      current value every turn, so the rules only say what, not how.
 *   3. A UI file exporting `app` metadata. The composed index puts every such
 *      bundle into one shared dock instead of each drawing its own button.
 *
 * Definitions: `app-pack-defs/<id>.ts`. UI: `packages/engine/app-packs/<id>.tsx`
 * (real TSX), copied into app-pack-sources.generated.ts by
 * `pnpm --filter @yumina/engine gen:app-packs`. Words are fixed once, at
 * install, in the card's language — an installed pack is the card's own
 * content from then on.
 */

const PACKS = { relations, phone, social, time, status, bag, places, journal, achievements } satisfies Record<string, AppPackDef>;

/** Dock order. */
export const APP_PACK_IDS = ["relations", "phone", "social", "time", "status", "bag", "places", "journal", "achievements"] as const;
export type AppPackId = (typeof APP_PACK_IDS)[number];

export interface AppPackSummary {
  id: AppPackId;
  icon: string;
  name: string;
  description: string;
}

/** A starter set for a kind of card: what most cards of that kind track. */
export interface AppPackSet {
  id: "romance" | "adventure" | "mystery";
  name: string;
  packs: AppPackId[];
}

const SETS: Record<AppPackLanguage, AppPackSet[]> = {
  zh: [
    { id: "romance", name: "恋爱 / 都市", packs: ["relations", "phone", "social", "time"] },
    { id: "adventure", name: "冒险 / RPG", packs: ["status", "bag", "places", "achievements"] },
    { id: "mystery", name: "悬疑 / 生存", packs: ["journal", "places", "time", "relations"] },
  ],
  en: [
    { id: "romance", name: "Romance / modern life", packs: ["relations", "phone", "social", "time"] },
    { id: "adventure", name: "Adventure / RPG", packs: ["status", "bag", "places", "achievements"] },
    { id: "mystery", name: "Mystery / survival", packs: ["journal", "places", "time", "relations"] },
  ],
  es: [
    { id: "romance", name: "Romance / vida moderna", packs: ["relations", "phone", "social", "time"] },
    { id: "adventure", name: "Aventura / RPG", packs: ["status", "bag", "places", "achievements"] },
    { id: "mystery", name: "Misterio / supervivencia", packs: ["journal", "places", "time", "relations"] },
  ],
};

/** Placeholder in the UI sources, replaced with the card's language. */
export const APP_PACK_LANG_TOKEN = "__YUMINA_APP_LANG__";

/** Map any language tag to one the packs are written in. */
export function appPackLanguage(language: string | undefined): AppPackLanguage {
  const base = (language ?? "en").toLowerCase().split("-")[0];
  return base === "zh" || base === "es" ? base : "en";
}

/** The UI source for a pack, with its words fixed to one language. */
export function appPackSource(id: AppPackId, language: string | undefined): string {
  return (APP_PACK_SOURCES[id] ?? "").split(APP_PACK_LANG_TOKEN).join(appPackLanguage(language));
}

/** The variable id a pack installs (`app_<id>`). */
export function appPackVariableId(id: AppPackId): string {
  return PACKS[id].variableId;
}

/** Sample data for previews (the editor renders each app with it). */
export function appPackSample(id: AppPackId, language?: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(PACKS[id].sample[appPackLanguage(language)])) as Record<string, unknown>;
}

/** The installable bundle for one app pack, in the card's language. */
export function appPack(id: AppPackId, language?: string): YuminaBundle {
  const pack = PACKS[id];
  const lang = appPackLanguage(language);
  const words = pack.words[lang];
  const variable: Variable = {
    id: pack.variableId,
    name: words.variableName,
    type: "json",
    defaultValue: JSON.parse(JSON.stringify(pack.defaultValue)) as Record<string, unknown>,
    description: words.description,
    behaviorRules: words.rules,
  };
  return {
    bundleVersion: "3.0.0",
    name: words.variableName,
    description: words.description,
    tags: ["app"],
    createdAt: new Date(0).toISOString(),
    entries: [],
    variables: [variable],
    rules: [],
    audioTracks: [],
    rootComponent: {
      id: `app-pack:${id}`,
      name: words.name,
      entryFile: "index.tsx",
      files: { "index.tsx": appPackSource(id, lang) },
      updatedAt: new Date(0).toISOString(),
    },
  };
}

export function appPackSummaries(language?: string): AppPackSummary[] {
  const lang = appPackLanguage(language);
  return APP_PACK_IDS.map((id) => ({
    id,
    icon: PACKS[id].icon,
    name: PACKS[id].words[lang].name,
    description: PACKS[id].words[lang].description,
  }));
}

export function appPackSets(language?: string): AppPackSet[] {
  return SETS[appPackLanguage(language)].map((s) => ({ ...s, packs: [...s.packs] }));
}
