import { and, eq } from "drizzle-orm";
import { worlds, worldPendingEdits } from "../db/schema.js";
import type { WorldEditExecutor } from "./pending-edit.js";
import { isStaleDraftSave } from "./world-save-guard.js";

/** Recheck the state used to plan a PATCH after waiting for earlier writers. */
export async function lockWorldForSave(tx: WorldEditExecutor, args: {
  worldId: string;
  creatorId: string;
  clientBaseUpdatedAt: string | null;
  observedStatus: string | null | undefined;
  observedUpdatedAt: Date | null | undefined;
  observedPendingUpdatedAt: Date | null;
}) {
  const [current] = await tx.select({ status: worlds.status, updatedAt: worlds.updatedAt })
    .from(worlds).where(and(eq(worlds.id, args.worldId), eq(worlds.creatorId, args.creatorId)))
    .for("update");
  if (!current) return { kind: "notFound" as const };
  const [pending] = current.status === "published"
    ? await tx.select({ updatedAt: worldPendingEdits.updatedAt }).from(worldPendingEdits)
      .where(eq(worldPendingEdits.worldId, args.worldId)).limit(1)
    : [];
  const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;
  if (isStaleDraftSave({ clientBaseUpdatedAt: args.clientBaseUpdatedAt, liveStatus: current.status, liveUpdatedAt: current.updatedAt })
    || current.status !== args.observedStatus
    || iso(current.updatedAt) !== iso(args.observedUpdatedAt)
    || iso(pending?.updatedAt) !== iso(args.observedPendingUpdatedAt)) {
    return { kind: "stale" as const, currentUpdatedAt: iso(current.updatedAt) };
  }
  return { kind: "ready" as const };
}
