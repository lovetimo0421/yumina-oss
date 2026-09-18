import { normalizeHubLanguage, normalizeWorldLanguage } from "./world-language.js";

export type HeroSlot = { slot: number; kind: "world" | "group"; id: string };
export interface HeroSlotRow {
  slot: number;
  language: string;
  kind: string;
  worldId: string | null;
  languageGroupId: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
}

/** An active local lineup replaces English; otherwise inherit English in full. */
export function resolveHeroSlots(rows: HeroSlotRow[], language: string, now = new Date()): HeroSlot[] {
  const locale = normalizeHubLanguage(language) ?? "en";
  const active = rows.filter(row => (!row.startsAt || row.startsAt <= now) && (!row.endsAt || row.endsAt > now));
  const local = active.filter(row => row.language === locale);
  return (local.length ? local : active.filter(row => row.language === "en"))
    .sort((a, b) => a.slot - b.slot)
    .flatMap<HeroSlot>(row => {
      if (row.kind === "world" && row.worldId) return [{ slot: row.slot, kind: "world" as const, id: row.worldId }];
      if (row.kind === "group" && row.languageGroupId) return [{ slot: row.slot, kind: "group" as const, id: row.languageGroupId }];
      return [];
    });
}

interface HeroCandidate {
  id: string;
  language: string | null;
  languageGroupId: string | null;
  isPrimaryVariant: boolean;
  createdAt: Date | string | null;
}

/** Candidates have already passed publication, visibility, age and block filters.
 * Return real variant rows so their titles, links, covers and game paths agree. */
export function resolveHeroWorlds<T extends HeroCandidate>(slots: HeroSlot[], candidates: T[], language: string): T[] {
  const locale = normalizeHubLanguage(language) ?? "en";
  const rank = (world: T) => {
    const lang = normalizeWorldLanguage(world.language);
    return lang === locale ? 0 : lang === "en" ? 1 : 2;
  };
  const sorted = [...candidates].sort((a, b) => rank(a) - rank(b)
    || Number(b.isPrimaryVariant) - Number(a.isPrimaryVariant)
    || Number(a.language !== locale) - Number(b.language !== locale)
    || new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime()
    || a.id.localeCompare(b.id));
  const seen = new Set<string>();
  return slots.flatMap(slot => {
    // A per-world pin is an explicit override; only group pins select siblings.
    const world = sorted.find(candidate => slot.kind === "world"
      ? candidate.id === slot.id : candidate.languageGroupId === slot.id);
    if (!world) return [];
    const key = world.languageGroupId ?? world.id;
    if (seen.has(key)) return [];
    seen.add(key);
    return [world];
  });
}
