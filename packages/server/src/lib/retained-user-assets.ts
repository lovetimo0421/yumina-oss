import { asc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { retainedUserAssetFiles } from "../db/schema.js";
import { deleteObject, isS3Configured } from "./s3.js";
import { runExclusive } from "./leader.js";
import { worldsUsingAsCover } from "./asset-cover-use.js";
import { assetIsVersioned } from "./world-version-store.js";
import type { WorldEditExecutor } from "./pending-edit.js";

// Library deletion has three outcomes:
// - a card the owner can edit still uses the file (live content, draft, pending
//   edit, overview) → refused, with the card's name;
// - only saved versions still hold it → the library row goes, the bytes stay
//   in retained_user_asset_files until those versions are pruned;
// - nothing holds it → the bytes go too.
// Before this, "held by a saved version" refused the delete outright, and each
// card keeps 20 automatic versions the owner can't remove — so a busy creator
// could delete almost nothing (JM, 2026-10-16: 98 of 99 deletes refused).

/** Cards whose current content (not saved versions) uses this library file.
 *  Covers are asked separately: any card may show any file as its cover. */
export async function worldsUsingAssetContent(
  tx: WorldEditExecutor, ownerId: string, id: string, url: string,
): Promise<Array<{ id: string; name: string }>> {
  const mentions = (doc: ReturnType<typeof sql>) => sql`(strpos(${doc}, ${id}) > 0 OR strpos(${doc}, ${url}) > 0)`;
  const candidates = sql`(w.creator_id = ${ownerId} OR w.id IN (SELECT world_id FROM asset_references WHERE asset_id = ${id}))`;
  const live = sql`(w.schema::text || COALESCE(w.description, '') || COALESCE(w.extended_description, '') || COALESCE(w.multilanguage_overview::text, ''))`;
  const pending = sql`(p.schema::text || COALESCE(p.metadata::text, ''))`;
  const result = await tx.execute(sql`
    SELECT w.id, w.name FROM worlds w WHERE ${candidates} AND ${mentions(live)}
    UNION
    SELECT w.id, w.name FROM world_pending_edits p JOIN worlds w ON w.id = p.world_id
     WHERE ${candidates} AND ${mentions(pending)}
    LIMIT 5`);
  return (result.rows as Array<{ id: string; name: string }>).map((r) => ({ id: String(r.id), name: String(r.name ?? "") }));
}

/** Another row still serves these bytes (a duplicate upload, or a card's own
 *  asset row pointing at the same object), so the object must stay. */
export async function urlServedElsewhere(tx: WorldEditExecutor, url: string, assetId: string): Promise<boolean> {
  const result = await tx.execute(sql`
    SELECT 1 FROM user_assets WHERE url = ${url} AND id <> ${assetId}
    UNION ALL SELECT 1 FROM assets WHERE url = ${url}
    UNION ALL SELECT 1 FROM retained_user_asset_files WHERE url = ${url} AND asset_id <> ${assetId}
    LIMIT 1`);
  return result.rows.length > 0;
}

/** Moves a library row into retention. Caller holds the world_versions lock. */
export async function retainUserAsset(tx: WorldEditExecutor, assetId: string): Promise<void> {
  await tx.execute(sql`
    INSERT INTO retained_user_asset_files (asset_id, user_id, url, row)
    SELECT u.id, u.user_id, u.url, to_jsonb(u) FROM user_assets u WHERE u.id = ${assetId}
    ON CONFLICT (asset_id) DO NOTHING`);
}

/**
 * Retained files whose versions have been pruned are deleted. One that is back
 * in a card's current content (a version was restored) returns to the library
 * instead, into its old folder when that still exists.
 */
export async function sweepRetainedUserAssets(limit = 100): Promise<{ purged: number; restored: number }> {
  const rows = await db.select().from(retainedUserAssetFiles).orderBy(asc(retainedUserAssetFiles.deletedAt)).limit(limit);
  let purged = 0;
  let restored = 0;
  for (const r of rows) {
    try {
      if (await assetIsVersioned(db, r.assetId, r.url)) continue;
      const inUse = (await worldsUsingAsCover(db, r.assetId, r.url)).length > 0
        || (await worldsUsingAssetContent(db, r.userId, r.assetId, r.url)).length > 0;
      if (inUse) {
        await db.transaction(async (tx) => {
          await tx.execute(sql`
            INSERT INTO user_assets
            SELECT * FROM jsonb_populate_record(NULL::user_assets,
              ${JSON.stringify(r.row)}::jsonb || jsonb_build_object('folder_id',
                (SELECT f.id FROM asset_folders f WHERE f.id = ${String(r.row.folder_id ?? "")} AND f.user_id = ${r.userId})))
            ON CONFLICT (id) DO NOTHING`);
          await tx.delete(retainedUserAssetFiles).where(eq(retainedUserAssetFiles.assetId, r.assetId));
        });
        restored++;
        continue;
      }
      const done = await db.transaction(async (tx) => {
        // Same serialization as library deletion: no checkpoint may pick the
        // file up between this check and the object delete.
        await tx.execute(sql`LOCK TABLE world_versions IN SHARE ROW EXCLUSIVE MODE`);
        if (await assetIsVersioned(tx, r.assetId, r.url)) return false;
        if (isS3Configured() && !(await urlServedElsewhere(tx, r.url, r.assetId))) await deleteObject(r.url);
        await tx.delete(retainedUserAssetFiles).where(eq(retainedUserAssetFiles.assetId, r.assetId));
        return true;
      });
      if (done) purged++;
    } catch (err) {
      console.error("[retained-assets] sweep failed for", r.assetId, (err as Error).message);
    }
  }
  return { purged, restored };
}

const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

export function startRetainedUserAssetSweepInterval(): void {
  if (sweepTimer) return;
  const run = () => {
    void runExclusive("retained-user-asset-sweep", 55 * 60, async () => {
      const { purged, restored } = await sweepRetainedUserAssets();
      if (purged || restored) console.log(`[retained-assets] purged ${purged}, returned ${restored} to libraries`);
    }).catch((err) => console.error("[retained-assets] sweep failed", err));
  };
  setTimeout(run, 10 * 60_000).unref();
  sweepTimer = setInterval(run, SWEEP_INTERVAL_MS);
  sweepTimer.unref();
}

export function stopRetainedUserAssetSweepInterval(): void {
  if (!sweepTimer) return;
  clearInterval(sweepTimer);
  sweepTimer = null;
}
