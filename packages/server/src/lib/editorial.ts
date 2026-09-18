import { and, asc, inArray } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { editorialBoosts, featuredHeroWorlds, featuredWorlds } from "../db/schema.js";
import { resolveHeroSlots, type HeroSlot } from "./hero-worlds.js";
import { normalizeHubLanguage } from "./world-language.js";
export type { HeroSlot } from "./hero-worlds.js";

const TTL_MS = 60_000;

export interface EditorialBoostRow {
  worldId: string | null;
  languageGroupId: string | null;
  scoreBoost: number;
  startsAt: Date | null;
  endsAt: Date | null;
}

interface CacheEntry {
  expiresAt: number;
  rows: EditorialBoostRow[];
}

let cache: CacheEntry | null = null;

export function __resetEditorialCache() {
  cache = null;
}

async function defaultLoader(): Promise<EditorialBoostRow[]> {
  // Lazy import so env validation is deferred until actual db access (not at module load)
  const { db } = await import("../db/index.js");
  return db
    .select({
      worldId: editorialBoosts.worldId,
      languageGroupId: editorialBoosts.languageGroupId,
      scoreBoost: editorialBoosts.scoreBoost,
      startsAt: editorialBoosts.startsAt,
      endsAt: editorialBoosts.endsAt,
    })
    .from(editorialBoosts);
}

export async function loadEditorialBoosts(
  loader: () => Promise<EditorialBoostRow[]> = defaultLoader,
): Promise<EditorialBoostRow[]> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.rows;
  const rows = await loader();
  cache = { rows, expiresAt: now + TTL_MS };
  return rows;
}

export function isEditorialBoostActive(row: EditorialBoostRow, now: Date): boolean {
  return (!row.startsAt || row.startsAt <= now) && (!row.endsAt || row.endsAt > now);
}

export async function getEditorialBoostForCandidate(
  candidate: { id: string; languageGroupId: string | null },
  loader: () => Promise<EditorialBoostRow[]> = defaultLoader,
): Promise<number> {
  const rows = await loadEditorialBoosts(loader);
  const now = new Date();
  // Prefer languageGroup match (broader semantic) over worldId match
  if (candidate.languageGroupId) {
    const groupHit = rows.find((r) => isEditorialBoostActive(r, now) && r.languageGroupId === candidate.languageGroupId);
    if (groupHit) return groupHit.scoreBoost;
  }
  const worldHit = rows.find((r) => isEditorialBoostActive(r, now) && r.worldId === candidate.id);
  return worldHit?.scoreBoost ?? 0;
}

export async function loadFeaturedSlots(
  db: Database,
): Promise<Array<{ slot: number; worldId: string }>> {
  const now = new Date();
  const rows = await db
    .select({
      slot: featuredWorlds.slot,
      worldId: featuredWorlds.worldId,
      startsAt: featuredWorlds.startsAt,
      endsAt: featuredWorlds.endsAt,
    })
    .from(featuredWorlds)
    .orderBy(featuredWorlds.slot);
  return rows
    .filter((r) => (!r.startsAt || r.startsAt <= now) && (!r.endsAt || r.endsAt > now))
    .map(({ slot, worldId }) => ({ slot, worldId }));
}

/** Load the hero-carousel slot list for a given UI language. Returns slots
 * in display order, filtered to those whose date window is currently
 * active. The route then resolves each slot id (worldId or
 * languageGroupId) into an actual world the renderer can use. */
export async function loadFeaturedHeroSlots(
  db: Database,
  language: string,
): Promise<HeroSlot[]> {
  const locale = normalizeHubLanguage(language) ?? "en";
  const rows = await db
    .select({
      slot: featuredHeroWorlds.slot,
      language: featuredHeroWorlds.language,
      kind: featuredHeroWorlds.kind,
      worldId: featuredHeroWorlds.worldId,
      languageGroupId: featuredHeroWorlds.languageGroupId,
      startsAt: featuredHeroWorlds.startsAt,
      endsAt: featuredHeroWorlds.endsAt,
    })
    .from(featuredHeroWorlds)
    .where(inArray(featuredHeroWorlds.language, locale === "en" ? ["en"] : [locale, "en"]))
    .orderBy(asc(featuredHeroWorlds.slot));
  return resolveHeroSlots(rows, locale);
}

// Suppress lint false-positive — `and` is exported for future date-range
// queries we may add to this loader.
void and;
