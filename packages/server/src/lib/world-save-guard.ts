/**
 * Optimistic-concurrency decision for the draft world save-clobber guard.
 *
 * The editor PATCHes the WHOLE world blob. If the Studio agent (or another tab)
 * wrote to the world after the editor loaded it — e.g. created entry-folders and
 * filed entries into them — a stale blob save would silently clobber those
 * field-level writes (the entry-folder data-loss bug). When the editor sends the
 * `updatedAt` it last synced with (clientBaseUpdatedAt) and the live row has
 * moved on since, the save is stale and must be rejected so the editor reloads
 * and merges rather than overwriting.
 *
 * Scoped to NON-published worlds on purpose: a published world's editor save
 * flows through the held-edit working copy, which has its own baseUpdatedAt
 * conflict handling (pending-edit.ts) and is actively being reworked alongside
 * the working-copy feature — we deliberately do not double-guard it here.
 */
export function isStaleDraftSave(opts: {
  /** The server updatedAt (ISO string) the editor last synced with. */
  clientBaseUpdatedAt: string | null;
  /** The live row's status. */
  liveStatus: string | null | undefined;
  /** The live row's current updatedAt. */
  liveUpdatedAt: Date | null | undefined;
}): boolean {
  const { clientBaseUpdatedAt, liveStatus, liveUpdatedAt } = opts;
  // No token → guard off. Back-compat for older clients, imports, and brand-new
  // worlds (POST path) that have nothing to compare against.
  if (!clientBaseUpdatedAt) return false;
  // Published worlds resolve concurrency via the held-edit working-copy path.
  if (liveStatus === "published") return false;
  // No live row / timestamp → nothing to compare; let the route's own 404 /
  // not-found handling take over.
  if (!liveUpdatedAt) return false;
  return liveUpdatedAt.toISOString() !== clientBaseUpdatedAt;
}
