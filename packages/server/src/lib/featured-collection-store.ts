import { and, eq, inArray } from "drizzle-orm";
import { resolveFeaturedCollection, type FeaturedScope, type FeaturedSlot } from "@yumina/shared";
import type { Database } from "../db/index.js";
import { featuredCollections, featuredWorlds } from "../db/schema.js";

export const featuredScopeWhere = (scope: FeaturedScope) => and(eq(featuredCollections.channel, scope.channel),
  eq(featuredCollections.language, scope.language), eq(featuredCollections.contentMode, scope.contentMode));

export async function readFeaturedCollection(database: Database, scope: FeaturedScope) {
  const rows = await database.select().from(featuredCollections).where(and(
    eq(featuredCollections.channel, scope.channel), inArray(featuredCollections.language, [scope.language, "default"]),
    inArray(featuredCollections.contentMode, [scope.contentMode, "default"]),
  ));
  const chosen = resolveFeaturedCollection(rows, scope);
  const exact = rows.find(r => r.language === scope.language && r.contentMode === scope.contentMode);
  if (chosen) return { revision: exact?.revision ?? null,
    source: { channel: scope.channel, language: chosen.language, contentMode: chosen.contentMode } as FeaturedScope,
    inherited: !exact, slots: chosen.slots };
  // Preserve the old All lineup without copying or editing any existing rows.
  const legacy = scope.channel === "all" ? await database.select().from(featuredWorlds).orderBy(featuredWorlds.slot) : [];
  return { revision: null, source: legacy.length ? { channel: "all", language: "default", contentMode: "default" } as FeaturedScope : null,
    inherited: legacy.length > 0, slots: legacy.map(r => ({ slot: r.slot, worldId: r.worldId, note: r.note,
      startsAt: r.startsAt?.toISOString() ?? null, endsAt: r.endsAt?.toISOString() ?? null })) };
}

/** A stale editor can never overwrite a newer save. */
export async function saveFeaturedCollection(database: Database, scope: FeaturedScope, revision: string | null, slots: FeaturedSlot[]) {
  const values = { ...scope, slots: [...slots].sort((a, b) => a.slot - b.slot), updatedAt: new Date() };
  if (revision === null) {
    const [created] = await database.insert(featuredCollections).values(values).onConflictDoNothing().returning();
    return created;
  }
  const [updated] = await database.update(featuredCollections).set({ slots: values.slots, updatedAt: values.updatedAt,
    revision: crypto.randomUUID() }).where(and(featuredScopeWhere(scope), eq(featuredCollections.revision, revision))).returning();
  return updated;
}

export async function resetFeaturedCollection(database: Database, scope: FeaturedScope, revision: string) {
  const [deleted] = await database.delete(featuredCollections).where(and(featuredScopeWhere(scope), eq(featuredCollections.revision, revision))).returning();
  return deleted;
}

export function activeFeaturedSlots(slots: FeaturedSlot[], now = Date.now()) {
  return slots.filter(s => (!s.startsAt || Date.parse(s.startsAt) <= now) && (!s.endsAt || Date.parse(s.endsAt) > now))
    .sort((a, b) => a.slot - b.slot);
}
