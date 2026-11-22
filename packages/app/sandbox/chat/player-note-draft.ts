/**
 * 给 AI 的话 the player has open in the composer, shared by every way a turn
 * leaves the sandbox.
 *
 * The field lives in the composer, but a turn can start from many places: the
 * send button, a choice chip, a choice button in a reply, a card's own
 * interface (api.sendMessage), voice auto-send, continue, regenerate / a new
 * swipe, re-answering an edited line. Each of those used to go out without the
 * note while the field still showed it, so the player believed the AI had it.
 * Now the sandbox API takes the open note on every one of them (sandbox-context
 * buildAPI), so whichever path sends the turn, the note rides along once and the
 * field closes, the same lifecycle the send button always had: one turn, then
 * gone; put back if that turn fails.
 *
 * A regenerate with no open note sends none, and the server re-reads the note
 * stored with the turn (server lib/player-note.ts), so a swipe follows the same
 * direction. With a note open, that note replaces it.
 */
import { useEffect, useSyncExternalStore } from "react";

export const MAX_PLAYER_NOTE_CHARS = 500;

/** null = the field is closed. */
let draft: string | null = null;
/** Taken by the last send; put back if that send fails. */
let inFlight: string | null = null;
const listeners = new Set<() => void>();
const emit = () => { for (const fn of listeners) fn(); };

export function getNoteDraft(): string | null {
  return draft;
}

export function setNoteDraft(next: string | null | ((current: string | null) => string | null)): void {
  const value = typeof next === "function" ? next(draft) : next;
  if (value === draft) return;
  draft = value;
  emit();
}

export function subscribeNoteDraft(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

let fields = 0;

/**
 * The composer's field: [text or null when closed, setter]. The note closes
 * when the last composer showing it goes away, as it did when it was the
 * composer's own state.
 */
export function useNoteDraft(): [string | null, typeof setNoteDraft] {
  const value = useSyncExternalStore(subscribeNoteDraft, getNoteDraft, getNoteDraft);
  useEffect(() => {
    fields++;
    return () => { if (--fields === 0) setNoteDraft(null); };
  }, []);
  return [value, setNoteDraft];
}

/** A note as the server will take it, or undefined. */
export function cleanNote(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim().slice(0, MAX_PLAYER_NOTE_CHARS).trim();
  return text || undefined;
}

/**
 * The note a turn goes out with: the player's open note (taken: the field
 * closes, and it is kept until the send settles), joined with any note the
 * caller passed itself (a card's `options.note`). `take: false` when the send
 * will not go through anyway (streaming, read-only, a story room), so the open
 * note stays where it is.
 */
export function takeTurnNote(explicit?: unknown, take = true): string | undefined {
  const own = cleanNote(explicit);
  if (!take) return own;
  const open = cleanNote(draft);
  inFlight = open ?? null;
  // An empty field the player only just opened stays open.
  if (open) {
    draft = null;
    emit();
  }
  if (!open) return own;
  if (!own || own === open) return open;
  return cleanNote(`${open}\n\n${own}`);
}

/** The send that took the note failed: reopen the field with it, never over a note typed since. */
export function restoreTurnNote(): void {
  if (inFlight === null) return;
  const note = inFlight;
  inFlight = null;
  if (draft === null || !draft.trim()) {
    draft = note;
    emit();
  }
}

/** The send went through: forget what it took. */
export function settleTurnNote(): void {
  inFlight = null;
}

/** Tests only. */
export function __resetNoteDraft(): void {
  draft = null;
  inFlight = null;
  fields = 0;
  listeners.clear();
}

/**
 * What saving an edit to `messageId` asks the AI for (world-renderer runs it,
 * the sandbox reads it to know whether the edit sends a turn): a rewritten
 * player line owes a new answer; editing an AI reply never re-rolls anything.
 */
export function editReplyAction(
  messages: ReadonlyArray<{ id?: unknown; role?: unknown }> | null | undefined,
  messageId: string,
): { kind: "regenerate"; replyId: string } | { kind: "continue" } | null {
  const list = messages ?? [];
  const last = list[list.length - 1];
  const secondToLast = list[list.length - 2];
  if (last?.role === "assistant" && typeof last.id === "string" && secondToLast?.id === messageId && secondToLast.role === "user") {
    return { kind: "regenerate", replyId: last.id };
  }
  if (last?.id === messageId && last.role === "user") return { kind: "continue" };
  return null;
}
