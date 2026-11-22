import { readMultiplayer, type MultiplayerSettings } from "@yumina/shared";
import type { Action, Contribution, Member, Room, RoomRole, RoomSnapshot, RoundInfo, TalkLine } from "./api";

// ── The round clock (the server runs it) ───────────────────────────────

export const IDLE_ROUND: RoundInfo = { status: "idle", dueAt: null, windowMs: 0 };

const ROUND_STATUSES = new Set<RoundInfo["status"]>(["idle", "counting", "held", "writing", "failed", "waiting"]);

export function normaliseRound(raw: unknown, windowMs = 0): RoundInfo {
  if (!isObj(raw)) return { ...IDLE_ROUND, windowMs };
  const status = ROUND_STATUSES.has(raw.status as RoundInfo["status"]) ? (raw.status as RoundInfo["status"]) : "idle";
  const dueAt = typeof raw.dueAt === "number" && Number.isFinite(raw.dueAt) ? raw.dueAt : null;
  const need = isObj(raw.need) && typeof raw.need.have === "number" && typeof raw.need.need === "number"
    ? { have: raw.need.have, need: raw.need.need }
    : null;
  return {
    status,
    dueAt: status === "counting" ? dueAt : null,
    // 0 is a real window (不限时), not a missing one.
    windowMs: typeof raw.windowMs === "number" && raw.windowMs >= 0 ? raw.windowMs : windowMs,
    failedCode: status === "failed" && typeof raw.failedCode === "string" ? raw.failedCode : null,
    need: status === "waiting" ? need : null,
  };
}

/** How long a typing signal counts as "writing now". */
export const TYPING_TTL_MS = 5_000;

export function typingIds(typing: Record<string, number> | undefined, now: number, exclude?: string | null): string[] {
  if (!typing) return [];
  return Object.entries(typing)
    .filter(([id, at]) => id !== exclude && now - at < TYPING_TTL_MS)
    .sort((a, b) => a[1] - b[1])
    .map(([id]) => id);
}

/** 1 → just started waiting, 0 → due. */
export function countdownFraction(dueAt: number | null, windowMs: number, now: number): number {
  if (dueAt == null || windowMs <= 0) return 0;
  return Math.max(0, Math.min(1, (dueAt - now) / windowMs));
}

// ── Join errors → what the screen offers ───────────────────────────────

export type JoinFix =
  | { kind: "birth-year" }
  | { kind: "adult" }
  | { kind: "role"; key: "pickRole" | "roleTaken" }
  | { kind: "message"; key: "closed" | "full" | "kicked" | "blocked" | "failed" };

export function joinErrorFix(code: string): JoinFix {
  switch (code) {
    case "birth-year-required":
      return { kind: "birth-year" };
    case "adult-required":
    case "limited-content-only":
      return { kind: "adult" };
    case "role-required":
      return { kind: "role", key: "pickRole" };
    case "role-taken":
    case "unknown-role":
      return { kind: "role", key: "roleTaken" };
    case "closed":
    case "not-found":
    case "410":
    case "404":
      return { kind: "message", key: "closed" };
    case "room-full":
      return { kind: "message", key: "full" };
    case "kicked":
      return { kind: "message", key: "kicked" };
    case "blocked":
      return { kind: "message", key: "blocked" };
    default:
      return { kind: "message", key: "failed" };
  }
}

// ── Room channel reducer ───────────────────────────────────────────────

export type RoomView = {
  snapshot: RoomSnapshot | null;
  closed: boolean;
  kicked: boolean;
  /** Why it closed, when the live channel said: "host-left" = the host was gone past the grace. */
  closedReason?: string | null;
};

export const EMPTY_ROOM_VIEW: RoomView = { snapshot: null, closed: false, kicked: false };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function pick<T>(data: unknown, key: string): T | null {
  if (!isObj(data)) return null;
  const inner = data[key];
  return (isObj(inner) ? inner : data) as T;
}

function sortByTime<T extends { createdAt: string }>(actions: T[]): T[] {
  return [...actions].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

const TALK_KEEP = 60;

export function normaliseSnapshot(snap: RoomSnapshot): RoomSnapshot {
  return withRoleHolders({
    ...snap,
    members: (snap.members ?? []).map((m) => ({ ...m, roleId: m.roleId ?? null, roleName: m.roleName ?? null })),
    pending: sortByTime((snap.pending ?? []).map((a) => ({ ...a, hold: a.hold === true }))),
    roles: snap.roles ?? [],
    rolesRequired: snap.rolesRequired === true,
    talk: sortByTime(Array.isArray(snap.talk) ? snap.talk : []).slice(-TALK_KEEP),
    round: normaliseRound(snap.round, snap.room?.mergeWindowMs ?? 0),
    recap: snap.recap ?? null,
    typing: snap.typing ?? {},
  });
}

/** Who holds each role follows the member list, so a role event needs no second fetch. */
function withRoleHolders(snap: RoomSnapshot): RoomSnapshot {
  if (!snap.roles?.length) return snap;
  const holder = new Map(snap.members.filter((m) => m.roleId).map((m) => [m.roleId!, m.userId]));
  return { ...snap, roles: snap.roles.map((r) => ({ ...r, userId: holder.get(r.id) ?? null })) };
}

export function applyRoomEvent(view: RoomView, event: string, data: unknown, now = Date.now()): RoomView {
  if (event === "snapshot") {
    const snap = data as RoomSnapshot;
    if (!snap?.room) return view;
    return { snapshot: normaliseSnapshot(snap), closed: snap.room.status === "closed", kicked: false };
  }
  if (event === "closed") {
    const reason = data && typeof data === "object" && typeof (data as Obj).reason === "string" ? ((data as Obj).reason as string) : null;
    return { ...view, closed: true, closedReason: reason, snapshot: view.snapshot && { ...view.snapshot, room: { ...view.snapshot.room, status: "closed" } } };
  }
  if (event === "kicked") return { ...view, kicked: true };

  const snap = view.snapshot;
  if (!snap) return view;

  switch (event) {
    case "member": {
      const d = isObj(data) ? data : {};
      const m = pick<Partial<Member> & { userId?: string }>(data, "member");
      if (!m?.userId) return view;
      const gone = d.change === "left" || d.change === "kicked";
      const rest = snap.members.filter((x) => x.userId !== m.userId);
      if (gone) return { ...view, snapshot: withRoleHolders({ ...snap, members: rest }) };
      const prev = snap.members.find((x) => x.userId === m.userId);
      const next: Member = {
        userId: m.userId,
        name: m.name ?? prev?.name ?? "",
        image: m.image ?? prev?.image ?? null,
        role: m.role ?? prev?.role ?? "player",
        mutedUntil: m.mutedUntil !== undefined ? m.mutedUntil : (prev?.mutedUntil ?? null),
        ready: m.ready ?? prev?.ready ?? false,
        online: m.online ?? prev?.online ?? true,
        roleId: m.roleId !== undefined ? m.roleId : (prev?.roleId ?? null),
        roleName: m.roleName !== undefined ? m.roleName : (prev?.roleName ?? null),
        splitOk: m.splitOk ?? prev?.splitOk,
      };
      const members = prev ? snap.members.map((x) => (x.userId === m.userId ? next : x)) : [...snap.members, next];
      return { ...view, snapshot: withRoleHolders({ ...snap, members }) };
    }
    case "action": {
      const a = pick<Action>(data, "action");
      if (!a?.id) return view;
      const pending = sortByTime([...snap.pending.filter((x) => x.id !== a.id), { ...a, turnId: a.turnId ?? null, hold: a.hold === true }]);
      // Their line landed: they are no longer "writing".
      const typing = { ...(snap.typing ?? {}) };
      delete typing[a.userId];
      return { ...view, snapshot: { ...snap, pending, typing } };
    }
    case "talk": {
      const line = pick<TalkLine>(data, "line");
      if (!line?.id || typeof line.text !== "string") return view;
      const talk = sortByTime([...(snap.talk ?? []).filter((x) => x.id !== line.id), line]).slice(-TALK_KEEP);
      return { ...view, snapshot: { ...snap, talk } };
    }
    case "typing": {
      const d = isObj(data) ? data : {};
      const userId = d.userId as string | undefined;
      if (!userId) return view;
      return { ...view, snapshot: { ...snap, typing: { ...(snap.typing ?? {}), [userId]: now } } };
    }
    case "round": {
      const raw = isObj(data) && isObj(data.round) ? data.round : data;
      return { ...view, snapshot: { ...snap, round: normaliseRound(raw, snap.room.mergeWindowMs) } };
    }
    case "action-removed": {
      const d = isObj(data) ? data : {};
      const id = (d.id ?? d.actionId) as string | undefined;
      if (!id) return view;
      return { ...view, snapshot: { ...snap, pending: snap.pending.filter((x) => x.id !== id) } };
    }
    case "ready": {
      const d = isObj(data) ? data : {};
      const userId = d.userId as string | undefined;
      if (!userId) return view;
      const members = snap.members.map((m) => (m.userId === userId ? { ...m, ready: Boolean(d.ready) } : m));
      return { ...view, snapshot: { ...snap, members } };
    }
    case "turn-start": {
      const d = isObj(data) ? data : {};
      const turnId = (d.turnId as string | undefined) ?? "turn";
      const ids = Array.isArray(d.actionIds) ? new Set(d.actionIds as string[]) : null;
      const pending = snap.pending.map((a) => (!a.turnId && (!ids || ids.has(a.id)) ? { ...a, turnId } : a));
      // A new round: everyone's ready flag starts over.
      const members = snap.members.map((m) => ({ ...m, ready: false }));
      const round: RoundInfo = { ...(snap.round ?? IDLE_ROUND), status: "writing", dueAt: null, failedCode: null };
      return { ...view, snapshot: { ...snap, pending, members, round } };
    }
    case "turn-done": {
      const d = isObj(data) ? data : {};
      // A failed send leaves the round unsent: its actions go back in the pool
      // and the next /turn claims them again.
      if (d.error === true) {
        const turnId = d.turnId as string | undefined;
        const pending = snap.pending.map((a) => (a.turnId && (!turnId || a.turnId === turnId) ? { ...a, turnId: null } : a));
        return { ...view, snapshot: { ...snap, pending } };
      }
      return { ...view, snapshot: { ...snap, pending: snap.pending.filter((a) => !a.turnId) } };
    }
    case "room": {
      const r = pick<Partial<Room>>(data, "room");
      if (!r) return view;
      const room = { ...snap.room, ...r };
      return { ...view, closed: room.status === "closed" || view.closed, snapshot: { ...snap, room } };
    }
    default:
      return view;
  }
}

// ── Live reply (members) ───────────────────────────────────────────────

export type LiveReply = { active: boolean; content: string; failed: boolean };

export const IDLE_REPLY: LiveReply = { active: false, content: "", failed: false };

/** `stream` carries the chat send SSE verbatim ({event, data}); the same
 *  event names lib/sse.ts handles. */
export function applyStreamEvent(live: LiveReply, payload: unknown): LiveReply {
  if (!isObj(payload)) return live;
  const event = payload.event as string | undefined;
  const data = isObj(payload.data) ? payload.data : {};
  switch (event) {
    case "text":
      return { active: true, failed: false, content: (live.active ? live.content : "") + String(data.content ?? "") };
    case "done":
      return { active: false, failed: false, content: typeof data.content === "string" ? data.content : live.content };
    case "error":
      return { active: false, failed: true, content: live.content };
    case "reasoning":
    case "segment":
    case "bg":
      return live.active ? live : { active: true, failed: false, content: "" };
    default:
      return live;
  }
}

/** Split a merged room turn back into who said what. Prefers the stored
 *  contributions; falls back to the `[Name]: text` lines. */
export function splitContributions(
  content: string,
  contributions?: ReadonlyArray<{ name: string; text: string }> | null,
): Array<{ name: string | null; text: string }> {
  if (contributions && contributions.length > 0) return contributions.map((c) => ({ name: c.name, text: c.text }));
  const lines = content.split("\n");
  const out: Array<{ name: string | null; text: string }> = [];
  for (const line of lines) {
    const m = /^\[([^\]\n]{1,80})\]:\s?(.*)$/.exec(line);
    if (m) out.push({ name: m[1]!, text: m[2] ?? "" });
    else if (out.length > 0) out[out.length - 1]!.text += `\n${line}`;
    else out.push({ name: null, text: line });
  }
  return out;
}

// ── Invites ────────────────────────────────────────────────────────────

/** The room a `room_invite` points at: its code, or the `/app/room/<code>` join link. */
export function roomInviteCode(payload: Record<string, unknown>): string | null {
  const code = payload.code ?? payload.roomCode;
  if (typeof code === "string" && /^[A-Za-z0-9]{4,12}$/.test(code)) return code.toUpperCase();
  const url = payload.joinUrl;
  const match = typeof url === "string" ? /^\/app\/room\/([A-Za-z0-9]{4,12})(?:[/?#]|$)/.exec(url) : null;
  return match ? match[1]!.toUpperCase() : null;
}

// ── Card setting ───────────────────────────────────────────────────────

/** The card's multiplayer setting when friends can share a chat on it (story mode), else null. */
export function storyRoomSetting(world: Parameters<typeof readMultiplayer>[0]): MultiplayerSettings | null {
  const mp = readMultiplayer(world);
  return mp?.mode === "story" ? mp : null;
}

/** "2–6", or "4" when the card fixes the count. */
export function seatRange(mp: Pick<MultiplayerSettings, "minSeats" | "maxSeats">): string {
  return mp.minSeats === mp.maxSeats ? String(mp.maxSeats) : `${mp.minSeats}–${mp.maxSeats}`;
}

// ── Roles ──────────────────────────────────────────────────────────────

export type RoleChoice = RoomRole & {
  holder: Pick<Member, "userId" | "name" | "image"> | null;
  mine: boolean;
  free: boolean;
};

export function roleChoices(roles: readonly RoomRole[], members: readonly Member[], meId: string | null): RoleChoice[] {
  return roles.map((role) => {
    const held = role.userId ? members.find((m) => m.userId === role.userId) ?? null : null;
    const mine = !!meId && role.userId === meId;
    return {
      ...role,
      holder: held ? { userId: held.userId, name: held.name, image: held.image } : null,
      mine,
      free: !role.userId || mine,
    };
  });
}

// ── The round being gathered ───────────────────────────────────────────

export type RoundState = {
  /** Who has an action in this round, in the order they acted. */
  actedIds: string[];
  /** My newest action that can still be withdrawn. */
  mine: Action | null;
  /** Below the card's minimum: how many are here and how many it needs. */
  waiting: { have: number; need: number } | null;
  /** A round is on its way to the AI (claimed, not written yet). */
  sending: boolean;
};

export function roundState(input: {
  room: { minSeats?: number };
  members: readonly Member[];
  pending: readonly Action[];
  meId: string | null;
}): RoundState {
  const actedIds: string[] = [];
  for (const a of input.pending) if (!actedIds.includes(a.userId)) actedIds.push(a.userId);
  const mineOpen = input.pending.filter((a) => a.userId === input.meId && !a.turnId);
  const need = input.room.minSeats ?? 0;
  return {
    actedIds,
    mine: mineOpen.length ? mineOpen[mineOpen.length - 1]! : null,
    waiting: input.members.length < need ? { have: input.members.length, need } : null,
    sending: input.pending.some((a) => !!a.turnId),
  };
}

// ── Rules tables (rooms a card's own UI hosts) ─────────────────────────

const TABLE_CODE = /^[A-Za-z0-9]{4,12}$/;

/** Where a friend lands to sit at a rules table: the card's page carrying the table code. */
export function tableInvitePath(worldId: string, roomId: string): string | null {
  const code = roomId.startsWith("rules:") ? roomId.slice("rules:".length) : "";
  if (!worldId || !TABLE_CODE.test(code)) return null;
  return `/app/hub/${encodeURIComponent(worldId)}?table=${code.toUpperCase()}`;
}

export function parseTableCode(raw: unknown): string | null {
  return typeof raw === "string" && TABLE_CODE.test(raw) ? raw.toUpperCase() : null;
}

// ── A member's chat mirrors the host's turn ────────────────────────────

type MirrorMessage = {
  id: string;
  sessionId: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  contributions?: Contribution[] | null;
};

export type MirrorState = {
  messages: MirrorMessage[];
  isStreaming: boolean;
  streamingContent: string;
  streamingReasoning: string;
  gameState: Record<string, unknown>;
};

export const ROOM_TURN_MESSAGE_PREFIX = "__room_";

/**
 * What a member's chat store does with one room frame: the round shows as the
 * players' bubbles the moment the host claims it, the reply streams in as it
 * does for the host, and the saved history replaces both once the turn is
 * written (`refresh`). Null = nothing to change.
 */
export function mirrorRoomEvent(
  state: MirrorState,
  name: string,
  data: unknown,
  sessionId: string,
  now = new Date(),
): { patch: Partial<MirrorState>; refresh?: boolean } | null {
  const d = isObj(data) ? data : {};
  switch (name) {
    case "turn-start": {
      const turnId = typeof d.turnId === "string" ? d.turnId : "turn";
      const id = `${ROOM_TURN_MESSAGE_PREFIX}${turnId}`;
      const contributions = Array.isArray(d.contributions) ? (d.contributions as Contribution[]) : [];
      const message: MirrorMessage = {
        id,
        sessionId,
        role: "user",
        content: typeof d.content === "string" ? d.content : contributions.map((c) => c.text).join("\n"),
        createdAt: now.toISOString(),
        contributions,
      };
      return {
        patch: {
          messages: [...state.messages.filter((m) => m.id !== id), message],
          isStreaming: true,
          streamingContent: "",
          streamingReasoning: "",
        },
      };
    }
    case "stream": {
      const event = d.event;
      const payload = isObj(d.data) ? d.data : {};
      if (event === "text" && typeof payload.content === "string") {
        return { patch: { isStreaming: true, streamingContent: state.streamingContent + payload.content } };
      }
      if (event === "reasoning" && typeof payload.content === "string") {
        return { patch: { isStreaming: true, streamingReasoning: state.streamingReasoning + payload.content } };
      }
      if (event === "done") {
        const vars = isObj(payload.state) && isObj(payload.state.variables) ? payload.state.variables : null;
        return vars ? { patch: { gameState: vars } } : null;
      }
      return null;
    }
    case "turn-done": {
      if (d.error === true) {
        return {
          patch: {
            messages: state.messages.filter((m) => !m.id.startsWith(ROOM_TURN_MESSAGE_PREFIX)),
            isStreaming: false,
            streamingContent: "",
            streamingReasoning: "",
          },
        };
      }
      return { patch: {}, refresh: true };
    }
    default:
      return null;
  }
}

/**
 * A `state` frame (someone pressed something on the card's screen): the chat
 * store's variables as they now stand. My own press is already on my screen
 * (and its answer lands there), so it is skipped. Null = nothing to change.
 */
export function roomStatePatch(
  chat: { gameState: Record<string, unknown>; session: { state?: Record<string, unknown> | null } | null },
  data: unknown,
  meId: string | null,
): { gameState: Record<string, unknown>; session: unknown } | null {
  const d = isObj(data) ? data : {};
  if (!isObj(d.variables)) return null;
  if (meId && d.by === meId) return null;
  const variables = d.variables as Record<string, unknown>;
  return {
    gameState: variables,
    session: chat.session ? { ...chat.session, state: { ...(chat.session.state ?? {}), variables } } : chat.session,
  };
}

// ── What the chat sandbox sees of the room ─────────────────────────────

/** Mirrors sandbox/protocol.ts StoryRoomChannelData (the sandbox cannot import app code). */
export type StoryRoomUI = {
  isHost: boolean;
  meId: string;
  turnMode: "free" | "host";
  people: Record<string, { name: string; image: string | null; roleName: string | null }>;
  actedIds: string[];
  /** Acted with 「AI 先别接」 only. */
  heldIds: string[];
  mine: { id: string; text: string } | null;
  waiting: { have: number; need: number } | null;
  round: { status: RoundInfo["status"]; dueAt: number | null; windowMs: number; failedCode: string | null };
  meReady: boolean;
  /** Online players who acted or said 我好了, out of everyone online. */
  doneCount: number;
  onlineCount: number;
  /** 让 AI 接 is mine to press. */
  canSendNow: boolean;
  /** The round stopped at the host's spending limit and the host can raise it
   *  one step (`to`: the new limit, null = no limit). Null for everyone else. */
  raiseCap: { to: number | null } | null;
  /** When each other player last showed they were writing (epoch ms). */
  typingAt: Record<string, number>;
  talk: TalkLine[];
};

/** The limits a host picks from, in mushies per 24 hours (null = no limit). */
export const ROOM_SPEND_CAPS = [1_000, 5_000, 20_000, null] as const;

/** The next limit up from `cap`: undefined when there is none (already no limit). */
export function nextSpendCap(cap: number | null): number | null | undefined {
  if (cap == null) return undefined;
  for (const step of ROOM_SPEND_CAPS) if (step == null || step > cap) return step;
  return null;
}

export function storyRoomUI(snap: RoomSnapshot, meId: string, isHost: boolean): StoryRoomUI {
  const { room, members, pending } = snap;
  const round = roundState({ room, members, pending, meId });
  const people: StoryRoomUI["people"] = {};
  // A player's picture is the role they play when it has art, else their own.
  const roleArt = new Map((snap.roles ?? []).filter((r) => r.image).map((r) => [r.id, r.image!]));
  for (const m of members) people[m.userId] = { name: m.name, image: (m.roleId && roleArt.get(m.roleId)) || m.image, roleName: m.roleName ?? null };
  const open = pending.filter((a) => !a.turnId);
  const heldIds = round.actedIds.filter((id) => {
    const theirs = open.filter((a) => a.userId === id);
    return theirs.length > 0 && theirs.every((a) => a.hold);
  });
  const online = members.filter((m) => m.online);
  const doneCount = online.filter((m) => m.ready || open.some((a) => a.userId === m.userId)).length;
  const info = snap.round ?? IDLE_ROUND;
  const writing = info.status === "writing" || round.sending;
  const typingAt = { ...(snap.typing ?? {}) };
  delete typingAt[meId];
  const waiting = info.status === "waiting" ? info.need ?? round.waiting : round.waiting;
  const capped = !writing && info.status === "failed" && info.failedCode === "spend-cap";
  const raiseTo = nextSpendCap(room.spendCap === undefined ? 5_000 : room.spendCap);
  return {
    isHost,
    meId,
    turnMode: room.turnMode,
    people,
    actedIds: round.actedIds,
    heldIds,
    mine: round.mine ? { id: round.mine.id, text: round.mine.text } : null,
    waiting,
    round: {
      status: writing ? "writing" : info.status,
      dueAt: writing ? null : info.dueAt,
      windowMs: info.windowMs || room.mergeWindowMs,
      failedCode: info.failedCode ?? null,
    },
    meReady: members.find((m) => m.userId === meId)?.ready ?? false,
    doneCount,
    onlineCount: online.length,
    // At the limit a retry would only stop again: the host raises it instead.
    canSendNow: open.length > 0 && !writing && !waiting && !capped && (room.turnMode === "free" || isHost),
    raiseCap: capped && isHost && raiseTo !== undefined ? { to: raiseTo } : null,
    typingAt,
    talk: snap.talk ?? [],
  };
}
