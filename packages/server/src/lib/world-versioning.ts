import { readVersionState } from "./world-version-store.js";
import type { VersionMetadata } from "./world-version-content.js";
import { and, asc, eq, gte, inArray, isNotNull, ne, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { worldSnapshots } from "../db/schema.js";
import { writeStudioWorldSchema, type WorldEditExecutor } from "./pending-edit.js";
import { canEdit, getWorldAccess } from "./world-collaborators.js";
import { recordSnapshotEdits, revertRecordedSteps } from "./snapshot-edits.js";

/** Lock before reading either copy so snapshots capture the author's latest draft. */
export async function lockWorldForVersioning(
  tx: WorldEditExecutor,
  worldId: string,
  creatorId: string,
): Promise<{ schema: Record<string, unknown>; metadata: VersionMetadata } | null> {
  const state = await readVersionState(tx, worldId);
  return state?.creatorId === creatorId ? state.working : null;
}

/**
 * The same lock for anyone who may edit the card (creator or editor
 * collaborator). Authorizes before taking the row lock; returns the card's
 * real creatorId, which is who the records written under it belong to.
 */
export async function lockEditableWorldForVersioning(
  tx: WorldEditExecutor,
  worldId: string,
  userId: string,
): Promise<{ creatorId: string; working: { schema: Record<string, unknown>; metadata: VersionMetadata } } | null> {
  const access = await getWorldAccess(userId, worldId, tx);
  if (!canEdit(access)) return null;
  const working = await lockWorldForVersioning(tx, worldId, access.creatorId);
  return working ? { creatorId: access.creatorId, working } : null;
}

// Only the most recent automatic snapshot backup is retained in the AI timeline.
export const BEFORE_ROLLBACK_LABEL = "Before rollback";

/**
 * What a rollback to this restore point would leave, without writing it:
 * the recorded steps from here on undone on top of `current`, or null when
 * some step was never recorded (then a rollback restores the whole card).
 * Only the steps of whoever left the restore point count: rolling back my
 * assistant leaves a collaborator's assistant (and outside AI) alone. An
 * earlier rollback of theirs is one of those steps, so rollbacks compose.
 */
export async function planSelectiveRevert(
  executor: Pick<typeof db, "select">,
  worldId: string,
  target: { schemaData: Record<string, unknown>; edits: unknown; createdAt: Date | null; userId: string },
  current: Record<string, unknown>,
) {
  if (!target.edits || !target.createdAt) return null;
  const steps = await executor.select({ id: worldSnapshots.id, edits: worldSnapshots.edits }).from(worldSnapshots)
    .where(and(
      eq(worldSnapshots.worldId, worldId),
      eq(worldSnapshots.userId, target.userId),
      gte(worldSnapshots.createdAt, target.createdAt),
      // Backups from before recorded rollbacks only hold the whole card.
      or(ne(worldSnapshots.label, BEFORE_ROLLBACK_LABEL), isNotNull(worldSnapshots.edits)),
    ))
    .orderBy(asc(worldSnapshots.createdAt));
  if (!steps.every((step) => Array.isArray(step.edits))) return null;
  const reverted = revertRecordedSteps(target.schemaData, steps.map((step) => step.edits as unknown[]), current);
  return reverted && { ...reverted, stepIds: steps.map((step) => step.id) };
}

/**
 * An assistant's (or outside AI's) write together with the record of what it
 * changed on its restore point, in one transaction: a step is never saved
 * without its record, which would let a rollback skip it.
 */
export async function writeStudioStep(
  write: Parameters<typeof writeStudioWorldSchema>[0],
  step: { snapshotId: string | null | undefined; before: Record<string, unknown> | object; after: Record<string, unknown> | object },
) {
  return db.transaction(async (tx) => {
    const saved = await writeStudioWorldSchema(write, tx as WorldEditExecutor);
    await recordSnapshotEdits(step.snapshotId, step.before as Record<string, unknown>, step.after as Record<string, unknown>, tx);
    return saved;
  });
}

/** `userId` is whoever restores: the creator or an editor collaborator. */
export async function restoreStudioSnapshot(args: {
  worldId: string;
  userId: string;
  snapshotId: string;
}) {
  const { worldId, userId, snapshotId } = args;
  return db.transaction(async (tx) => {
    const editable = await lockEditableWorldForVersioning(tx, worldId, userId);
    if (!editable) return { kind: "worldNotFound" as const };
    // Restore points belong to the card, so they are recorded under its creator.
    const { creatorId, working: locked } = editable;
    const [target] = await tx.select({ schemaData: worldSnapshots.schemaData, edits: worldSnapshots.edits, createdAt: worldSnapshots.createdAt, userId: worldSnapshots.userId })
      .from(worldSnapshots)
      .where(and(eq(worldSnapshots.id, snapshotId), eq(worldSnapshots.worldId, worldId))).limit(1);
    if (!target) return { kind: "snapshotNotFound" as const };

    // Undo only what the recorded steps from this point on changed, so a
    // collaborator's work (or their assistant's) made meanwhile survives.
    // Older restore points never recorded their steps: those still restore
    // the whole card, as before.
    let schema = target.schemaData;
    let kept: Array<{ collection: string; id: string }> = [];
    let mode: "selective" | "whole" = "whole";
    const reverted = await planSelectiveRevert(tx, worldId, target, locked.schema);
    if (reverted) {
      schema = reverted.schema;
      kept = reverted.kept;
      mode = "selective";
      // Those steps are undone now; a later rollback past them has nothing
      // of theirs left to undo.
      await tx.update(worldSnapshots).set({ edits: [] }).where(inArray(worldSnapshots.id, reverted.stepIds));
    }

    // Capture the author's working copy even when the restore will be held.
    // Read the target before pruning: the target itself may be the old backup.
    // A selective rollback is itself a step of the restore point's owner (what
    // it changed is recorded), so rolling back to before it redoes just that.
    await tx.delete(worldSnapshots)
      .where(and(eq(worldSnapshots.worldId, worldId), eq(worldSnapshots.label, BEFORE_ROLLBACK_LABEL)));
    const [backup] = await tx.insert(worldSnapshots).values({
      worldId, userId: mode === "selective" ? target.userId : creatorId, schemaData: locked.schema, label: BEFORE_ROLLBACK_LABEL,
      ...(mode === "selective" ? { edits: [] } : {}),
    }).returning();
    if (mode === "selective") await recordSnapshotEdits(backup?.id, locked.schema, schema, tx);
    const gate = await writeStudioWorldSchema({ worldId, actorId: userId, schema }, tx);
    return { kind: "ok" as const, ...gate, mode, kept };
  });
}
