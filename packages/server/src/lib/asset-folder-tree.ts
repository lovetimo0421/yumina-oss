import { sql } from "drizzle-orm";
import type { DrizzleDB } from "../db/index.js";

/** UNION deduplicates cycles; ownership is checked at every level, not just the root. */
export function assetFolderTree(userId: string, roots: string[]) {
  return sql`WITH RECURSIVE folder_tree(root_id,id) AS (
    SELECT id,id FROM asset_folders WHERE user_id=${userId} AND id IN (${roots.length ? sql.join(roots.map(id => sql`${id}`), sql`,`) : sql`NULL`})
    UNION
    SELECT folder_tree.root_id,child.id FROM asset_folders child JOIN folder_tree ON child.parent_folder_id=folder_tree.id WHERE child.user_id=${userId}
  )`;
}

export async function summarizeAssetFolderTrees(db: Pick<DrizzleDB, "execute">, userId: string, roots: string[]) {
  if (!roots.length) return { counts: [], previews: [] };
  const [counts, previews] = await Promise.all([
    db.execute(sql`${assetFolderTree(userId, roots)}
      SELECT folder_tree.root_id AS "folderId",count(*)::int AS count
      FROM folder_tree JOIN user_assets ON user_assets.folder_id=folder_tree.id
      WHERE user_assets.user_id=${userId} GROUP BY folder_tree.root_id`),
    db.execute(sql`${assetFolderTree(userId, roots)}
      SELECT id,folder_id FROM (
        SELECT user_assets.id,folder_tree.root_id AS folder_id,
          row_number() OVER(PARTITION BY folder_tree.root_id ORDER BY user_assets.created_at,user_assets.id) AS rn
        FROM user_assets JOIN folder_tree ON user_assets.folder_id=folder_tree.id
        WHERE user_assets.user_id=${userId} AND type='image'
      ) ranked WHERE rn<=4`),
  ]);
  return {
    counts: counts.rows as { folderId: string; count: number }[],
    previews: previews.rows as { id: string; folder_id: string }[],
  };
}
