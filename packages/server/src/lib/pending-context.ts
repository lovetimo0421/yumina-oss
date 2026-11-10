import type { GameStateManager } from "@yumina/engine";

/** One-shot context ("tell the AI") waiting for the player's next message. */
export type PendingContext = { message: string; role: string };

/** A clock behaviour can keep adding while nobody sends a message; keep the
 *  newest ones rather than letting the list grow without end. */
const MAX_PENDING_CONTEXT = 20;

/** Add one-shot context after whatever is already waiting. Every writer used
 *  to replace the list, so two button presses before the next message kept
 *  only the second button's words. */
export function appendPendingContext(manager: GameStateManager, messages: PendingContext[]): void {
  if (messages.length === 0) return;
  const waiting = manager.getSnapshot().metadata?.pendingContext;
  const prior = Array.isArray(waiting) ? (waiting as PendingContext[]) : [];
  manager.setMetadata("pendingContext", [...prior, ...messages].slice(-MAX_PENDING_CONTEXT));
}
