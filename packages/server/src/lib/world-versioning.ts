import { readVersionState } from "./world-version-store.js";
import type { VersionMetadata } from "./world-version-content.js";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { worldSnapshots } from "../db/schema.js";
import { writeStudioWorldSchema, type WorldEditExecutor } from "./pending-edit.js";

/** Lock before reading either copy so snapshots capture the author's latest draft. */
export async function lockWorldForVersioning(
  tx: WorldEditExecutor,
  worldId: string,
  creatorId: string,
): Promise<{ schema: Record<string, unknown>; metadata: VersionMetadata } | null> {
  const state = await readVersionState(tx, worldId);
  return state?.creatorId === creatorId ? state.working : null;
}

// Only the most recent automatic snapshot backup is retained in the AI timeline.
export const BEFORE_ROLLBACK_LABEL = "Before rollback";

export async function restoreStudioSnapshot(args: {
  worldId: string;
  creatorId: string;
  snapshotId: string;
}) {
  const { worldId, creatorId, snapshotId } = args;
  return db.transaction(async (tx) => {
    const locked = await lockWorldForVersioning(tx, worldId, creatorId);
    if (!locked) return { kind: "worldNotFound" as const };
    const [target] = await tx.select({ schemaData: worldSnapshots.schemaData }).from(worldSnapshots)
      .where(and(eq(worldSnapshots.id, snapshotId), eq(worldSnapshots.worldId, worldId))).limit(1);
    if (!target) return { kind: "snapshotNotFound" as const };

    // Capture the author's working copy even when the restore will be held.
    // Read the target before pruning: the target itself may be the old backup.
    await tx.delete(worldSnapshots)
      .where(and(eq(worldSnapshots.worldId, worldId), eq(worldSnapshots.label, BEFORE_ROLLBACK_LABEL)));
    await tx.insert(worldSnapshots).values({
      worldId, userId: creatorId, schemaData: locked.schema, label: BEFORE_ROLLBACK_LABEL,
    });
    const gate = await writeStudioWorldSchema({ worldId, creatorId, schema: target.schemaData }, tx);
    return { kind: "ok" as const, ...gate };
  });
}
