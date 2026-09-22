import { planMaterialHold, type PendingEditRow } from "./pending-edit-plan.js";
export { planMaterialHold, type PendingEditRow, type LiveMaterial } from "./pending-edit-plan.js";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { captureAutomaticVersion, capturePublishVersion, lockVersionWorld } from "./world-version-history.js";
import { db } from "../db/index.js";
import { viewerSeesWorkingCopy } from "./working-copy.js";
import {
  adminActions,
  user,
  userLibrary,
  worlds,
  worldPendingEdits,
  worldReviewSubmissions,
  worldUpdates,
} from "../db/schema.js";
import {
  diffWorldSchemas,
  estimateTokens,
  migrateWorldDefinition,
  type MaterialChangeReason,
  type WorldDiff,
} from "@yumina/engine";
import { notify, notifyMany, notifyCoalescedByGroup } from "./notify.js";
import { embedAndStoreWorld } from "./embeddings.js";
import { onWorldEditPublished } from "./achievements/engine.js";
import { resolveImageCdn } from "./cdn-url.js";
import type { RejectionReason } from "./review.js";
import {
  resolveCopyMaterialForViewer,
  type WorldCopyMaterial,
} from "./world-copy-material.js";
import { MAX_WORLD_UPDATE_CONTENT, MAX_WORLD_UPDATE_TITLE } from "@yumina/shared";
import type { ReviewContext } from './review-transaction.js';
import type { LedgerDatabase } from './transaction-hash.js';

// A db handle OR a transaction handle — both expose the same query builders.
// Typed loosely so a drizzle PgTransaction can be passed where `db` is expected
// without fighting the pg|pglite union on `typeof db`.
type Executor = Pick<typeof db, "insert" | "delete" | "update" | "select">;

// Migration is run on BOTH sides before diffing so a stored-old-version vs
// editor-loaded-new-version schema doesn't read as a creator edit.
function migrate(schema: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return migrateWorldDefinition((schema ?? {}) as any);
}

function isAdult(rating: string | null | undefined): boolean {
  return !(rating === "all" || rating == null || rating === "");
}

function recomputeTokens(schema: unknown): number {
  try {
    const entries = ((schema as { entries?: Array<{ content?: string }> })?.entries) ?? [];
    return entries.reduce((sum, e) => sum + estimateTokens(e.content ?? ""), 0);
  } catch {
    return 0;
  }
}

/** Fetch the (at most one) held edit for a world, or null. */
export async function getPendingEdit(worldId: string, exec: Executor = db): Promise<PendingEditRow | null> {
  const [row] = await exec
    .select({
      worldId: worldPendingEdits.worldId,
      status: worldPendingEdits.status,
      reasons: worldPendingEdits.reasons,
      submittedAt: worldPendingEdits.submittedAt,
      rejectionReason: worldPendingEdits.rejectionReason,
      rejectionDetail: worldPendingEdits.rejectionDetail,
      updatedAt: worldPendingEdits.updatedAt,
      schema: worldPendingEdits.schema,
      preserveDraft: worldPendingEdits.preserveDraft,
      thumbnailUrl: worldPendingEdits.thumbnailUrl,
      ageRating: worldPendingEdits.ageRating,
      updateTitle: worldPendingEdits.updateTitle,
      updateContent: worldPendingEdits.updateContent,
      updateIsMajor: worldPendingEdits.updateIsMajor,
    })
    .from(worldPendingEdits)
    .where(eq(worldPendingEdits.worldId, worldId))
    .limit(1);
  return (row as PendingEditRow | undefined) ?? null;
}

/** Map a pending-edit row to the compact summary the editor renders. */
export function summarizePendingEdit(row: PendingEditRow) {
  return {
    status: row.status,
    reasons: (row.reasons ?? []) as MaterialChangeReason[],
    submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
    rejectionReason: row.rejectionReason,
    rejectionDetail: row.rejectionDetail,
    updatedAt: (row.updatedAt ?? new Date()).toISOString(),
  };
}

export async function clearPendingEdit(worldId: string): Promise<void> {
  await db.delete(worldPendingEdits).where(eq(worldPendingEdits.worldId, worldId));
}

/**
 * The compact held-edit summary the creator-facing surfaces render for a
 * published card: its review state ('待提交' / '审核中' / '被拒'), when it was
 * submitted, what material surfaces changed, and any rejection note. Returned
 * alongside owned worlds in /api/creator/stats and /api/worlds so the library
 * banner and the dashboard "审核进度" section can show a published card's
 * in-flight update state (the live `worlds.status` stays 'published' the whole
 * time, so it can't carry this).
 */
export interface PendingEditSummary {
  status: "draft" | "pending" | "rejected";
  submittedAt: string | null;
  reasons: MaterialChangeReason[];
  rejectionReason: string | null;
  rejectionDetail: string | null;
  updatedAt: string | null;
}

/** Batch-load held-edit summaries for a set of worlds, keyed by worldId. */
export async function getPendingEditSummaries(
  worldIds: string[],
): Promise<Map<string, PendingEditSummary>> {
  if (worldIds.length === 0) return new Map();
  const rows = await db
    .select({
      worldId: worldPendingEdits.worldId,
      status: worldPendingEdits.status,
      submittedAt: worldPendingEdits.submittedAt,
      reasons: worldPendingEdits.reasons,
      rejectionReason: worldPendingEdits.rejectionReason,
      rejectionDetail: worldPendingEdits.rejectionDetail,
      updatedAt: worldPendingEdits.updatedAt,
    })
    .from(worldPendingEdits)
    .where(inArray(worldPendingEdits.worldId, worldIds));

  const map = new Map<string, PendingEditSummary>();
  for (const r of rows) {
    map.set(r.worldId, {
      status: r.status as "draft" | "pending" | "rejected",
      submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
      reasons: (r.reasons ?? []) as MaterialChangeReason[],
      rejectionReason: r.rejectionReason,
      rejectionDetail: r.rejectionDetail,
      updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
    });
  }
  return map;
}

/** Apply a {@link planMaterialHold} result. Pass a tx to make it atomic with a sibling write. */
export async function applyHoldPlan(plan: ReturnType<typeof planMaterialHold>, exec: Executor = db): Promise<void> {
  if (plan.upsert) {
    await exec
      .insert(worldPendingEdits)
      .values(plan.upsert)
      .onConflictDoUpdate({ target: worldPendingEdits.worldId, set: plan.upsert });
  } else if (plan.clearWorldId) {
    await exec.delete(worldPendingEdits).where(eq(worldPendingEdits.worldId, plan.clearWorldId));
  }
}

/**
 * Convenience: plan + apply in one call (non-transactional). Used by the cover
 * and Studio write paths, which do a single hold write. The PATCH path uses
 * planMaterialHold + applyHoldPlan directly so the hold shares the worlds UPDATE
 * transaction.
 */
export async function holdMaterialEditIfNeeded(args: Parameters<typeof planMaterialHold>[0], exec: Executor = db): Promise<MaterialChangeReason[]> {
  const plan = planMaterialHold(args);
  await applyHoldPlan(plan, exec);
  return plan.reasons;
}

/**
 * Set a world's cover. For a PUBLISHED world the new cover is a material change,
 * so it is parked in the held edit (live cover keeps showing the approved image)
 * rather than written to the live row. For any other status it writes through to
 * `worlds.thumbnailUrl` as before. Used by both cover-upload endpoints.
 */
export async function applyWorldCover(args: {
  worldId: string;
  creatorId: string;
  newKey: string;
}): Promise<
  | { ok: true; thumbnailUrl: string; held: boolean }
  | { ok: false; status: 404 | 409; error: string; code?: string }
> {
  const { worldId, creatorId, newKey } = args;
  const resolved = resolveImageCdn(newKey) ?? newKey;
  return db.transaction(async (tx) => {
    const live = await lockVersionWorld(tx, worldId, creatorId);
    if (!live) return { ok: false as const, status: 404 as const, error: "World not found or not authorized" };
    if (live.status === "published") {
      const existing = await getPendingEdit(worldId, tx);
      const plan = planMaterialHold({
        worldId, creatorId,
        live: { ...live, ageRating: live.ageRating ?? "all" },
        proposedSchema: existing?.schema ?? live.schema,
        proposedThumbnailUrl: newKey,
        proposedAgeRating: existing?.ageRating ?? live.ageRating ?? "all",
        existing: existing ? { ...existing, status: "draft" } : null,
      });
      if (existing?.status === "pending") {
        await tx.update(worldReviewSubmissions)
          .set({ decision: "withdrawn", decidedBy: creatorId, decidedAt: new Date() })
          .where(and(eq(worldReviewSubmissions.worldId, worldId), eq(worldReviewSubmissions.decision, "pending"), eq(worldReviewSubmissions.submissionType, "edit")));
      }
      await applyHoldPlan(plan, tx);
      await tx.update(worlds).set({ updatedAt: new Date() }).where(eq(worlds.id, worldId));
      return { ok: true as const, thumbnailUrl: resolved, held: !!plan.upsert };
    }
    await tx.update(worlds).set({ thumbnailUrl: newKey, updatedAt: new Date() }).where(eq(worlds.id, worldId));
    return { ok: true as const, thumbnailUrl: resolved, held: false };
  });
}

/**
 * The schema the creator should be EDITING for a world: the held working copy
 * when a published world has a pending edit, else the live schema. Used by the
 * Studio AI loader so the agent operates on (and writes back) the same working
 * copy the editor shows — otherwise a Studio write would clobber held edits.
 */
export async function resolveWorkingSchema(
  worldId: string,
  status: string,
  liveSchema: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (status !== "published") return liveSchema;
  const pending = await getPendingEdit(worldId);
  return pending ? pending.schema : liveSchema;
}

/**
 * Resolve the material a viewer-authorized copy operation should clone. A creator copying
 * their own published world must copy the held working version they are
 * actually editing/playing, not the older last-approved row that regular
 * players still see. Otherwise a freshly duplicated card can silently lose a
 * frontend fix (for example the root wrapper that renders both a panel and
 * `<Chat />`) even though the original looks correct to its creator.
 *
 * Non-creators always receive the live material, so an unapproved held edit is
 * never exposed through the public fork endpoint.
 */
export async function resolveWorldCopyMaterial(
  world: {
    id: string;
    status: string;
    creatorId: string;
    schema: Record<string, unknown>;
    thumbnailUrl: string | null;
    ageRating: string;
    isNsfw: boolean | null;
  },
  viewerId: string,
): Promise<WorldCopyMaterial> {
  return resolveCopyMaterialForViewer(world, viewerId, getPendingEdit);
}

/**
 * The variable definitions for the worldDef a given viewer ACTUALLY plays: the
 * held working copy's variables when the creator plays their own published card
 * with an in-flight edit, else the live schema's. The opening-switch (swipe)
 * adoption path keys preserveSetupScopedVariables() off this so it sees the SAME
 * variable set the session renders.
 *
 * Why this matters: a setup-scoped variable can exist ONLY in the held draft
 * (e.g. a cast-selection added by a not-yet-approved edit). Reading variables
 * from the live `worlds.schema` would miss it, so switching the opening while
 * the creator playtests their own working copy wiped the pick back to the
 * snapshot default — the K-pop "选X只出X" bug on published cards. Only `scope`
 * is read downstream, which the raw stored JSON carries verbatim, so no migrate
 * is needed here. Non-creators never get the working copy (no unapproved leak).
 */
export async function resolveSessionVariables(
  worldId: string,
  viewerId: string,
): Promise<unknown[]> {
  const [w] = await db
    .select({
      status: worlds.status,
      creatorId: worlds.creatorId,
      variables: sql<unknown>`${worlds.schema}->'variables'`,
    })
    .from(worlds)
    .where(eq(worlds.id, worldId))
    .limit(1);
  if (!w) return [];

  if (viewerSeesWorkingCopy(w.status, w.creatorId, viewerId)) {
    const [pend] = await db
      .select({ variables: sql<unknown>`${worldPendingEdits.schema}->'variables'` })
      .from(worldPendingEdits)
      .where(eq(worldPendingEdits.worldId, worldId))
      .limit(1);
    if (pend && Array.isArray(pend.variables)) return pend.variables;
  }

  return Array.isArray(w.variables) ? w.variables : [];
}

/**
 * The full world SCHEMA a given viewer ACTUALLY plays for a session: the held
 * working copy when the creator plays/playtests their own published card with an
 * in-flight edit, else the live schema. Use this in EVERY session play path that
 * resolves a worldDef from `worlds.schema` (state-patch, execute-action, revert,
 * restart, branch, checkpoint-restore) so they all agree with the prompt/render
 * paths.
 *
 * Why this matters: GameStateManager.normalizeState() drops any variable not
 * declared in the worldDef it is given. A variable that exists ONLY in the held
 * draft (e.g. a cast-selection added by a not-yet-approved edit) is therefore
 * stripped on every state operation that mis-resolves to the LIVE schema — the
 * creator's pick never persists. Players/non-creators always get live (no
 * unapproved-content leak); the caller migrates the returned schema.
 */
export async function resolveSessionWorldSchema(
  world: { id: string; status: string; creatorId: string; schema: unknown },
  viewerId: string,
): Promise<unknown> {
  if (viewerSeesWorkingCopy(world.status, world.creatorId, viewerId)) {
    const pend = await getPendingEdit(world.id);
    if (pend?.schema) return pend.schema;
  }
  return world.schema;
}

/**
 * Persist a schema produced by Studio AI. For a published world the change is
 * routed through the same material-edit gate as the manual editor: a material
 * change (entries/frontend) is held for re-review instead of going live; a
 * non-material change writes through. A fresh edit supersedes any already-
 * submitted hold (it is withdrawn from the queue back to draft).
 */
export async function writeStudioWorldSchema(args: {
  worldId: string;
  creatorId: string;
  schema: Record<string, unknown>;
  /** Share the caller's transaction when saving a recoverable agent step. */
  database?: LedgerDatabase;
}): Promise<{ held: boolean; reasons: MaterialChangeReason[] }> {
  const { worldId, creatorId, schema } = args;
  return (args.database ?? db).transaction(async (tx) => {
    const live = await lockVersionWorld(tx, worldId, creatorId);
    if (!live) return { held: false, reasons: [] };
    const proposedName = typeof schema.name === "string" && schema.name.trim() ? schema.name : null;
    const nameSet = proposedName !== null && proposedName !== live.name ? { name: proposedName } : {};
    if (live.status !== "published") {
      await tx.update(worlds).set({ schema, ...nameSet, updatedAt: new Date() }).where(eq(worlds.id, worldId));
      return { held: false, reasons: [] };
    }
    const existing = await getPendingEdit(worldId, tx);
    const plan = planMaterialHold({
      worldId, creatorId, live: { ...live, ageRating: live.ageRating ?? "all" },
      proposedSchema: schema,
      proposedThumbnailUrl: existing?.thumbnailUrl ?? live.thumbnailUrl,
      proposedAgeRating: existing?.ageRating ?? live.ageRating ?? "all",
      existing: existing ? { ...existing, status: "draft" } : null,
    });
    if (existing?.status === "pending") {
      await tx.update(worldReviewSubmissions)
        .set({ decision: "withdrawn", decidedBy: creatorId, decidedAt: new Date() })
        .where(and(eq(worldReviewSubmissions.worldId, worldId), eq(worldReviewSubmissions.decision, "pending"), eq(worldReviewSubmissions.submissionType, "edit")));
    }
    await applyHoldPlan(plan, tx);
    await tx.update(worlds).set({ ...(plan.upsert ? {} : { schema }), ...nameSet, updatedAt: new Date() }).where(eq(worlds.id, worldId));
    return { held: !!plan.upsert, reasons: plan.reasons };
  });
}

/**
 * Move a held edit from 'draft'/'rejected' into the admin queue. Records a
 * world_review_submissions row (submissionType='edit') so it shows up in the
 * existing moderation queue, and pings admins.
 */
export async function submitPendingEdit(args: {
  worldId: string;
  creatorId: string;
}): Promise<{ ok: true; autoApproved: boolean } | { ok: false; error: string; code: string }> {
  const { worldId, creatorId } = args;

  const [w] = await db
    .select({
      name: worlds.name,
      thumbnailUrl: worlds.thumbnailUrl,
      languageGroupId: worlds.languageGroupId,
      targetAudience: worlds.targetAudience,
      visibility: worlds.visibility,
      allowEdit: worlds.allowEdit,
      allowReviews: worlds.allowReviews,
    })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, creatorId)))
    .limit(1);
  if (!w) return { ok: false, error: "World not found", code: "NOT_FOUND" };

  const [creator] = await db
    .select({ name: user.name, isBanned: user.isBanned, skipReview: user.skipReview })
    .from(user)
    .where(eq(user.id, creatorId))
    .limit(1);
  if (creator?.isBanned) {
    return { ok: false, error: "Your account is restricted. You cannot submit for review.", code: "BANNED" };
  }
  const skipReview = creator?.skipReview ?? false;

  const groupKey = w.languageGroupId ?? worldId;
  const now = new Date();

  // Lock the held-edit row for the duration so a concurrent hold (e.g. a Studio
  // write or autosave) can't reset it to 'draft' between our read and write and
  // leave a queued submission pointing at a draft row. The snapshot ageRating is
  // taken from the locked row so it matches exactly what we enqueue.
  const outcome = await db.transaction(async (tx) => {
    const live = await lockVersionWorld(tx, worldId, creatorId);
    if (!live || live.status !== "published") return { ok: false as const, error: "Published world not found", code: "NOT_FOUND" };
    const [pending] = await tx
      .select()
      .from(worldPendingEdits)
      .where(eq(worldPendingEdits.worldId, worldId))
      .for("update")
      .limit(1);
    if (!pending) return { ok: false as const, error: "No pending changes to submit", code: "NO_PENDING_EDIT" };
    if (pending.status === "pending") return { ok: false as const, error: "Already submitted for review", code: "ALREADY_SUBMITTED" };

    await capturePublishVersion(tx, live, pending);

    await tx
      .update(worldPendingEdits)
      .set({ status: "pending", submittedAt: now, rejectionReason: null, rejectionDetail: null, updatedAt: now })
      .where(eq(worldPendingEdits.worldId, worldId));

    await tx.insert(worldReviewSubmissions).values({
      worldId,
      groupKey,
      submittedBy: creatorId,
      submittedAt: now,
      decision: "pending",
      submissionType: "edit",
      snapshotAgeRating: pending.ageRating,
      snapshotIsNsfw: isAdult(pending.ageRating),
      snapshotTargetAudience: w.targetAudience,
      snapshotVisibility: w.visibility,
      snapshotAllowEdit: w.allowEdit,
      snapshotAllowReviews: w.allowReviews,
    });
    return { ok: true as const };
  });
  if (!outcome.ok) return outcome;

  if (skipReview) {
    // Trusted creator: commit the just-submitted held edit straight to live
    // instead of queuing it. Reuses commitPendingEditsForGroup so the
    // diff/commit/embed/sibling-sync machinery is identical to an admin approve
    // (reviewerId = creatorId — there is no admin in the loop). That fn writes
    // an `approve_world_edit` audit row; we add an explicit
    // `skip_review_auto_publish_edit` row so the bypass is unambiguous in the
    // log. The admin ping is skipped — nothing needs human action.
    let committed = false;
    try {
      // Commit ONLY this just-submitted world's held edit (not the whole group)
      // — future-only. Audit the auto-commit ONLY if it actually committed:
      // handled=false means a concurrent withdraw/supersede reverted the hold to
      // draft in the gap between the submit txn and the commit txn, so nothing
      // was published and we must not write a misleading audit row.
      const res = await commitPendingEditsForGroup(groupKey, creatorId, [worldId]);
      if (res.handled) {
        committed = true;
        await db.insert(adminActions).values({
          adminId: null,
          actionType: "skip_review_auto_publish_edit",
          targetType: "world_review_group",
          targetId: groupKey,
          metadata: { creatorId, worldId, source: "skipReview" },
        }).catch(() => {});
      }
    } catch (err) {
      console.error("[skipReview] gate-2 auto-commit failed:", (err as Error)?.message);
    }
    // `committed` lets the client show "approved & live" instead of the
    // misleading "submitted — your live card stays up until approved" toast.
    return { ok: true, autoApproved: committed };
  }

  // Ping admins (same notification type the first-publish flow uses).
  const admins = await db.select({ id: user.id }).from(user).where(eq(user.role, "admin"));
  if (admins.length > 0) {
    notifyCoalescedByGroup(admins.map((a) => a.id), "new_review_pending", groupKey, {
      worldId,
      worldName: w.name,
      thumbnailUrl: w.thumbnailUrl,
      authorUserId: creatorId,
      authorName: creator?.name ?? "Someone",
      groupKey,
    }, { actorUserId: creatorId }).catch(() => {});
  }

  return { ok: true, autoApproved: false };
}

/** Pull a submitted edit back out of the queue (creator self-withdraw). */
export async function withdrawPendingEdit(args: {
  worldId: string;
  creatorId: string;
}): Promise<{ ok: true } | { ok: false; error: string; code: string }> {
  const { worldId, creatorId } = args;
  const pending = await getPendingEdit(worldId);
  if (!pending) return { ok: false, error: "No pending changes", code: "NO_PENDING_EDIT" };
  if (pending.status !== "pending") return { ok: false, error: "Not in review", code: "NOT_IN_REVIEW" };

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(worldPendingEdits)
      // Status guard: only flip a still-pending hold (an approve/edit-supersede
      // racing us may already have moved it), so we never resurrect a draft.
      .set({ status: "draft", submittedAt: null, updatedAt: now })
      .where(and(eq(worldPendingEdits.worldId, worldId), eq(worldPendingEdits.status, "pending")));
    await tx
      .update(worldReviewSubmissions)
      .set({ decision: "withdrawn", decidedBy: creatorId, decidedAt: now })
      .where(and(
        eq(worldReviewSubmissions.worldId, worldId),
        eq(worldReviewSubmissions.decision, "pending"),
        eq(worldReviewSubmissions.submissionType, "edit"),
      ));
  });
  return { ok: true };
}

/** True if this queue group is a held-edit review (vs a first-publish review). */
export async function groupHasPendingEdits(groupKey: string): Promise<boolean> {
  const [row] = await db
    .select({ worldId: worldPendingEdits.worldId })
    .from(worldPendingEdits)
    .where(and(eq(worldPendingEdits.groupKey, groupKey), eq(worldPendingEdits.status, "pending")))
    .limit(1);
  return !!row;
}

/**
 * Approve every submitted edit in a group: commit the proposed material values
 * onto the live `worlds` row, clear the holds, mark submissions approved, and
 * re-embed. Returns handled=false when the group has no submitted edits (so the
 * caller can fall through to the first-publish approve path).
 */
export async function commitPendingEditsForGroup(
  groupKey: string,
  reviewerId: string,
  // When set, commit ONLY these worlds' held edits within the group; other
  // pending holds are left for a human. Omit = whole group (admin approve).
  // The skipReview auto-commit passes the single just-submitted worldId so it
  // never sweeps a sibling hold queued before the creator was trusted.
  onlyWorldIds?: string[],
  context?: ReviewContext,
): Promise<{ handled: boolean; count: number }> {
  const now = new Date();
  const scopeIds = onlyWorldIds && onlyWorldIds.length > 0 ? onlyWorldIds : null;
  // Everything that must be consistent (read the submitted holds → commit them
  // live → delete the holds → mark the submissions approved) runs in ONE
  // transaction. The pending rows are SELECT … FOR UPDATE so a concurrent
  // withdraw / Studio-supersede blocks until we commit (and then finds nothing),
  // closing the race where an approve could force a withdrawn, no-longer-intended
  // schema live. "What's new" notes are collected here but fanned out after.
  const committed = await (context?.database??db).transaction(async (tx) => {
    // Same world-before-draft lock order as saves and version switches. Read
    // pending status only AFTER these locks, so withdrawn edits never go live.
    await tx.select({ id: worlds.id }).from(worlds).where(and(
      sql`coalesce(${worlds.languageGroupId}, ${worlds.id}) = ${groupKey}`,
      scopeIds ? inArray(worlds.id, scopeIds) : undefined,
    )).orderBy(worlds.id).for("update");
    const pendings = await tx
      .select()
      .from(worldPendingEdits)
      .where(and(
        eq(worldPendingEdits.groupKey, groupKey),
        eq(worldPendingEdits.status, "pending"),
        scopeIds ? inArray(worldPendingEdits.worldId, scopeIds) : undefined,
      ))
      .for("update");
    if (pendings.length === 0) return null;

    const worldIds = pendings.map((p) => p.worldId);
    const liveRows = await tx
      .select({
        id: worlds.id,
        creatorId: worlds.creatorId,
        name: worlds.name,
        description: worlds.description,
        tags: worlds.tags,
        announcement: worlds.announcement,
        thumbnailUrl: worlds.thumbnailUrl,
        schema: worlds.schema,
        ageRating: worlds.ageRating,
        reviewedAt: worlds.reviewedAt,
      })
      .from(worlds)
      .where(inArray(worlds.id, worldIds));
    const liveById = new Map(liveRows.map((r) => [r.id, r]));
    const publishedForEmbedding: Array<typeof worlds.$inferSelect> = [];
    const postedUpdates: Array<{ worldId: string; updateId: string; title: string; isMajor: boolean }> = [];

    for (const p of pendings) {
      // Heal the name copy inside the held schema before it goes live. Renames
      // are non-material — they land on worlds.name directly while a hold is
      // parked — and holds created before the name-sync fix carry a stale
      // pre-rename schema.name; going live verbatim would resurrect the old
      // title into the AI prompt's character-name fallback.
      const liveName = liveById.get(p.worldId)?.name;
      if (typeof liveName === "string" && liveName.trim() && p.schema && typeof p.schema === "object") {
        (p.schema as Record<string, unknown>).name = liveName;
      }
      const [published] = await tx
        .update(worlds)
        .set({
          schema: p.schema,
          thumbnailUrl: p.thumbnailUrl,
          ageRating: p.ageRating ?? "all",
          isNsfw: isAdult(p.ageRating),
          totalTokens: recomputeTokens(p.schema),
          updatedAt: now,
        })
        .where(eq(worlds.id, p.worldId)).returning();
      if (published) {
        await captureAutomaticVersion(tx, published, "live", published);
        publishedForEmbedding.push(published);
      }

      // Now that the edit is actually live, publish the creator's update note.
      const noteTitle = p.updateTitle?.trim();
      if (noteTitle) {
        const [u] = await tx
          .insert(worldUpdates)
          .values({ worldId: p.worldId, title: noteTitle.slice(0, 200), content: p.updateContent ?? null, isMajor: p.updateIsMajor })
          .returning();
        if (u) postedUpdates.push({ worldId: p.worldId, updateId: u.id, title: noteTitle.slice(0, 200), isMajor: p.updateIsMajor });
      }
    }
    // Status guard belt-and-suspenders with the row lock above.
    await tx.delete(worldPendingEdits).where(and(inArray(worldPendingEdits.worldId, worldIds), eq(worldPendingEdits.status, "pending")));
    await tx
      .update(worldReviewSubmissions)
      .set({ decision: "approved", decidedBy: reviewerId, decidedAt: now })
      .where(and(
        eq(worldReviewSubmissions.groupKey, groupKey),
        eq(worldReviewSubmissions.decision, "pending"),
        eq(worldReviewSubmissions.submissionType, "edit"),
        // Match the variant scoping (skipReview) so a backlogged sibling's edit
        // submission isn't marked decided while its hold is left for a human.
        scopeIds ? inArray(worldReviewSubmissions.worldId, worldIds) : undefined,
      ));
    await tx.insert(adminActions).values({
      adminId: reviewerId,
      actionType: "approve_world_edit",
      targetType: "world_review_group",
      targetId: groupKey,
      metadata: { count: pendings.length, worldIds },
    });
    return { pendings, liveById, postedUpdates, publishedForEmbedding };
  });

  if (!committed) return { handled: false, count: 0 };
  const { pendings, liveById, postedUpdates, publishedForEmbedding } = committed;

  // Post-commit side effects.
  const afterCommit=async()=>{
  const primary = pendings[0]!;
  const primaryLive = liveById.get(primary.worldId);
  if (primaryLive) {
    notify(primaryLive.creatorId, "world_review_approved", {
      groupKey,
      primaryWorldId: primary.worldId,
      worldName: primaryLive.name,
      thumbnailUrl: primary.thumbnailUrl ?? primaryLive.thumbnailUrl,
      variantCount: pendings.length,
      autoApproved: false,
    }).catch(() => {});
  }
  for (const live of publishedForEmbedding) {
    embedAndStoreWorld({
      worldId: live.id,
      name: live.name,
      description: live.description,
      tags: live.tags,
      announcement: live.announcement,
      schema: live.schema,
    }).catch(() => {});
  }

  // Fan out the (now-live) update notes to each world's library users.
  for (const upd of postedUpdates) {
    const live = liveById.get(upd.worldId);
    if (!live) continue;
    const lib = await db
      .select({ userId: userLibrary.userId })
      .from(userLibrary)
      .where(eq(userLibrary.worldId, upd.worldId));
    const recipients = lib.map((l) => l.userId).filter((uid) => uid !== live.creatorId);
    if (recipients.length > 0) {
      notifyMany(recipients, "world_update", {
        worldId: upd.worldId,
        worldName: live.name,
        updateId: upd.updateId,
        title: upd.title,
        isMajor: upd.isMajor,
        creatorUserId: live.creatorId,
      }, { actorUserId: live.creatorId, dedupeKey: upd.updateId }).catch(() => {});
    }
  }

  // Achievement engine: these edits are now live to the public — re-check the
  // creator's edit achievements (补丁炼金术 / 我再改最后一次). Fire-and-forget.
  for (const cid of new Set(Array.from(liveById.values()).map((l) => l.creatorId))) {
    void onWorldEditPublished(cid);
  }
  };
  if(context)context.afterCommit(afterCommit);else void afterCommit().catch(()=>{});

  return { handled: true, count: pendings.length };
}

/**
 * Attach/replace the creator's optional "what's new" note on a held edit (any
 * status). The note is posted to players only when the edit is approved (see
 * commitPendingEditsForGroup) — never while it is still held/unreviewed.
 */
export async function setPendingEditUpdateNote(args: {
  worldId: string;
  creatorId: string;
  title: string | null;
  content: string | null;
  isMajor: boolean;
}): Promise<{ ok: true } | { ok: false; code: "NO_PENDING_EDIT" | "IN_REVIEW" }> {
  const { worldId, creatorId, title, content, isMajor } = args;
  // The note is posted to subscribers verbatim on approval and is part of the
  // admin diff. Block edits while the hold is in the review queue so the posted
  // text can't be swapped to something the admin never saw — editing the held
  // content already pulls it back to draft, so the note follows the same rule.
  const [updated] = await db
    .update(worldPendingEdits)
    .set({
      updateTitle: title ? title.slice(0, MAX_WORLD_UPDATE_TITLE) : null,
      updateContent: content ? content.slice(0, MAX_WORLD_UPDATE_CONTENT) : null,
      updateIsMajor: isMajor,
      updatedAt: new Date(),
    })
    .where(and(
      eq(worldPendingEdits.worldId, worldId),
      ne(worldPendingEdits.status, "pending"),
      sql`EXISTS (
        SELECT 1 FROM worlds w
        WHERE w.id = ${worldId} AND w.creator_id = ${creatorId}
      )`,
    ))
    .returning();
  if (updated) return { ok: true };

  const [owned] = await db
    .select({ worldId: worldPendingEdits.worldId })
    .from(worldPendingEdits)
    .innerJoin(worlds, eq(worlds.id, worldPendingEdits.worldId))
    .where(and(eq(worldPendingEdits.worldId, worldId), eq(worlds.creatorId, creatorId)))
    .limit(1);
  return owned ? { ok: false, code: "IN_REVIEW" } : { ok: false, code: "NO_PENDING_EDIT" };
}

/**
 * Reject every submitted edit in a group. Keeps the held content (status →
 * 'rejected') so the creator can revise and resubmit; the live card is untouched.
 * Returns handled=false when there are no submitted edits.
 */
export async function rejectPendingEditsForGroup(args: {
  groupKey: string;
  reviewerId: string;
  reason: RejectionReason;
  detail: string | null;
  defaultMessage: string;
  context?: ReviewContext;
}): Promise<{ handled: boolean }> {
  const { groupKey, reviewerId, reason, detail } = args;
  const database=args.context?.database??db;
  const pendings = await database
    .select({ worldId: worldPendingEdits.worldId })
    .from(worldPendingEdits)
    .where(and(eq(worldPendingEdits.groupKey, groupKey), eq(worldPendingEdits.status, "pending")));
  if (pendings.length === 0) return { handled: false };

  const worldIds = pendings.map((p) => p.worldId);
  const now = new Date();

  await database.transaction(async (tx) => {
    await tx
      .update(worldPendingEdits)
      .set({ status: "rejected", reviewedBy: reviewerId, reviewedAt: now, rejectionReason: reason, rejectionDetail: detail, updatedAt: now })
      .where(inArray(worldPendingEdits.worldId, worldIds));
    await tx
      .update(worldReviewSubmissions)
      .set({ decision: "rejected", decidedBy: reviewerId, decidedAt: now, rejectionReason: reason, rejectionDetail: detail })
      .where(and(
        eq(worldReviewSubmissions.groupKey, groupKey),
        eq(worldReviewSubmissions.decision, "pending"),
        eq(worldReviewSubmissions.submissionType, "edit"),
      ));
    await tx.insert(adminActions).values({
      adminId: reviewerId,
      actionType: "reject_world_edit",
      targetType: "world_review_group",
      targetId: groupKey,
      metadata: { reason, detail, worldIds },
    });
  });

  const [primaryLive] = await database
    .select({ creatorId: worlds.creatorId, name: worlds.name, thumbnailUrl: worlds.thumbnailUrl })
    .from(worlds)
    .where(eq(worlds.id, worldIds[0]!))
    .limit(1);
  if (primaryLive) {
    const afterCommit=()=>{
    notify(primaryLive.creatorId, "world_review_rejected", {
      groupKey,
      primaryWorldId: worldIds[0]!,
      worldName: primaryLive.name,
      thumbnailUrl: primaryLive.thumbnailUrl,
      variantCount: worldIds.length,
      reason,
      detail,
    }).catch(() => {});
    };
    if(args.context)args.context.afterCommit(afterCommit);else afterCommit();
  }

  return { handled: true };
}

export interface PendingEditDiff {
  worldId: string;
  worldName: string;
  reasons: MaterialChangeReason[];
  diff: WorldDiff;
  ageRating: { before: string; after: string; changed: boolean };
  cover: { before: string | null; after: string | null; changed: boolean };
  /** The "what's new" note that will be posted to library subscribers on
   *  approval — surfaced so the admin reviews the exact text that ships. */
  updateNote: { title: string | null; content: string | null; isMajor: boolean };
}

/**
 * For each submitted edit in a group, build a section-summary + text diff of
 * live (last-approved) vs proposed, for the admin "what changed" panel.
 */
export async function buildGroupPendingDiffs(groupKey: string): Promise<PendingEditDiff[]> {
  const pendings = await db
    .select()
    .from(worldPendingEdits)
    .where(and(eq(worldPendingEdits.groupKey, groupKey), eq(worldPendingEdits.status, "pending")));
  if (pendings.length === 0) return [];

  const liveRows = await db
    .select({ id: worlds.id, name: worlds.name, schema: worlds.schema, thumbnailUrl: worlds.thumbnailUrl, ageRating: worlds.ageRating })
    .from(worlds)
    .where(inArray(worlds.id, pendings.map((p) => p.worldId)));
  const liveById = new Map(liveRows.map((r) => [r.id, r]));

  return pendings.map((p) => {
    const live = liveById.get(p.worldId);
    const liveSchema = live?.schema ?? {};
    const liveRating = live?.ageRating ?? "all";
    const liveThumb = live?.thumbnailUrl ?? null;
    const diff = diffWorldSchemas(migrate(liveSchema), migrate(p.schema), { detail: true });
    return {
      worldId: p.worldId,
      worldName: live?.name ?? "",
      reasons: (p.reasons ?? []) as MaterialChangeReason[],
      diff,
      ageRating: {
        before: liveRating,
        after: p.ageRating ?? "all",
        changed: isAdult(liveRating) !== isAdult(p.ageRating),
      },
      cover: {
        before: resolveImageCdn(liveThumb),
        after: resolveImageCdn(p.thumbnailUrl),
        changed: (liveThumb ?? "").trim() !== (p.thumbnailUrl ?? "").trim(),
      },
      updateNote: {
        title: p.updateTitle ?? null,
        content: p.updateContent ?? null,
        isMajor: p.updateIsMajor ?? false,
      },
    };
  });
}
