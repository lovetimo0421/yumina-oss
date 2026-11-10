import { sql } from "drizzle-orm";
import type { WorldEditExecutor } from "./pending-edit.js";

/** Every spelling a cover / gallery column can hold for one hosted file. */
export function coverRefs(id: string, url: string): string[] {
  return [...new Set([url, id, `@asset:${id}`, `/cdn/${id}`].filter(Boolean))];
}

/**
 * Cards that still show this file as their cover, landscape cover, gallery image,
 * or proposed (pending-review) cover. Saved versions don't reliably cover this:
 * older checkpoints carry no metadata and the landscape cover was never in it,
 * so a translation could keep pointing at a cover its author deleted from the
 * library (zh/ja/es "第二恩惠", 2026-10-16) and render as a broken image.
 */
export async function worldsUsingAsCover(tx: WorldEditExecutor, id: string, url: string): Promise<Array<{ id: string; name: string }>> {
  const refs = sql`ARRAY[${sql.join(coverRefs(id, url).map((r) => sql`${r}`), sql`, `)}]::text[]`;
  const result = await tx.execute(sql`
    SELECT w.id, w.name FROM worlds w
     WHERE w.thumbnail_url = ANY(${refs}) OR w.landscape_cover_url = ANY(${refs})
        OR (jsonb_typeof(w.gallery_images) = 'array' AND w.gallery_images ?| ${refs})
    UNION
    SELECT w.id, w.name FROM world_pending_edits p JOIN worlds w ON w.id = p.world_id
     WHERE p.thumbnail_url = ANY(${refs})
    LIMIT 5`);
  return (result.rows as Array<{ id: string; name: string }>).map((r) => ({ id: String(r.id), name: String(r.name ?? "") }));
}
