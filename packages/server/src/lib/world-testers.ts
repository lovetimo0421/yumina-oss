import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { worlds, worldTesters } from "../db/schema.js";
import { followerWorldAudienceSql } from "./world-follower-access.js";

/**
 * Testers: friends a creator lets play a world BEFORE it is published.
 *
 * The list is named people, never a link. These worlds have not been reviewed,
 * so the cap is what bounds how far unreviewed content can travel. (A reviewed
 * world that should stay off Discover uses the "unlisted" visibility instead.)
 *
 * A tester can play and report. Forking, the Studio read and the export still
 * belong to the creator alone; callers keep those closed.
 */

/** Current testers per world. The owner's number (the Roblox-style rule they asked for). */
export const MAX_WORLD_TESTERS = 10;

/**
 * New people per world per rolling day. Without it a creator could cycle ten
 * fresh players through every few minutes and the cap above would bound nothing.
 * One full list a day is a guess, not a measured number; re-inviting someone
 * who was on the list before does not count.
 */
export const MAX_NEW_TESTERS_PER_DAY = 10;

/** Statuses where only the creator, an admin or a tester may play. */
const PRE_RELEASE = sql`('draft', 'pending_review', 'rejected')`;

/**
 * A card is either in development or published (the Roblox split: Playtest or
 * Public). Anything not published can be tested, whatever its review history:
 * never submitted, waiting for review, rejected, or unpublished by its creator.
 * The one exception is a card a moderator took down (or whose creator was
 * banned), which stays closed until it passes review again. Admins see every
 * card that has testers (GET /api/world-testers/admin/testing), which is what
 * makes letting unreviewed cards out to ten people acceptable.
 */
const IN_DEVELOPMENT = ["draft", "pending_review", "rejected", "unpublished"];
const TESTING_CLOSED_BY = ["unpublish", "ban_creator"];

export function isWorldTestable(world: { status: string | null; moderationAction?: string | null }): boolean {
  return IN_DEVELOPMENT.includes(world.status ?? "") && !TESTING_CLOSED_BY.includes(world.moderationAction ?? "");
}

const testableSql = sql`(${worlds.status} IN ('draft', 'pending_review', 'rejected', 'unpublished')
  AND COALESCE(${worlds.moderationAction}, '') NOT IN ('unpublish', 'ban_creator'))`;

const activeTesterSql = (viewerId: string) => sql`EXISTS (
  SELECT 1 FROM world_testers wt
  WHERE wt.world_id = ${worlds.id} AND wt.user_id = ${viewerId} AND wt.removed_at IS NULL)`;

/**
 * A boolean column for a query on `worlds`: the viewer holds a seat on a world
 * that can currently be tested. Rides in the query that already loads the world.
 */
export function activeWorldTesterSql(viewerId?: string | null): SQL<boolean> {
  if (!viewerId) return sql<boolean>`FALSE`;
  return sql<boolean>`(${testableSql} AND ${activeTesterSql(viewerId)})`;
}

/**
 * Pre-release gate for PLAY paths, evaluated against the `worlds` table. It
 * passes every world that is not pre-release, so it only ever narrows who can
 * continue a session on a draft. Not for list or preview queries: a DM share
 * grant legitimately previews a draft without being a tester.
 */
export function testerPlayGateSql(viewerId?: string): SQL<boolean> {
  const preRelease = sql`COALESCE(${worlds.status}, '') IN ${PRE_RELEASE}`;
  if (!viewerId) return sql<boolean>`(NOT ${preRelease})`;
  return sql<boolean>`(NOT ${preRelease} OR ${worlds.creatorId} = ${viewerId}
    OR EXISTS (SELECT 1 FROM "user" tester_admin WHERE tester_admin.id = ${viewerId} AND tester_admin.role = 'admin')
    OR (${testableSql} AND ${activeTesterSql(viewerId)}))`;
}

/** The live audience of a play session: the follower gate and the tester gate together. */
export function worldPlayAccessSql(viewerId?: string): SQL<boolean> {
  return sql<boolean>`(${followerWorldAudienceSql(viewerId)} AND ${testerPlayGateSql(viewerId)})`;
}

/** Primary read: removing a tester has to take effect on their next request. */
export async function passesTesterPlayGate(worldId: string, viewerId?: string): Promise<boolean> {
  const [row] = await db.select({ id: worlds.id }).from(worlds)
    .where(and(eq(worlds.id, worldId), testerPlayGateSql(viewerId))).limit(1);
  return Boolean(row);
}

/** Is the viewer on the list of a world that can currently be tested? */
export async function isActiveWorldTester(worldId: string, viewerId: string | null | undefined): Promise<boolean> {
  if (!viewerId) return false;
  const [row] = await db.select({ id: worlds.id }).from(worlds)
    .where(and(eq(worlds.id, worldId), testableSql, activeTesterSql(viewerId))).limit(1);
  return Boolean(row);
}

/** A block in either direction ends testing between the two, both ways round. */
export async function removeTestersBetween(userA: string, userB: string): Promise<void> {
  await db.execute(sql`
    UPDATE world_testers wt SET removed_at = NOW()
    FROM worlds w
    WHERE w.id = wt.world_id AND wt.removed_at IS NULL
      AND ((w.creator_id = ${userA} AND wt.user_id = ${userB}) OR (w.creator_id = ${userB} AND wt.user_id = ${userA}))
  `);
}

export function activeTesterRows(worldId: string) {
  return and(eq(worldTesters.worldId, worldId), isNull(worldTesters.removedAt));
}
