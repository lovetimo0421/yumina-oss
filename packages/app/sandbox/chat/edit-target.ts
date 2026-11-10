/**
 * Which swipe an inline edit is aimed at.
 *
 * Swiping is server-mediated: the counter and the bubble only change once the
 * swipe request comes back. An edit opened inside that window used to copy the
 * OLD swipe's text into the edit box, the swipe then landed underneath it, and
 * saving wrote that stale text into the NEW active swipe — overwriting the
 * version the player was looking at (launch QA, 2026-09-25).
 *
 * The rules this module encodes:
 *   - no edit may open while a swipe switch for that message is in flight;
 *   - an open edit remembers the swipe it was opened on;
 *   - if the displayed swipe changes under an open edit, an untouched draft
 *     follows the new swipe, a touched draft is abandoned (never retargeted);
 *   - the save names the swipe, so the server can refuse a mismatch.
 */

export interface EditableMessage {
  id: string;
  content: string;
  activeSwipeIndex?: number;
  swipes?: ReadonlyArray<unknown>;
}

export interface EditTarget {
  messageId: string;
  /** The active swipe when the edit opened; null for rows without variants. */
  swipeIndex: number | null;
  /** The text the edit box was seeded with. */
  baseContent: string;
}

export function swipeIndexOf(message: EditableMessage): number | null {
  return Array.isArray(message.swipes) && message.swipes.length > 0
    ? (message.activeSwipeIndex ?? 0)
    : null;
}

export function canStartEdit(messageId: string, swipingIds: ReadonlySet<string>): boolean {
  return !swipingIds.has(messageId);
}

export function editTargetFor(message: EditableMessage): EditTarget {
  return { messageId: message.id, swipeIndex: swipeIndexOf(message), baseContent: message.content };
}

export type EditReconcile =
  | { action: "keep" }
  | { action: "reseed"; target: EditTarget; draft: string }
  | { action: "cancel" };

/** Decide what an open edit does when the message under it changes. */
export function reconcileEditTarget(
  target: EditTarget,
  message: EditableMessage | undefined,
  draft: string,
): EditReconcile {
  if (!message || message.id !== target.messageId) return { action: "cancel" };
  const swipeIndex = swipeIndexOf(message);
  if (swipeIndex === target.swipeIndex && message.content === target.baseContent) {
    return { action: "keep" };
  }
  // The row now holds exactly what the player typed (their own save echoing
  // back): adopt it quietly.
  if (swipeIndex === target.swipeIndex && message.content === draft) {
    return { action: "reseed", target: editTargetFor(message), draft };
  }
  // Nothing typed yet: follow what is on screen now.
  if (draft === target.baseContent) {
    return { action: "reseed", target: editTargetFor(message), draft: message.content };
  }
  return { action: "cancel" };
}
