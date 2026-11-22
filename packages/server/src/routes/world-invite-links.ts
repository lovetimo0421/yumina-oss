/**
 * A card's invite link, the Figma way: the creator turns on "anyone with the
 * link can edit / view", copies it, and whoever signed in opens it joins the
 * card. One live link per card; resetting it retires the old address.
 *
 * Mounted under /api/world-collab before the collaborator routes, so
 * `/worlds/:worldId/link` is not read as a person's id.
 */
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worldCollaborators, worldInviteLinks, worlds } from "../db/schema.js";
import { authMiddleware, optionalAuthMiddleware } from "../middleware/auth.js";
import { ipRateLimitMiddleware, rateLimitMiddleware } from "../middleware/rate-limit.js";
import { getBlockStatus } from "../lib/blocks.js";
import { notify } from "../lib/notify.js";
import { resolveImageCdn } from "../lib/cdn-url.js";
import { announceAccessChange, getWorldAccess, grantWorldIds, MAX_WORLD_COLLABORATORS, SEAT_STATUSES } from "../lib/world-collaborators.js";
import type { AppEnv } from "../lib/types.js";

export const worldInviteLinkRoutes = new Hono<AppEnv>();
// Signed in for everything, except looking up what a link is for: someone
// who opens the link logged out sees the card before signing in.
const isLinkLookup = (method: string, path: string) => method === "GET" && /\/links\/[^/]+$/.test(path);
worldInviteLinkRoutes.use("/*", (c, next) =>
  (isLinkLookup(c.req.method, c.req.path) ? optionalAuthMiddleware : authMiddleware)(c, next));
/** Guests are counted by IP (a token is unguessable, but lookups are not free). */
const guestLookupLimit = ipRateLimitMiddleware(30, 60, "collab-link");

type Role = "editor" | "viewer";
const isRole = (v: unknown): v is Role => v === "editor" || v === "viewer";
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{22,64}$/;

/** 24 random bytes, url-safe: 32 characters nobody guesses. */
const newToken = () => randomBytes(24).toString("base64url");

const linkJson = (row: { token: string; role: string } | null | undefined) =>
  row ? { token: row.token, role: row.role, path: `/app/join/${row.token}` } : null;

/** The live link of a world, or undefined. */
async function liveLink(worldId: string) {
  const [row] = await db.select({ id: worldInviteLinks.id, token: worldInviteLinks.token, role: worldInviteLinks.role })
    .from(worldInviteLinks)
    .where(and(eq(worldInviteLinks.worldId, worldId), isNull(worldInviteLinks.revokedAt)))
    .limit(1);
  return row;
}

/** Creator-only gate; null when `userId` didn't make `worldId`. */
async function asOwner(userId: string, worldId: string) {
  const access = await getWorldAccess(userId, worldId);
  return access?.role === "owner" ? access : null;
}

// GET /worlds/:worldId/link — the card's live link (creator only).
worldInviteLinkRoutes.get("/worlds/:worldId/link", async (c) => {
  const me = c.get("user");
  const worldId = c.req.param("worldId");
  if (!(await asOwner(me.id, worldId))) return c.json({ error: "Only the card's creator can manage its link", code: "NOT_OWNER" }, 403);
  return c.json({ data: { link: linkJson(await liveLink(worldId)) } });
});

// PUT /worlds/:worldId/link { role } — turn the link on, or change what it grants.
worldInviteLinkRoutes.put("/worlds/:worldId/link", async (c) => {
  const me = c.get("user");
  const worldId = c.req.param("worldId");
  if (!(await asOwner(me.id, worldId))) return c.json({ error: "Only the card's creator can manage its link", code: "NOT_OWNER" }, 403);
  const body = await c.req.json().catch(() => null) as { role?: unknown } | null;
  const role: Role = isRole(body?.role) ? body.role : "viewer";
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`world-link:${worldId}`}))`);
    const [live] = await tx.select({ id: worldInviteLinks.id }).from(worldInviteLinks)
      .where(and(eq(worldInviteLinks.worldId, worldId), isNull(worldInviteLinks.revokedAt))).limit(1);
    if (live) {
      const [updated] = await tx.update(worldInviteLinks).set({ role }).where(eq(worldInviteLinks.id, live.id)).returning();
      return updated;
    }
    const [created] = await tx.insert(worldInviteLinks).values({ worldId, token: newToken(), role, createdBy: me.id }).returning();
    return created;
  });
  return c.json({ data: { link: linkJson(row) } });
});

// POST /worlds/:worldId/link/reset — retire the current address for a new one.
worldInviteLinkRoutes.post("/worlds/:worldId/link/reset", async (c) => {
  const me = c.get("user");
  const worldId = c.req.param("worldId");
  if (!(await asOwner(me.id, worldId))) return c.json({ error: "Only the card's creator can manage its link", code: "NOT_OWNER" }, 403);
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`world-link:${worldId}`}))`);
    const [live] = await tx.update(worldInviteLinks).set({ revokedAt: new Date() })
      .where(and(eq(worldInviteLinks.worldId, worldId), isNull(worldInviteLinks.revokedAt)))
      .returning();
    if (!live) return null;
    const [created] = await tx.insert(worldInviteLinks)
      .values({ worldId, token: newToken(), role: live.role, createdBy: me.id }).returning();
    return created;
  });
  if (!row) return c.json({ error: "This card has no link to reset", code: "NO_LINK" }, 404);
  return c.json({ data: { link: linkJson(row) } });
});

// DELETE /worlds/:worldId/link — turn the link off; the old address stops working.
worldInviteLinkRoutes.delete("/worlds/:worldId/link", async (c) => {
  const me = c.get("user");
  const worldId = c.req.param("worldId");
  if (!(await asOwner(me.id, worldId))) return c.json({ error: "Only the card's creator can manage its link", code: "NOT_OWNER" }, 403);
  await db.update(worldInviteLinks).set({ revokedAt: new Date() })
    .where(and(eq(worldInviteLinks.worldId, worldId), isNull(worldInviteLinks.revokedAt)));
  return c.json({ data: { link: null } });
});

/** A live link by its token, with its card and creator; undefined when it no longer works. */
async function linkByToken(token: string) {
  if (!TOKEN_SHAPE.test(token)) return undefined;
  const [row] = await db.select({
    role: worldInviteLinks.role, worldId: worlds.id, worldName: worlds.name, thumbnailUrl: worlds.thumbnailUrl,
    creatorId: worlds.creatorId, creatorName: user.name, creatorBanned: user.isBanned,
  }).from(worldInviteLinks)
    .innerJoin(worlds, eq(worlds.id, worldInviteLinks.worldId))
    .innerJoin(user, eq(user.id, worlds.creatorId))
    .where(and(eq(worldInviteLinks.token, token), isNull(worldInviteLinks.revokedAt)))
    .limit(1);
  return row && !row.creatorBanned ? row : undefined;
}

const gone = { error: "This link no longer works", code: "LINK_GONE" } as const;
const removedBody = { error: "The card's creator removed you from this card. Ask them to invite you again.", code: "REMOVED_BY_OWNER" } as const;

/** Did the creator take `userId` off this card (and not invite them back since)? */
async function removedFromCard(worldId: string, userId: string): Promise<boolean> {
  const [row] = await db.select({ id: worldCollaborators.id }).from(worldCollaborators)
    .where(and(inArray(worldCollaborators.worldId, await grantWorldIds(worldId)), eq(worldCollaborators.userId, userId),
      eq(worldCollaborators.status, "removed")))
    .limit(1);
  return !!row;
}

// GET /links/:token — what opening this link would do. Works logged out:
// a guest sees only the card's name and cover, who shares it, and the role.
worldInviteLinkRoutes.get("/links/:token", async (c, next) => {
  if (c.get("user")) return next();
  return guestLookupLimit(c, next);
}, rateLimitMiddleware("social-actions"), async (c) => {
  const me = c.get("user") as AppEnv["Variables"]["user"] | undefined;
  const link = await linkByToken(c.req.param("token"));
  if (!link) return c.json(gone, 404);
  if (!me) {
    return c.json({
      data: {
        worldName: link.worldName, thumbnailUrl: resolveImageCdn(link.thumbnailUrl),
        creatorName: link.creatorName, role: link.role, alreadyMember: false, myRole: null,
      },
    });
  }
  const access = await getWorldAccess(me.id, link.worldId);
  return c.json({
    data: {
      worldId: link.worldId, worldName: link.worldName, thumbnailUrl: resolveImageCdn(link.thumbnailUrl),
      creatorName: link.creatorName, role: link.role,
      alreadyMember: !!access, myRole: access?.role ?? null,
      // Joining would be refused (REMOVED_BY_OWNER): only a new invite lets them back.
      removed: !access && await removedFromCard(link.worldId, me.id),
    },
  });
});

// POST /links/:token/join — join the card the link is for.
worldInviteLinkRoutes.post("/links/:token/join", rateLimitMiddleware("social-actions"), async (c) => {
  const me = c.get("user");
  const link = await linkByToken(c.req.param("token"));
  if (!link) return c.json(gone, 404);
  if (link.creatorId === me.id) return c.json({ data: { worldId: link.worldId, role: "owner" } });
  const [self] = await db.select({ isBanned: user.isBanned }).from(user).where(eq(user.id, me.id)).limit(1);
  if (!self || self.isBanned) return c.json(gone, 404);
  if ((await getBlockStatus(me.id, link.creatorId)).blocked) {
    return c.json({ error: "You can't join this card", code: "BLOCKED" }, 403);
  }
  const role = link.role as Role;

  // The same lock and per-card count an invite takes, so the two can't pass the cap together.
  type Outcome = { kind: "full" } | { kind: "removed" } | { kind: "joined"; role: Role; changed: boolean };
  const outcome = await db.transaction(async (tx): Promise<Outcome> => {
    const ids = await grantWorldIds(link.worldId, tx);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`world-collab:${ids[0] ?? link.worldId}`}))`);
    const rows = await tx.select({ userId: worldCollaborators.userId, role: worldCollaborators.role, status: worldCollaborators.status })
      .from(worldCollaborators).where(inArray(worldCollaborators.worldId, ids));
    const mine = rows.filter((r) => r.userId === me.id);
    // The creator took them off: a link anyone can open must not undo that.
    if (mine.some((r) => r.status === "removed")) return { kind: "removed" };
    const isSeat = (status: string) => (SEAT_STATUSES as readonly string[]).includes(status);
    const seat = mine.filter((r) => isSeat(r.status));
    const mineOnCard = and(inArray(worldCollaborators.worldId, ids), eq(worldCollaborators.userId, me.id));
    if (seat.length === 0) {
      // New to the card, or left it themselves: the link seats them.
      if (new Set(rows.filter((r) => isSeat(r.status)).map((r) => r.userId)).size >= MAX_WORLD_COLLABORATORS) return { kind: "full" };
      if (mine.length > 0) {
        await tx.update(worldCollaborators).set({ role, canPublish: false, status: "accepted", acceptedAt: new Date(), invitedBy: link.creatorId })
          .where(mineOnCard);
      } else {
        await tx.insert(worldCollaborators).values({
          worldId: link.worldId, userId: me.id, role, status: "accepted", acceptedAt: new Date(), invitedBy: link.creatorId,
        });
      }
      return { kind: "joined", role, changed: true };
    }
    // Already invited or on the card: the link accepts a pending invite, and
    // never changes the role the creator gave them (a viewer they lowered
    // stays a viewer, even through an editor link).
    const accepted = seat.some((r) => r.status === "accepted");
    if (!accepted) {
      await tx.update(worldCollaborators).set({ status: "accepted", acceptedAt: new Date() })
        .where(and(mineOnCard, eq(worldCollaborators.status, "pending")));
    }
    return { kind: "joined", role: seat.some((r) => r.role === "editor") ? "editor" : "viewer", changed: !accepted };
  });
  if (outcome.kind === "removed") return c.json(removedBody, 403);
  if (outcome.kind === "full") {
    return c.json({ error: `A card can have up to ${MAX_WORLD_COLLABORATORS} collaborators`, code: "TOO_MANY" }, 409);
  }
  if (outcome.changed) {
    announceAccessChange(link.worldId, me.id).catch(() => {});
    notify(link.creatorId, "world_collab_joined", { worldId: link.worldId, worldName: link.worldName, userId: me.id, name: me.name, viaLink: true },
      { actorUserId: me.id, dedupeKey: `${link.worldId}:${me.id}:joined:${Math.floor(Date.now() / 60_000)}` }).catch(() => {});
  }
  return c.json({ data: { worldId: link.worldId, role: outcome.role } });
});
