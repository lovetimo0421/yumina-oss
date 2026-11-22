import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { worlds } from "../db/schema.js";
import { canEditWorldSql } from "./world-collaborators.js";

/**
 * Principle: edits to a published world take effect immediately for the people
 * making them — its creator and the editors they invited — (preview, play,
 * prompt), while everyone else keeps seeing the last-approved live version
 * until an admin approves the held edit.
 *
 * This pure gate decides whether a given viewer should be served the held
 * working copy (when one exists) instead of the live schema. It is deliberately
 * dependency-free so the play routes (sessions / messages / combat) can all
 * share one definition and it can be unit-tested without a DB.
 *
 * `viewerIsEditor` is the access decision for a non-creator: true only for an
 * accepted EDITOR collaborator (never a viewer collaborator or a player).
 * Callers get it from `viewerCanEditSql` folded into the query that already
 * loads the world, or `viewerCanEditWorld`, and only need it when the viewer
 * is not the creator.
 *
 * Security note: returning `true` for anyone else would leak unapproved
 * content to players — the creator / editor check is load-bearing.
 */
export function viewerSeesWorkingCopy(
  status: string,
  creatorId: string,
  viewerId: string,
  viewerIsEditor = false,
): boolean {
  return status === "published" && (creatorId === viewerId || viewerIsEditor);
}

/**
 * A card that was never published (draft, in review, rejected) belongs to the
 * people working on it. A session kept from when someone could — a removed
 * collaborator's playtest — must not keep serving its current draft, or let
 * them play it. Unpublished cards keep their old read-only rule; admins keep
 * their review previews.
 */
export function draftAccessEnded(
  world: { status: string; creatorId: string },
  viewer: { id: string; role?: string },
  viewerIsEditor: boolean,
): boolean {
  return world.status !== "published" && world.status !== "unpublished"
    && world.creatorId !== viewer.id && !viewerIsEditor && viewer.role !== "admin";
}

/**
 * A boolean column for a query on `worlds` (unaliased): `viewerId` is the
 * creator or an accepted editor collaborator. Fold it into the query that
 * already loads the world so the play paths pay no extra round trip — the
 * grant lookup is one indexed EXISTS.
 */
export function viewerCanEditSql(viewerId: string): SQL<boolean> {
  return sql<boolean>`(${canEditWorldSql(viewerId)})`;
}

/** One query: may `viewerId` edit this world (creator or accepted editor)? */
export async function viewerCanEditWorld(
  viewerId: string,
  worldId: string,
  executor: Pick<typeof db, "select"> = db,
): Promise<boolean> {
  const [row] = await executor.select({ id: worlds.id }).from(worlds)
    .where(and(eq(worlds.id, worldId), canEditWorldSql(viewerId))).limit(1);
  return Boolean(row);
}

/**
 * Who to resolve a session's schema as with the viewer-keyed resolvers
 * (resolveSessionWorldSchema & co.): an editor collaborator sees what the
 * creator sees, everyone else sees what they see.
 */
export function workingCopyViewerId(world: { creatorId: string }, viewerId: string, viewerIsEditor: boolean): string {
  return viewerIsEditor ? world.creatorId : viewerId;
}
