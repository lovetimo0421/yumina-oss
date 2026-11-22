/**
 * Working on a card together, the Google Docs way: the creator invites people
 * by name, each as an editor or a viewer, and manages every grant. An invite
 * becomes access once the invited person accepts it; either side can end it
 * (the creator removes, the collaborator leaves).
 *
 * Under /api/world-collab. Access itself is decided in lib/world-collaborators.
 */
import { Hono } from "hono";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worldCollaborators, worlds } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware } from "../middleware/rate-limit.js";
import { getBlockStatus } from "../lib/blocks.js";
import { notify } from "../lib/notify.js";
import { publishRoomEvent } from "../lib/room-manager.js";
import { publishWorldEvent } from "../lib/world-events.js";
import { resolveImageCdn } from "../lib/cdn-url.js";
import {
  announceAccessChange, cursorAccess, getWorldAccess, grantWorldIds, MAX_WORLD_COLLABORATORS, SEAT_STATUSES,
} from "../lib/world-collaborators.js";
import type { AppEnv } from "../lib/types.js";

export const worldCollaboratorRoutes = new Hono<AppEnv>();
worldCollaboratorRoutes.use("/*", authMiddleware);

type Role = "editor" | "viewer";
const isRole = (v: unknown): v is Role => v === "editor" || v === "viewer";

/** The world when `userId` created it, else null. */
async function ownedWorld(userId: string, worldId: string) {
  const [w] = await db.select({ id: worlds.id, name: worlds.name, creatorId: worlds.creatorId, thumbnailUrl: worlds.thumbnailUrl })
    .from(worlds).where(and(eq(worlds.id, worldId), eq(worlds.creatorId, userId))).limit(1);
  return w ?? null;
}

/** Tell every open editor of the card (each language variant) that someone's access changed. */
function announceAccess(worldId: string, userId: string) {
  announceAccessChange(worldId, userId).catch(() => {});
}

/** A grant covers the card's language variants, so one person can hold rows on
 *  several of them (e.g. invited before two cards were linked). Listed once:
 *  accepted over pending, editor over viewer. */
type GrantRow = { userId: string; role: string; canPublish: boolean; status: string };
function strongest<T extends GrantRow>(rows: T[]): T[] {
  const rank = (r: GrantRow) => (r.status === "accepted" ? 2 : 0) + (r.role === "editor" ? 1 : 0);
  const best = new Map<string, T>();
  for (const r of rows) {
    const had = best.get(r.userId);
    if (!had || rank(r) > rank(had)) best.set(r.userId, r);
  }
  return [...best.values()].map((pick) => ({
    ...pick,
    canPublish: pick.role === "editor" && rows.some((o) =>
      o.userId === pick.userId && o.status === pick.status && o.role === "editor" && o.canPublish),
  }));
}

const holdsSeat = (status: string) => (SEAT_STATUSES as readonly string[]).includes(status);
const seatSql = inArray(worldCollaborators.status, [...SEAT_STATUSES]);
/** One notice per person per card per hour for the "left"/"removed" kind. */
const hourBucket = () => Math.floor(Date.now() / 3_600_000);
/** A pending invite is pushed to the invitee again at most this often. */
export const INVITE_RENOTIFY_MS = 24 * 60 * 60 * 1000;

type Executor = Pick<typeof db, "select" | "update" | "delete" | "execute">;

/**
 * End someone's seat on every variant of the card. The creator removing them
 * keeps the rows as 'removed', so an invite link can't bring them back until
 * the creator invites them again. Leaving keeps a row as 'left' only when it
 * was ever accepted (the images they put in stay protected); an invite never
 * accepted just goes. Returns the rows as they were.
 */
async function endSeat(executor: Executor, ids: string[], userId: string, how: "removed" | "left") {
  const mine = and(inArray(worldCollaborators.worldId, ids), eq(worldCollaborators.userId, userId), seatSql);
  const before = await executor.select({ status: worldCollaborators.status, acceptedAt: worldCollaborators.acceptedAt })
    .from(worldCollaborators).where(mine);
  if (before.length === 0) return before;
  if (how === "left") await executor.delete(worldCollaborators).where(and(mine, isNull(worldCollaborators.acceptedAt)));
  await executor.update(worldCollaborators).set({ status: how, canPublish: false }).where(mine);
  return before;
}

/** Folders of `userId` bound to the card: the card stops offering them once they're off it. */
async function unbindTheirFolders(executor: Executor, ids: string[], userId: string) {
  if (ids.length === 0) return;
  await executor.execute(sql`
    DELETE FROM world_folder_bindings b USING asset_folders f
    WHERE b.folder_id = f.id AND f.user_id = ${userId}
      AND b.world_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
}

/**
 * A token bucket per key (in memory, per replica): `burst` calls at once, then
 * `perSecond`. False when the call should be dropped.
 */
export function takeToken(
  buckets: Map<string, { tokens: number; at: number }>, key: string, now: number,
  opts: { burst: number; perSecond: number },
): boolean {
  const had = buckets.get(key);
  const tokens = had ? Math.min(opts.burst, had.tokens + ((now - had.at) / 1000) * opts.perSecond) : opts.burst;
  if (tokens < 1) { buckets.set(key, { tokens, at: now }); return false; }
  if (!had && buckets.size > 20_000) buckets.clear();
  buckets.set(key, { tokens: tokens - 1, at: now });
  return true;
}

const isUniqueViolation = (error: unknown) => {
  const e = error as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
};

// GET /worlds/:worldId — the creator and everyone invited, for anyone on the card.
worldCollaboratorRoutes.get("/worlds/:worldId", async (c) => {
  const me = c.get("user");
  const worldId = c.req.param("worldId");
  const access = await getWorldAccess(me.id, worldId);
  if (!access) return c.json({ error: "Not found" }, 404);
  const [owner] = await db.select({ id: user.id, name: user.name, username: user.username, image: user.image })
    .from(user).where(eq(user.id, access.creatorId)).limit(1);
  const rows = await db.select({
    userId: worldCollaborators.userId, role: worldCollaborators.role, canPublish: worldCollaborators.canPublish,
    status: worldCollaborators.status, createdAt: worldCollaborators.createdAt, acceptedAt: worldCollaborators.acceptedAt,
    name: user.name, username: user.username, image: user.image,
  }).from(worldCollaborators).innerJoin(user, eq(user.id, worldCollaborators.userId))
    .where(and(inArray(worldCollaborators.worldId, await grantWorldIds(worldId)), seatSql))
    .orderBy(worldCollaborators.createdAt);
  // Pending invites are the creator's business.
  const people = strongest(rows);
  const visible = access.role === "owner" ? people : people.filter((r) => r.status === "accepted");
  return c.json({
    data: {
      me: { role: access.role, canPublish: access.canPublish },
      owner: owner ? { ...owner, image: resolveImageCdn(owner.image) } : null,
      collaborators: visible.map((r) => ({ ...r, image: resolveImageCdn(r.image) })),
      max: MAX_WORLD_COLLABORATORS,
    },
  });
});

// POST /worlds/:worldId/invite — creator only. Body: { username | userId, role, canPublish? }
worldCollaboratorRoutes.post("/worlds/:worldId/invite", rateLimitMiddleware("social-actions"), async (c) => {
  const me = c.get("user");
  const worldId = c.req.param("worldId");
  const world = await ownedWorld(me.id, worldId);
  if (!world) return c.json({ error: "Only the card's creator can invite people", code: "NOT_OWNER" }, 403);
  const body = await c.req.json().catch(() => null) as { username?: unknown; userId?: unknown; role?: unknown; canPublish?: unknown } | null;
  const role: Role = isRole(body?.role) ? body.role : "editor";
  const canPublish = role === "editor" && body?.canPublish === true;

  const handle = typeof body?.username === "string" ? body.username.trim().replace(/^@/, "") : "";
  const [target] = typeof body?.userId === "string" && body.userId
    ? await db.select({ id: user.id, name: user.name, isBanned: user.isBanned }).from(user).where(eq(user.id, body.userId)).limit(1)
    : handle
      ? await db.select({ id: user.id, name: user.name, isBanned: user.isBanned }).from(user)
        .where(sql`lower(${user.username}) = lower(${handle})`).limit(1)
      : [];
  if (!target || target.isBanned) return c.json({ error: "No one by that name", code: "USER_NOT_FOUND" }, 404);
  if (target.id === me.id) return c.json({ error: "That's you", code: "SELF" }, 400);
  if ((await getBlockStatus(me.id, target.id)).blocked) {
    return c.json({ error: "No one by that name", code: "USER_NOT_FOUND" }, 404);
  }

  // Count and write under one lock per card, so two invites at once can't pass
  // the cap together or race on the same person.
  type Outcome =
    | { kind: "tooMany" }
    | { kind: "updated" }
    | { kind: "invited"; round: Date; notify: boolean };
  let outcome: Outcome;
  try {
    outcome = await db.transaction(async (tx): Promise<Outcome> => {
      const ids = await grantWorldIds(worldId, tx);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`world-collab:${ids[0] ?? worldId}`}))`);
      const rows = await tx.select({ userId: worldCollaborators.userId, status: worldCollaborators.status, createdAt: worldCollaborators.createdAt })
        .from(worldCollaborators).where(inArray(worldCollaborators.worldId, ids));
      const theirs = rows.filter((r) => r.userId === target.id);
      const seated = new Set(rows.filter((r) => holdsSeat(r.status)).map((r) => r.userId));
      const theirsOnCard = and(inArray(worldCollaborators.worldId, ids), eq(worldCollaborators.userId, target.id));
      const now = new Date();
      if (theirs.some((r) => r.status === "accepted")) {
        // Re-inviting updates the grant everywhere it is held; an accepted one stays accepted.
        await tx.update(worldCollaborators).set({ role, canPublish }).where(and(theirsOnCard, seatSql));
        return { kind: "updated" };
      }
      const pending = theirs.filter((r) => r.status === "pending");
      if (pending.length > 0) {
        // Still waiting on them: update what the invite offers, but push it to
        // them again only once a day, so repeated clicks don't spam them.
        const last = Math.max(...pending.map((r) => r.createdAt?.getTime() ?? 0));
        const renotify = now.getTime() - last >= INVITE_RENOTIFY_MS;
        await tx.update(worldCollaborators).set({ role, canPublish, ...(renotify ? { createdAt: now } : {}) })
          .where(and(theirsOnCard, eq(worldCollaborators.status, "pending")));
        return { kind: "invited", round: renotify ? now : new Date(last), notify: renotify };
      }
      if (seated.size >= MAX_WORLD_COLLABORATORS) return { kind: "tooMany" };
      if (theirs.length > 0) {
        // Removed or left before: the creator asking again is what lets them back.
        await tx.update(worldCollaborators).set({ role, canPublish, status: "pending", invitedBy: me.id, createdAt: now })
          .where(theirsOnCard);
        return { kind: "invited", round: now, notify: true };
      }
      await tx.insert(worldCollaborators).values({ worldId, userId: target.id, role, canPublish, invitedBy: me.id, createdAt: now });
      return { kind: "invited", round: now, notify: true };
    });
  } catch (error) {
    if (isUniqueViolation(error)) return c.json({ error: "Already invited", code: "ALREADY_INVITED" }, 409);
    throw error;
  }
  if (outcome.kind === "tooMany") {
    return c.json({ error: `A card can have up to ${MAX_WORLD_COLLABORATORS} collaborators`, code: "TOO_MANY" }, 409);
  }
  if (outcome.kind === "updated") {
    announceAccess(worldId, target.id);
    return c.json({ data: { userId: target.id, status: "accepted", role, canPublish } });
  }

  if (outcome.notify) {
    const payload = {
      worldId, worldName: world.name, worldThumbnail: resolveImageCdn(world.thumbnailUrl),
      fromUserId: me.id, fromName: me.name, role,
    };
    // Keyed by the invite round, so an invite after a removal is a new notice.
    notify(target.id, "world_collab_invite", payload, { actorUserId: me.id, dedupeKey: `${worldId}:${target.id}:invite:${outcome.round.getTime()}` }).catch(() => {});
    publishRoomEvent(`user:${target.id}`, "world_collab_invite", payload).catch(() => {});
  }
  return c.json({ data: { userId: target.id, status: "pending", role, canPublish, notified: outcome.notify } }, 201);
});

// PATCH /worlds/:worldId/:userId — creator changes someone's role.
worldCollaboratorRoutes.patch("/worlds/:worldId/:userId", async (c) => {
  const me = c.get("user");
  const worldId = c.req.param("worldId");
  const userId = c.req.param("userId");
  if (!(await ownedWorld(me.id, worldId))) return c.json({ error: "Only the card's creator can change access", code: "NOT_OWNER" }, 403);
  const body = await c.req.json().catch(() => null) as { role?: unknown; canPublish?: unknown } | null;
  // Every row this person holds on the card's variants changes together, or
  // the strongest one left behind would keep the old access.
  const ids = await grantWorldIds(worldId);
  // Only a seat (pending or accepted) changes; someone removed or gone is
  // brought back by inviting them again.
  const theirs = and(inArray(worldCollaborators.worldId, ids), eq(worldCollaborators.userId, userId), seatSql);
  const held = await db.select().from(worldCollaborators).where(theirs);
  const [row] = strongest(held);
  if (!row) return c.json({ error: "Not found" }, 404);
  const role: Role = isRole(body?.role) ? body.role : (row.role as Role);
  const canPublish = role === "editor" && (typeof body?.canPublish === "boolean" ? body.canPublish : row.canPublish);
  await db.update(worldCollaborators).set({ role, canPublish }).where(theirs);
  announceAccess(worldId, userId);
  return c.json({ data: { userId, role, canPublish, status: row.status } });
});

// DELETE /worlds/:worldId/:userId — the creator removes someone, or someone leaves.
worldCollaboratorRoutes.delete("/worlds/:worldId/:userId", async (c) => {
  const me = c.get("user");
  const worldId = c.req.param("worldId");
  const userId = c.req.param("userId");
  if (userId !== me.id && !(await ownedWorld(me.id, worldId))) {
    return c.json({ error: "Only the card's creator can remove people", code: "NOT_OWNER" }, 403);
  }
  // From every variant of the card: a row left on one would keep them in all.
  const leaving = userId === me.id;
  const ids = await grantWorldIds(worldId);
  const ended = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`world-collab:${ids[0] ?? worldId}`}))`);
    const before = await endSeat(tx, ids, userId, leaving ? "left" : "removed");
    if (before.length > 0) await unbindTheirFolders(tx, ids, userId);
    return before;
  });
  if (ended.length === 0) return c.json({ error: "Not found" }, 404);
  announceAccess(worldId, userId);
  if (ended.some((r) => r.status === "accepted")) {
    const [w] = await db.select({ name: worlds.name, creatorId: worlds.creatorId }).from(worlds).where(eq(worlds.id, worldId)).limit(1);
    if (w && leaving) {
      // They left: the creator hears it (once an hour at most, however often they rejoin and leave).
      notify(w.creatorId, "world_collab_left", { worldId, worldName: w.name, name: me.name, userId: me.id }, { actorUserId: me.id, dedupeKey: `${worldId}:${me.id}:left:${hourBucket()}` }).catch(() => {});
    } else if (w) {
      // The creator removed them: they hear it.
      notify(userId, "world_collab_removed", { worldId, worldName: w.name, reason: "removed", byName: me.name }, { actorUserId: me.id, dedupeKey: `${worldId}:${userId}:removed:${hourBucket()}` }).catch(() => {});
    }
  }
  return c.json({ ok: true });
});

const presenceBuckets = new Map<string, { tokens: number; at: number }>();
const PRESENCE_RATE = { burst: 10, perSecond: 0.5 };

// POST /worlds/:worldId/presence — "I have this card open" (heartbeat), or
// { gone: true } when the tab closes. Fanned out on the card's live stream.
worldCollaboratorRoutes.post("/worlds/:worldId/presence", async (c) => {
  const me = c.get("user");
  const worldId = c.req.param("worldId");
  if (!(await getWorldAccess(me.id, worldId))) return c.json({ error: "Not found" }, 404);
  // A heartbeat every ~20s per open tab; anything far beyond that is refused.
  if (!takeToken(presenceBuckets, `${me.id}|${worldId}`, Date.now(), PRESENCE_RATE)) {
    return c.json({ error: "Too many presence updates", code: "RATE_LIMITED" }, 429);
  }
  const body = await c.req.json().catch(() => null) as { clientId?: unknown; focus?: unknown; gone?: unknown; hello?: unknown } | null;
  const clientId = typeof body?.clientId === "string" ? body.clientId.slice(0, 64) : "";
  if (!clientId) return c.json({ error: "clientId required" }, 400);
  let focus: Record<string, string> | null = null;
  if (body?.focus && typeof body.focus === "object") {
    focus = {};
    for (const [k, v] of Object.entries(body.focus as Record<string, unknown>).slice(0, 6)) {
      if (typeof v === "string") focus[k.slice(0, 32)] = v.slice(0, 120);
    }
  }
  publishWorldEvent(worldId, {
    kind: "presence", userId: me.id, name: me.name, image: resolveImageCdn(me.image ?? null),
    clientId, focus, gone: body?.gone === true, ...(body?.hello === true ? { hello: true } : {}), at: new Date().toISOString(),
  });
  return c.json({ ok: true });
});

// POST /worlds/:worldId/cursor — the pointer, selection and view of an open
// editor, fanned out on the card's live stream (Figma-style cursors and
// following). It fires up to ~12 times a second per moving person, so access
// is remembered briefly and extra calls are dropped instead of queued.
const CURSOR_ACCESS_MS = 15_000;
const CURSOR_MIN_GAP_MS = 50;
/** "user|clientId" → when that tab's last cursor went out. */
const cursorLast = new Map<string, number>();
/** Per person per card, across all their tabs: about two moving tabs' worth. */
const cursorBuckets = new Map<string, { tokens: number; at: number }>();
const CURSOR_RATE = { burst: 40, perSecond: 25 };
const finite = (v: unknown, limit = 1e7) => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) < limit ? v : undefined);
worldCollaboratorRoutes.post("/worlds/:worldId/cursor", async (c) => {
  const me = c.get("user");
  const worldId = c.req.param("worldId");
  const now = Date.now();
  const key = `${me.id}|${worldId}`;
  if ((cursorAccess.get(key) ?? 0) < now) {
    if (!(await getWorldAccess(me.id, worldId))) return c.json({ error: "Not found" }, 404);
    if (cursorAccess.size > 20_000) cursorAccess.clear();
    cursorAccess.set(key, now + CURSOR_ACCESS_MS);
  }
  const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  const clientId = typeof body?.clientId === "string" ? body.clientId.slice(0, 64) : "";
  if (!clientId) return c.json({ error: "clientId required" }, 400);
  // Keyed by person too: the client picks its id, so one person must not be
  // able to throttle someone else's tab, or dodge the limit with fresh ids.
  const tab = `${me.id}|${clientId}`;
  if (now - (cursorLast.get(tab) ?? 0) < CURSOR_MIN_GAP_MS) return c.body(null, 204);
  if (!takeToken(cursorBuckets, key, now, CURSOR_RATE)) return c.body(null, 204);
  if (cursorLast.size > 20_000) cursorLast.clear();
  cursorLast.set(tab, now);
  const view = body?.view && typeof body.view === "object" ? body.view as Record<string, unknown> : null;
  const zoom = finite(view?.zoom, 100);
  publishWorldEvent(worldId, {
    kind: "cursor", userId: me.id, name: me.name, clientId,
    ...(finite(body?.x) !== undefined && finite(body?.y) !== undefined ? { x: finite(body?.x), y: finite(body?.y) } : {}),
    ...(body?.out === true ? { out: true } : body?.out === false ? { out: false } : {}),
    ...(body?.sel === null || typeof body?.sel === "string" ? { sel: body.sel === null ? null : (body.sel as string).slice(0, 160) } : {}),
    ...(view && finite(view.x) !== undefined && finite(view.y) !== undefined && zoom ? { view: { x: finite(view.x)!, y: finite(view.y)!, zoom } } : {}),
    at: new Date(now).toISOString(),
  });
  return c.body(null, 204);
});

// GET /invites — invitations waiting for me.
worldCollaboratorRoutes.get("/invites", async (c) => {
  const me = c.get("user");
  const rows = await db.select({
    worldId: worldCollaborators.worldId, role: worldCollaborators.role, createdAt: worldCollaborators.createdAt,
    worldName: worlds.name, thumbnailUrl: worlds.thumbnailUrl, fromName: user.name, fromUsername: user.username,
  }).from(worldCollaborators)
    .innerJoin(worlds, eq(worlds.id, worldCollaborators.worldId))
    .innerJoin(user, eq(user.id, worlds.creatorId))
    .where(and(eq(worldCollaborators.userId, me.id), eq(worldCollaborators.status, "pending")))
    .orderBy(desc(worldCollaborators.createdAt));
  return c.json({ data: rows.map((r) => ({ ...r, thumbnailUrl: resolveImageCdn(r.thumbnailUrl) })) });
});

// POST /invites/:worldId/accept | /decline
worldCollaboratorRoutes.post("/invites/:worldId/:answer{accept|decline}", async (c) => {
  const me = c.get("user");
  const worldId = c.req.param("worldId");
  const answer = c.req.param("answer");
  const [row] = await db.select({ id: worldCollaborators.id, status: worldCollaborators.status, creatorId: worlds.creatorId })
    .from(worldCollaborators).innerJoin(worlds, eq(worlds.id, worldCollaborators.worldId))
    .where(and(eq(worldCollaborators.worldId, worldId), eq(worldCollaborators.userId, me.id))).limit(1);
  if (!row || !holdsSeat(row.status)) return c.json({ error: "This invitation is no longer open", code: "GONE" }, 404);
  const ids = await grantWorldIds(worldId);
  if (answer === "decline") {
    if (row.status === "pending") await endSeat(db, ids, me.id, "left");
    return c.json({ ok: true });
  }
  if ((await getBlockStatus(me.id, row.creatorId)).blocked) {
    await endSeat(db, ids, me.id, "left");
    return c.json({ error: "This invitation is no longer open", code: "GONE" }, 404);
  }
  if (row.status !== "accepted") {
    const acceptedAt = new Date();
    const updated = await db.update(worldCollaborators).set({ status: "accepted", acceptedAt })
      .where(and(inArray(worldCollaborators.worldId, ids), eq(worldCollaborators.userId, me.id), eq(worldCollaborators.status, "pending")))
      .returning();
    if (updated.length === 0) return c.json({ error: "This invitation is no longer open", code: "GONE" }, 404);
    // Keyed by when they joined: leaving and joining again is news again.
    notify(row.creatorId, "world_collab_joined", { worldId, userId: me.id, name: me.name }, { actorUserId: me.id, dedupeKey: `${worldId}:${me.id}:joined:${acceptedAt.getTime()}` }).catch(() => {});
    announceAccess(worldId, me.id);
  }
  return c.json({ ok: true, worldId });
});

// GET /mine — for my own cards: how many people work on each with me.
worldCollaboratorRoutes.get("/mine", async (c) => {
  const me = c.get("user");
  // Per card, counting someone on several of its language variants once.
  const result = await db.execute(sql`
    SELECT w.id AS world_id, count(DISTINCT wc.user_id)::int AS count
    FROM worlds w
    JOIN worlds v ON v.creator_id = w.creator_id
      AND (v.id = w.id OR (w.language_group_id IS NOT NULL AND v.language_group_id = w.language_group_id))
    JOIN world_collaborators wc ON wc.world_id = v.id AND wc.status = 'accepted'
    WHERE w.creator_id = ${me.id}
    GROUP BY w.id`);
  const rows = result.rows as Array<{ world_id: string; count: number }>;
  return c.json({ data: Object.fromEntries(rows.map((r) => [r.world_id, Number(r.count)])) });
});

// GET /shared — cards other people shared with me.
worldCollaboratorRoutes.get("/shared", async (c) => {
  const me = c.get("user");
  const rows = await db.select({
    id: worlds.id, name: worlds.name, description: worlds.description, thumbnailUrl: worlds.thumbnailUrl,
    status: worlds.status, updatedAt: worlds.updatedAt, role: worldCollaborators.role, canPublish: worldCollaborators.canPublish,
    creatorId: worlds.creatorId, creatorName: user.name, creatorUsername: user.username,
  }).from(worldCollaborators)
    .innerJoin(worlds, eq(worlds.id, worldCollaborators.worldId))
    .innerJoin(user, eq(user.id, worlds.creatorId))
    .where(and(eq(worldCollaborators.userId, me.id), eq(worldCollaborators.status, "accepted")))
    .orderBy(desc(worlds.updatedAt));
  return c.json({ data: rows.map((r) => ({ ...r, thumbnailUrl: resolveImageCdn(r.thumbnailUrl) })) });
});
