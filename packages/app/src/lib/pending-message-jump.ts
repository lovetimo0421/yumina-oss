// "Open this save at message #N": the save picker's search hands a jump to
// whichever WorldRenderer shows that session — one already on screen, or the
// one the navigation is about to mount. WorldRenderer passes it to the sandbox
// (protocol "jump-to-message"), which loads history up to the message and
// scrolls there like the in-story search (sandbox/chat/search-jump.ts).

export interface MessageJump {
  sessionId: string;
  messageId: string;
  /** 1-based place in the session, for the page budget. */
  position: number;
  /** The search, so a card without the platform transcript can show the hit. */
  query: string;
}

/** Window event: a jump was requested; a mounted renderer may take it. */
export const MESSAGE_JUMP_REQUEST_EVENT = "yumina:request-message-jump";
/** A jump nobody took (navigation failed, card closed) goes stale. */
const JUMP_TTL_MS = 60_000;

let pending: (MessageJump & { at: number }) | null = null;

export function requestMessageJump(jump: MessageJump): void {
  pending = { ...jump, at: Date.now() };
  try {
    window.dispatchEvent(new CustomEvent(MESSAGE_JUMP_REQUEST_EVENT));
  } catch {
    // No window (tests): the renderer takes it when it mounts.
  }
}

/** The pending jump for `sessionId`, removed once taken. */
export function takeMessageJump(sessionId: string | null | undefined): MessageJump | null {
  if (!pending || !sessionId) return null;
  if (Date.now() - pending.at > JUMP_TTL_MS) { pending = null; return null; }
  if (pending.sessionId !== sessionId) return null;
  const { messageId, position, query } = pending;
  pending = null;
  return { sessionId, messageId, position, query };
}
