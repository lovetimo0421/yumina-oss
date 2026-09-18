import { isDeepStrictEqual } from "node:util";
import { detectMaterialChange, migrateWorldDefinition, type MaterialChangeReason } from "@yumina/engine";
import type { worldPendingEdits } from "../db/schema.js";

function migrate(schema: unknown) { return migrateWorldDefinition((schema ?? {}) as never); }
function isAdult(rating: string | null | undefined) { return !(rating === "all" || rating == null || rating === ""); }

export interface PendingEditRow {
  worldId: string;
  status: "draft" | "pending" | "rejected";
  reasons: string[];
  submittedAt: Date | null;
  rejectionReason: string | null;
  rejectionDetail: string | null;
  updatedAt: Date | null;
  schema: Record<string, unknown>;
  preserveDraft?: boolean;
  thumbnailUrl: string | null;
  ageRating: string | null;
  // The creator's held "what's new" note — carried forward across re-edits so a
  // material re-edit never drops it (see planMaterialHold).
  updateTitle: string | null;
  updateContent: string | null;
  updateIsMajor: boolean;
}

export interface LiveMaterial {
  schema: Record<string, unknown>;
  thumbnailUrl: string | null;
  ageRating: string;
  languageGroupId: string | null;
  updatedAt: Date | null;
}

interface HoldArgs {
  worldId: string;
  creatorId: string;
  live: LiveMaterial;
  proposedSchema: Record<string, unknown>;
  proposedThumbnailUrl: string | null;
  proposedAgeRating: string;
  existing: PendingEditRow | null;
}

interface HoldPlan {
  reasons: MaterialChangeReason[];
  /** Values to upsert into world_pending_edits (material change), else null. */
  upsert: typeof worldPendingEdits.$inferInsert | null;
  /** worldId whose stale hold should be deleted (material reverted to live), else null. */
  clearWorldId: string | null;
}

/**
 * PURE decision (no DB writes): does this proposed edit to a PUBLISHED world
 * touch a material surface (entries / frontend / rating / cover)? Returns the
 * reasons plus the world_pending_edits mutation to apply. The detection compares
 * the proposed material values against LIVE; the caller then applies the plan
 * (see {@link applyHoldPlan}) — ideally inside the same transaction as the live
 * worlds UPDATE so the hold and the patch commit atomically.
 */
export function planMaterialHold(args: HoldArgs): HoldPlan {
  const { worldId, creatorId, live, proposedSchema, proposedThumbnailUrl, proposedAgeRating, existing } = args;

  const result = detectMaterialChange(
    { schema: migrate(live.schema), thumbnailUrl: live.thumbnailUrl, ageRating: live.ageRating },
    { schema: migrate(proposedSchema), thumbnailUrl: proposedThumbnailUrl, ageRating: proposedAgeRating },
  );

  // A version switch explicitly separates the working copy from live. Keep
  // that separation on later variable/behavior-only saves until Publish.
  const retainedVersionDraft = existing?.preserveDraft === true && (
    !isDeepStrictEqual(proposedSchema, live.schema)
    || proposedThumbnailUrl !== live.thumbnailUrl || proposedAgeRating !== live.ageRating
  );
  if (!result.changed && !retainedVersionDraft) {
    // Working copy matches live on every material surface again — drop any stale
    // unsubmitted/rejected hold. (A submitted 'pending' hold never reaches here;
    // the caller blocks edits while it is in the queue.)
    return {
      reasons: [],
      upsert: null,
      clearWorldId: existing && existing.status !== "pending" ? worldId : null,
    };
  }

  const now = new Date();
  return {
    reasons: result.reasons,
    clearWorldId: null,
    upsert: {
      worldId,
      createdBy: creatorId,
      groupKey: live.languageGroupId ?? worldId,
      schema: proposedSchema,
      preserveDraft: existing?.preserveDraft ?? false,
      thumbnailUrl: proposedThumbnailUrl,
      ageRating: proposedAgeRating,
      isNsfw: isAdult(proposedAgeRating),
      reasons: result.reasons as string[],
      // A fresh edit (incl. one made after a rejection) lands as an unsubmitted
      // draft — the creator must click "Submit for review" to enqueue it.
      status: "draft",
      submittedAt: null,
      reviewedBy: null,
      reviewedAt: null,
      rejectionReason: null,
      rejectionDetail: null,
      baseUpdatedAt: live.updatedAt,
      updatedAt: now,
      // Explicitly carry the held "what's new" note forward on a re-edit. (ON
      // CONFLICT DO UPDATE already preserves unlisted columns, but a material
      // re-edit must never silently drop the creator's note, so make it explicit
      // and refactor-proof.)
      updateTitle: existing?.updateTitle ?? null,
      updateContent: existing?.updateContent ?? null,
      updateIsMajor: existing?.updateIsMajor ?? false,
    },
  };
}
