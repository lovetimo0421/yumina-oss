import { eq, ilike, isNull, sql } from "drizzle-orm";
import { userAssets } from "../db/schema.js";
import { assetFolderTree } from "./asset-folder-tree.js";

/** Share exactly the same predicates between the page query and its count. */
export function userAssetFilters(userId: string, opts: { type?: typeof userAssets.$inferSelect.type; folderId?: string; search?: string; recursive?: boolean }) {
  const conditions = [eq(userAssets.userId, userId)];
  if (opts.type) conditions.push(eq(userAssets.type, opts.type));
  if (opts.folderId === "root") conditions.push(isNull(userAssets.folderId));
  else if (opts.folderId) conditions.push(opts.recursive
    ? sql`${userAssets.folderId} IN (${assetFolderTree(userId, [opts.folderId])} SELECT id FROM folder_tree)`
    : eq(userAssets.folderId, opts.folderId));
  if (opts.search?.trim()) {
    const literal = opts.search.trim().replace(/[\\%_]/g, "\\$&");
    conditions.push(ilike(userAssets.filename, `%${literal}%`));
  }
  return conditions;
}
