import type { PendingEditSummary } from "@/stores/worlds";

/**
 * A card's in-flight review state, normalized for the creator-facing surfaces
 * (the dashboard 审核进度 section + the library "我的作品" banner). `null` means
 * nothing is in flight — the card is fully live, or a plain draft in dev.
 */
export type ReviewState = "in_review" | "pending_submit" | "rejected";

export interface ReviewStateInput {
  status?: string | null;
  pendingEdit?: PendingEditSummary | null;
}

/**
 * Derive the review state from a card. A held edit on a PUBLISHED card wins
 * (its live `status` stays "published" the whole time, so we can't read it
 * there); otherwise fall back to the first-publish lifecycle status. Plain
 * drafts (no held edit, status "draft") return null — they're in development,
 * not awaiting review.
 */
export function deriveReviewState(w: ReviewStateInput): ReviewState | null {
  const pe = w.pendingEdit;
  if (pe) {
    if (pe.status === "pending") return "in_review";
    if (pe.status === "rejected") return "rejected";
    if (pe.status === "draft") return "pending_submit";
  }
  if (w.status === "pending_review") return "in_review";
  if (w.status === "rejected") return "rejected";
  return null;
}

/** Tally review states across a set of cards (for the library banner counts). */
export function tallyReviewStates(cards: ReviewStateInput[]): {
  in_review: number;
  pending_submit: number;
  rejected: number;
  total: number;
} {
  const counts = { in_review: 0, pending_submit: 0, rejected: 0, total: 0 };
  for (const c of cards) {
    const s = deriveReviewState(c);
    if (!s) continue;
    counts[s] += 1;
    counts.total += 1;
  }
  return counts;
}
