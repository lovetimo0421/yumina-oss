import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { eq, inArray } from "drizzle-orm";
import type { AdminWorldArtwork, AdminWorldArtworkUpdate } from "@yumina/shared";
import { db, type Database } from "../db/index.js";
import { adminActions, discoverArtworkOverrides, worlds } from "../db/schema.js";
import { resolveImageCdn } from "./cdn-url.js";
export type ArtworkRow = Pick<typeof worlds.$inferSelect, "id" | "thumbnailUrl" | "coverCrop" | "galleryCoverCrop" | "landscapeCoverUrl" | "landscapeCoverCrop">;
type Override = typeof discoverArtworkOverrides.$inferSelect;
function artworkValues(row: ArtworkRow) {
  return { thumbnailUrl: row.thumbnailUrl ?? null, coverCrop: row.coverCrop ?? null, galleryCoverCrop: row.galleryCoverCrop ?? null,
    landscapeCoverUrl: row.landscapeCoverUrl ?? null, landscapeCoverCrop: row.landscapeCoverCrop ?? null };
}
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function baseline(row: ArtworkRow) { return hash({ id: row.id, ...artworkValues(row) }); }
function effective(row: ArtworkRow, override?: Override): ArtworkRow {
  return override?.baselineRevision === baseline(row) ? { ...row, ...override.artwork } as ArtworkRow : row;
}
export function adminWorldArtwork(row: ArtworkRow, override?: Override): AdminWorldArtwork {
  const raw = artworkValues(effective(row, override));
  return { ...raw, thumbnailUrl: resolveImageCdn(raw.thumbnailUrl), landscapeCoverUrl: resolveImageCdn(raw.landscapeCoverUrl),
    revision: hash({ baseline: baseline(row), override: override?.revision ?? null }) };
}
export async function readAdminArtwork(rows: ArtworkRow[]) {
  const overrides = rows.length ? await db.select().from(discoverArtworkOverrides).where(inArray(discoverArtworkOverrides.worldId, rows.map(r => r.id))) : [];
  return new Map(rows.map(row => [row.id, adminWorldArtwork(row, overrides.find(o => o.worldId === row.id))]));
}
/** Resolve only authorized rows. Invalidated baselines fall back to creator art, never an old image. */
export async function overlayDiscoverArtwork<T extends { id: string }>(rows: T[], database: Database = db): Promise<T[]> {
  if (!rows.length) return rows;
  const ids = rows.map(r => r.id);
  const [originals, overrides] = await Promise.all([
    database.select({ id: worlds.id, thumbnailUrl: worlds.thumbnailUrl, coverCrop: worlds.coverCrop, galleryCoverCrop: worlds.galleryCoverCrop, landscapeCoverUrl: worlds.landscapeCoverUrl, landscapeCoverCrop: worlds.landscapeCoverCrop }).from(worlds).where(inArray(worlds.id, ids)),
    database.select().from(discoverArtworkOverrides).where(inArray(discoverArtworkOverrides.worldId, ids)),
  ]);
  return rows.map(row => {
    const original = originals.find(w => w.id === row.id);
    if (!original) return row;
    const art = artworkValues(effective(original, overrides.find(o => o.worldId === row.id)));
    return { ...row, ...art, thumbnailUrl: resolveImageCdn(art.thumbnailUrl), landscapeCoverUrl: resolveImageCdn(art.landscapeCoverUrl) };
  });
}
export async function updateAdminWorldArtwork(worldId: string, adminId: string, update: AdminWorldArtworkUpdate) {
  return db.transaction(async tx => {
    // Serialize with creator saves; never write the locked row or any pending edit.
    const [before] = await tx.select().from(worlds).where(eq(worlds.id, worldId)).limit(1).for("update");
    if (!before) return { ok: false as const, status: 404 as const, error: "World not found" };
    const [stored] = await tx.select().from(discoverArtworkOverrides).where(eq(discoverArtworkOverrides.worldId, worldId));
    const current = adminWorldArtwork(before, stored);
    if (current.revision !== update.expectedRevision) return { ok: false as const, status: 409 as const, code: "ARTWORK_CONFLICT" as const, error: "Artwork changed. Reload before saving.", data: current };
    const art = artworkValues(effective(before, stored));
    const source = update.landscapeSource === "portrait" ? art.thumbnailUrl : art.landscapeCoverUrl;
    if ((update.coverCrop && !resolveImageCdn(art.thumbnailUrl)) || (update.landscapeCoverCrop && !resolveImageCdn(source))) return { ok: false as const, status: 400 as const, error: "The selected artwork has no image. Confirm portrait reuse for a legacy landscape crop." };
    const next = { ...art, ...(update.coverCrop ? { coverCrop: update.coverCrop } : {}), ...(update.landscapeCoverCrop ? { landscapeCoverCrop: update.landscapeCoverCrop } : {}), ...(update.landscapeSource === "portrait" ? { landscapeCoverUrl: art.thumbnailUrl } : {}) };
    if (isDeepStrictEqual(art, next)) return { ok: true as const, data: current, changed: false, creatorId: before.creatorId };
    const values = { worldId, baselineRevision: baseline(before), revision: crypto.randomUUID(), artwork: next, updatedAt: new Date() };
    const [saved] = await tx.insert(discoverArtworkOverrides).values(values).onConflictDoUpdate({ target: discoverArtworkOverrides.worldId, set: values }).returning();
    await tx.insert(adminActions).values({ adminId, actionType: "stage_world_artwork", targetType: "world", targetId: worldId, metadata: { before: art, after: next, previewOnly: true } });
    return { ok: true as const, data: adminWorldArtwork(before, saved), changed: true, creatorId: before.creatorId };
  });
}
