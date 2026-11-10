import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  detectMaterialChange,
  diffWorldSchemas,
  migrateWorldDefinition,
  type MaterialChangeReason,
  type WorldDiff,
} from "@yumina/engine";
import { db } from "../db/index.js";
import { worlds, worldPendingEdits, worldReviewSubmissions, worldVersions } from "../db/schema.js";
import { resolveImageCdn } from "./cdn-url.js";

/**
 * "new": nothing of this world was ever live. "edit": a held change to a live
 * world. "republish": a world that was live before, unpublished, and is back
 * in review — reviewed against what players last saw.
 */
export type ReviewKind = "new" | "edit" | "republish";

/** Per-submission kind over a world_review_submissions row referenced as `ref`. */
export function reviewKindSql(ref: string) {
  return sql.raw(`CASE WHEN ${ref}.submission_type = 'edit' THEN 'edit'
    WHEN ${ref}.base_version_id IS NOT NULL OR EXISTS (
      SELECT 1 FROM world_review_submissions prior
      WHERE prior.world_id = ${ref}.world_id AND prior.decision = 'approved' AND prior.submitted_at < ${ref}.submitted_at
    ) THEN 'republish' ELSE 'new' END`);
}

export interface ReviewDiff {
  worldId: string;
  worldName: string;
  submissionId: string;
  kind: ReviewKind;
  decision: string;
  submittedAt: Date;
  reasons: MaterialChangeReason[];
  diff: WorldDiff;
  ageRating: { before: string; after: string; changed: boolean };
  cover: { before: string | null; after: string | null; changed: boolean };
  landscapeCover: { before: string | null; after: string | null; changed: boolean };
  /** The "what's new" note posted to library subscribers on approval — only
   *  known while the held edit still exists. */
  updateNote: { title: string | null; content: string | null; isMajor: boolean } | null;
  /** The snapshots this diff needs weren't recorded (submitted before they
   *  were) or have since been pruned by version retention. */
  unavailable?: "not_recorded" | "pruned";
}

type Material = { schema: Record<string, unknown>; thumbnailUrl: string | null; ageRating: string | null };

// Migration is run on BOTH sides so a stored-old-version vs newer schema
// doesn't read as a creator edit.
function migrate(schema: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return migrateWorldDefinition((schema ?? {}) as any);
}

function isAdult(rating: string | null | undefined): boolean {
  return !(rating === "all" || rating == null || rating === "");
}

const EMPTY_DIFF: WorldDiff = { changes: [], counts: { added: 0, removed: 0, modified: 0 } };

function describeChange(before: Material, after: Material, reasons?: MaterialChangeReason[]) {
  const prev = migrate(before.schema);
  const next = migrate(after.schema);
  const beforeRating = before.ageRating ?? "all";
  const afterRating = after.ageRating ?? "all";
  const landscape = (m: Material) => (m.schema.landscapeCover as string | null | undefined) ?? null;
  return {
    reasons: reasons ?? detectMaterialChange(
      { schema: prev, thumbnailUrl: before.thumbnailUrl, ageRating: beforeRating },
      { schema: next, thumbnailUrl: after.thumbnailUrl, ageRating: afterRating },
    ).reasons,
    diff: diffWorldSchemas(prev, next, { detail: true }),
    ageRating: { before: beforeRating, after: afterRating, changed: isAdult(beforeRating) !== isAdult(afterRating) },
    cover: {
      before: resolveImageCdn(before.thumbnailUrl),
      after: resolveImageCdn(after.thumbnailUrl),
      changed: (before.thumbnailUrl ?? "").trim() !== (after.thumbnailUrl ?? "").trim(),
    },
    landscapeCover: {
      before: resolveImageCdn(landscape(before)),
      after: resolveImageCdn(landscape(after)),
      changed: (landscape(before) ?? "") !== (landscape(after) ?? ""),
    },
  };
}

function unavailableDiff(reason: "not_recorded" | "pruned") {
  const none = { before: null, after: null, changed: false };
  return {
    reasons: [], diff: EMPTY_DIFF, ageRating: { before: "", after: "", changed: false },
    cover: none, landscapeCover: none, updateNote: null, unavailable: reason,
  };
}

/**
 * "What changed" for a review group: one diff per world, from that world's
 * latest submission — or just the one submission asked for. A pending edit
 * diffs live against the held proposal; a pending republish diffs what players
 * last saw against the current row (what approve would publish); a decided
 * submission diffs the snapshots recorded with it. New cards have nothing to
 * diff against and are left out.
 */
export async function buildReviewDiffs(groupKey: string, submissionId?: string): Promise<ReviewDiff[]> {
  const fields = {
    id: worldReviewSubmissions.id,
    worldId: worldReviewSubmissions.worldId,
    submittedAt: worldReviewSubmissions.submittedAt,
    decision: worldReviewSubmissions.decision,
    submissionType: worldReviewSubmissions.submissionType,
    versionId: worldReviewSubmissions.versionId,
    baseVersionId: worldReviewSubmissions.baseVersionId,
    kind: sql<ReviewKind>`${reviewKindSql("world_review_submissions")}`,
  };
  const scope = and(eq(worldReviewSubmissions.groupKey, groupKey), isNotNull(worldReviewSubmissions.worldId));
  const submissions = submissionId
    ? await db.select(fields).from(worldReviewSubmissions)
      .where(and(scope, eq(worldReviewSubmissions.id, submissionId))).limit(1)
    : await db.selectDistinctOn([worldReviewSubmissions.worldId], fields).from(worldReviewSubmissions)
      .where(scope).orderBy(worldReviewSubmissions.worldId, desc(worldReviewSubmissions.submittedAt));
  const reviewable = submissions.filter((s) => s.kind !== "new");
  if (reviewable.length === 0) return [];

  const worldIds = reviewable.map((s) => s.worldId!);
  const versionIds = reviewable.flatMap((s) => [s.versionId, s.baseVersionId]).filter((id): id is string => !!id);
  const [liveRows, holds, versions] = await Promise.all([
    db.select({ id: worlds.id, name: worlds.name, schema: worlds.schema, thumbnailUrl: worlds.thumbnailUrl, ageRating: worlds.ageRating })
      .from(worlds).where(inArray(worlds.id, worldIds)),
    db.select().from(worldPendingEdits)
      .where(and(inArray(worldPendingEdits.worldId, worldIds), eq(worldPendingEdits.status, "pending"))),
    versionIds.length === 0 ? [] : db.select({ id: worldVersions.id, schema: worldVersions.schema, thumbnailUrl: worldVersions.thumbnailUrl, ageRating: worldVersions.ageRating })
      .from(worldVersions).where(inArray(worldVersions.id, versionIds)),
  ]);
  const liveById = new Map(liveRows.map((r) => [r.id, r]));
  const holdByWorld = new Map(holds.map((h) => [h.worldId, h]));
  const versionById = new Map(versions.map((v) => [v.id, v]));

  const out: ReviewDiff[] = [];
  for (const s of reviewable) {
    const live = liveById.get(s.worldId!);
    if (!live) continue;
    const head = { worldId: live.id, worldName: live.name, submissionId: s.id, kind: s.kind, decision: s.decision, submittedAt: s.submittedAt };
    const liveMaterial = { schema: live.schema as Record<string, unknown>, thumbnailUrl: live.thumbnailUrl, ageRating: live.ageRating };

    const hold = s.decision === "pending" && s.submissionType === "edit" ? holdByWorld.get(live.id) : undefined;
    if (hold) {
      out.push({
        ...head,
        ...describeChange(liveMaterial, hold, (hold.reasons ?? []) as MaterialChangeReason[]),
        updateNote: { title: hold.updateTitle ?? null, content: hold.updateContent ?? null, isMajor: hold.updateIsMajor ?? false },
      });
      continue;
    }

    if (!s.baseVersionId || (s.decision !== "pending" && !s.versionId)) {
      out.push({ ...head, ...unavailableDiff("not_recorded") });
      continue;
    }
    const before = versionById.get(s.baseVersionId);
    const after = s.decision === "pending" ? liveMaterial : versionById.get(s.versionId!);
    if (!before || !after) {
      out.push({ ...head, ...unavailableDiff("pruned") });
      continue;
    }
    out.push({ ...head, ...describeChange(before, after), updateNote: null });
  }
  return out;
}
