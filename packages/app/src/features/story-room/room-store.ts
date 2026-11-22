import { create } from "zustand";
import { confirmAction } from "@/components/ui/global-confirm-dialog";
import { feedback } from "@/lib/feedback";
import i18n from "@/lib/i18n";
import { RoomApiError, storyRoomApi, TALK_MAX_CHARS, ACTION_MAX_CHARS, type Room, type RoomSnapshot } from "./api";
import { joinErrorFix } from "./room-logic";
import { openStoryRoomInvite } from "./invite-sheet-store";

/**
 * The story room on the chat that is open right now, for whoever is in it:
 * the host (who owns the session) or a member (who reads it). The chat view
 * attaches it from the session load (`storyRoomCode`) or the join page; the
 * room controller keeps `snapshot` live from the room channel. The server
 * sends every round to the AI, so nobody's browser has to stay open for it.
 */
interface RoomStoreState {
  room: Room | null;
  role: "host" | "player" | null;
  snapshot: RoomSnapshot | null;
  opening: boolean;
  /** The 前情提要 panel under the room bar. */
  recapOpen: boolean;
  /** The card's screen carries the platform composer and its round strip
   *  (null = not reported yet). A card with its own full screen does not:
   *  the round then shows under the room bar. */
  composer: boolean | null;
  openForSession: (sessionId: string, opts?: { invite?: boolean; public?: boolean }) => Promise<void>;
  attach: (snapshot: RoomSnapshot) => void;
  attachByCode: (code: string, sessionId: string) => Promise<void>;
  detach: () => void;
  setSnapshot: (snapshot: RoomSnapshot) => void;
  setRecapOpen: (open: boolean) => void;
}

export const useRoomStore = create<RoomStoreState>()((set, get) => ({
  room: null,
  role: null,
  snapshot: null,
  opening: false,
  recapOpen: false,
  composer: null,

  openForSession: async (sessionId, opts) => {
    const current = get().room;
    if (current?.sessionId === sessionId && current.status === "open") {
      if (opts?.invite !== false) openStoryRoomInvite(current);
      return;
    }
    if (get().opening) return;
    set({ opening: true });
    try {
      let room = await storyRoomApi.create(sessionId);
      // Opened from the card page's 开一个公开房: list it for strangers right away.
      if (opts?.public) room = await storyRoomApi.update(room.code, { isPublic: true }).catch(() => room);
      set({ room, role: "host", snapshot: null });
      if (opts?.invite !== false) openStoryRoomInvite(room);
    } catch (err) {
      reportOpenFailure(err instanceof RoomApiError ? err.code : "");
    } finally {
      set({ opening: false });
    }
  },

  attach: (snapshot) => {
    if (!snapshot.me || snapshot.room.status !== "open") return;
    set({ room: snapshot.room, role: snapshot.me.role, snapshot });
  },

  attachByCode: async (code, sessionId) => {
    if (get().room?.code === code && get().room?.sessionId === sessionId) return;
    try {
      const snap = await storyRoomApi.get(code);
      if (snap.room.sessionId === sessionId) get().attach(snap);
    } catch {
      /* closed meanwhile: the chat simply has no room */
    }
  },

  detach: () => set({ room: null, role: null, snapshot: null, recapOpen: false, composer: null }),
  setSnapshot: (snapshot) => set({ snapshot, room: snapshot.room }),
  setRecapOpen: (recapOpen) => set({ recapOpen }),
}));

function reportOpenFailure(code: string) {
  if (code === "multiplayer-off") {
    feedback.error(i18n.t("common:storyRoom.notEnabled"));
    return;
  }
  // Adult cards gate the host too (same codes as join).
  const fix = joinErrorFix(code);
  if (fix.kind === "adult") {
    feedback.error(i18n.t("common:storyRoom.errAdult"), {
      label: i18n.t("common:storyRoom.contentSettings"),
      onClick: () => window.location.assign("/app/settings#content-safety"),
    });
  } else if (fix.kind === "birth-year") {
    feedback.error(i18n.t("common:storyRoom.errBirthYear"), {
      label: i18n.t("common:storyRoom.addBirthYear"),
      onClick: () => window.location.assign("/app/settings"),
    });
  } else {
    feedback.error(i18n.t("common:storyRoom.openFailed"));
  }
}

export type RoomSendOptions = { talk?: boolean; hold?: boolean };

function openRoomFor(sessionId: string | undefined): Room | null {
  const { room } = useRoomStore.getState();
  if (!sessionId || !room || room.sessionId !== sessionId || room.status !== "open") return null;
  return room;
}

/** Any send from this chat while a room is open on it (the composer, or a
 *  card's own UI calling api.sendMessage) joins the round as the sender's
 *  action instead of going to the AI; `talk` makes it a line for the players
 *  only, `hold` keeps the round's clock from starting. False when there is no
 *  room here, so the caller sends normally. */
export function routeSendToRoom(sessionId: string | undefined, text: string, opts?: RoomSendOptions): boolean {
  const room = openRoomFor(sessionId);
  if (!room) return false;
  const trimmed = text.trim();
  if (!trimmed) return true;
  const post = opts?.talk
    ? storyRoomApi.postTalk(room.code, trimmed.slice(0, TALK_MAX_CHARS))
    : storyRoomApi.postAction(room.code, trimmed.slice(0, ACTION_MAX_CHARS), { hold: opts?.hold === true });
  post.catch(async (err) => {
    const code = err instanceof RoomApiError ? err.code : "";
    // The host switched to splitting the cost: agree once, then the action goes.
    if (code === "split-consent-required") {
      const ok = await confirmAction(i18n.t("common:storyRoom.splitAsk"), {
        title: i18n.t("common:storyRoom.costSplit"),
        confirmLabel: i18n.t("common:storyRoom.splitAgree"),
      });
      if (!ok) return;
      try {
        await storyRoomApi.acceptSplit(room.code);
        routeSendToRoom(sessionId, text, opts);
      } catch {
        feedback.error(i18n.t("common:storyRoom.actionFailed"));
      }
      return;
    }
    feedback.error(
      i18n.t(
        code === "muted" ? "common:storyRoom.mutedPlaceholder"
          : code === "rate-limited" ? "common:storyRoom.tooFast"
            : code === "split-no-credits" ? "common:storyRoom.splitNoCredits"
              : "common:storyRoom.actionFailed",
      ),
    );
  });
  return true;
}

// ── "和好友一起玩" from a card page ─────────────────────────────────────
// The card page starts play like Play does; the chat that opens next opens
// the room and its invite sheet. The request expires so a cancelled picker
// never opens a room on some later chat.

const REQUEST_TTL_MS = 3 * 60_000;
let roomRequestAt = 0;
let roomRequestPublic = false;

/** `public`: the room opens as a public room (公开房) for anyone on the card page. */
export function requestRoomOnNextPlay(opts?: { public?: boolean }): void {
  roomRequestAt = Date.now();
  roomRequestPublic = opts?.public === true;
}

/** Whether the pending request asked for a public room; read before takeRoomRequest clears it. */
export function roomRequestIsPublic(): boolean {
  return roomRequestPublic;
}

export function takeRoomRequest(now = Date.now()): boolean {
  const fresh = roomRequestAt > 0 && now - roomRequestAt < REQUEST_TTL_MS;
  roomRequestAt = 0;
  if (!fresh) roomRequestPublic = false;
  return fresh;
}

/** 让 AI 接: the server sends the gathered round now. */
export async function sendRoomNow(sessionId: string | undefined): Promise<void> {
  const room = openRoomFor(sessionId);
  if (!room) return;
  try {
    await storyRoomApi.sendNow(room.code);
  } catch (err) {
    const code = err instanceof RoomApiError ? err.code : "";
    if (code === "nothing-to-send" || code === "busy" || code === "already-claimed") return;
    feedback.error(i18n.t(code === "waiting-for-players" ? "common:storyRoom.waitingForPlayers" : "common:storyRoom.sendFailed"));
  }
}

/** The round stopped at the spending limit: the host raises it one step and the round goes. */
export async function raiseRoomCapAndSend(sessionId: string | undefined, to: number | null): Promise<void> {
  const room = openRoomFor(sessionId);
  if (!room) return;
  try {
    await storyRoomApi.update(room.code, { spendCap: to });
  } catch {
    feedback.error(i18n.t("common:storyRoom.updateFailed"));
    return;
  }
  await sendRoomNow(sessionId);
}

// "正在写": at most one signal every few seconds while someone types.
const TYPING_EVERY_MS = 3_000;
let lastTypingAt = 0;

export function sendRoomTyping(sessionId: string | undefined, now = Date.now()): void {
  const room = openRoomFor(sessionId);
  if (!room || now - lastTypingAt < TYPING_EVERY_MS) return;
  lastTypingAt = now;
  storyRoomApi.typing(room.code).catch(() => {});
}
