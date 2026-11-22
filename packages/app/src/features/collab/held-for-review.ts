import { feedback } from "@/lib/feedback";
import i18n from "@/lib/i18n";

/**
 * A change to a published card that waits for review (an editor without the
 * creator's leave to publish): the server says `heldForReview`, and the
 * change shows up for players only with the next submission.
 */
export function noteHeldForReview(data: unknown): void {
  if (!data || typeof data !== "object" || (data as { heldForReview?: unknown }).heldForReview !== true) return;
  feedback.notice((i18n.t as (k: string, o?: Record<string, unknown>) => string)("editor:collab.heldForReview", {
    defaultValue: "This change goes live with the next submission for review",
  }));
}
