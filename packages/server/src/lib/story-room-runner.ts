import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { friendInvites, storyRoomActions, storyRoomMembers, storyRooms, user } from "../db/schema.js";
import { internalActorHeaders } from "./internal-actor.js";
import { publishRoomEvent } from "./room-manager.js";
import { redis } from "./redis.js";
import {
  TRANSIENT_ROUND_FAILURES,
  buildMergedTurn,
  buildRosterLine,
  loadPlayerPersonas,
  clearReady,
  decideRound,
  forgetPresence,
  getOnline,
  hostGone,
  lastSeen,
  STORY_ROOM_PUBLIC_SEAT_IDLE_MS,
  getReady,
  overSpendCap,
  roomSpend,
  roundActionKey,
  storyRoomChannel,
  storyRoomJoinUrl,
  type StoryRoomContribution,
  type StoryRoomRound,
} from "./story-rooms.js";

/**
 * The server sends a story room's rounds, as the host. A round goes to the AI
 * when its countdown runs out, when everyone online has acted, or when someone
 * asks for it (lib/story-rooms.ts decideRound). The send is the ordinary chat
 * send (routes/messages.ts) run in this process with the host as the actor
 * (lib/internal-actor.ts), carrying the host's registered model and settings
 * (PUT /:code/profile), so billing, keys, prompts and the room tee are exactly
 * a host send's. Nobody's browser has to stay open.
 *
 * Several replicas may look at the same room: a run lock (Redis, else memory)
 * lets one of them send; the others see "writing". Timers are per process and
 * a slow sweep picks rooms up again after a restart.
 */

type RoomRow = typeof storyRooms.$inferSelect;
type Fetcher = { fetch: (request: Request) => Response | Promise<Response> };

let app: Fetcher | null = null;
let sweeper: NodeJS.Timeout | null = null;
const timers = new Map<string, { at: number; timer: NodeJS.Timeout }>();
const evaluating = new Map<string, Promise<void>>();
const lastRound = new Map<string, string>();

const RUN_TTL_MS = 6 * 60_000;
const RUN_REFRESH_MS = 60_000;
const STATE_TTL_S = 12 * 60 * 60;
const TRANSIENT_RETRY_MS = 10_000;
const SWEEP_MS = 15_000;

/** Wires the app the runner sends through and starts the sweep. Call once at boot. */
export function registerStoryRoomRunner(target: Fetcher, opts: { sweep?: boolean } = {}): void {
  app = target;
  if (opts.sweep !== false && !sweeper) {
    sweeper = setInterval(() => void sweep().catch((e) => console.warn("[StoryRoomRunner] sweep failed", errMsg(e))), SWEEP_MS);
    sweeper.unref?.();
  }
}

export function stopStoryRoomRunner(): void {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
  for (const { timer } of timers.values()) clearTimeout(timer);
  timers.clear();
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const publish = (roomId: string, event: string, payload: Record<string, unknown>) =>
  publishRoomEvent(storyRoomChannel(roomId), event, payload).catch(() => {});

// ── Shared per-room state (Redis when configured, else this process) ──────

const runKey = (id: string) => `story-room:${id}:run`;
const doneKey = (id: string) => `story-room:${id}:done`;
const failKey = (id: string) => `story-room:${id}:failed`;
const memRun = new Map<string, { token: string; until: number }>();
const memDone = new Map<string, number>();
const memFail = new Map<string, FailRecord>();

type FailRecord = { ids: string; code: string; retryAt?: number };

async function acquireRun(roomId: string, token: string): Promise<boolean> {
  if (redis) {
    try {
      return (await redis.set(runKey(roomId), token, "PX", RUN_TTL_MS, "NX")) === "OK";
    } catch { /* memory */ }
  }
  const held = memRun.get(roomId);
  if (held && held.until > Date.now()) return false;
  memRun.set(roomId, { token, until: Date.now() + RUN_TTL_MS });
  return true;
}

async function refreshRun(roomId: string, token: string): Promise<void> {
  if (redis) {
    try {
      if ((await redis.get(runKey(roomId))) === token) await redis.pexpire(runKey(roomId), RUN_TTL_MS);
      return;
    } catch { /* memory */ }
  }
  const held = memRun.get(roomId);
  if (held?.token === token) held.until = Date.now() + RUN_TTL_MS;
}

async function releaseRun(roomId: string, token: string): Promise<void> {
  if (redis) {
    try {
      if ((await redis.get(runKey(roomId))) === token) await redis.del(runKey(roomId));
      return;
    } catch { /* memory */ }
  }
  if (memRun.get(roomId)?.token === token) memRun.delete(roomId);
}

export async function isRoundRunning(roomId: string): Promise<boolean> {
  if (redis) {
    try { return (await redis.exists(runKey(roomId))) === 1; } catch { /* memory */ }
  }
  const held = memRun.get(roomId);
  return !!held && held.until > Date.now();
}

async function readDone(roomId: string): Promise<number | null> {
  if (redis) {
    try {
      const v = await redis.get(doneKey(roomId));
      return v ? Number(v) || null : null;
    } catch { /* memory */ }
  }
  return memDone.get(roomId) ?? null;
}

async function writeDone(roomId: string, at: number): Promise<void> {
  memDone.set(roomId, at);
  if (redis) await redis.set(doneKey(roomId), String(at), "EX", STATE_TTL_S).catch(() => {});
}

async function readFail(roomId: string): Promise<FailRecord | null> {
  if (redis) {
    try {
      const v = await redis.get(failKey(roomId));
      return v ? (JSON.parse(v) as FailRecord) : null;
    } catch { /* memory */ }
  }
  return memFail.get(roomId) ?? null;
}

async function writeFail(roomId: string, record: FailRecord | null): Promise<void> {
  if (record) memFail.set(roomId, record); else memFail.delete(roomId);
  if (!redis) return;
  if (record) await redis.set(failKey(roomId), JSON.stringify(record), "EX", STATE_TTL_S).catch(() => {});
  else await redis.del(failKey(roomId)).catch(() => {});
}

// ── Reading a room ────────────────────────────────────────────────────────

async function loadRoomRow(roomId: string): Promise<RoomRow | null> {
  const [row] = await db.select().from(storyRooms).where(eq(storyRooms.id, roomId)).limit(1);
  return row ?? null;
}

const activeMember = and(isNull(storyRoomMembers.leftAt), isNull(storyRoomMembers.kickedAt));

async function loadSeats(roomId: string) {
  const [rows, ready, online] = await Promise.all([
    db
      .select({ userId: storyRoomMembers.userId, name: user.name, roleId: storyRoomMembers.roleId, roleName: storyRoomMembers.roleName })
      .from(storyRoomMembers)
      .innerJoin(user, eq(user.id, storyRoomMembers.userId))
      .where(and(eq(storyRoomMembers.roomId, roomId), activeMember))
      .orderBy(asc(storyRoomMembers.joinedAt)),
    getReady(roomId),
    getOnline(roomId),
  ]);
  return rows.map((r) => ({ ...r, roleName: r.roleId ? r.roleName : null, ready: ready.has(r.userId), online: online.has(r.userId) }));
}

async function loadOpenActions(roomId: string) {
  return db
    .select({ id: storyRoomActions.id, userId: storyRoomActions.userId, createdAt: storyRoomActions.createdAt, hold: storyRoomActions.hold, turnId: storyRoomActions.turnId })
    .from(storyRoomActions)
    .where(and(eq(storyRoomActions.roomId, roomId), eq(storyRoomActions.kind, "action"), isNull(storyRoomActions.messageId)));
}

/** The round as it stands, from the shared state. */
export async function computeRound(room: RoomRow, now = Date.now()): Promise<{ round: StoryRoomRound; fire: boolean }> {
  const [members, actions, writing, lastDoneAt, failRecord] = await Promise.all([
    loadSeats(room.id),
    loadOpenActions(room.id),
    isRoundRunning(room.id),
    readDone(room.id),
    readFail(room.id),
  ]);
  const failed = failRecord && !(failRecord.retryAt && now >= failRecord.retryAt) ? failRecord : null;
  return decideRound({
    room,
    members,
    actions: actions.map((a) => ({ ...a, createdAt: a.createdAt.getTime() })),
    writing,
    lastDoneAt,
    failed,
    now,
  });
}

// ── Claiming a round ──────────────────────────────────────────────────────

export type ClaimedRound = {
  turnId: string;
  content: string;
  contributions: StoryRoomContribution[];
  roster: string | null;
  actionIds: string[];
};

/** Claims every unsent round action into one turn and announces it. Re-claims a failed turn's actions. */
export async function claimRoomRound(room: RoomRow): Promise<ClaimedRound | { error: "waiting-for-players" | "nothing-to-send" }> {
  const members = await loadSeats(room.id);
  if (members.length < room.minSeats) return { error: "waiting-for-players" };
  // The AI hears who is at the table on the first turn and whenever that
  // changed since the last turn it actually got.
  const personas = await loadPlayerPersonas(members.map((m) => m.userId));
  const line = buildRosterLine(members.map((m) => ({ ...m, persona: personas.get(m.userId) ?? null })));
  const [lastSent] = await db
    .select({ roster: storyRoomActions.roster })
    .from(storyRoomActions)
    .where(and(eq(storyRoomActions.roomId, room.id), isNotNull(storyRoomActions.messageId), isNotNull(storyRoomActions.roster)))
    .orderBy(desc(storyRoomActions.createdAt), desc(storyRoomActions.id))
    .limit(1);
  const roster = lastSent?.roster === line ? null : line;
  const turnId = crypto.randomUUID();
  const claimed = await db
    .update(storyRoomActions)
    .set({ turnId, roster })
    .where(and(eq(storyRoomActions.roomId, room.id), eq(storyRoomActions.kind, "action"), isNull(storyRoomActions.messageId)))
    .returning();
  if (!claimed.length) return { error: "nothing-to-send" };
  const rows = await db
    .select({
      id: storyRoomActions.id,
      userId: storyRoomActions.userId,
      name: user.name,
      text: storyRoomActions.text,
      createdAt: storyRoomActions.createdAt,
      roleId: storyRoomMembers.roleId,
      roleName: storyRoomMembers.roleName,
    })
    .from(storyRoomActions)
    .innerJoin(user, eq(user.id, storyRoomActions.userId))
    .leftJoin(storyRoomMembers, and(eq(storyRoomMembers.roomId, storyRoomActions.roomId), eq(storyRoomMembers.userId, storyRoomActions.userId)))
    .where(and(eq(storyRoomActions.roomId, room.id), eq(storyRoomActions.turnId, turnId), isNull(storyRoomActions.messageId)));
  const { content, contributions } = buildMergedTurn(rows.map((r) => ({ ...r, personaName: personas.get(r.userId)?.name ?? null })), roster);
  await clearReady(room.id);
  const actionIds = rows.map((r) => r.id);
  await publish(room.id, "turn-start", { turnId, content, contributions, roster, actionIds });
  return { turnId, content, contributions, roster, actionIds };
}

// ── The host's send settings ──────────────────────────────────────────────

export type SendProfile = {
  model: string | null;
  pool: Array<{ model: string; weight: number }> | null;
  overrides: Record<string, number | string | boolean>;
  scene?: unknown;
};

const NUMBER_OVERRIDES = [
  "maxTokens", "maxContext", "storyMemory", "temperature", "topP", "frequencyPenalty",
  "presencePenalty", "repetitionPenalty", "topK", "minP",
] as const;
const PROFILE_MAX_BYTES = 32 * 1024;

/** What PUT /:code/profile may store: the fields a host's own send carries, nothing else. */
export function sanitizeSendProfile(raw: unknown): SendProfile | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (JSON.stringify(o).length > PROFILE_MAX_BYTES) return null;
  const model = typeof o.model === "string" && o.model.length > 0 && o.model.length <= 200 ? o.model : null;
  const pool = Array.isArray(o.pool)
    ? o.pool
        .slice(0, 24)
        .filter((p): p is { model: string; weight: number } =>
          !!p && typeof p === "object" && typeof (p as any).model === "string" && (p as any).model.length <= 200
          && typeof (p as any).weight === "number" && Number.isFinite((p as any).weight) && (p as any).weight > 0)
        .map((p) => ({ model: p.model, weight: p.weight }))
    : [];
  const overrides: SendProfile["overrides"] = {};
  const src = o.overrides && typeof o.overrides === "object" && !Array.isArray(o.overrides) ? (o.overrides as Record<string, unknown>) : {};
  for (const key of NUMBER_OVERRIDES) {
    const v = src[key];
    if (typeof v === "number" && Number.isFinite(v)) overrides[key] = v;
  }
  if (typeof src.recapShare === "string" && src.recapShare.length <= 40) overrides.recapShare = src.recapShare;
  if (typeof src.reasoningEffort === "string" && src.reasoningEffort.length <= 20) overrides.reasoningEffort = src.reasoningEffort;
  if (typeof src.streaming === "boolean") overrides.streaming = src.streaming;
  return { model, pool: pool.length > 1 ? pool : null, overrides, ...(o.scene !== undefined && o.scene !== null ? { scene: o.scene } : {}) };
}

export function pickProfileModel(profile: SendProfile | null, random = Math.random): string | undefined {
  if (profile?.pool?.length) {
    const total = profile.pool.reduce((sum, p) => sum + p.weight, 0);
    let roll = random() * total;
    for (const p of profile.pool) {
      roll -= p.weight;
      if (roll <= 0) return p.model;
    }
    return profile.pool[profile.pool.length - 1]!.model;
  }
  return profile?.model ?? undefined;
}

// ── Running a round ───────────────────────────────────────────────────────

/** Reads a send's answer to the end; returns the error code it carried, if any. */
async function drainSend(res: Response): Promise<string | null> {
  const type = res.headers.get("content-type") ?? "";
  if (!type.includes("text/event-stream")) {
    const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
    if (res.ok) return null;
    return typeof body?.code === "string" ? body.code : res.status === 429 ? "RATE_LIMIT" : "error";
  }
  if (!res.body) return null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let code: string | null = null;
  const scan = (block: string) => {
    if (!/^event: ?error$/m.test(block)) return;
    const data = /^data: ?(.*)$/m.exec(block)?.[1];
    try {
      const parsed = data ? (JSON.parse(data) as { code?: unknown }) : null;
      code = typeof parsed?.code === "string" ? parsed.code : "error";
    } catch {
      code = "error";
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf("\n\n");
    while (cut >= 0) {
      scan(buffer.slice(0, cut));
      buffer = buffer.slice(cut + 2);
      cut = buffer.indexOf("\n\n");
    }
  }
  if (buffer.trim()) scan(buffer);
  return code;
}

export type RoundRequestResult = { started: true } | { error: "busy" | "nothing-to-send" | "waiting-for-players" | "not-ready" | "spend-cap" };

/** The code a round fails with when the host's 24-hour limit for the room is used up. */
export const SPEND_CAP_CODE = "spend-cap";

/**
 * Sends the round now if nobody else is. `manual` = someone asked
 * (让 AI 接): it goes even before the countdown and retries a failed set.
 * Resolves once the round is claimed; the reply keeps streaming after.
 */
export async function runRound(roomId: string, opts: { manual?: boolean } = {}): Promise<RoundRequestResult> {
  if (!app) return { error: "not-ready" };
  const token = crypto.randomUUID();
  if (!(await acquireRun(roomId, token))) return { error: "busy" };
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await releaseRun(roomId, token);
  };
  try {
    const room = await loadRoomRow(roomId);
    if (!room || room.status !== "open") {
      await release();
      return { error: "nothing-to-send" };
    }
    if (!opts.manual) {
      // Re-check under the lock: another replica may have just sent it.
      const { fire } = await computeRoundIgnoringLock(room);
      if (!fire) {
        await release();
        void evaluateRoom(roomId);
        return { error: "nothing-to-send" };
      }
    }
    // The host's limit for this room: nothing goes out past it, whoever asks.
    if (room.spendCap != null && overSpendCap(await roomSpend(room), room.spendCap)) {
      const open = await loadOpenActions(roomId);
      await writeFail(roomId, { ids: roundActionKey(open.map((a) => a.id)), code: SPEND_CAP_CODE });
      await release();
      void evaluateRoom(roomId);
      return { error: SPEND_CAP_CODE };
    }
    await publishRound(roomId, { status: "writing", dueAt: null, windowMs: room.mergeWindowMs });
    const claim = await claimRoomRound(room);
    if ("error" in claim) {
      await release();
      void evaluateRoom(roomId);
      return { error: claim.error };
    }
    void sendClaimed(room, claim, token, release);
    return { started: true };
  } catch (error) {
    await release();
    console.warn("[StoryRoomRunner] round failed to start", errMsg(error));
    void evaluateRoom(roomId);
    return { error: "not-ready" };
  }
}

/** computeRound as if the lock this caller holds were not there. */
async function computeRoundIgnoringLock(room: RoomRow) {
  const [members, actions, lastDoneAt, failRecord] = await Promise.all([
    loadSeats(room.id), loadOpenActions(room.id), readDone(room.id), readFail(room.id),
  ]);
  const now = Date.now();
  const failed = failRecord && !(failRecord.retryAt && now >= failRecord.retryAt) ? failRecord : null;
  return decideRound({ room, members, actions: actions.map((a) => ({ ...a, createdAt: a.createdAt.getTime() })), writing: false, lastDoneAt, failed, now });
}

async function sendClaimed(room: RoomRow, claim: ClaimedRound, token: string, release: () => Promise<void>) {
  const keepAlive = setInterval(() => void refreshRun(room.id, token), RUN_REFRESH_MS);
  keepAlive.unref?.();
  let code: string | null = null;
  try {
    const profile = sanitizeSendProfile(room.sendProfile);
    const body = {
      roomTurnId: claim.turnId,
      ...(pickProfileModel(profile) ? { model: pickProfileModel(profile) } : {}),
      overrides: profile?.overrides ?? {},
      ...(profile?.scene !== undefined ? { scene: profile.scene } : {}),
    };
    const request = new Request(`http://story-room.internal/api/sessions/${encodeURIComponent(room.sessionId)}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "yumina-story-room-runner",
        ...internalActorHeaders(room.hostUserId, "story-room-round"),
      },
      body: JSON.stringify(body),
    });
    code = await drainSend(await app!.fetch(request));
  } catch (error) {
    console.warn("[StoryRoomRunner] send failed", errMsg(error));
    code = "error";
  } finally {
    clearInterval(keepAlive);
  }
  try {
    // The round counts as sent once its user message was written, even if
    // the reply then failed (the host can regenerate it like any reply).
    const [unsent] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(storyRoomActions)
      .where(and(eq(storyRoomActions.roomId, room.id), eq(storyRoomActions.turnId, claim.turnId), isNull(storyRoomActions.messageId)));
    if ((unsent?.n ?? 0) > 0) {
      const failCode = code ?? "error";
      const transient = TRANSIENT_ROUND_FAILURES.has(failCode);
      await writeFail(room.id, {
        ids: roundActionKey(claim.actionIds),
        code: failCode,
        ...(transient ? { retryAt: Date.now() + TRANSIENT_RETRY_MS } : {}),
      });
      // The send may have failed before the chat send ever saw the turn (so
      // it never announced the end): end it for everyone. A repeat is harmless.
      await publish(room.id, "turn-done", { messageId: null, userMessageId: null, turnId: claim.turnId, error: true, code: failCode });
    } else {
      await writeFail(room.id, null);
    }
    await writeDone(room.id, Date.now());
  } finally {
    await release();
    void evaluateRoom(room.id);
  }
}

// ── Scheduling ────────────────────────────────────────────────────────────

async function publishRound(roomId: string, round: StoryRoomRound) {
  const key = JSON.stringify(round);
  if (lastRound.get(roomId) === key) return;
  lastRound.set(roomId, key);
  await publish(roomId, "round", { round });
}

function setTimer(roomId: string, at: number) {
  const existing = timers.get(roomId);
  if (existing && existing.at === at) return;
  if (existing) clearTimeout(existing.timer);
  const timer = setTimeout(() => {
    timers.delete(roomId);
    void evaluateRoom(roomId);
  }, Math.max(50, at - Date.now() + 50));
  timer.unref?.();
  timers.set(roomId, { at, timer });
}

function clearTimer(roomId: string) {
  const existing = timers.get(roomId);
  if (existing) clearTimeout(existing.timer);
  timers.delete(roomId);
}

/**
 * Looks at a room after anything that can move its round (an action, ready,
 * someone coming or going, a reply ending) and acts: send, count down, or wait.
 * Coalesces overlapping calls; never throws.
 */
export function evaluateRoom(roomId: string): Promise<void> {
  const running = evaluating.get(roomId);
  if (running) return running.then(() => evaluateOnce(roomId));
  const next = evaluateOnce(roomId).finally(() => evaluating.delete(roomId));
  evaluating.set(roomId, next);
  return next;
}

async function evaluateOnce(roomId: string): Promise<void> {
  try {
    const room = await loadRoomRow(roomId);
    if (!room || room.status !== "open") {
      clearTimer(roomId);
      lastRound.delete(roomId);
      return;
    }
    const failRecord = await readFail(roomId);
    const { round, fire } = await computeRound(room);
    await publishRound(roomId, round);
    if (fire) {
      clearTimer(roomId);
      void runRound(roomId);
      return;
    }
    if (round.status === "counting" && round.dueAt) setTimer(roomId, round.dueAt);
    else if (round.status === "failed" && failRecord?.retryAt) setTimer(roomId, failRecord.retryAt);
    else clearTimer(roomId);
  } catch (error) {
    console.warn("[StoryRoomRunner] evaluate failed", errMsg(error));
  }
}

/** The round as it stands, for a snapshot. */
export async function currentRound(room: RoomRow): Promise<StoryRoomRound> {
  try {
    return (await computeRound(room)).round;
  } catch {
    return { status: "idle", dueAt: null, windowMs: room.mergeWindowMs };
  }
}

/** The host changed something that may unblock a failed round (the spend limit): let it go again. */
export async function clearRoundFailure(roomId: string): Promise<void> {
  await writeFail(roomId, null);
}

/** Forgets a closed room's per-room state. */
export async function forgetRoom(roomId: string): Promise<void> {
  clearTimer(roomId);
  lastRound.delete(roomId);
  memDone.delete(roomId);
  memFail.delete(roomId);
  if (redis) await redis.del(doneKey(roomId), failKey(roomId)).catch(() => {});
}

/**
 * Closes an open room: pending invites die, everyone's page hears `closed`
 * (with why: the host closed it, or the host left). Safe to call twice: only
 * the call that flips it announces it.
 */
export async function closeStoryRoom(room: RoomRow, reason: "closed" | "host-left" = "closed"): Promise<RoomRow> {
  const [closed] = await db
    .update(storyRooms)
    .set({ status: "closed", closedAt: new Date() })
    .where(and(eq(storyRooms.id, room.id), eq(storyRooms.status, "open")))
    .returning();
  if (!closed) return { ...room, status: "closed" };
  const revoked = await db
    .update(friendInvites)
    .set({ status: "revoked", respondedAt: new Date() })
    .where(and(eq(friendInvites.joinUrl, storyRoomJoinUrl(room.code)), eq(friendInvites.status, "pending")))
    .returning();
  // Their invite cards turn to "No longer open" now, not on the next poll.
  for (const invite of revoked) {
    publishRoomEvent(`user:${invite.toUserId}`, "friend_invite_changed", { inviteId: invite.id }).catch(() => {});
  }
  await clearReady(room.id);
  await forgetRoom(room.id);
  await publishRoomEvent(storyRoomChannel(room.id), "closed", { roomId: room.id, reason }).catch(() => {});
  await forgetPresence(room.id);
  return closed;
}

/** Open rooms whose host has been gone past the grace dissolve, as a game does when its host quits. */
async function dissolveAbandoned(now = Date.now()): Promise<void> {
  const open = await db.select().from(storyRooms).where(eq(storyRooms.status, "open")).limit(1000);
  for (const room of open) {
    const online = await getOnline(room.id);
    const gone = hostGone({
      hostOnline: online.has(room.hostUserId),
      lastSeenAt: await lastSeen(room.id, room.hostUserId),
      openedAt: room.createdAt.getTime(),
      now,
    });
    if (gone) {
      await closeStoryRoom(room, "host-left").catch((e) => console.warn("[StoryRoomRunner] dissolve failed", errMsg(e)));
      continue;
    }
    if (room.isPublic) await releaseIdleSeats(room, online, now).catch((e) => console.warn("[StoryRoomRunner] seat release failed", errMsg(e)));
  }
}

/** A public room gives a stranger's seat back once they have been gone a while, so the room stays joinable. */
async function releaseIdleSeats(room: RoomRow, online: Set<string>, now: number): Promise<void> {
  const seated = await db
    .select({ userId: storyRoomMembers.userId, joinedAt: storyRoomMembers.joinedAt })
    .from(storyRoomMembers)
    .where(and(eq(storyRoomMembers.roomId, room.id), activeMember, sql`${storyRoomMembers.role} <> 'host'`));
  let released = false;
  for (const m of seated) {
    if (online.has(m.userId)) continue;
    const since = Math.max((await lastSeen(room.id, m.userId)) ?? 0, m.joinedAt.getTime());
    if (now - since <= STORY_ROOM_PUBLIC_SEAT_IDLE_MS) continue;
    await db
      .update(storyRoomMembers)
      .set({ leftAt: new Date(), roleId: null, roleName: null })
      .where(and(eq(storyRoomMembers.roomId, room.id), eq(storyRoomMembers.userId, m.userId), isNull(storyRoomMembers.leftAt)));
    await publishRoomEvent(storyRoomChannel(room.id), "member", { userId: m.userId, change: "left" }).catch(() => {});
    released = true;
  }
  if (released) void evaluateRoom(room.id);
}

/** After a restart (or on a replica that never saw the action): rooms with unsent actions get looked at. */
async function sweep(): Promise<void> {
  await dissolveAbandoned();
  const rows = await db
    .selectDistinct({ roomId: storyRoomActions.roomId })
    .from(storyRoomActions)
    .innerJoin(storyRooms, eq(storyRooms.id, storyRoomActions.roomId))
    .where(and(isNull(storyRoomActions.messageId), eq(storyRoomActions.kind, "action"), eq(storyRooms.status, "open")))
    .limit(500);
  for (const { roomId } of rows) {
    if (!timers.has(roomId) && !evaluating.has(roomId)) await evaluateRoom(roomId);
  }
}
