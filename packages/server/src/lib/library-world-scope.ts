import { eq, inArray, or, sql } from "drizzle-orm";
import { favorites, userLibrary, worlds } from "../db/schema.js";

/** Restrict list metadata to Library dependencies, without changing the outer
 * visibility or language-representative filters. Include the whole group so
 * saving a non-primary variant does not hide its existing representative. */
export function libraryWorldScope(userId: string, requestedWorldId?: string) {
  const savedIds = sql`(
    SELECT ${userLibrary.worldId} FROM ${userLibrary} WHERE ${userLibrary.userId} = ${userId}
    UNION
    SELECT ${favorites.worldId} FROM ${favorites} WHERE ${favorites.userId} = ${userId}
  )`;
  const requested = requestedWorldId
    ? eq(worlds.id, requestedWorldId)
    : undefined;
  return or(
    eq(worlds.creatorId, userId),
    inArray(worlds.id, savedIds),
    sql`${worlds.languageGroupId} IN (
      SELECT saved.language_group_id FROM worlds saved WHERE saved.id IN ${savedIds}
    )`,
    requested,
  )!;
}
