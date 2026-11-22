import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { worlds } from "../db/schema.js";

/** Audience gate only: publication, blocks and content restrictions remain with callers. */
export function followerWorldAudienceSql(viewerId?: string, alias?: "sw" | "w2" | "w" | "featured"): SQL<boolean> {
  const w = alias ? {
    visibility: sql.raw(`${alias}.visibility`), status: sql.raw(`${alias}.status`), creatorId: sql.raw(`${alias}.creator_id`),
  } : worlds;
  if (!viewerId) return sql<boolean>`(${w.status} <> 'published' OR ${w.visibility} <> 'followers')`;
  // Alias names are internal query constants, never request values.
  return sql<boolean>`(${w.status} <> 'published' OR ${w.visibility} <> 'followers' OR ${w.creatorId} = ${viewerId}
    OR EXISTS (SELECT 1 FROM "user" access_user WHERE access_user.id = ${viewerId} AND access_user.role = 'admin')
    OR EXISTS (SELECT 1 FROM follows audience_follow WHERE audience_follow.follower_id = ${viewerId} AND audience_follow.following_id = ${w.creatorId}))`;
}

/** Primary read: a saved session or stale client card never keeps a revoked follower grant. */
export async function canReadFollowerWorld(worldId: string, viewerId?: string): Promise<boolean> {
  const [row] = await db.select({ id: worlds.id }).from(worlds)
    .where(and(eq(worlds.id, worldId), followerWorldAudienceSql(viewerId))).limit(1);
  return Boolean(row);
}

/** Canonical resolution also permits the creator/admin's existing private preview. */
export async function canResolveWorldAddress(worldId: string, viewerId?: string): Promise<boolean> {
  const privileged = viewerId ? sql`(${worlds.creatorId} = ${viewerId} OR EXISTS (
    SELECT 1 FROM "user" access_user WHERE access_user.id = ${viewerId} AND access_user.role = 'admin'))` : sql`FALSE`;
  const [row] = await db.select({ id: worlds.id }).from(worlds).where(and(eq(worlds.id, worldId), sql`(
    (${worlds.status} = 'published' AND ${worlds.isPublished} = true
      AND ${worlds.visibility} IN ('public', 'unlisted', 'followers') AND ${followerWorldAudienceSql(viewerId)})
    OR ${privileged})`)).limit(1);
  return Boolean(row);
}
