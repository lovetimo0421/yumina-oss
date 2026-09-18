import { diffWorldSchemas, type WorldChange } from "@yumina/engine";
import type { WorldDefinition } from "@yumina/engine";

export interface TimelineSnapshotInput {
  id: string;
  schemaData: unknown; // stored world schema JSON
}

export interface SnapshotSummary {
  id: string;
  summary: WorldChange[];
}

/**
 * snapshots MUST be ordered oldest -> newest. Each snapshot is paired with the
 * next newer snapshot's state; the newest snapshot is paired with `current`
 * (the live world). Returns lightweight (detail:false) change summaries.
 */
export function summarizeSnapshotTimeline(
  snapshots: TimelineSnapshotInput[],
  current: unknown,
): SnapshotSummary[] {
  const out: SnapshotSummary[] = [];
  for (let i = 0; i < snapshots.length; i++) {
    const prev = snapshots[i]!.schemaData as WorldDefinition;
    const next = (i + 1 < snapshots.length ? snapshots[i + 1]!.schemaData : current) as WorldDefinition;
    out.push({ id: snapshots[i]!.id, summary: diffWorldSchemas(prev, next).changes });
  }
  return out;
}
