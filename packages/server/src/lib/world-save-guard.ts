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
 * Published held edits also advance worlds.updatedAt. They need the same check
 * so an older tab cannot silently overwrite a restored working copy.
 */
export function isStaleDraftSave(opts: {
  /** The server updatedAt (ISO string) the editor last synced with. */
  clientBaseUpdatedAt: string | null;
  /** The live row's status. */
  liveStatus: string | null | undefined;
  /** The live row's current updatedAt. */
  liveUpdatedAt: Date | null | undefined;
}): boolean {
  const { clientBaseUpdatedAt, liveUpdatedAt } = opts;
  // No token → guard off. Back-compat for older clients, imports, and brand-new
  // worlds (POST path) that have nothing to compare against.
  if (!clientBaseUpdatedAt) return false;
  // No live row / timestamp → nothing to compare; let the route's own 404 /
  // not-found handling take over.
  if (!liveUpdatedAt) return false;
  return liveUpdatedAt.toISOString() !== clientBaseUpdatedAt;
}

/** Keep consecutive writes distinguishable even if they share a millisecond. */
export function nextWorldSaveTime(previous: Date | null | undefined): Date {
  return new Date(Math.max(Date.now(), (previous?.getTime() ?? 0) + 1));
}
