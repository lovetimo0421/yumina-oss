import { overlayDiscoverArtwork } from "./admin-world-artwork.js";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { DEFAULT_EDITORIAL_CATEGORIES, type DiscoverEditorialConfig, type EditorialWorld, type EditorialSlot, type EditorialLanguage } from "@yumina/shared";
import type { Database } from "../db/index.js";
import { adminActions, discoverEditorial, featuredCollections, featuredHeroWorlds, featuredWorlds, user, worlds } from "../db/schema.js";
import { resolveImageCdn } from "./cdn-url.js";
import { aggregatedCounters } from "./world-aggregates.js";
import { withWorldPlaytime } from "./world-playtime.js";
import { normalizeWorldLanguage } from "./world-language.js";

export async function publishedEditorial(database: Database) {
  const [row] = await database.select().from(discoverEditorial).where(eq(discoverEditorial.id, "published"));
  return row;
}

/** Import every stored scope, including inactive schedules, without mutating legacy tables. */
export async function importLegacyEditorial(database: Database): Promise<DiscoverEditorialConfig> {
  const [collections, oldFeatured, oldHero] = await Promise.all([
    database.select().from(featuredCollections),
    database.select().from(featuredWorlds).orderBy(featuredWorlds.slot),
    database.select().from(featuredHeroWorlds).orderBy(featuredHeroWorlds.slot),
  ]);
  const featured: DiscoverEditorialConfig["featured"] = collections.map(c => ({ categoryId: c.channel,
    language: c.language as EditorialLanguage, contentMode: c.contentMode as "default" | "safe" | "sensitive", layout: "mosaic",
    slots: [...c.slots].sort((a, b) => a.slot - b.slot).map(s => ({ id: `legacy-${c.channel}-${c.language}-${c.contentMode}-${s.slot}`, worldId: s.worldId, note: s.note, startsAt: s.startsAt, endsAt: s.endsAt })),
  }));
  if (!featured.some(c => c.categoryId === "all" && c.language === "default" && c.contentMode === "default")) {
    featured.push({ categoryId: "all", language: "default", contentMode: "default", layout: "mosaic", slots: oldFeatured.map(s => ({ id: s.id, worldId: s.worldId, note: s.note, startsAt: s.startsAt?.toISOString() ?? null, endsAt: s.endsAt?.toISOString() ?? null })) });
  }
  const groupIds = oldHero.flatMap(s => s.languageGroupId ? [s.languageGroupId] : []);
  const siblings = groupIds.length ? await database.select({ id: worlds.id, language: worlds.language, languageGroupId: worlds.languageGroupId, isPrimaryVariant: worlds.isPrimaryVariant, isPublished: worlds.isPublished, status: worlds.status, visibility: worlds.visibility }).from(worlds).where(inArray(worlds.languageGroupId, groupIds)).orderBy(desc(worlds.isPrimaryVariant), worlds.createdAt, worlds.id) : [];
  const hero: DiscoverEditorialConfig["hero"] = [];
  for (const language of [...new Set(oldHero.map(s => s.language))]) {
    const slots = oldHero.filter(s => s.language === language).map(s => {
      const variants = siblings.filter(w => w.languageGroupId === s.languageGroupId);
      const available = variants.filter(editorialWorldAvailable);
      const world = available.find(w => normalizeWorldLanguage(w.language) === language) ?? available[0] ?? variants[0];
      return { id: s.id, worldId: s.worldId ?? world?.id ?? `legacy-group:${s.languageGroupId}`, note: s.note, startsAt: s.startsAt?.toISOString() ?? null, endsAt: s.endsAt?.toISOString() ?? null };
    });
    hero.push({ language: language as EditorialLanguage, contentMode: "default", slots });
  }
  // English historically supplies the shared fallback. Preserve its explicit scope too.
  hero.unshift({ language: "default", contentMode: "default", slots: structuredClone(hero.find(c => c.language === "en")?.slots ?? []) });
  return { version: 1, categories: structuredClone(DEFAULT_EDITORIAL_CATEGORIES), featured, hero };
}

export const editorialWorldSelection = {
  id: worlds.id, name: worlds.name, description: worlds.description,
  creatorId: worlds.creatorId, creatorName: user.name, creatorUsername: user.username, creatorImage: user.image,
  thumbnailUrl: worlds.thumbnailUrl, landscapeCoverUrl: worlds.landscapeCoverUrl,
  coverCrop: worlds.coverCrop, galleryCoverCrop: worlds.galleryCoverCrop, landscapeCoverCrop: worlds.landscapeCoverCrop,
  language: worlds.language, languageGroupId: worlds.languageGroupId, isPrimaryVariant: worlds.isPrimaryVariant,
  isPublished: worlds.isPublished, status: worlds.status, visibility: worlds.visibility,
  isNsfw: worlds.isNsfw, ageRating: worlds.ageRating, blurCover: worlds.blurCover,
  messageCount: aggregatedCounters.messageCount, gamePath: worlds.gamePath,
};
async function resolveArtwork(rows: Omit<EditorialWorld, "totalPlaytimeSeconds">[]): Promise<EditorialWorld[]> {
  return withWorldPlaytime((await overlayDiscoverArtwork(rows)).map(w => ({ ...w, thumbnailUrl: resolveImageCdn(w.thumbnailUrl), landscapeCoverUrl: resolveImageCdn(w.landscapeCoverUrl), creatorImage: resolveImageCdn(w.creatorImage) })));
}
export async function editorialWorldsForConfig(database: Database, config: DiscoverEditorialConfig): Promise<EditorialWorld[]> {
  const ids = [...new Set([...config.featured, ...config.hero].flatMap(c => c.slots.map(s => s.worldId)))];
  if (!ids.length) return [];
  const pinned = await database.select({ languageGroupId: worlds.languageGroupId }).from(worlds).where(inArray(worlds.id, ids));
  const groups = pinned.flatMap(w => w.languageGroupId ? [w.languageGroupId] : []);
  const rows = await database.select(editorialWorldSelection).from(worlds).leftJoin(user, eq(worlds.creatorId, user.id))
    .where(or(inArray(worlds.id, ids), ...(groups.length ? [inArray(worlds.languageGroupId, groups)] : [])));
  return resolveArtwork(rows);
}
export async function readEditorialStudio(database: Database) {
  const published = await publishedEditorial(database);
  const config = published?.config ?? await importLegacyEditorial(database);
  return { revision: published?.revision ?? null, config, worlds: await editorialWorldsForConfig(database, config) };
}

export function editorialWorldAvailable(world: { isPublished: boolean | null; status: string | null; visibility: string | null }) {
  return world.isPublished === true && world.status === "published" && world.visibility === "public";
}
export function activeEditorialSlots(slots: EditorialSlot[], now = Date.now()) {
  return slots.filter(s => (!s.startsAt || Date.parse(s.startsAt) <= now) && (!s.endsAt || Date.parse(s.endsAt) > now));
}

export class EditorialValidationError extends Error {}
export async function publishEditorial(database: Database, adminId: string, revision: string | null, config: DiscoverEditorialConfig) {
  return database.transaction(async tx => {
    const transaction = tx as unknown as Database;
    const existing = await publishedEditorial(transaction);
    if ((existing?.revision ?? null) !== revision) return undefined;
    const previous = existing?.config ?? await importLegacyEditorial(transaction);
    const ids = [...new Set([...config.featured, ...config.hero].flatMap(c => c.slots.map(s => s.worldId)))];
    const rows = ids.length ? await tx.select({ id: worlds.id, languageGroupId: worlds.languageGroupId, isPublished: worlds.isPublished, status: worlds.status, visibility: worlds.visibility, ageRating: worlds.ageRating, isNsfw: worlds.isNsfw }).from(worlds).where(inArray(worlds.id, ids)) : [];
    const byId = new Map(rows.map(w => [w.id, w]));
    for (const [kind, collections] of [["featured", config.featured], ["hero", config.hero]] as const) {
      for (const collection of collections) {
        const prior = previous[kind].find(c => c.language === collection.language && c.contentMode === collection.contentMode && ("categoryId" in c ? c.categoryId : undefined) === ("categoryId" in collection ? collection.categoryId : undefined));
        const groups = new Set<string>();
        for (const slot of collection.slots) {
          const world = byId.get(slot.worldId);
          const unchanged = prior?.slots.some(s => s.id === slot.id && s.worldId === slot.worldId);
          if ((!world || !editorialWorldAvailable(world) || (collection.contentMode === "safe" && (world.isNsfw || world.ageRating !== "all"))) && !unchanged) {
            throw new EditorialValidationError("Choose published, public worlds eligible for this content mode. Existing unavailable cards may be retained or removed.");
          }
          const key = world?.languageGroupId ? `group:${world.languageGroupId}` : `world:${slot.worldId}`;
          if (groups.has(key)) throw new EditorialValidationError("Choose only one translation of each world per lineup.");
          groups.add(key);
        }
      }
    }
    const nextRevision = crypto.randomUUID();
    const [saved] = revision === null
      ? await tx.insert(discoverEditorial).values({ id: "published", revision: nextRevision, config }).onConflictDoNothing().returning()
      : await tx.update(discoverEditorial).set({ revision: nextRevision, config, updatedAt: new Date() }).where(and(eq(discoverEditorial.id, "published"), eq(discoverEditorial.revision, revision))).returning();
    if (!saved) return undefined;
    await tx.insert(adminActions).values({ adminId, actionType: "publish_discover_editorial", targetType: "discover_editorial", targetId: "published", metadata: { previousRevision: revision, revision: nextRevision, previousConfig: previous, config } });
    return saved;
  });
}

export async function searchEditorialWorlds(database: Database, query: string, offset: number) {
  const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
  const groupKey = sql<string>`CASE WHEN ${worlds.languageGroupId} IS NULL THEN 'world:' || ${worlds.id} ELSE 'group:' || ${worlds.languageGroupId} END`;
  const groups = await database.select({ key: groupKey }).from(worlds).leftJoin(user, eq(worlds.creatorId, user.id))
    .where(query ? or(eq(worlds.id, query), ilike(worlds.name, pattern), ilike(user.name, pattern), ilike(user.username, pattern)) : and(eq(worlds.isPublished, true), eq(worlds.status, "published")))
    .groupBy(groupKey).orderBy(sql`max(${worlds.createdAt}) DESC`, groupKey).limit(21).offset(offset);
  const keys = groups.slice(0, 20).map(g => g.key);
  if (!keys.length) return { worlds: [], nextCursor: null };
  const rows = await database.select(editorialWorldSelection).from(worlds).leftJoin(user, eq(worlds.creatorId, user.id)).where(inArray(groupKey, keys)).orderBy(worlds.language, worlds.id);
  rows.sort((a, b) => keys.indexOf(a.languageGroupId ? `group:${a.languageGroupId}` : `world:${a.id}`) - keys.indexOf(b.languageGroupId ? `group:${b.languageGroupId}` : `world:${b.id}`));
  return { worlds: await resolveArtwork(rows), nextCursor: groups.length > 20 ? String(offset + 20) : null };
}
