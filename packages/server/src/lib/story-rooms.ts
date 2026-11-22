import { randomInt } from "node:crypto";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getAgeFromBirthYear, normaliseMultiplayer } from "@yumina/shared";
import { db } from "../db/index.js";
import { storyRoomActions, storyRoomMembers, storyRooms, user, userBlocks, userPersonas } from "../db/schema.js";
import { redis } from "./redis.js";

/**
 * Story rooms: one play session shared by 2-12 friends. The host owns the
 * session and pays for every turn (a room turn is an ordinary send by the host
 * carrying `roomTurnId`); members post short actions that the host merges into
 * that turn's user message. Pure helpers first, then the small DB/presence
 * layer the routes and the chat pipeline share.
 */

export type StoryRoom = {
  id: string;
  code: string;
  sessionId: string;
  worldId: string;
  hostUserId: string;
  turnMode: "free" | "host";
  maxSeats: number;
  minSeats: number;
  mergeWindowMs: number;
  status: "open" | "closed";
  createdAt: string;
  openToFriends: boolean;
  /** Most the rounds may cost the host in any 24 hours (mushies); null = no limit. */
  spendCap: number | null;
  /** host = the host pays every round; split = each round's players share it. */
  costMode: "host" | "split";
  /** Listed on the card page for anyone to join. */
  isPublic: boolean;
};
export type StoryRoomMember = {
  userId: string;
  name: string;
  image: string | null;
  role: "host" | "player";
  mutedUntil: string | null;
  ready: boolean;
  online: boolean;
  /** The card role this member plays (settings.multiplayer.roles), or null. */
  roleId: string | null;
  roleName: string | null;
  /** Agreed to share the cost (only asked in a split room). */
  splitOk: boolean;
};
export type StoryRoomAction = {
  id: string;
  userId: string;
  name: string;
  text: string;
  createdAt: string;
  turnId: string | null;
  /** 「AI 先别接」: in the round, but it does not start the countdown. */
  hold: boolean;
};
/** Table talk: players only, the AI never sees it. */
export type StoryRoomTalkLine = { id: string; userId: string; name: string; text: string; createdAt: string };
export type StoryRoomRoundStatus = "idle" | "counting" | "held" | "writing" | "failed" | "waiting";
export type StoryRoomRound = {
  status: StoryRoomRoundStatus;
  /** Epoch ms the round goes to the AI on its own (status counting). */
  dueAt: number | null;
  windowMs: number;
  failedCode?: string | null;
  need?: { have: number; need: number };
};
export type StoryRoomContribution = { userId: string; name: string; text: string; roleId?: string; roleName?: string };

export const STORY_ROOM_MAX_SEATS = 12;
export const STORY_ROOM_ACTION_MAX_CHARS = 4000;
export const STORY_ROOM_MERGE_WINDOW_MIN_MS = 10_000;
export const STORY_ROOM_MERGE_WINDOW_MAX_MS = 300_000;
/** A new room's countdown: everyone writes at once, then the round goes. */
export const STORY_ROOM_DEFAULT_WINDOW_MS = 60_000;
/** 不限时: no countdown; the round goes when everyone online has acted or is ready, or someone asks. */
export const STORY_ROOM_UNTIMED = 0;
/** The host gone this long (page closed, offline) dissolves the room, as a host leaving a game does. */
export const STORY_ROOM_HOST_AWAY_MS = 2 * 60_000;
/** A public room frees a player's seat after they have been gone this long. */
export const STORY_ROOM_PUBLIC_SEAT_IDLE_MS = 10 * 60_000;
export const STORY_ROOM_TALK_MAX_CHARS = 1000;
export const STORY_ROOM_INVITE_MAX = 11;
/** The host's 24-hour limit on what the room's rounds may cost (mushies; 1000 = US$1). */
export const STORY_ROOM_DEFAULT_SPEND_CAP = 5000;
export const STORY_ROOM_SPEND_CAP_MIN = 100;
export const STORY_ROOM_SPEND_CAP_MAX = 1_000_000;
export const STORY_ROOM_SPEND_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Pub/sub key for a room's live channel (lib/room-manager.ts). */
export const storyRoomChannel = (roomId: string) => `story-room:${roomId}`;
export const storyRoomJoinUrl = (code: string) => `/app/room/${code}`;

// ── Codes ────────────────────────────────────────────────────────────────

/** No 0/O, 1/I: a code read aloud or retyped from a screenshot survives. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

export function generateRoomCode(pick: (max: number) => number = randomInt): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[pick(ROOM_CODE_ALPHABET.length)]!;
  return code;
}

export function normalizeRoomCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  return ROOM_CODE_PATTERN.test(code) ? code : null;
}

/** Retry on collision; `taken` answers whether a candidate is already in use. */
export async function uniqueRoomCode(
  taken: (code: string) => Promise<boolean>,
  pick?: (max: number) => number,
  attempts = 8,
): Promise<string> {
  for (let i = 0; i < attempts; i++) {
    const code = generateRoomCode(pick);
    if (!(await taken(code))) return code;
  }
  throw new Error("Could not allocate a room code");
}

// ── Merged turn ──────────────────────────────────────────────────────────

type MergeableAction = {
  id?: string;
  userId: string;
  name: string;
  text: string;
  createdAt: Date | string;
  roleId?: string | null;
  roleName?: string | null;
  /** The player's own persona name, used when they play no card role. */
  personaName?: string | null;
};

/** A player's own persona, for a card whose author set no roles (or a player who took none). */
export type PlayerPersona = { name: string; about: string | null };

const PERSONA_ABOUT_MAX = 300;

/** Each user's active persona (name + a short line about them), for the room's players. */
export async function loadPlayerPersonas(userIds: readonly string[]): Promise<Map<string, PlayerPersona>> {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (!ids.length) return new Map();
  const rows = await db
    .select({ userId: userPersonas.userId, name: userPersonas.name, appearance: userPersonas.appearance, personality: userPersonas.personality, backstory: userPersonas.backstory })
    .from(userPersonas)
    .where(and(inArray(userPersonas.userId, ids), eq(userPersonas.isActive, true)));
  const out = new Map<string, PlayerPersona>();
  for (const r of rows) {
    const name = cleanLabel(r.name ?? "");
    if (!name) continue;
    const about = [r.appearance, r.personality, r.backstory].map((x) => cleanLabel(x ?? "")).filter(Boolean).join(" ").slice(0, PERSONA_ABOUT_MAX);
    out.set(r.userId, { name: name.slice(0, 60), about: about || null });
  }
  return out;
}

/**
 * One line per action, oldest first: `[Role (Name)]: text` when the actor
 * plays a card role, `[Persona (Name)]: text` when they play as their own
 * persona, else `[Name]: text`. A roster line, when given, leads.
 */
export function buildMergedTurn(
  actions: ReadonlyArray<MergeableAction>,
  roster: string | null = null,
): { content: string; contributions: StoryRoomContribution[] } {
  const ordered = [...actions].sort((a, b) => {
    const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    return diff !== 0 ? diff : (a.id ?? "").localeCompare(b.id ?? "");
  });
  const contributions = ordered.map((a): StoryRoomContribution => {
    const roleName = a.roleId ? cleanLabel(a.roleName ?? "") : "";
    const personaName = !roleName ? cleanLabel(a.personaName ?? "") : "";
    return {
      userId: a.userId,
      name: cleanName(a.name),
      text: a.text.trim(),
      ...(a.roleId && roleName ? { roleId: a.roleId, roleName } : personaName ? { roleName: personaName } : {}),
    };
  });
  const lines = contributions.map((c) => `[${speaker(c.name, c.roleName)}]: ${c.text}`);
  return { content: (roster ? [roster, ...lines] : lines).join("\n"), contributions };
}

/**
 * Who is at the table, in join order, and how to read the lines under it:
 * `[Players: Knight (Ann), Mage (Bea), Host]` plus one line of guidance. A
 * role leads so the story calls the character by it, not by the account name.
 */
export function buildRosterLine(members: ReadonlyArray<{ name: string; roleName?: string | null; persona?: PlayerPersona | null }>): string {
  const label = (m: (typeof members)[number]) => speaker(cleanName(m.name), cleanLabel(m.roleName ?? "") || cleanLabel(m.persona?.name ?? ""));
  const seats = members.map(label).join(", ");
  // Players without a card role play as their own persona: say who that is.
  const about = members
    .filter((m) => !cleanLabel(m.roleName ?? "") && m.persona?.about)
    .map((m) => `[${label(m)}: ${m.persona!.about}]`);
  return [`[Players: ${seats}]`, ROSTER_GUIDE, ...about].join("\n");
}

/** Sent with the roster: several people share this story, each line below is one of them. */
export const ROSTER_GUIDE =
  "[Several players share this story. Each [Name]: line is a different player acting this round: answer every one, call a character by the name before the brackets, and never decide what a player does or says.]";

const speaker = (name: string, roleName?: string | null) => (roleName ? `${roleName} (${name})` : name);

function cleanLabel(label: string): string {
  // A name with brackets or line breaks would forge another speaker's line.
  return label.replace(/[\[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function cleanName(name: string): string {
  return cleanLabel(name) || "Player";
}

// ── When a round goes to the AI ──────────────────────────────────────────

/** Send failures worth trying again on their own a little later. */
export const TRANSIENT_ROUND_FAILURES = new Set(["CONCURRENT_LIMIT", "RATE_LIMIT", "rate-limited", "busy"]);

export type RoundInput = {
  room: { status: string; turnMode: string; mergeWindowMs: number; minSeats: number };
  members: ReadonlyArray<{ userId: string; online: boolean; ready: boolean }>;
  /** Unsent round actions (kind action, no message yet), any claim state. */
  actions: ReadonlyArray<{ id: string; userId: string; createdAt: number; hold: boolean; turnId: string | null }>;
  /** A round is being written right now (the run lock is held). */
  writing: boolean;
  /** When the last reply finished: actions sent while the AI wrote count from here. */
  lastDoneAt: number | null;
  /** The last failed round: the action ids it held and why. */
  failed: { ids: string; code: string } | null;
  now: number;
};

export const roundActionKey = (ids: readonly string[]) => [...ids].sort().join(",");

/**
 * The round as everyone sees it, and whether it should go to the AI now.
 * Free mode sends when the countdown (from the round's first non-hold action,
 * or the last reply's end) runs out, or as soon as every online member has
 * acted or said ready. An untimed room (window 0) only does the latter. Hold actions never start it. Host mode never sends on
 * its own. A failed set of actions is not retried until it changes.
 */
export function decideRound(input: RoundInput): { round: StoryRoomRound; fire: boolean } {
  const { room, members, writing, now } = input;
  const windowMs = room.mergeWindowMs;
  const round = (status: StoryRoomRoundStatus, extra: Partial<StoryRoomRound> = {}) =>
    ({ round: { status, dueAt: null, windowMs, ...extra }, fire: false });
  if (room.status !== "open") return round("idle");
  if (writing) return round("writing");
  const open = input.actions;
  if (!open.length) return round("idle");
  if (input.failed && input.failed.ids === roundActionKey(open.map((a) => a.id))) {
    return round("failed", { failedCode: input.failed.code });
  }
  if (members.length < room.minSeats) return round("waiting", { need: { have: members.length, need: room.minSeats } });
  const armed = open.filter((a) => !a.hold);
  if (room.turnMode !== "free" || !armed.length) return round("held");
  const first = Math.min(...armed.map((a) => a.createdAt));
  // 不限时 (window 0): no due time, only "everyone is done" sends it.
  const dueAt = windowMs > 0 ? Math.max(first, input.lastDoneAt ?? 0) + windowMs : null;
  if (dueAt != null && now >= dueAt) return { round: { status: "counting", dueAt, windowMs }, fire: true };
  const acted = new Set(open.map((a) => a.userId));
  const online = members.filter((m) => m.online);
  if (online.length > 0 && online.every((m) => m.ready || acted.has(m.userId))) {
    return { round: { status: "counting", dueAt, windowMs }, fire: true };
  }
  return { round: { status: "counting", dueAt, windowMs }, fire: false };
}

// ── Roles ────────────────────────────────────────────────────────────────

export type StoryRoomRoleError = "role-required" | "unknown-role" | "role-taken";
export const ROLE_ERROR_STATUS: Record<StoryRoomRoleError, 400 | 409> = {
  "role-required": 400,
  "unknown-role": 400,
  "role-taken": 409,
};

/**
 * Which card role a member ends up with. `requested` undefined keeps the
 * current role (a join without a roleId); null drops it. Returns the role
 * (null = none) or why it is refused.
 */
export function roleDecision<R extends { id: string; name: string }>(input: {
  roles: readonly R[];
  rolesRequired: boolean;
  requested: string | null | undefined;
  holderOf: (roleId: string) => string | null | undefined;
  userId: string;
  currentRoleId: string | null;
}): { role: R | null } | { error: StoryRoomRoleError } {
  const explicit = input.requested !== undefined;
  const target = explicit ? input.requested : input.currentRoleId;
  const role = target ? input.roles.find((r) => r.id === target) ?? null : null;
  if (target && !role && explicit) return { error: "unknown-role" };
  // A kept role the card no longer lists counts as none.
  if (!role) return input.rolesRequired ? { error: "role-required" } : { role: null };
  const holder = input.holderOf(role.id);
  if (holder && holder !== input.userId) return { error: "role-taken" };
  return { role };
}

/** A card's raw settings.multiplayer, read for story rooms (roles only in story mode). */
export function storyRoomCard(raw: unknown) {
  const setting = normaliseMultiplayer(raw);
  const story = setting?.mode === "story";
  return {
    /** Story rooms open only on a card whose author turned on story multiplayer. */
    enabled: !!setting && story,
    minSeats: setting?.minSeats ?? 2,
    maxSeats: Math.min(setting?.maxSeats ?? STORY_ROOM_MAX_SEATS, STORY_ROOM_MAX_SEATS),
    roles: story ? setting.roles : [],
    rolesRequired: story ? setting.rolesRequired : false,
  };
}

// ── Adult gate ───────────────────────────────────────────────────────────

import { adultGateFailure, type AdultGateUser, type AdultGateReason } from "./adult-world-gate.js";
export { isAdultWorld, adultGateFailure, type AdultGateUser } from "./adult-world-gate.js";
export type AdultGateFailure = AdultGateReason;

/** Birth year on file and 18+, an adult content level, and not Limited-only. */
export function canJoinAdultWorld(account: AdultGateUser): boolean {
  return adultGateFailure(account) === null;
}

export async function loadAdultGateUser(userId: string): Promise<AdultGateUser | null> {
  const [row] = await db
    .select({
      birthYear: user.birthYear,
      contentLevel: sql<string | null>`${user.preferences}->>'contentLevel'`,
      limitedContentOnly: user.limitedContentOnly,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row ?? null;
}

// ── Blocks ───────────────────────────────────────────────────────────────

/** True when any block row (either direction) pairs `userId` with a member. */
export function hasBlockWithAny(
  userId: string,
  memberIds: readonly string[],
  blocks: ReadonlyArray<{ blockerId: string; blockedId: string }>,
): boolean {
  const others = new Set(memberIds.filter((id) => id !== userId));
  return blocks.some((b) =>
    (b.blockerId === userId && others.has(b.blockedId)) || (b.blockedId === userId && others.has(b.blockerId)),
  );
}

export async function isBlockedWithAnyMember(userId: string, memberIds: readonly string[]): Promise<boolean> {
  const others = memberIds.filter((id) => id !== userId);
  if (!others.length) return false;
  const rows = await db
    .select({ blockerId: userBlocks.blockerId, blockedId: userBlocks.blockedId })
    .from(userBlocks)
    .where(or(
      and(eq(userBlocks.blockerId, userId), inArray(userBlocks.blockedId, others)),
      and(eq(userBlocks.blockedId, userId), inArray(userBlocks.blockerId, others)),
    ));
  return hasBlockWithAny(userId, others, rows);
}

// ── Join decision ────────────────────────────────────────────────────────

export type StoryRoomJoinError = "closed" | "room-full" | "kicked" | "blocked" | AdultGateFailure;
export const JOIN_ERROR_STATUS: Record<StoryRoomJoinError, 403 | 409 | 410> = {
  closed: 410,
  "room-full": 409,
  kicked: 403,
  blocked: 403,
  "birth-year-required": 403,
  "adult-required": 403,
  "limited-content-only": 403,
};

export function joinDecision(input: {
  status: "open" | "closed";
  kicked: boolean;
  alreadyActive: boolean;
  activeCount: number;
  maxSeats: number;
  blocked: boolean;
  adultWorld: boolean;
  gate: AdultGateFailure | null;
}): StoryRoomJoinError | null {
  if (input.status !== "open") return "closed";
  if (input.kicked) return "kicked";
  if (input.blocked) return "blocked";
  // Limited-only accounts never enter an adult card's room; the rest of the
  // gate applies to adult cards only.
  if (input.adultWorld && input.gate) return input.gate;
  if (!input.alreadyActive && input.activeCount >= input.maxSeats) return "room-full";
  return null;
}

// ── Shared DB lookups ────────────────────────────────────────────────────

const activeMember = and(isNull(storyRoomMembers.leftAt), isNull(storyRoomMembers.kickedAt));

/** The open room on a session, or null. Never throws (a missing table reads as "no room"). */
export async function findOpenRoomForSession(sessionId: string) {
  try {
    const [room] = await db
      .select()
      .from(storyRooms)
      .where(and(eq(storyRooms.sessionId, sessionId), eq(storyRooms.status, "open")))
      .limit(1);
    return room ?? null;
  } catch {
    return null;
  }
}

/** Read-only access for an active, non-kicked member of an open room on this session. */
export async function canReadSessionAsRoomMember(sessionId: string, userId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ roomId: storyRooms.id })
      .from(storyRooms)
      .innerJoin(storyRoomMembers, eq(storyRoomMembers.roomId, storyRooms.id))
      .where(and(
        eq(storyRooms.sessionId, sessionId),
        eq(storyRooms.status, "open"),
        eq(storyRoomMembers.userId, userId),
        activeMember,
      ))
      .limit(1);
    return !!row;
  } catch {
    return false;
  }
}

/**
 * The host's 解除限制 prompts apply to a room turn only while every active
 * member passes canJoinAdultWorld. True = withhold them this turn.
 */
export async function roomWithholdsUnrestrict(sessionId: string): Promise<boolean> {
  try {
    const rows = await db
      .select({
        birthYear: user.birthYear,
        contentLevel: sql<string | null>`${user.preferences}->>'contentLevel'`,
        limitedContentOnly: user.limitedContentOnly,
      })
      .from(storyRooms)
      .innerJoin(storyRoomMembers, eq(storyRoomMembers.roomId, storyRooms.id))
      .innerJoin(user, eq(user.id, storyRoomMembers.userId))
      .where(and(eq(storyRooms.sessionId, sessionId), eq(storyRooms.status, "open"), activeMember));
    return rows.some((row) => !canJoinAdultWorld(row));
  } catch {
    return false;
  }
}

export function serializeRoom(row: typeof storyRooms.$inferSelect): StoryRoom {
  return {
    id: row.id,
    code: row.code,
    sessionId: row.sessionId,
    worldId: row.worldId,
    hostUserId: row.hostUserId,
    turnMode: row.turnMode === "host" ? "host" : "free",
    maxSeats: row.maxSeats,
    minSeats: row.minSeats,
    mergeWindowMs: row.mergeWindowMs,
    status: row.status === "closed" ? "closed" : "open",
    createdAt: row.createdAt.toISOString(),
    openToFriends: row.openToFriends === true,
    spendCap: row.spendCap ?? null,
    costMode: row.costMode === "split" ? "split" : "host",
    isPublic: row.isPublic === true,
  };
}

// ── Presence (ready / online) ────────────────────────────────────────────
// Redis when configured so every replica agrees; in-memory otherwise.

const ONLINE_TTL_MS = 90_000;
const PRESENCE_KEY_TTL_S = 12 * 60 * 60;
const memReady = new Map<string, Set<string>>();
const memOnline = new Map<string, Map<string, number>>();
const readyKey = (roomId: string) => `story-room:${roomId}:ready`;
const onlineKey = (roomId: string) => `story-room:${roomId}:online`;

export async function setReady(roomId: string, userId: string, ready: boolean): Promise<void> {
  if (redis) {
    try {
      if (ready) await redis.multi().sadd(readyKey(roomId), userId).expire(readyKey(roomId), PRESENCE_KEY_TTL_S).exec();
      else await redis.srem(readyKey(roomId), userId);
      return;
    } catch { /* fall through to memory */ }
  }
  const set = memReady.get(roomId) ?? new Set<string>();
  if (ready) set.add(userId); else set.delete(userId);
  if (set.size) memReady.set(roomId, set); else memReady.delete(roomId);
}

export async function clearReady(roomId: string): Promise<void> {
  memReady.delete(roomId);
  if (redis) await redis.del(readyKey(roomId)).catch(() => {});
}

export async function getReady(roomId: string): Promise<Set<string>> {
  if (redis) {
    try { return new Set(await redis.smembers(readyKey(roomId))); } catch { /* memory */ }
  }
  return new Set(memReady.get(roomId) ?? []);
}

export async function touchOnline(roomId: string, userId: string): Promise<void> {
  const now = Date.now();
  await markSeen(roomId, userId, now);
  if (redis) {
    try {
      await redis.multi().zadd(onlineKey(roomId), now, userId).expire(onlineKey(roomId), PRESENCE_KEY_TTL_S).exec();
      return;
    } catch { /* memory */ }
  }
  const map = memOnline.get(roomId) ?? new Map<string, number>();
  map.set(userId, now);
  memOnline.set(roomId, map);
}

export async function dropOnline(roomId: string, userId: string): Promise<void> {
  memOnline.get(roomId)?.delete(userId);
  await markSeen(roomId, userId, Date.now());
  if (redis) await redis.zrem(onlineKey(roomId), userId).catch(() => {});
}

// When each member was last there (online, or the moment they left): how long the host has been away.
const seenKey = (roomId: string) => `story-room:${roomId}:seen`;
const memSeen = new Map<string, Map<string, number>>();

export async function markSeen(roomId: string, userId: string, at = Date.now()): Promise<void> {
  const map = memSeen.get(roomId) ?? new Map<string, number>();
  map.set(userId, at);
  memSeen.set(roomId, map);
  if (redis) await redis.multi().hset(seenKey(roomId), userId, String(at)).expire(seenKey(roomId), PRESENCE_KEY_TTL_S).exec().catch(() => {});
}

export async function lastSeen(roomId: string, userId: string): Promise<number | null> {
  if (redis) {
    try {
      const v = await redis.hget(seenKey(roomId), userId);
      if (v) return Number(v) || null;
    } catch { /* memory */ }
  }
  return memSeen.get(roomId)?.get(userId) ?? null;
}

export async function forgetPresence(roomId: string): Promise<void> {
  memSeen.delete(roomId);
  memOnline.delete(roomId);
  if (redis) await redis.del(seenKey(roomId), onlineKey(roomId)).catch(() => {});
}

/** Whether the room should dissolve because its host left: away (not online) for longer than the grace. */
export function hostGone(input: { hostOnline: boolean; lastSeenAt: number | null; openedAt: number; now: number }): boolean {
  if (input.hostOnline) return false;
  const since = Math.max(input.lastSeenAt ?? 0, input.openedAt);
  return input.now - since > STORY_ROOM_HOST_AWAY_MS;
}

export async function getOnline(roomId: string): Promise<Set<string>> {
  const cutoff = Date.now() - ONLINE_TTL_MS;
  if (redis) {
    try { return new Set(await redis.zrangebyscore(onlineKey(roomId), cutoff, "+inf")); } catch { /* memory */ }
  }
  const map = memOnline.get(roomId);
  return new Set(map ? [...map].filter(([, at]) => at > cutoff).map(([id]) => id) : []);
}

// ── Room turns in the chat pipeline ──────────────────────────────────────

export type ResolvedRoomTurn = {
  roomId: string;
  turnId: string;
  content: string;
  contributions: StoryRoomContribution[];
  /** The [Players: ...] line leading `content`, when this turn carries one. */
  roster: string | null;
  /** Every claimed action already points at a message: only a retry may reuse it. */
  alreadySent: boolean;
  /** The host, and in a split room who acted and who agreed to share: how the reply is charged. */
  hostUserId: string;
  costMode: "host" | "split";
  actorIds: string[];
  splitAgreed: string[];
};

/**
 * Validates `roomTurnId` on a send: the caller hosts the open room on this
 * session and the turn was claimed (POST /:code/turn). Returns the merged
 * content the user message must carry.
 */
export async function resolveRoomTurn(
  sessionId: string,
  userId: string,
  turnId: unknown,
  opts: { retry: boolean },
): Promise<ResolvedRoomTurn | { error: string; code: string; status: 400 | 403 | 404 | 409 }> {
  if (typeof turnId !== "string" || !turnId || turnId.length > 100) {
    return { error: "Invalid roomTurnId", code: "invalid-turn", status: 400 };
  }
  const room = await findOpenRoomForSession(sessionId);
  if (!room) return { error: "No open room on this session", code: "room-not-found", status: 404 };
  if (room.hostUserId !== userId) return { error: "Only the host sends room turns", code: "not-host", status: 403 };
  const rows = await db
    .select({
      id: storyRoomActions.id,
      userId: storyRoomActions.userId,
      name: user.name,
      text: storyRoomActions.text,
      createdAt: storyRoomActions.createdAt,
      messageId: storyRoomActions.messageId,
      roster: storyRoomActions.roster,
      roleId: storyRoomMembers.roleId,
      roleName: storyRoomMembers.roleName,
      splitOk: storyRoomMembers.splitOk,
    })
    .from(storyRoomActions)
    .innerJoin(user, eq(user.id, storyRoomActions.userId))
    .leftJoin(storyRoomMembers, and(eq(storyRoomMembers.roomId, storyRoomActions.roomId), eq(storyRoomMembers.userId, storyRoomActions.userId)))
    .where(and(eq(storyRoomActions.roomId, room.id), eq(storyRoomActions.turnId, turnId)));
  if (!rows.length) return { error: "This turn was not claimed", code: "turn-not-found", status: 409 };
  const personas = await loadPlayerPersonas(rows.map((r) => r.userId));
  const alreadySent = rows.every((row) => row.messageId != null);
  if (alreadySent && !opts.retry) return { error: "This turn was already sent", code: "turn-already-sent", status: 409 };
  const pending = alreadySent ? rows : rows.filter((row) => row.messageId == null);
  // The same text POST /:code/turn showed: the claim stored its roster on every row.
  const roster = pending.find((row) => row.roster)?.roster ?? null;
  const merged = buildMergedTurn(pending.map((r) => ({ ...r, personaName: personas.get(r.userId)?.name ?? null })), roster);
  return {
    roomId: room.id,
    turnId,
    ...merged,
    roster,
    alreadySent,
    hostUserId: room.hostUserId,
    costMode: room.costMode === "split" ? "split" : "host",
    actorIds: [...new Set(pending.map((r) => r.userId))],
    splitAgreed: [...new Set(pending.filter((r) => r.splitOk).map((r) => r.userId))],
  };
}

/** Points the turn's claimed actions at the user message just written. Returns how many it claimed. */
export async function markRoomTurnSent(roomId: string, turnId: string, messageId: string): Promise<number> {
  const updated = await db
    .update(storyRoomActions)
    .set({ messageId })
    .where(and(eq(storyRoomActions.roomId, roomId), eq(storyRoomActions.turnId, turnId), isNull(storyRoomActions.messageId)))
    .returning();
  return updated.length;
}

// ── What the room has cost the host ──────────────────────────────────────

/**
 * Mushies the host was charged for this room's session over the last 24
 * hours (every reply and background step on it, since the room opened), for
 * the host's spend limit. A host on their own key pays nothing here.
 */
export async function roomSpend(room: { id: string; sessionId: string; createdAt: Date }, now = Date.now()): Promise<number> {
  return (await roomCostStats(room, now)).spent;
}

/**
 * What the room's rounds cost over the last 24 hours, whoever paid (the host's
 * charge and, in a split room, each player's share), and how many replies that
 * was: the per-round figure a split room shows before you join.
 */
export async function roomCostStats(room: { id: string; sessionId: string; createdAt: Date }, now = Date.now()): Promise<{ spent: number; rounds: number }> {
  const since = new Date(Math.max(now - STORY_ROOM_SPEND_WINDOW_MS, room.createdAt.getTime()));
  const result = await db.execute(sql`
    SELECT COALESCE(SUM(-ct.amount), 0)::float8 AS spent, COUNT(DISTINCT ul.id)::int AS rounds
    FROM usage_logs ul
    JOIN credit_transactions ct ON ct.type = 'usage' AND (
      ct.reference_id = ul.id
      OR ct.reference_id IN (SELECT ul.id || ':' || m.user_id FROM story_room_members m WHERE m.room_id = ${room.id}))
    WHERE ul.session_id = ${room.sessionId} AND ul.created_at >= ${since}`);
  const row = result.rows[0] as { spent?: unknown; rounds?: unknown } | undefined;
  const spent = Number(row?.spent ?? 0);
  const rounds = Number(row?.rounds ?? 0);
  return {
    spent: Number.isFinite(spent) && spent > 0 ? Math.round(spent * 10) / 10 : 0,
    rounds: Number.isFinite(rounds) ? rounds : 0,
  };
}

/** One share's ledger reference: the reply's usage log and who paid it. */
export const splitShareRef = (usageLogId: string, userId: string) => `${usageLogId}:${userId}`;

/**
 * How a split round's cost divides: an equal share for every distinct player
 * who acted in it. Shares of players who never agreed to split (they joined
 * before the host switched) stay with the host. Returns who owes what; the
 * host's part is the rest.
 */
export function splitShares(input: { cost: number; hostUserId: string; actorIds: readonly string[]; agreed: ReadonlySet<string> }): Array<{ userId: string; amount: number }> {
  const actors = [...new Set(input.actorIds)];
  if (!(input.cost > 0) || !actors.length) return [];
  const share = Math.floor((input.cost / actors.length) * 10) / 10;
  if (!(share > 0)) return [];
  return actors.filter((id) => id !== input.hostUserId && input.agreed.has(id)).map((userId) => ({ userId, amount: share }));
}

/** The limit is reached: the next round would go over what the host allowed. */
export function overSpendCap(spent: number, cap: number | null): boolean {
  return cap != null && spent >= cap;
}
