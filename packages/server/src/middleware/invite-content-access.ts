import type { Context } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { playSessions, worlds, threads, sharedPlaythroughs } from "../db/schema.js";
import type { AppEnv } from "../lib/types.js";

/** Run after authentication, before route handlers and their content caches. */
export async function enforceInviteContentAccess(c: Context<AppEnv>): Promise<Response | undefined> {
  if (!c.get("user")?.limitedContentOnly) return;
  c.header("Cache-Control", "private, no-store");
  const denied = () => c.json({ error: "Limitless content is not available for this account", code: "LIMITED_CONTENT_ONLY" }, 403);
  if (c.req.queries("contentLevel")?.some(level => level !== "safe") || c.req.queries("showNsfw")?.includes("true")) return denied();

  // Check the source before any read/copy/export/variant handler can return it.
  const worldMatch = /^\/api\/(?:worlds|studio)\/([^/]+)(?:\/|$)/.exec(c.req.path);
  if (worldMatch) {
    const [row] = await db.select({ ageRating: worlds.ageRating, isNsfw: worlds.isNsfw })
      .from(worlds).where(eq(worlds.id, decodeURIComponent(worldMatch[1]!))).limit(1);
    if (row && ((row.ageRating ?? "all") !== "all" || row.isNsfw)) return denied();
  }
  const threadMatch = /^\/api\/community\/threads\/([^/]+)(?:\/|$)/.exec(c.req.path);
  if (threadMatch) {
    const [row] = await db.select({ ageRating: threads.ageRating }).from(threads)
      .where(eq(threads.id, decodeURIComponent(threadMatch[1]!))).limit(1);
    if (row && (row.ageRating ?? "all") !== "all") return denied();
  }
  const shareMatch = /^\/api\/playthroughs\/([^/]+)(?:\/|$)/.exec(c.req.path);
  if (shareMatch) {
    const [row] = await db.select({ ageRating: sharedPlaythroughs.ageRating }).from(sharedPlaythroughs)
      .where(eq(sharedPlaythroughs.id, decodeURIComponent(shareMatch[1]!))).limit(1);
    if (row && (row.ageRating ?? "all") !== "all") return denied();
  }

  // A saved session must not retain access after its invite is restricted.
  // This also covers message, media and storage subroutes mounted separately.
  const match = /^\/api\/(?:sessions|session-media\/session)\/([^/]+)(?:\/|$)/.exec(c.req.path);
  if (match) {
    const [row] = await db.select({ ageRating: worlds.ageRating, isNsfw: worlds.isNsfw })
      .from(playSessions).innerJoin(worlds, eq(worlds.id, playSessions.worldId))
      .where(eq(playSessions.id, decodeURIComponent(match[1]!))).limit(1);
    if (row && ((row.ageRating ?? "all") !== "all" || row.isNsfw)) return denied();
  }
}
