/**
 * Story rooms: the HTTP surface (`/api/story-rooms`) and the shapes it speaks.
 * Every type the room UI depends on lives here so aligning with the server is
 * one file.
 *
 * Room SSE events (server routes/story-rooms.ts), folded by room-logic.ts:
 *   snapshot        RoomSnapshot
 *   member          { member, change: joined|online|offline|muted|unmuted|role } or { userId, change: left|kicked }
 *   action          { action }  (another player's text is empty until the round is sent)
 *   action-removed  { id }
 *   ready           { userId, ready }
 *   turn-start      { turnId, content, contributions, roster, actionIds }
 *   stream          { event, data }  (the chat send SSE, data already parsed)
 *   turn-done       { messageId, userMessageId, turnId, error?: true }
 *   room            { room }
 *   round           { round: RoundInfo }  (the server runs every round; this is its clock)
 *   talk            { line: TalkLine }    (table talk the AI never sees)
 *   typing          { userId }            (someone is writing an action)
 *   state           { variables, by }     (the card's screen changed the shared game; by = who)
 *   closed          { roomId, reason?: "closed" | "host-left" }; kicked { userId } (to that user). The stream ends after either.
 *
 * Errors are { error: code, code }: the join/create gate codes below, plus
 * multiplayer-off 403 (create: the card is not on in story mode),
 * not-found 404, not-member / not-host / muted 403, rate-limited 429,
 * nothing-to-send / already-claimed / waiting-for-players / busy / role-taken 409,
 * role-required / unknown-role 400, closed 410.
 */

const apiBase = import.meta.env.VITE_API_URL || "";

export type TurnMode = "free" | "host";
export type CostMode = "host" | "split";

export type Room = {
  id: string;
  code: string;
  sessionId: string;
  worldId: string;
  hostUserId: string;
  turnMode: TurnMode;
  minSeats: number;
  maxSeats: number;
  mergeWindowMs: number;
  /** The host's friends can find and join this room from the card page. */
  openToFriends?: boolean;
  /** Most the rounds may cost the host in any 24 hours (mushies); null = no limit. */
  spendCap?: number | null;
  /** host = the host pays; split = each round's players share its cost. */
  costMode?: CostMode;
  /** Listed on the card page for anyone to join. */
  isPublic?: boolean;
  status: "open" | "closed";
  createdAt: string;
};

export type Member = {
  userId: string;
  name: string;
  image: string | null;
  role: "host" | "player";
  mutedUntil: string | null;
  ready: boolean;
  online: boolean;
  roleId: string | null;
  roleName: string | null;
  /** Agreed to share the cost (always true for the host, and outside split rooms it is never asked). */
  splitOk?: boolean;
};

export type Action = {
  id: string;
  userId: string;
  name: string;
  text: string;
  createdAt: string;
  turnId: string | null;
  /** 「AI 先别接」: joins the round without starting its clock. */
  hold?: boolean;
};

/** 只给队友看: a line for the players only; the AI never sees it. */
export type TalkLine = { id: string; userId: string; name: string; text: string; createdAt: string };

export type RoundStatus = "idle" | "counting" | "held" | "writing" | "failed" | "waiting";

/** The server's view of the round being gathered (it sends every round to the AI). */
export type RoundInfo = {
  status: RoundStatus;
  /** Epoch ms the round goes out on its own, while counting. */
  dueAt: number | null;
  windowMs: number;
  failedCode?: string | null;
  need?: { have: number; need: number } | null;
};

/** What a player joining mid-story reads first. */
export type RoomRecap = { turns: number; summary: string | null; last: string | null };

export type RoomSessionInfo = {
  id: string;
  worldId: string;
  worldName: string | null;
  worldCover: string | null;
};

/** A playable role from the card's multiplayer setting; userId = who holds it now. */
export type RoomRole = { id: string; name: string; note?: string; userId: string | null; /** Its picture (CDN URL), when the author gave one. */ image?: string };

export type RoomSnapshot = {
  room: Room;
  members: Member[];
  me: { role: "host" | "player" } | null;
  pending: Action[];
  session: RoomSessionInfo;
  roles: RoomRole[];
  rolesRequired: boolean;
  talk: TalkLine[];
  round: RoundInfo;
  /** Members only; null before the first AI reply. */
  recap: RoomRecap | null;
  /** The host has told the server which model and settings run the rounds. */
  profileSet?: boolean;
  /** Host only: mushies this room cost over the last 24 hours. */
  spent?: number | null;
  /** Who pays, and what a round has cost lately (mushies; null before the first reply). */
  cost?: { mode: CostMode; perRound: number | null };
  /** Client-only: when each player last showed they were writing (epoch ms). */
  typing?: Record<string, number>;
};

/** The model and settings the server runs this room's rounds with (the host's own). */
export type SendProfile = {
  model: string;
  pool?: Array<{ model: string; weight: number }> | null;
  overrides: Record<string, unknown>;
  scene?: unknown;
};

/** An open room on this card a friend is in, which I may join. */
export type FriendRoom = { code: string; hostName: string; hostImage: string | null; friends?: Array<{ name: string; image: string | null }>; members: number; maxSeats: number };

/** A public room on this card with a free seat (公开房间). */
export type PublicRoom = {
  code: string;
  hostName: string;
  hostImage: string | null;
  members: number;
  maxSeats: number;
  online: number;
  costMode: CostMode;
  createdAt: string;
  lastReplyAt: string | null;
  people: Array<{ name: string; image: string | null }>;
};

export type Contribution = { userId: string; name: string; text: string; roleId?: string; roleName?: string };

export type JoinErrorCode =
  | "closed"
  | "room-full"
  | "kicked"
  | "blocked"
  | "birth-year-required"
  | "adult-required"
  | "limited-content-only"
  | "role-required"
  | "role-taken"
  | "unknown-role"
  | "split-consent-required";

export class RoomApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "RoomApiError";
  }
}

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(`${apiBase}/api/story-rooms${path}`, {
    method: init?.method ?? "GET",
    credentials: "include",
    headers: init?.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = (await res.json().catch(() => null)) as { data?: T; error?: unknown; code?: unknown } | null;
  if (!res.ok) {
    const code = typeof body?.code === "string" ? body.code : typeof body?.error === "string" ? body.error : String(res.status);
    throw new RoomApiError(code, res.status);
  }
  return body?.data as T;
}

const enc = encodeURIComponent;

export const storyRoomApi = {
  // No trailing slash: the server mounts the create route at /api/story-rooms exactly.
  create: (sessionId: string) => call<Room>("", { method: "POST", body: { sessionId } }),
  get: (code: string) => call<RoomSnapshot>(`/${enc(code)}`),
  join: (code: string, roleId?: string | null, opts?: { acceptSplit?: boolean }) =>
    call<RoomSnapshot>(`/${enc(code)}/join`, {
      method: "POST",
      body: { ...(roleId ? { roleId } : {}), ...(opts?.acceptSplit ? { acceptSplit: true } : {}) },
    }),
  /** A seated player agrees to share the cost (the host switched the room to split). */
  acceptSplit: (code: string) => call<Member>(`/${enc(code)}/split-ok`, { method: "POST", body: {} }),
  setRole: (code: string, roleId: string | null) => call<Member>(`/${enc(code)}/role`, { method: "POST", body: { roleId } }),
  leave: (code: string) => call<unknown>(`/${enc(code)}/leave`, { method: "POST", body: {} }),
  kick: (code: string, userId: string) => call<unknown>(`/${enc(code)}/kick`, { method: "POST", body: { userId } }),
  mute: (code: string, userId: string, minutes: number) =>
    call<unknown>(`/${enc(code)}/mute`, { method: "POST", body: { userId, minutes } }),
  close: (code: string) => call<unknown>(`/${enc(code)}/close`, { method: "POST", body: {} }),
  update: (code: string, patch: { turnMode?: TurnMode; mergeWindowMs?: number; openToFriends?: boolean; spendCap?: number | null; costMode?: CostMode; isPublic?: boolean }) =>
    call<Room>(`/${enc(code)}`, { method: "PATCH", body: patch }),
  invite: (code: string, userIds: string[]) =>
    call<{ sent?: number }>(`/${enc(code)}/invite`, { method: "POST", body: { userIds } }),
  postAction: (code: string, text: string, opts?: { hold?: boolean }) =>
    call<Action>(`/${enc(code)}/actions`, { method: "POST", body: { text, ...(opts?.hold ? { hold: true } : {}) } }),
  postTalk: (code: string, text: string) =>
    call<TalkLine>(`/${enc(code)}/actions`, { method: "POST", body: { text, kind: "talk" } }),
  withdrawAction: (code: string, actionId: string) =>
    call<unknown>(`/${enc(code)}/actions/${enc(actionId)}`, { method: "DELETE" }),
  setReady: (code: string, ready: boolean) => call<unknown>(`/${enc(code)}/ready`, { method: "POST", body: { ready } }),
  /** 让 AI 接: the server sends the round now. */
  sendNow: (code: string) => call<{ started: boolean }>(`/${enc(code)}/turn`, { method: "POST", body: {} }),
  typing: (code: string) => call<unknown>(`/${enc(code)}/typing`, { method: "POST", body: {} }),
  setProfile: (code: string, profile: SendProfile) =>
    call<unknown>(`/${enc(code)}/profile`, { method: "PUT", body: profile }),
  friendRooms: (worldId: string) => call<FriendRoom[]>(`/friends/${enc(worldId)}`),
  publicRooms: (worldId: string) => call<PublicRoom[]>(`/public/${enc(worldId)}`),
  eventsUrl: (code: string) => `${apiBase}/api/story-rooms/${enc(code)}/events`,
};

export function roomJoinPath(code: string): string {
  return `/app/room/${code}`;
}

export function roomJoinUrl(code: string): string {
  return `${window.location.origin}${roomJoinPath(code)}`;
}

export const ACTION_MAX_CHARS = 4000;
export const TALK_MAX_CHARS = 1000;
