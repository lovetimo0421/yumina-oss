/**
 * 给 AI 的话 — a one-turn direction from the player to the story AI
 * ("slow down", "let her speak first").
 *
 * It rides on a send as `note`, is stored on the turn's user message (or, for
 * a note sent with no message, on the reply it asked for), and goes into that
 * turn's prompt only. It is never story text: history, the recap and session
 * memory read `content`, which the note is not part of. Regenerating the turn
 * (or retrying a failed send of it) reads it back from the row, so a swipe
 * follows the same direction, unless the request brings a note of its own: the
 * one the player has open in the composer now. That one replaces the stored
 * note (resolveTurnNote) and is saved where the old one lived (turnNoteRowId).
 */

export const MAX_PLAYER_NOTE_CHARS = 500;

/** Whatever the client sent, as a note fit for a prompt, or null. */
export function normalizePlayerNote(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return null;
  return text.slice(0, MAX_PLAYER_NOTE_CHARS);
}

/**
 * The prompt block. English instructions, the player's own words inside.
 *
 * Sent as a user turn, not a system message: a system message after the chat
 * is not read where it sits. Gemini and Claude (OpenRouter, and our own
 * google.ts / anthropic.ts) lift every system message into the system prompt
 * above the whole story, and most DeepSeek V3.2 hosts ignored it; as a
 * user turn all of them read it last, next to the player's message (probed on
 * OpenRouter 2026-11-20; Soleria on Discord: "the LLM doesn't acknowledge it at all").
 */
export function playerNoteMessage(note: string): { role: "user"; content: string } {
  return {
    role: "user",
    content: [
      "[Out-of-character direction from the player, for this reply only. Follow it in how you write this reply. It is not something anyone in the story said or did: do not quote it, mention it, or answer it out of character.]",
      note,
    ].join("\n"),
  };
}

/**
 * The note a regenerated reply follows: the one stored on the reply itself (a
 * note sent with no message), else the one on the player's message right
 * before it.
 */
export function turnPlayerNote(
  target: { playerNote?: string | null },
  preceding: { role: string; playerNote?: string | null } | null | undefined,
): string | null {
  return normalizePlayerNote(target.playerNote)
    ?? (preceding?.role === "user" ? normalizePlayerNote(preceding.playerNote) : null);
}

/**
 * The note a re-run of a turn (regenerate, a retried send) follows: the one the
 * request brought, else the one stored with the turn. `replaced` = the request's
 * note differs from the stored one, so the row should take it.
 */
export function resolveTurnNote(
  sent: unknown,
  stored: string | null | undefined,
): { note: string | null; replaced: boolean } {
  const fresh = normalizePlayerNote(sent);
  const kept = normalizePlayerNote(stored);
  if (fresh === null) return { note: kept, replaced: false };
  return { note: fresh, replaced: fresh !== kept };
}

/**
 * Where a regenerated reply's replacement note is saved, mirroring
 * turnPlayerNote: the reply itself if the note already lived there (a note sent
 * with no message), else the player's message right before it, else the reply.
 */
export function turnNoteRowId(
  target: { id: string; playerNote?: string | null },
  preceding: { id: string; role: string } | null | undefined,
): string {
  if (normalizePlayerNote(target.playerNote)) return target.id;
  return preceding?.role === "user" ? preceding.id : target.id;
}
