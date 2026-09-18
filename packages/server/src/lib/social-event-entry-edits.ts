export type EditableSocialEntryStatus = "submitted" | "under_initial_review" | "needs_changes";

const EDITABLE_STATUSES = new Set<string>([
  "submitted",
  "under_initial_review",
  "needs_changes",
]);

export interface SocialEntryEditTransition {
  linkChanged: boolean;
  changeKind: "correction" | "replacement";
  nextReplacementCount: number;
  resetInitialReviewMaturity: boolean;
}

export function resolveSocialEntryEditTransition(input: {
  status: string;
  replacementCount: number;
  currentCanonicalPostKey: string;
  nextCanonicalPostKey: string;
}): SocialEntryEditTransition {
  if (!EDITABLE_STATUSES.has(input.status)) {
    throw new Error("SOCIAL_ENTRY_EDIT_LOCKED");
  }

  const linkChanged = input.currentCanonicalPostKey !== input.nextCanonicalPostKey;
  const officialCorrection = input.status === "needs_changes";
  const countsAsReplacement = linkChanged && !officialCorrection;
  if (countsAsReplacement && input.replacementCount >= 1) {
    throw new Error("SOCIAL_ENTRY_REPLACEMENT_LIMIT_REACHED");
  }

  return {
    linkChanged,
    changeKind: countsAsReplacement ? "replacement" : "correction",
    nextReplacementCount: input.replacementCount + (countsAsReplacement ? 1 : 0),
    resetInitialReviewMaturity: linkChanged,
  };
}
