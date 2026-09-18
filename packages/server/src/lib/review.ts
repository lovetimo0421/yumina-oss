import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { worlds } from "../db/schema.js";

/** Reasons an admin can pick when rejecting. Keys are stable; UI maps to labels. */
export const REJECTION_REASONS = [
  "inappropriate_content",
  "sexual_minors",
  "hate_or_harassment",
  "copyright_infringement",
  "mislabeled_age_rating",
  "mislabeled_audience",
  "low_quality",
  "broken_or_unplayable",
  "duplicate",
  "metadata_issue",
  "other",
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

/**
 * Default English message bodies used when the admin does not write a custom
 * detail. UI / i18n layer can override with localized strings; this exists so
 * the notification has *something* useful even if admin forgets to type.
 */
export const REJECTION_DEFAULT_MESSAGES: Record<RejectionReason, string> = {
  inappropriate_content: "Your submission contains content that violates our content policy.",
  sexual_minors: "Your submission appears to involve minors in sexual contexts, which is strictly prohibited.",
  hate_or_harassment: "Your submission contains hate speech or harassing content.",
  copyright_infringement: "Your submission appears to infringe on a third party's copyright.",
  mislabeled_age_rating: "Your content mode does not match the actual content. Please update it and resubmit.",
  mislabeled_audience: "Your target audience tag does not match the actual content. Please re-tag and resubmit.",
  low_quality: "Your submission appears to be empty, test data, or below our quality bar.",
  broken_or_unplayable: "Your world failed playability checks — first message empty, variables broken, or similar.",
  duplicate: "This submission duplicates an existing world.",
  metadata_issue: "Your cover image, description, or tags have issues that need correction.",
  other: "Your submission needs revision. See the reviewer's note for details.",
};

/** Statuses from which an author can transition into pending_review. */
const SUBMITTABLE: ReadonlySet<string> = new Set(["draft", "rejected", "unpublished"]);

export function isEligibleForReviewSubmit(currentStatus: string | null | undefined): boolean {
  if (!currentStatus) return false;
  return SUBMITTABLE.has(currentStatus);
}

/** Compute the queue group key for a world. */
export function computeGroupKey(world: { id: string; languageGroupId: string | null }): string {
  return world.languageGroupId ?? world.id;
}

/**
 * Find sibling worlds in the same languageGroupId owned by the same creator.
 * Returns the input world's id included. When languageGroupId is null, returns
 * just the input world.
 */
export async function findVariantSiblings(
  creatorId: string,
  languageGroupId: string | null,
  worldId: string,
): Promise<Array<{ id: string; status: string; language: string | null; name: string; thumbnailUrl: string | null }>> {
  if (!languageGroupId) {
    const [w] = await db
      .select({ id: worlds.id, status: worlds.status, language: worlds.language, name: worlds.name, thumbnailUrl: worlds.thumbnailUrl })
      .from(worlds)
      .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, creatorId)));
    return w ? [w] : [];
  }
  return db
    .select({ id: worlds.id, status: worlds.status, language: worlds.language, name: worlds.name, thumbnailUrl: worlds.thumbnailUrl })
    .from(worlds)
    .where(and(eq(worlds.languageGroupId, languageGroupId), eq(worlds.creatorId, creatorId)));
}

/** Type guard for rejection reason input from request bodies. */
export function isRejectionReason(input: unknown): input is RejectionReason {
  return typeof input === "string" && (REJECTION_REASONS as readonly string[]).includes(input);
}
