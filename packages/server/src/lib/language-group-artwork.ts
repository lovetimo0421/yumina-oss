import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

type Executor = Pick<typeof db, "execute">;

/**
 * Translations of one card share its Discover artwork. When a card has a cover,
 * every sibling in its language group that has none of its own takes it, so a
 * creator sets the 2:3 and 16:9 covers once instead of once per language.
 *
 * Only fills empty slots, never replaces artwork a sibling already has, and only
 * touches siblings by the same creator that are not live (draft / rejected /
 * unpublished): a live card's artwork changes go through review. A crop travels
 * only together with the image it was made for. The artwork columns are derived
 * from these schema fields by worlds_schema_derived_trg, so the schema is written.
 * Bumping updated_at makes an editor that still holds the sibling merge on its
 * next save instead of writing its older schema over the shared cover.
 *
 * Returns the ids of the siblings that were filled.
 */
export async function shareArtworkWithLanguageSiblings(
  worldId: string,
  creatorId: string,
  executor: Executor = db,
): Promise<string[]> {
  const result = await executor.execute(sql`
    WITH src AS (
      SELECT language_group_id AS g,
             NULLIF(thumbnail_url, '') AS thumb,
             CASE WHEN jsonb_typeof(schema->'coverCrop') = 'object' THEN schema->'coverCrop' END AS crop,
             NULLIF(schema->>'landscapeCover', '') AS wide,
             CASE WHEN jsonb_typeof(schema->'landscapeCoverCrop') = 'object' THEN schema->'landscapeCoverCrop' END AS wide_crop
      FROM worlds
      WHERE id = ${worldId} AND creator_id = ${creatorId} AND language_group_id IS NOT NULL
    ), fill AS (
      SELECT w.id,
             (NULLIF(w.thumbnail_url, '') IS NULL AND src.thumb IS NOT NULL) AS take_thumb,
             (NULLIF(w.schema->>'landscapeCover', '') IS NULL AND src.wide IS NOT NULL) AS take_wide,
             src.thumb, src.crop, src.wide, src.wide_crop
      FROM worlds w, src
      WHERE w.language_group_id = src.g
        AND w.creator_id = ${creatorId}
        AND w.id <> ${worldId}
        AND w.is_published = false
        AND w.status IN ('draft', 'rejected', 'unpublished')
    )
    UPDATE worlds w
    SET thumbnail_url = CASE WHEN fill.take_thumb THEN fill.thumb ELSE w.thumbnail_url END,
        schema = w.schema
          || CASE WHEN fill.take_thumb AND fill.crop IS NOT NULL
                  THEN jsonb_build_object('coverCrop', fill.crop) ELSE '{}'::jsonb END
          || CASE WHEN fill.take_wide
                  THEN jsonb_strip_nulls(jsonb_build_object('landscapeCover', to_jsonb(fill.wide), 'landscapeCoverCrop', fill.wide_crop))
                  ELSE '{}'::jsonb END,
        updated_at = now()
    FROM fill
    WHERE w.id = fill.id AND (fill.take_thumb OR fill.take_wide)
    RETURNING w.id
  `);
  return (result.rows ?? []).map((r) => String(r.id));
}
