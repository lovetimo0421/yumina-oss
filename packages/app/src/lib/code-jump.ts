// ── Jump-to-line handoff ─────────────────────────────────────────────
//
// "Open the code at this line" has to survive the code panel not existing
// yet: the shell opens that panel in response to the same gesture, so an
// event dispatched at that moment lands before there is a listener. The
// request is parked here instead and claimed on mount — a mailbox, not a
// broadcast.
//
// It sits in lib rather than beside the panel because the senders are not all
// in the Studio: the module page in the normal editor asks for the same jump,
// and the normal editor may not import the experimental canvas.

let pendingJump: { file: string; line: number } | null = null;

export function setPendingCodeJump(file: string, line: number) {
  pendingJump = { file, line };
}

/** Read without consuming — the initial file choice needs to know the target
 *  before the effect that acts on it runs. Consuming here instead would drain
 *  the mailbox during render and throw the line number away with it. */
export function peekPendingCodeJump(): { file: string; line: number } | null {
  return pendingJump;
}

export function takePendingCodeJump(): { file: string; line: number } | null {
  const jump = pendingJump;
  pendingJump = null;
  return jump;
}
