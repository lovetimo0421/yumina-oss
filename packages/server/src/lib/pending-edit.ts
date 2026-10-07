import { syncSearchDocNormalized } from "./normalize-search.js";
import { readVersionState } from "./world-version-store.js";
import { versionMetadata, worldVersionHash, type VersionMetadata } from "./world-version-content.js";
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
  detectMaterialChange,
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
import { nextWorldSaveTime } from "./world-save-guard.js";
import type { RejectionReason } from "./review.js";
import { isUserMuted, MAX_WORLD_UPDATE_CONTENT, MAX_WORLD_UPDATE_TITLE } from "@yumina/shared";
import {
  resolveCopyMaterialForViewer,
  type WorldCopyMaterial,
} from "./world-copy-material.js";
import type { ReviewContext } from './review-transaction.js';
import type { LedgerDatabase } from './transaction-hash.js';
import { rebaseAgentWrite, type AgentWriteConflict } from "./studio-tools/rebase-agent-write.js";

// A db handle OR a transaction handle — both expose the same query builders.
// Typed loosely so a drizzle PgTransaction can be passed where `db` is expected
// without fighting the pg|pglite union on `typeof db`.
export type WorldEditExecutor = Pick<typeof db, "insert" | "delete" | "update" | "select" | "execute">;
type Executor = WorldEditExecutor;

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

export interface PendingEditRow {
  worldId: string;
  status: "draft" | "pending" | "rejected";
  reasons: string[];
  submittedAt: Date | null;
  rejectionReason: string | null;
  rejectionDetail: string | null;
  updatedAt: Date | null;
  schema: Record<string, unknown>;
  metadata?: VersionMetadata | null;
  /** Set by a live-version switch: keep the working copy separate from live
   *  until the creator publishes again. */
  preserveDraft?: boolean;
  thumbnailUrl: string | null;
  ageRating: string | null;
  // The creator's held "what's new" note — carried forward across re-edits so a
  // material re-edit never drops it (see planMaterialHold).
  updateTitle: string | null;
  updateContent: string | null;
  updateIsMajor: boolean;
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
      metadata: worldPendingEdits.metadata,
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
  liveMetadata?: VersionMetadata;
  proposedMetadata?: VersionMetadata;
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

  const metadata = args.proposedMetadata ?? existing?.metadata ?? null;
  const schemaChanged = worldVersionHash(migrate(live.schema) as unknown as Record<string, unknown>, {})
    !== worldVersionHash(migrate(proposedSchema) as unknown as Record<string, unknown>, {});
  const metadataChanged = args.liveMetadata && metadata
    ? worldVersionHash({}, args.liveMetadata) !== worldVersionHash({}, metadata) : false;
  // A live-version switch explicitly separates the working copy from live. Keep
  // that separation on later variable/behavior-only saves until Publish.
  const retainedVersionDraft = existing?.preserveDraft === true && (
    schemaChanged || metadataChanged
    || proposedThumbnailUrl !== live.thumbnailUrl || proposedAgeRating !== live.ageRating
  );
  if (!result.changed && !schemaChanged && !metadataChanged && !retainedVersionDraft) {
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
      metadata,
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

/** Apply a {@link planMaterialHold} result. Pass a tx to make it atomic with a sibling write. */
export async function applyHoldPlan(plan: HoldPlan, exec: Executor = db): Promise<void> {
  const worldId = plan.upsert?.worldId ?? plan.clearWorldId;
  if (worldId) {
    // Serialize held-edit creation/removal with direct update announcements.
    // All current mutation callers pass a transaction, so this row lock is
    // held until both the working-copy and live-world writes commit.
    await exec.execute(sql`SELECT id FROM worlds WHERE id = ${worldId} FOR UPDATE`);
  }
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
  target?: "portrait" | "landscape";
  discoverPreview?: boolean;
}): Promise<
  | { ok: true; thumbnailUrl: string; held: boolean; previousUpdatedAt: string | null; updatedAt: string }
  | { ok: false; status: 404 | 409; error: string; code?: string }
> {
  const { worldId, creatorId, newKey } = args;
  const resolved = resolveImageCdn(newKey) ?? newKey;
  return db.transaction(async tx => {
    const state = await readVersionState(tx, worldId);
    if (!state || state.creatorId !== creatorId) return { ok: false as const, status: 404 as const, error: "World not found or not authorized" };
    const previous = state.row.updatedAt ? new Date(String(state.row.updatedAt)) : null;
    const updatedAt = nextWorldSaveTime(previous);
    // Both revisions go back to the editor: if the one this write replaced is
    // the one it holds, the new one is its own and the next save is not a
    // conflict with some "change from elsewhere".
    const tokens = { previousUpdatedAt: previous ? previous.toISOString() : null, updatedAt: updatedAt.toISOString() };
    const landscape = args.target === "landscape";
    const proposedSchema: Record<string, unknown> = { ...state.working.schema };
    // Crop coordinates belong to a particular image. Never carry them over to
    // a replacement, and never touch the other artwork slot.
    if (landscape) {
      proposedSchema.landscapeCover = newKey;
      delete proposedSchema.landscapeCoverCrop;
    } else if (args.discoverPreview) {
      delete proposedSchema.coverCrop;
      delete proposedSchema.galleryCoverCrop;
    }
    const proposedThumbnailUrl = landscape ? state.working.metadata.thumbnailUrl ?? null : newKey;
    if (state.status === "published") {
      const existing = await getPendingEdit(worldId, tx);
      const plan = planMaterialHold({ worldId, creatorId,
        live: { schema: state.live.schema, thumbnailUrl: state.live.metadata.thumbnailUrl ?? null,
          ageRating: state.live.metadata.ageRating ?? "all", languageGroupId: state.row.languageGroupId as string | null, updatedAt },
        proposedSchema, liveMetadata: state.live.metadata,
        proposedMetadata: { ...state.working.metadata, thumbnailUrl: proposedThumbnailUrl },
        proposedThumbnailUrl, proposedAgeRating: state.working.metadata.ageRating ?? "all",
        existing: existing ? { ...existing, status: "draft" } : null });
      if (existing?.status === "pending") {
        await tx.update(worldReviewSubmissions).set({ decision: "withdrawn", decidedBy: creatorId, decidedAt: updatedAt })
          .where(and(eq(worldReviewSubmissions.worldId, worldId), eq(worldReviewSubmissions.decision, "pending")));
      }
      await applyHoldPlan(plan, tx);
      await tx.update(worlds).set({ updatedAt }).where(eq(worlds.id, worldId));
      return { ok: true as const, thumbnailUrl: resolved, held: !!plan.upsert, ...tokens };
    }
    await tx.update(worlds).set({ thumbnailUrl: proposedThumbnailUrl, ...(landscape || args.discoverPreview ? { schema: proposedSchema } : {}), updatedAt }).where(eq(worlds.id, worldId));
    return { ok: true as const, thumbnailUrl: resolved, held: false, ...tokens };
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

export interface StudioWorldWriteResult {
  held: boolean;
  reasons: MaterialChangeReason[];
  /** What was actually stored — differs from the input when it was rebased. */
  schema?: Record<string, unknown>;
  /** The save token this write set on worlds.updated_at. */
  updatedAt?: Date;
  /** Present when a newer save was merged in (see `base`). */
  rebased?: { conflicts: AgentWriteConflict[] };
}

/**
 * Persist a schema produced by Studio AI. For a published world the change is
 * routed through the same material-edit gate as the manual editor: a material
 * change (entries/frontend) requires re-review. All other content changes
 * also stay in the working copy until the creator publishes them. A fresh edit supersedes any already-
 * submitted hold (it is withdrawn from the queue back to draft).
 */
export async function writeStudioWorldSchema(args: {
  worldId: string;
  creatorId: string;
  schema: Record<string, unknown>;
  /** Share the caller's transaction when saving a recoverable agent step. */
  database?: LedgerDatabase;
  /**
   * The working copy `schema` was computed from, and the worlds.updated_at
   * (epoch ms, or null) it was read at. Long-running writers (the Studio agent
   * outside credit recovery) pass this: when the row's save token moved since —
   * the creator saved in the editor mid-run — the write is rebased onto the
   * stored copy with a three-way merge instead of overwriting it.
   */
  base?: { schema: Record<string, unknown>; updatedAt: number | null };
}, transaction?: WorldEditExecutor): Promise<StudioWorldWriteResult> {
  // Version restore already owns a transaction so its safety snapshot and the
  // material hold must commit together. Other Studio writers start one here.
  if (!transaction) {
    const executor = args.database ?? db;
    return executor.transaction((tx) => writeStudioWorldSchema(args, tx as WorldEditExecutor));
  }
  const tx = transaction;
  const { worldId, creatorId } = args;
  // Read only AFTER acquiring the lock: a restore or another writer may have
  // changed the live/held copy while this request waited for its turn.
  await tx.execute(sql`SELECT id FROM worlds WHERE id = ${worldId} FOR UPDATE`);
  const [live] = await tx
    .select({
      status: worlds.status,
      name: worlds.name,
      description: worlds.description,
      schema: worlds.schema,
      thumbnailUrl: worlds.thumbnailUrl,
      ageRating: worlds.ageRating,
      languageGroupId: worlds.languageGroupId,
      updatedAt: worlds.updatedAt,
    })
    .from(worlds)
    .where(and(eq(worlds.id, worldId), eq(worlds.creatorId, creatorId)))
    .limit(1);

  if (!live) return { held: false, reasons: [] };

  let schema = args.schema;
  let rebased: StudioWorldWriteResult["rebased"];
  if (args.base && (live.updatedAt?.getTime() ?? null) !== args.base.updatedAt) {
    // Someone saved since this writer read the world. Merge instead of
    // clobbering: on a published card the creator edits the held working
    // copy, otherwise the live row.
    const current = live.status === "published"
      ? ((await getPendingEdit(worldId, tx))?.schema ?? live.schema)
      : live.schema;
    const result = rebaseAgentWrite(args.base.schema, (current ?? {}) as Record<string, unknown>, schema);
    schema = result.schema;
    rebased = { conflicts: result.conflicts };
  }

  // A Studio rename arrives inside the schema (the agent edits schema.name).
  // worlds.name is the display truth the editor now loads, so a schema-only
  // rename would otherwise be invisible there and synced back over on the
  // next manual save. Renames are non-material — propagate to worlds.name
  // in the working metadata while this write is held.
  const proposedName = typeof schema.name === "string" && schema.name.trim() ? schema.name : null;
  const nameSet = proposedName !== null && proposedName !== live.name ? { name: proposedName } : {};
  // The blurb the same way: the assistant writes it into the schema
  // (update_settings), and the library reads the column.
  const proposedDescription = typeof schema.description === "string" ? schema.description : null;
  const descriptionSet = proposedDescription !== null && proposedDescription !== (live.description ?? "") ? { description: proposedDescription } : {};
  const updatedAt = nextWorldSaveTime(live.updatedAt);

  const written = { schema, updatedAt, ...(rebased ? { rebased } : {}) };

  if (live.status !== "published") {
    await tx.update(worlds).set({ schema, ...nameSet, ...descriptionSet, updatedAt }).where(eq(worlds.id, worldId));
    return { held: false, reasons: [], ...written };
  }

  const existing = await getPendingEdit(worldId, tx);
  const plan = planMaterialHold({
    worldId,
    creatorId,
    live: {
      schema: live.schema,
      thumbnailUrl: live.thumbnailUrl,
      ageRating: live.ageRating ?? "all",
      languageGroupId: live.languageGroupId,
      updatedAt: live.updatedAt,
    },
    proposedSchema: schema,
    liveMetadata: (await readVersionState(tx, worldId))!.live.metadata,
    proposedMetadata: { ...(await readVersionState(tx, worldId))!.working.metadata, ...(proposedName ? { name: proposedName } : {}), ...(proposedDescription !== null ? { description: proposedDescription } : {}) },
    proposedThumbnailUrl: existing?.thumbnailUrl ?? live.thumbnailUrl,
    proposedAgeRating: existing?.ageRating ?? live.ageRating ?? "all",
    existing: existing ? { ...existing, status: "draft" } : null,
  });

  // Supersede-a-queued-submission + hold + (optional) live write commit together.
  if (existing?.status === "pending") {
    await tx
      .update(worldReviewSubmissions)
      .set({ decision: "withdrawn", decidedBy: creatorId, decidedAt: new Date() })
      .where(and(
        eq(worldReviewSubmissions.worldId, worldId),
        eq(worldReviewSubmissions.decision, "pending"),
        eq(worldReviewSubmissions.submissionType, "edit"),
      ));
  }
  await applyHoldPlan(plan, tx);
  if (!plan.upsert) {
    // No content difference remains; clear the hold and advance the save token.
    await tx.update(worlds).set({ schema, ...nameSet, ...descriptionSet, updatedAt }).where(eq(worlds.id, worldId));
  } else {
    // Renames are non-material, matching manual PATCH. Advance the save token
    // for EVERY held write too, so a stale tab cannot silently undo a restore.
    await tx.update(worlds).set({ updatedAt }).where(eq(worlds.id, worldId));
  }

  return { held: !!plan.upsert, reasons: plan.reasons, ...written };
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
    // Same world-before-draft lock order as saves and version switches.
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

    // Snapshot what is being submitted so the publish lineage keeps its
    // live provenance.
    await capturePublishVersion(tx, live, pending);

    await tx
      .update(worldPendingEdits)
      .set({ status: "pending", submittedAt: now, rejectionReason: null, rejectionDetail: null, updatedAt: now })
      .where(eq(worldPendingEdits.worldId, worldId));

    const [submission] = await tx.insert(worldReviewSubmissions).values({
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
    }).returning();
    if (!submission) throw new Error("Submission could not be saved");
    return { ok: true as const, requiresReview: pending.reasons.length > 0, submissionId: submission.id };
  });
  if (!outcome.ok) return outcome;

  if (skipReview || !outcome.requiresReview) {
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
      const res = await commitPendingEditsForGroup(groupKey, creatorId, [worldId], outcome.submissionId);
      if (res.handled) {
        committed = true;
        await db.insert(adminActions).values({
          adminId: null,
          actionType: skipReview ? "skip_review_auto_publish_edit" : "nonmaterial_auto_publish_edit",
          targetType: "world_review_group",
          targetId: groupKey,
          metadata: { creatorId, worldId, source: skipReview ? "skipReview" : "nonmaterial" },
        }).catch(() => {});
      }
    } catch (err) {
      console.error("[skipReview] gate-2 auto-commit failed:", (err as Error)?.message);
    }
    // `committed` lets the client show "approved & live" instead of the
    // misleading "submitted — your live card stays up until approved" toast.
    return committed ? { ok: true, autoApproved: true }
      : { ok: false, code: "PUBLISH_SUPERSEDED", error: "Publication did not complete. Reload your draft and try again." };
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
    await tx.execute(sql`SELECT id FROM worlds WHERE id = ${worldId} FOR UPDATE`);
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
  expectedSubmissionId?: string,
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
  const committed = await (context?.database ?? db).transaction(async (tx) => {
    // Every save/restore/activation takes world then pending. Keep the same order.
    const candidates = await tx.select({ worldId: worldPendingEdits.worldId }).from(worldPendingEdits)
      .where(and(eq(worldPendingEdits.groupKey, groupKey), eq(worldPendingEdits.status, "pending"),
        scopeIds ? inArray(worldPendingEdits.worldId, scopeIds) : undefined));
    for (const id of candidates.map(p => p.worldId).sort()) {
      await tx.execute(sql`SELECT id FROM worlds WHERE id = ${id} FOR UPDATE`);
    }
    if (candidates.length === 0) return null;
    if (expectedSubmissionId) {
      const [submission] = await tx.select({ id: worldReviewSubmissions.id }).from(worldReviewSubmissions)
        .where(and(eq(worldReviewSubmissions.id, expectedSubmissionId), eq(worldReviewSubmissions.decision, "pending"),
          eq(worldReviewSubmissions.groupKey, groupKey), inArray(worldReviewSubmissions.worldId, candidates.map(p => p.worldId)))).limit(1);
      if (!submission) return null;
    }
    const pendings = await tx
      .select()
      .from(worldPendingEdits)
      .where(and(
        eq(worldPendingEdits.groupKey, groupKey),
        eq(worldPendingEdits.status, "pending"),
        inArray(worldPendingEdits.worldId, candidates.map(p => p.worldId)),
      ))
      .for("update");
    if (pendings.length === 0) return null;

    const worldIds = pendings.map((p) => p.worldId);
    const liveRows = await tx
      .select({
        id: worlds.id,
        creatorId: worlds.creatorId,
        isMuted: user.isMuted,
        mutedUntil: user.mutedUntil,
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
      .innerJoin(user, eq(user.id, worlds.creatorId))
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
      const liveName = p.metadata?.name ?? liveById.get(p.worldId)?.name;
      if (typeof liveName === "string" && liveName.trim() && p.schema && typeof p.schema === "object") {
        (p.schema as Record<string, unknown>).name = liveName;
      }
      const [published] = await tx
        .update(worlds)
        .set({
          ...versionMetadata((p.metadata ?? {}) as Record<string, unknown>),
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

      const committedLive = liveById.get(p.worldId);
      if (committedLive) Object.assign(committedLive, versionMetadata(p.metadata ?? {}), { thumbnailUrl: p.thumbnailUrl });

      // Now that the edit is actually live, publish the creator's update note.
      const noteTitle = p.updateTitle?.trim();
      if (noteTitle && !isUserMuted(liveById.get(p.worldId) ?? {})) {
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
        inArray(worldReviewSubmissions.worldId, worldIds),
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
  // testing's search index stays in step with each approved edit; main's
  // embedding pass reads the live rows it already collected.
  for (const p of pendings) await syncSearchDocNormalized(db, p.worldId).catch(() => {});
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
 * Attach/replace the creator's optional "what's new" note on an editable held
 * edit. The note is posted to players only when the edit is approved (see
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
    for (const id of [...worldIds].sort()) await tx.execute(sql`SELECT id FROM worlds WHERE id = ${id} FOR UPDATE`);
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
  landscapeCover: { before: string | null; after: string | null; changed: boolean };
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
      landscapeCover: {
        before: resolveImageCdn((liveSchema as Record<string, unknown>).landscapeCover as string | null ?? null),
        after: resolveImageCdn(p.schema.landscapeCover as string | null ?? null),
        changed: ((liveSchema as Record<string, unknown>).landscapeCover ?? "") !== (p.schema.landscapeCover ?? ""),
      },
      updateNote: {
        title: p.updateTitle ?? null,
        content: p.updateContent ?? null,
        isMajor: p.updateIsMajor ?? false,
      },
    };
  });
}
