/**
 * Story rooms: one play session shared by 2-12 friends (invite-only, or the
 * host's friends when the host allows it).
 *
 * The host owns the session and pays for every AI call. Everyone writes at
 * once; the server sends the round as the host when its countdown runs out,
 * when everyone online has acted, or when someone asks (POST /:code/turn),
 * see lib/story-room-runner.ts. The reply is mirrored to everyone on the room
 * channel (lib/story-room-tee.ts). Live events ride lib/room-manager.ts on the
 * key `story-room:<roomId>`; ready/online presence lives in Redis (or memory).
 */
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { friendInvites, messages, playSessions, storyRoomActions, storyRoomMembers, storyRooms, user, worlds } from "../db/schema.js";
import { authMiddleware } from "../middleware/auth.js";
import { rateLimitMiddleware, slidingWindowCheck } from "../middleware/rate-limit.js";
import { areFriends, listFriends } from "../lib/friends.js";
import { clearRoundFailure, closeStoryRoom, currentRound, evaluateRoom, runRound, sanitizeSendProfile } from "../lib/story-room-runner.js";
import { getBlockStatus } from "../lib/blocks.js";
import { checkBalance } from "../lib/credit-service.js";
import { notify } from "../lib/notify.js";
import { publishRoomEvent, subscribeToRoom } from "../lib/room-manager.js";
import { resolveImageCdn } from "../lib/cdn-url.js";
import { postInviteMessage } from "../lib/dm-invite-message.js";
import {
  JOIN_ERROR_STATUS,
  ROLE_ERROR_STATUS,
  STORY_ROOM_ACTION_MAX_CHARS,
  STORY_ROOM_DEFAULT_WINDOW_MS,
  STORY_ROOM_INVITE_MAX,
  STORY_ROOM_TALK_MAX_CHARS,
  STORY_ROOM_MERGE_WINDOW_MAX_MS,
  STORY_ROOM_MERGE_WINDOW_MIN_MS,
  STORY_ROOM_SPEND_CAP_MAX,
  STORY_ROOM_SPEND_CAP_MIN,
  STORY_ROOM_UNTIMED,
  adultGateFailure,
  clearReady,
  dropOnline,
  getOnline,
  getReady,
  isAdultWorld,
  isBlockedWithAnyMember,
  joinDecision,
  loadAdultGateUser,
  markSeen,
  normalizeRoomCode,
  roleDecision,
  roomCostStats,
  serializeRoom,
  setReady,
  storyRoomCard,
  storyRoomChannel,
  storyRoomJoinUrl,
  touchOnline,
  uniqueRoomCode,
  type StoryRoom,
  type StoryRoomAction,
  type StoryRoomMember,
  type StoryRoomTalkLine,
} from "../lib/story-rooms.js";
import type { AppEnv } from "../lib/types.js";

export type { StoryRoom, StoryRoomAction, StoryRoomMember, StoryRoomRound, StoryRoomTalkLine } from "../lib/story-rooms.js";

const storyRoomRoutes = new Hono<AppEnv>();
storyRoomRoutes.use("/*", authMiddleware);

type RoomRow = typeof storyRooms.$inferSelect;
type MemberRow = typeof storyRoomMembers.$inferSelect;

const ROOM_INVITE_TTL_MS = 60 * 60 * 1000;
const ACTIONS_PER_MINUTE = 20;
const MAX_MUTE_MINUTES = 24 * 60;
const HEARTBEAT_MS = 25_000;
const TALK_KEPT = 40;
const RECAP_SUMMARY_CHARS = 1500;
const RECAP_LAST_CHARS = 900;
const TYPING_MIN_GAP_MS = 2000;
const typingSeen = new Map<string, number>();

const fail = (c: Context<AppEnv>, code: string, status: 400 | 403 | 404 | 409 | 410 | 429) =>
  c.json({ error: code, code }, status);
const publish = (room: { id: string }, event: string, payload: Record<string, unknown>) =>
  publishRoomEvent(storyRoomChannel(room.id), event, payload).catch(() => {});
const isActive = (m: MemberRow | null | undefined): m is MemberRow => !!m && !m.leftAt && !m.kickedAt;

async function loadRoom(rawCode: string): Promise<RoomRow | null> {
  const code = normalizeRoomCode(rawCode);
  if (!code) return null;
  const [room] = await db.select().from(storyRooms).where(eq(storyRooms.code, code)).limit(1);
  return room ?? null;
}

async function loadMembership(roomId: string, userId: string): Promise<MemberRow | null> {
  const [row] = await db
    .select()
    .from(storyRoomMembers)
    .where(and(eq(storyRoomMembers.roomId, roomId), eq(storyRoomMembers.userId, userId)))
    .limit(1);
  return row ?? null;
}

async function loadMembers(roomId: string): Promise<StoryRoomMember[]> {
  const [rows, ready, online] = await Promise.all([
    db
      .select({
        userId: storyRoomMembers.userId,
        role: storyRoomMembers.role,
        mutedUntil: storyRoomMembers.mutedUntil,
        roleId: storyRoomMembers.roleId,
        roleName: storyRoomMembers.roleName,
        splitOk: storyRoomMembers.splitOk,
        name: user.name,
        image: user.image,
      })
      .from(storyRoomMembers)
      .innerJoin(user, eq(user.id, storyRoomMembers.userId))
      .where(and(eq(storyRoomMembers.roomId, roomId), isNull(storyRoomMembers.leftAt), isNull(storyRoomMembers.kickedAt)))
      .orderBy(asc(storyRoomMembers.joinedAt)),
    getReady(roomId),
    getOnline(roomId),
  ]);
  const now = Date.now();
  return rows.map((row) => ({
    userId: row.userId,
    name: row.name,
    image: row.image ? resolveImageCdn(row.image) : null,
    role: row.role === "host" ? "host" : "player",
    mutedUntil: row.mutedUntil && row.mutedUntil.getTime() > now ? row.mutedUntil.toISOString() : null,
    ready: ready.has(row.userId),
    online: online.has(row.userId),
    roleId: row.roleId,
    roleName: row.roleId ? row.roleName : null,
    splitOk: row.role === "host" || row.splitOk === true,
  }));
}

async function loadMember(roomId: string, userId: string): Promise<StoryRoomMember | null> {
  return (await loadMembers(roomId)).find((m) => m.userId === userId) ?? null;
}

function serializeAction(row: { id: string; userId: string; name: string; text: string; createdAt: Date; turnId: string | null; hold: boolean }): StoryRoomAction {
  return { id: row.id, userId: row.userId, name: row.name, text: row.text, createdAt: row.createdAt.toISOString(), turnId: row.turnId, hold: row.hold === true };
}

/** Another player's action before its round is sent: who acted, not what they wrote. */
export function hideActionText(action: StoryRoomAction, viewerId: string): StoryRoomAction {
  return action.userId === viewerId ? action : { ...action, text: "" };
}

function serializeTalk(row: { id: string; userId: string; name: string; text: string; createdAt: Date }): StoryRoomTalkLine {
  return { id: row.id, userId: row.userId, name: row.name, text: row.text, createdAt: row.createdAt.toISOString() };
}

const actionColumns = {
  id: storyRoomActions.id,
  userId: storyRoomActions.userId,
  name: user.name,
  text: storyRoomActions.text,
  createdAt: storyRoomActions.createdAt,
  turnId: storyRoomActions.turnId,
  hold: storyRoomActions.hold,
};

async function loadPending(roomId: string): Promise<StoryRoomAction[]> {
  const rows = await db
    .select(actionColumns)
    .from(storyRoomActions)
    .innerJoin(user, eq(user.id, storyRoomActions.userId))
    .where(and(eq(storyRoomActions.roomId, roomId), eq(storyRoomActions.kind, "action"), isNull(storyRoomActions.messageId)))
    .orderBy(asc(storyRoomActions.createdAt), asc(storyRoomActions.id));
  return rows.map(serializeAction);
}

/** The newest table talk, oldest first. */
async function loadTalk(roomId: string): Promise<StoryRoomTalkLine[]> {
  const rows = await db
    .select(actionColumns)
    .from(storyRoomActions)
    .innerJoin(user, eq(user.id, storyRoomActions.userId))
    .where(and(eq(storyRoomActions.roomId, roomId), eq(storyRoomActions.kind, "talk")))
    .orderBy(desc(storyRoomActions.createdAt), desc(storyRoomActions.id))
    .limit(TALK_KEPT);
  return rows.reverse().map(serializeTalk);
}

/** Markup-free, whitespace-tidied, clipped. */
export function plainExcerpt(text: string, max: number): string {
  const plain = text
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[[a-z_][\w-]*:[^\]\n]*\]/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return plain.length <= max ? plain : `${plain.slice(0, max).trimEnd()}…`;
}

/** The memory summary's story section ("## Story So Far" up to the next heading), else all of it. */
export function storySoFar(summary: string): string {
  const match = /^#{1,3}\s*Story So Far\s*$([\s\S]*?)(?=^#{1,3}\s|(?![\s\S]))/im.exec(summary);
  const body = (match?.[1] ?? summary).trim();
  return body.replace(/^#{1,6}\s+/gm, "");
}

/**
 * 前情提要 for someone arriving mid-story, from what the session already has:
 * its memory summary (no extra AI call) and the latest reply. Null before the
 * first reply.
 */
async function loadRecap(sessionId: string): Promise<{ turns: number; summary: string | null; last: string | null } | null> {
  const [[count], [session], [last]] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(messages).where(and(eq(messages.sessionId, sessionId), eq(messages.role, "assistant"))),
    db.select({ summary: playSessions.summary }).from(playSessions).where(eq(playSessions.id, sessionId)).limit(1),
    db
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.sessionId, sessionId), eq(messages.role, "assistant")))
      .orderBy(desc(messages.createdAt))
      .limit(1),
  ]);
  const turns = count?.n ?? 0;
  if (!turns) return null;
  const summary = session?.summary ? plainExcerpt(storySoFar(session.summary), RECAP_SUMMARY_CHARS) : "";
  const lastText = last?.content ? plainExcerpt(last.content, RECAP_LAST_CHARS) : "";
  return { turns, summary: summary || null, last: lastText || null };
}

async function loadWorldInfo(worldId: string) {
  const [row] = await db
    .select({
      name: worlds.name,
      thumbnailUrl: worlds.thumbnailUrl,
      ageRating: worlds.ageRating,
      isNsfw: worlds.isNsfw,
      // Only the card's multiplayer setting, never the whole schema.
      multiplayer: sql<unknown>`${worlds.schema}->'settings'->'multiplayer'`,
      // Character portraits by entry id: a role linked to a character wears theirs.
      portraits: sql<Record<string, string> | null>`(
        SELECT jsonb_object_agg(e->>'id', e->>'portrait')
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${worlds.schema}->'entries') = 'array' THEN ${worlds.schema}->'entries' ELSE '[]'::jsonb END) e
        WHERE e->>'role' = 'character' AND coalesce(e->>'portrait', '') <> '')`,
    })
    .from(worlds)
    .where(eq(worlds.id, worldId))
    .limit(1);
  return row ?? null;
}

/** A role's picture: its own, else its linked character's portrait. */
function roleImage(role: { image?: string; entryId?: string }, portraits: Record<string, string> | null): string | null {
  const ref = role.image ?? (role.entryId ? portraits?.[role.entryId] : undefined);
  return ref ? resolveImageCdn(ref) : null;
}

/** Active members' held roles, for role checks: roleId -> userId. */
async function loadRoleHolders(roomId: string): Promise<Array<{ userId: string; roleId: string | null }>> {
  return db
    .select({ userId: storyRoomMembers.userId, roleId: storyRoomMembers.roleId })
    .from(storyRoomMembers)
    .where(and(eq(storyRoomMembers.roomId, roomId), isNull(storyRoomMembers.leftAt), isNull(storyRoomMembers.kickedAt)));
}
const holderOf = (rows: ReadonlyArray<{ userId: string; roleId: string | null }>) => (roleId: string) =>
  rows.find((r) => r.roleId === roleId)?.userId ?? null;

async function snapshot(room: RoomRow, viewer: { id: string; limitedContentOnly?: boolean | null }, membership: MemberRow | null) {
  const member = isActive(membership) ? membership : null;
  const [members, pending, world, talk, round, recap] = await Promise.all([
    loadMembers(room.id),
    member ? loadPending(room.id) : Promise.resolve([] as StoryRoomAction[]),
    loadWorldInfo(room.worldId),
    member ? loadTalk(room.id) : Promise.resolve([] as StoryRoomTalkLine[]),
    member ? currentRound(room) : Promise.resolve(null),
    member ? loadRecap(room.sessionId).catch(() => null) : Promise.resolve(null),
  ]);
  const hideCover = !!viewer.limitedContentOnly && !!world && isAdultWorld(world);
  const card = storyRoomCard(world?.multiplayer);
  const isHost = member?.role === "host";
  const stats = await roomCostStats(room).catch(() => null);
  const spent = isHost ? stats?.spent ?? null : null;
  return {
    room: serializeRoom(room),
    members,
    // Visible before joining: the join screen picks a role from these.
    roles: card.roles.map((r) => ({
      id: r.id,
      name: r.name,
      ...(r.note ? { note: r.note } : {}),
      ...(!hideCover && roleImage(r, world?.portraits ?? null) ? { image: roleImage(r, world?.portraits ?? null) } : {}),
      userId: members.find((m) => m.roleId === r.id)?.userId ?? null,
    })),
    rolesRequired: card.rolesRequired,
    // What a round has cost lately, so a split room says what joining costs.
    cost: {
      mode: room.costMode === "split" ? ("split" as const) : ("host" as const),
      perRound: stats && stats.rounds ? Math.round((stats.spent / stats.rounds) * 10) / 10 : null,
    },
    me: member ? { role: member.role === "host" ? "host" as const : "player" as const } : null,
    // Nobody reads another player's action before the round goes to the AI.
    pending: pending.map((a) => hideActionText(a, viewer.id)),
    talk,
    round,
    recap,
    // The host's browser registers its model and settings when this is false.
    ...(isHost ? { profileSet: room.sendProfile != null, spent } : {}),
    session: {
      id: room.sessionId,
      worldId: room.worldId,
      worldName: world?.name ?? null,
      worldCover: world?.thumbnailUrl && !hideCover ? resolveImageCdn(world.thumbnailUrl) : null,
    },
  };
}

/** Loads the room and the caller's active membership, or answers with the error. */
async function requireMember(c: Context<AppEnv>, opts: { host?: boolean; open?: boolean } = {}) {
  const room = await loadRoom(c.req.param("code") ?? "");
  if (!room) return { response: fail(c, "not-found", 404) } as const;
  const membership = await loadMembership(room.id, c.get("user").id);
  if (!isActive(membership)) return { response: fail(c, "not-member", 403) } as const;
  if (opts.host && membership.role !== "host") return { response: fail(c, "not-host", 403) } as const;
  if (opts.open && room.status !== "open") return { response: fail(c, "closed", 410) } as const;
  return { room, membership } as const;
}

const closeRoom = (room: RoomRow) => closeStoryRoom(room);

/** Writes a member's role and tells the room. */
async function setMemberRole(room: RoomRow, userId: string, roleId: string | null, roleName: string | null) {
  await db
    .update(storyRoomMembers)
    .set({ roleId, roleName })
    .where(and(eq(storyRoomMembers.roomId, room.id), eq(storyRoomMembers.userId, userId)));
  const member = await loadMember(room.id, userId);
  if (member) await publish(room, "member", { member, change: "role" });
  return member;
}

// POST /api/story-rooms — the host opens a room on their session (or gets the open one back).
storyRoomRoutes.post("/", async (c) => {
  const currentUser = c.get("user");
  const body = await c.req.json().catch(() => null);
  const sessionId: unknown = body?.sessionId;
  if (typeof sessionId !== "string" || !sessionId) return fail(c, "sessionId required", 400);

  const [session] = await db
    .select({ id: playSessions.id, worldId: playSessions.worldId })
    .from(playSessions)
    .where(and(eq(playSessions.id, sessionId), eq(playSessions.userId, currentUser.id)))
    .limit(1);
  if (!session) return fail(c, "not-found", 404);

  // Rooms open only where the card's author turned on story multiplayer.
  const world = await loadWorldInfo(session.worldId);
  const card = storyRoomCard(world?.multiplayer);
  if (!card.enabled) return fail(c, "multiplayer-off", 403);
  // The host is a participant too: an adult card needs the same gate.
  if (world && isAdultWorld(world)) {
    const gate = adultGateFailure((await loadAdultGateUser(currentUser.id)) ?? { birthYear: null });
    if (gate) return fail(c, gate, JOIN_ERROR_STATUS[gate]);
  }

  const [existing] = await db.select().from(storyRooms).where(eq(storyRooms.sessionId, sessionId)).limit(1);
  if (existing?.status === "open") return c.json({ data: serializeRoom(existing) });

  const codeTaken = async (code: string) =>
    (await db.select({ id: storyRooms.id }).from(storyRooms).where(eq(storyRooms.code, code)).limit(1)).length > 0;
  const code = await uniqueRoomCode(codeTaken);

  let room: RoomRow | undefined;
  if (existing) {
    // Reopen under a fresh code so old links die; everyone else rejoins (and
    // picks a role again). Seats follow the card as it is now.
    [room] = await db
      .update(storyRooms)
      .set({ status: "open", closedAt: null, code, maxSeats: card.maxSeats, minSeats: card.minSeats, openToFriends: false })
      .where(eq(storyRooms.id, existing.id))
      .returning();
    await db
      .update(storyRoomMembers)
      .set({ leftAt: new Date(), roleId: null, roleName: null })
      .where(and(eq(storyRoomMembers.roomId, existing.id), sql`${storyRoomMembers.role} <> 'host'`, isNull(storyRoomMembers.leftAt)));
    await db.delete(storyRoomActions).where(and(eq(storyRoomActions.roomId, existing.id), isNull(storyRoomActions.messageId)));
  } else {
    try {
      [room] = await db
        .insert(storyRooms)
        .values({ code, sessionId, worldId: session.worldId, hostUserId: currentUser.id, maxSeats: card.maxSeats, minSeats: card.minSeats, mergeWindowMs: STORY_ROOM_DEFAULT_WINDOW_MS })
        .returning();
    } catch (error) {
      // Two tabs opened the same session's room at once: the other one won.
      const [winner] = await db.select().from(storyRooms).where(eq(storyRooms.sessionId, sessionId)).limit(1);
      if (!winner) throw error;
      return c.json({ data: serializeRoom(winner) });
    }
  }
  if (!room) return fail(c, "not-found", 404);

  await db
    .insert(storyRoomMembers)
    .values({ roomId: room.id, userId: currentUser.id, role: "host" })
    .onConflictDoUpdate({
      target: [storyRoomMembers.roomId, storyRoomMembers.userId],
      set: { role: "host", leftAt: null, kickedAt: null, mutedUntil: null, joinedAt: new Date() },
    });
  // The host is here now: the away clock (host gone 2 minutes → the room dissolves) starts fresh.
  await markSeen(room.id, currentUser.id);
  return c.json({ data: serializeRoom(room) }, 201);
});

// GET /api/story-rooms/:code — the room as the caller may see it.
storyRoomRoutes.get("/:code", async (c) => {
  const currentUser = c.get("user");
  const room = await loadRoom(c.req.param("code"));
  if (!room) return fail(c, "not-found", 404);
  const membership = await loadMembership(room.id, currentUser.id);
  if (!isActive(membership) && room.status !== "open") return fail(c, "closed", 410);
  return c.json({ data: await snapshot(room, currentUser, membership) });
});

// POST /api/story-rooms/:code/join {roleId?}
storyRoomRoutes.post("/:code/join", async (c) => {
  const currentUser = c.get("user");
  const room = await loadRoom(c.req.param("code"));
  if (!room) return fail(c, "not-found", 404);
  const body = await c.req.json().catch(() => null);
  const requested: unknown = body?.roleId ?? undefined;
  if (requested !== undefined && (typeof requested !== "string" || !requested)) return fail(c, "roleId must be a string", 400);
  const membership = await loadMembership(room.id, currentUser.id);
  const alreadyActive = isActive(membership);

  const activeRows = await loadRoleHolders(room.id);
  const memberIds = activeRows.map((r) => r.userId);
  const world = await loadWorldInfo(room.worldId);
  const adultWorld = !!world && isAdultWorld(world);
  const [blocked, gateUser] = await Promise.all([
    isBlockedWithAnyMember(currentUser.id, memberIds),
    adultWorld ? loadAdultGateUser(currentUser.id) : Promise.resolve(null),
  ]);
  const error = joinDecision({
    status: room.status === "closed" ? "closed" : "open",
    kicked: !!membership?.kickedAt,
    alreadyActive,
    activeCount: memberIds.length,
    maxSeats: room.maxSeats,
    blocked,
    adultWorld,
    gate: adultWorld ? adultGateFailure(gateUser ?? { birthYear: null }) : null,
  });
  if (error) return fail(c, error, JOIN_ERROR_STATUS[error]);

  const card = storyRoomCard(world?.multiplayer);
  const currentRoleId = alreadyActive ? membership.roleId : null;
  const decided = roleDecision({
    roles: card.roles,
    rolesRequired: card.rolesRequired,
    requested: requested as string | undefined,
    holderOf: holderOf(activeRows),
    userId: currentUser.id,
    currentRoleId,
  });
  if ("error" in decided) return fail(c, decided.error, ROLE_ERROR_STATUS[decided.error]);
  const roleId = decided.role?.id ?? null;
  const roleName = decided.role?.name ?? null;
  // A split room: you pay a share of the rounds you act in, so you say yes first.
  const acceptSplit = body?.acceptSplit === true;
  if (room.costMode === "split" && !alreadyActive && !acceptSplit) return fail(c, "split-consent-required", 409);

  if (!alreadyActive) {
    await db
      .insert(storyRoomMembers)
      .values({ roomId: room.id, userId: currentUser.id, role: "player", roleId, roleName, splitOk: acceptSplit })
      .onConflictDoUpdate({
        target: [storyRoomMembers.roomId, storyRoomMembers.userId],
        set: { leftAt: null, joinedAt: new Date(), roleId, roleName, splitOk: acceptSplit },
      });
    await markSeen(room.id, currentUser.id);
    await db
      .update(friendInvites)
      .set({ status: "accepted", respondedAt: new Date() })
      .where(and(
        eq(friendInvites.toUserId, currentUser.id),
        eq(friendInvites.joinUrl, storyRoomJoinUrl(room.code)),
        eq(friendInvites.status, "pending"),
      ));
    const member = await loadMember(room.id, currentUser.id);
    if (member) await publish(room, "member", { member, change: "joined" });
  } else if (roleId !== currentRoleId || roleName !== membership.roleName) {
    await setMemberRole(room, currentUser.id, roleId, roleName);
  }
  void evaluateRoom(room.id);
  return c.json({ data: await snapshot(room, currentUser, await loadMembership(room.id, currentUser.id)) });
});

// POST /api/story-rooms/:code/leave — the host leaving closes the room.
storyRoomRoutes.post("/:code/leave", async (c) => {
  const found = await requireMember(c);
  if ("response" in found) return found.response;
  const { room, membership } = found;
  if (membership.role === "host") {
    if (room.status === "open") await closeRoom(room);
    return c.json({ data: { ok: true } });
  }
  await db
    .update(storyRoomMembers)
    .set({ leftAt: new Date(), roleId: null, roleName: null })
    .where(and(eq(storyRoomMembers.roomId, room.id), eq(storyRoomMembers.userId, membership.userId)));
  await setReady(room.id, membership.userId, false);
  await dropOnline(room.id, membership.userId);
  await publish(room, "member", { userId: membership.userId, change: "left" });
  void evaluateRoom(room.id);
  return c.json({ data: { ok: true } });
});

// POST /api/story-rooms/:code/kick {userId} (host)
storyRoomRoutes.post("/:code/kick", async (c) => {
  const found = await requireMember(c, { host: true });
  if ("response" in found) return found.response;
  const { room } = found;
  const body = await c.req.json().catch(() => null);
  const targetId: unknown = body?.userId;
  if (typeof targetId !== "string" || !targetId) return fail(c, "userId required", 400);
  const target = await loadMembership(room.id, targetId);
  if (!isActive(target) || target.role === "host") return fail(c, "not-member", 404);

  await db
    .update(storyRoomMembers)
    .set({ kickedAt: new Date(), roleId: null, roleName: null })
    .where(and(eq(storyRoomMembers.roomId, room.id), eq(storyRoomMembers.userId, targetId)));
  const removed = await db
    .delete(storyRoomActions)
    .where(and(eq(storyRoomActions.roomId, room.id), eq(storyRoomActions.userId, targetId), isNull(storyRoomActions.turnId), isNull(storyRoomActions.messageId)))
    .returning();
  await setReady(room.id, targetId, false);
  await dropOnline(room.id, targetId);
  for (const action of removed) await publish(room, "action-removed", { id: action.id });
  await publish(room, "member", { userId: targetId, change: "kicked" });
  await publish(room, "kicked", { userId: targetId });
  void evaluateRoom(room.id);
  return c.json({ data: { ok: true } });
});

// POST /api/story-rooms/:code/mute {userId, minutes} (host; 0 = unmute)
storyRoomRoutes.post("/:code/mute", async (c) => {
  const found = await requireMember(c, { host: true });
  if ("response" in found) return found.response;
  const { room } = found;
  const body = await c.req.json().catch(() => null);
  const targetId: unknown = body?.userId;
  const minutes: unknown = body?.minutes;
  if (typeof targetId !== "string" || !targetId) return fail(c, "userId required", 400);
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0 || minutes > MAX_MUTE_MINUTES) {
    return fail(c, "minutes must be 0..1440", 400);
  }
  const target = await loadMembership(room.id, targetId);
  if (!isActive(target) || target.role === "host") return fail(c, "not-member", 404);
  const mutedUntil = minutes > 0 ? new Date(Date.now() + Math.round(minutes * 60_000)) : null;
  await db
    .update(storyRoomMembers)
    .set({ mutedUntil })
    .where(and(eq(storyRoomMembers.roomId, room.id), eq(storyRoomMembers.userId, targetId)));
  const member = await loadMember(room.id, targetId);
  if (member) await publish(room, "member", { member, change: minutes > 0 ? "muted" : "unmuted" });
  return c.json({ data: member });
});

// POST /api/story-rooms/:code/close (host)
storyRoomRoutes.post("/:code/close", async (c) => {
  const found = await requireMember(c, { host: true });
  if ("response" in found) return found.response;
  const room = found.room.status === "open" ? await closeRoom(found.room) : found.room;
  return c.json({ data: serializeRoom(room) });
});

// PATCH /api/story-rooms/:code {turnMode?, mergeWindowMs?, openToFriends?, spendCap?} (host)
storyRoomRoutes.patch("/:code", async (c) => {
  const found = await requireMember(c, { host: true, open: true });
  if ("response" in found) return found.response;
  const body = await c.req.json().catch(() => null);
  const patch: Partial<Pick<RoomRow, "turnMode" | "mergeWindowMs" | "openToFriends" | "spendCap" | "costMode" | "isPublic">> = {};
  if (body?.costMode !== undefined) {
    if (body.costMode !== "host" && body.costMode !== "split") return fail(c, "costMode must be host or split", 400);
    patch.costMode = body.costMode;
  }
  if (body?.isPublic !== undefined) {
    if (typeof body.isPublic !== "boolean") return fail(c, "isPublic must be a boolean", 400);
    if (body.isPublic) {
      // Strangers find a public room on the card page: only a published card has one.
      const [card] = await db.select({ published: worlds.isPublished }).from(worlds).where(eq(worlds.id, found.room.worldId)).limit(1);
      if (!card?.published) return fail(c, "card-not-published", 409);
      // A public room splits the cost unless the host says they pay.
      if (body.costMode === undefined && !found.room.isPublic) patch.costMode = "split";
    }
    patch.isPublic = body.isPublic;
  }
  if (body?.spendCap !== undefined) {
    const cap = body.spendCap;
    if (cap !== null && (typeof cap !== "number" || !Number.isInteger(cap) || cap < STORY_ROOM_SPEND_CAP_MIN || cap > STORY_ROOM_SPEND_CAP_MAX)) {
      return fail(c, `spendCap must be null or ${STORY_ROOM_SPEND_CAP_MIN}..${STORY_ROOM_SPEND_CAP_MAX}`, 400);
    }
    patch.spendCap = cap;
  }
  if (body?.openToFriends !== undefined) {
    if (typeof body.openToFriends !== "boolean") return fail(c, "openToFriends must be a boolean", 400);
    patch.openToFriends = body.openToFriends;
  }
  if (body?.turnMode !== undefined) {
    if (body.turnMode !== "free" && body.turnMode !== "host") return fail(c, "turnMode must be free or host", 400);
    patch.turnMode = body.turnMode;
  }
  if (body?.mergeWindowMs !== undefined) {
    const ms = body.mergeWindowMs;
    if (typeof ms !== "number" || !Number.isInteger(ms) || (ms !== STORY_ROOM_UNTIMED && (ms < STORY_ROOM_MERGE_WINDOW_MIN_MS || ms > STORY_ROOM_MERGE_WINDOW_MAX_MS))) {
      return fail(c, `mergeWindowMs must be 0 (no limit) or ${STORY_ROOM_MERGE_WINDOW_MIN_MS}..${STORY_ROOM_MERGE_WINDOW_MAX_MS}`, 400);
    }
    patch.mergeWindowMs = ms;
  }
  if (!Object.keys(patch).length) return c.json({ data: serializeRoom(found.room) });
  const [updated] = await db.update(storyRooms).set(patch).where(eq(storyRooms.id, found.room.id)).returning();
  // Switching to split asks everyone already seated to agree before they act again.
  if (patch.costMode === "split" && found.room.costMode !== "split") {
    await db
      .update(storyRoomMembers)
      .set({ splitOk: false })
      .where(and(eq(storyRoomMembers.roomId, found.room.id), sql`${storyRoomMembers.role} <> 'host'`));
    for (const m of await loadMembers(found.room.id)) await publish(found.room, "member", { member: m, change: "split" });
  }
  // A new limit may let a round that stopped at the old one go now.
  if (patch.spendCap !== undefined) await clearRoundFailure(found.room.id);
  const room = serializeRoom(updated ?? found.room);
  await publish(found.room, "room", { room });
  void evaluateRoom(found.room.id);
  return c.json({ data: room });
});

// POST /api/story-rooms/:code/invite {userIds} (host; friends only)
storyRoomRoutes.post("/:code/invite", rateLimitMiddleware("social-actions"), async (c) => {
  const found = await requireMember(c, { host: true, open: true });
  if ("response" in found) return found.response;
  const { room } = found;
  const currentUser = c.get("user");
  const body = await c.req.json().catch(() => null);
  const userIds: unknown = body?.userIds;
  if (!Array.isArray(userIds) || userIds.length === 0 || userIds.length > STORY_ROOM_INVITE_MAX) {
    return fail(c, `userIds must be 1..${STORY_ROOM_INVITE_MAX} user ids`, 400);
  }

  const joinUrl = storyRoomJoinUrl(room.code);
  const world = await loadWorldInfo(room.worldId);
  const expiresAt = new Date(Date.now() + ROOM_INVITE_TTL_MS);
  let sent = 0;
  let skipped = 0;
  for (const raw of new Set(userIds as unknown[])) {
    const toUserId = typeof raw === "string" ? raw : "";
    if (!toUserId || toUserId === currentUser.id) continue;
    if (!(await areFriends(currentUser.id, toUserId)) || (await getBlockStatus(currentUser.id, toUserId)).blocked) {
      skipped++;
      continue;
    }
    // Refresh-not-stack, as friend invites do (one pending per pair).
    await db
      .update(friendInvites)
      .set({ status: "revoked", respondedAt: new Date() })
      .where(and(eq(friendInvites.fromUserId, currentUser.id), eq(friendInvites.toUserId, toUserId), eq(friendInvites.status, "pending")));
    const [invite] = await db
      .insert(friendInvites)
      .values({ fromUserId: currentUser.id, toUserId, worldId: world ? room.worldId : null, joinUrl, expiresAt })
      .returning();
    if (!invite) continue;
    sent++;
    // The invite is a message from the host, in the conversation with them.
    const message = await postInviteMessage({
      from: currentUser,
      toUserId,
      invite: {
        id: invite.id, kind: "room", worldId: world ? room.worldId : null, worldName: world?.name ?? null,
        // An 18+ card's cover is not put in front of someone who has not passed its gate.
        thumbnailUrl: world && !isAdultWorld(world) ? world.thumbnailUrl : null, joinUrl, roomCode: room.code, expiresAt,
      },
    }).catch(() => null);
    const payload = {
      inviteId: invite.id,
      kind: "room",
      fromUserId: currentUser.id,
      fromName: currentUser.name,
      fromImage: resolveImageCdn(currentUser.image ?? null),
      worldId: world ? room.worldId : null,
      worldName: world?.name ?? null,
      joinUrl,
      roomCode: room.code,
      expiresAt: expiresAt.toISOString(),
      conversationId: message?.conversationId ?? null,
      messageId: message?.messageId ?? null,
    };
    notify(toUserId, "room_invite", payload, { actorUserId: currentUser.id, dedupeKey: invite.id }).catch(() => {});
    publishRoomEvent(`user:${toUserId}`, "friend_invite", payload).catch(() => {});
  }
  return c.json({ data: { sent, skipped } }, sent > 0 ? 201 : 200);
});

// POST /api/story-rooms/:code/actions {text, kind?: "action"|"talk", hold?}
// An action joins the round; `hold` (AI 先别接) keeps it from starting the
// countdown. Talk is table talk among the players: the AI never sees it.
storyRoomRoutes.post("/:code/actions", async (c) => {
  const found = await requireMember(c, { open: true });
  if ("response" in found) return found.response;
  const { room, membership } = found;
  if (membership.mutedUntil && membership.mutedUntil.getTime() > Date.now()) return fail(c, "muted", 403);
  const body = await c.req.json().catch(() => null);
  // A split room's player pays a share of the round: agreed, and with mushies to pay it.
  if (room.costMode === "split" && membership.role !== "host" && body?.kind !== "talk") {
    if (!membership.splitOk) return fail(c, "split-consent-required", 409);
    const wallet = await checkBalance(membership.userId).catch(() => null);
    if (wallet && wallet.balance <= 0) return fail(c, "split-no-credits", 403);
  }
  const kind = body?.kind === undefined || body?.kind === "action" ? "action" : body?.kind === "talk" ? "talk" : null;
  if (!kind) return fail(c, "kind must be action or talk", 400);
  if (body?.hold !== undefined && typeof body.hold !== "boolean") return fail(c, "hold must be a boolean", 400);
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return fail(c, "text required", 400);
  if (text.length > (kind === "talk" ? STORY_ROOM_TALK_MAX_CHARS : STORY_ROOM_ACTION_MAX_CHARS)) return fail(c, "text-too-long", 400);
  const limited = await slidingWindowCheck(`rl:story-room-action:${membership.userId}`, ACTIONS_PER_MINUTE, 60_000);
  if (limited) {
    c.header("Retry-After", String(limited.retryAfter));
    return c.json({ error: "rate-limited", code: "rate-limited", retryAfter: limited.retryAfter }, 429);
  }
  const hold = kind === "action" && body?.hold === true;
  const [row] = await db.insert(storyRoomActions).values({ roomId: room.id, userId: membership.userId, text, kind, hold }).returning();
  typingSeen.delete(`${room.id}:${membership.userId}`);
  if (kind === "talk") {
    const line = serializeTalk({ ...row!, name: c.get("user").name });
    await publish(room, "talk", { line });
    return c.json({ data: line }, 201);
  }
  const action = serializeAction({ ...row!, name: c.get("user").name });
  await publish(room, "action", { action });
  void evaluateRoom(room.id);
  return c.json({ data: action }, 201);
});

// DELETE /api/story-rooms/:code/actions/:id — the author withdraws an unclaimed action.
storyRoomRoutes.delete("/:code/actions/:id", async (c) => {
  const found = await requireMember(c);
  if ("response" in found) return found.response;
  const { room, membership } = found;
  const [action] = await db
    .select()
    .from(storyRoomActions)
    .where(and(
      eq(storyRoomActions.id, c.req.param("id")),
      eq(storyRoomActions.roomId, room.id),
      eq(storyRoomActions.userId, membership.userId),
      eq(storyRoomActions.kind, "action"),
    ))
    .limit(1);
  if (!action) return fail(c, "not-found", 404);
  if (action.turnId || action.messageId) return fail(c, "already-claimed", 409);
  const deleted = await db
    .delete(storyRoomActions)
    .where(and(eq(storyRoomActions.id, action.id), isNull(storyRoomActions.turnId), isNull(storyRoomActions.messageId)))
    .returning();
  if (!deleted.length) return fail(c, "already-claimed", 409);
  await publish(room, "action-removed", { id: action.id });
  void evaluateRoom(room.id);
  return c.json({ data: { ok: true } });
});

// POST /api/story-rooms/:code/role {roleId} (any member; null drops an optional role)
storyRoomRoutes.post("/:code/role", async (c) => {
  const found = await requireMember(c, { open: true });
  if ("response" in found) return found.response;
  const { room, membership } = found;
  const body = await c.req.json().catch(() => null);
  const requested: unknown = body?.roleId;
  if (requested !== null && (typeof requested !== "string" || !requested)) return fail(c, "roleId must be a string or null", 400);
  const [world, holders] = await Promise.all([loadWorldInfo(room.worldId), loadRoleHolders(room.id)]);
  const card = storyRoomCard(world?.multiplayer);
  const decided = roleDecision({
    roles: card.roles,
    rolesRequired: card.rolesRequired,
    requested,
    holderOf: holderOf(holders),
    userId: membership.userId,
    currentRoleId: membership.roleId,
  });
  if ("error" in decided) return fail(c, decided.error, ROLE_ERROR_STATUS[decided.error]);
  const roleId = decided.role?.id ?? null;
  const roleName = decided.role?.name ?? null;
  if (roleId === membership.roleId && roleName === membership.roleName) {
    return c.json({ data: await loadMember(room.id, membership.userId) });
  }
  return c.json({ data: await setMemberRole(room, membership.userId, roleId, roleName) });
});

// POST /api/story-rooms/:code/ready {ready}
storyRoomRoutes.post("/:code/ready", async (c) => {
  const found = await requireMember(c, { open: true });
  if ("response" in found) return found.response;
  const body = await c.req.json().catch(() => null);
  if (typeof body?.ready !== "boolean") return fail(c, "ready must be a boolean", 400);
  await setReady(found.room.id, found.membership.userId, body.ready);
  await publish(found.room, "ready", { userId: found.membership.userId, ready: body.ready });
  void evaluateRoom(found.room.id);
  return c.json({ data: { ready: body.ready } });
});

// POST /api/story-rooms/:code/turn — 让 AI 接: send the round now. Any member
// may ask (the host only, when the host runs the turns). The server sends it
// as the host; the reply arrives on the room channel.
storyRoomRoutes.post("/:code/turn", async (c) => {
  const found = await requireMember(c, { open: true });
  if ("response" in found) return found.response;
  const { room, membership } = found;
  if (room.turnMode === "host" && membership.role !== "host") return fail(c, "not-host", 403);
  const members = await loadMembers(room.id);
  if (members.length < room.minSeats) return fail(c, "waiting-for-players", 409);
  const result = await runRound(room.id, { manual: true });
  if ("error" in result) {
    if (result.error === "not-ready") return c.json({ error: "Rounds are not available right now", code: "not-ready" }, 503);
    return fail(c, result.error, 409);
  }
  return c.json({ data: { started: true } }, 202);
});

// POST /api/story-rooms/:code/typing — "writing…" for the others, a few seconds.
storyRoomRoutes.post("/:code/typing", async (c) => {
  const found = await requireMember(c, { open: true });
  if ("response" in found) return found.response;
  const key = `${found.room.id}:${found.membership.userId}`;
  const now = Date.now();
  if (now - (typingSeen.get(key) ?? 0) >= TYPING_MIN_GAP_MS) {
    typingSeen.set(key, now);
    if (typingSeen.size > 5000) typingSeen.clear();
    await publish(found.room, "typing", { userId: found.membership.userId });
  }
  return c.json({ data: { ok: true } });
});

// PUT /api/story-rooms/:code/profile (host) — the model and settings the
// server sends this room's rounds with: what the host's own send would carry.
storyRoomRoutes.put("/:code/profile", async (c) => {
  const found = await requireMember(c, { host: true, open: true });
  if ("response" in found) return found.response;
  const profile = sanitizeSendProfile(await c.req.json().catch(() => null));
  if (!profile) return fail(c, "invalid-profile", 400);
  await db.update(storyRooms).set({ sendProfile: profile as Record<string, unknown> }).where(eq(storyRooms.id, found.room.id));
  return c.json({ data: { ok: true } });
});

// POST /api/story-rooms/:code/split-ok — a seated player agrees to share the cost.
storyRoomRoutes.post("/:code/split-ok", async (c) => {
  const found = await requireMember(c, { open: true });
  if ("response" in found) return found.response;
  await db
    .update(storyRoomMembers)
    .set({ splitOk: true })
    .where(and(eq(storyRoomMembers.roomId, found.room.id), eq(storyRoomMembers.userId, found.membership.userId)));
  const member = await loadMember(found.room.id, found.membership.userId);
  if (member) await publish(found.room, "member", { member, change: "split" });
  return c.json({ data: member });
});

// GET /api/story-rooms/public/:worldId — open public rooms on this card with a
// free seat (the card page's 公开房间), most people online first: quick-join takes the top one.
storyRoomRoutes.get("/public/:worldId", async (c) => {
  const me = c.get("user").id;
  const rooms = await db
    .select()
    .from(storyRooms)
    .where(and(eq(storyRooms.worldId, c.req.param("worldId")), eq(storyRooms.status, "open"), eq(storyRooms.isPublic, true)))
    .orderBy(desc(storyRooms.createdAt))
    .limit(40);
  const out: PublicRoom[] = [];
  for (const room of rooms) {
    const members = await loadMembers(room.id);
    if (members.some((m) => m.userId === me)) continue;
    if (members.length >= room.maxSeats) continue;
    if (await isBlockedWithAnyMember(me, members.map((m) => m.userId))) continue;
    const [last] = await db
      .select({ at: messages.createdAt })
      .from(messages)
      .where(and(eq(messages.sessionId, room.sessionId), eq(messages.role, "assistant")))
      .orderBy(desc(messages.createdAt))
      .limit(1);
    const host = members.find((m) => m.role === "host");
    out.push({
      code: room.code,
      hostName: host?.name ?? "",
      hostImage: host?.image ?? null,
      members: members.length,
      maxSeats: room.maxSeats,
      online: members.filter((m) => m.online).length,
      costMode: room.costMode === "split" ? "split" : "host",
      createdAt: room.createdAt.toISOString(),
      lastReplyAt: last?.at ? last.at.toISOString() : null,
      people: members.slice(0, 6).map((m) => ({ name: m.name, image: m.image })),
    });
    if (out.length >= 12) break;
  }
  out.sort((a, b) => b.online - a.online || b.members - a.members);
  return c.json({ data: out });
});

type PublicRoom = {
  code: string;
  hostName: string;
  hostImage: string | null;
  members: number;
  maxSeats: number;
  online: number;
  costMode: "host" | "split";
  createdAt: string;
  lastReplyAt: string | null;
  people: Array<{ name: string; image: string | null }>;
};

// GET /api/story-rooms/friends/:worldId — open rooms on this card a friend is
// in and whose host lets friends walk in (the card page's 好友在玩).
storyRoomRoutes.get("/friends/:worldId", async (c) => {
  const me = c.get("user").id;
  const worldId = c.req.param("worldId");
  const friendIds = new Set((await listFriends(me)).map((f) => f.id));
  if (!friendIds.size) return c.json({ data: [] });
  const rooms = await db
    .select()
    .from(storyRooms)
    .where(and(eq(storyRooms.worldId, worldId), eq(storyRooms.status, "open"), eq(storyRooms.openToFriends, true)))
    .orderBy(desc(storyRooms.createdAt))
    .limit(50);
  const out: Array<{ code: string; hostName: string; hostImage: string | null; friends: Array<{ name: string; image: string | null }>; members: number; maxSeats: number }> = [];
  for (const room of rooms) {
    const members = await loadMembers(room.id);
    if (members.some((m) => m.userId === me)) continue;
    // Friends of the host only: a stranger's room never shows because a mutual friend sits in it.
    if (!friendIds.has(room.hostUserId)) continue;
    if (members.length >= room.maxSeats) continue;
    if (await isBlockedWithAnyMember(me, members.map((m) => m.userId))) continue;
    const host = members.find((m) => m.role === "host");
    out.push({
      code: room.code,
      hostName: host?.name ?? "",
      hostImage: host?.image ?? null,
      friends: members.filter((m) => friendIds.has(m.userId)).slice(0, 4).map((m) => ({ name: m.name, image: m.image })),
      members: members.length,
      maxSeats: room.maxSeats,
    });
    if (out.length >= 6) break;
  }
  return c.json({ data: out });
});

// GET /api/story-rooms/:code/events — the room's live channel for members.
storyRoomRoutes.get("/:code/events", async (c) => {
  const found = await requireMember(c);
  if ("response" in found) return found.response;
  const { room } = found;
  const currentUser = c.get("user");
  const me = currentUser.id;

  return streamSSE(c, async (stream) => {
    let ended = false;
    let wake: () => void = () => {};
    const endedSignal = new Promise<void>((resolve) => { wake = resolve; });
    const end = () => { ended = true; wake(); };

    const unsubscribe = subscribeToRoom(storyRoomChannel(room.id), me, async (event, payload) => {
      if (ended) return;
      // `kicked` goes to the kicked member only; everyone sees the `member` change.
      if (event === "kicked" && payload.userId !== me) return;
      // Another player's action is only "they acted" until the round is sent.
      if (event === "action" && payload.action && typeof payload.action === "object") {
        payload = { ...payload, action: hideActionText(payload.action as StoryRoomAction, me) };
      }
      await stream.writeSSE({ event, data: JSON.stringify(payload) });
      if (event === "closed" || event === "kicked") end();
    });
    stream.onAbort(() => end());

    await touchOnline(room.id, me);
    const fresh = await loadRoom(room.code);
    await stream.writeSSE({
      event: "snapshot",
      data: JSON.stringify(await snapshot(fresh ?? room, currentUser, await loadMembership(room.id, me))),
    });
    const online = await loadMember(room.id, me);
    if (online) await publish(room, "member", { member: online, change: "online" });
    void evaluateRoom(room.id);

    // Hono swallows write errors, so loop on `aborted`, never while(true)
    // (see the per-user channel in routes/friend-invites.ts).
    while (!stream.aborted && !ended) {
      await Promise.race([stream.sleep(HEARTBEAT_MS), endedSignal]);
      if (stream.aborted || ended) break;
      await stream.writeSSE({ event: "ping", data: "" });
      await touchOnline(room.id, me);
    }

    unsubscribe();
    await dropOnline(room.id, me);
    const still = await loadMembership(room.id, me);
    if (isActive(still)) {
      const offline = await loadMember(room.id, me);
      if (offline) await publish(room, "member", { member: offline, change: "offline" });
      void evaluateRoom(room.id);
    }
  });
});

export { storyRoomRoutes };
