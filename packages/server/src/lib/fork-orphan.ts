/**
 * "Orphaned fork" — the rule that tombstones a copy in My Projects and 403s
 * its play/regenerate/continue calls.
 *
 * The intent (ec8a024f7) is creator control: when a creator pulls a card that
 * was live on the hub, copies other people forked off it go dark too.
 *
 * The original condition was `source.is_published === false`, which is much
 * wider than that intent — it cannot tell "pulled" from "never published":
 *
 *   - A DM world-share of a DRAFT is a first-class feature ("未发布 — 加入你的
 *     作品后才能打开"). The recipient hits "Add to my projects", the copy is
 *     created with `source_world_id` pointing at a draft, and `is_published` is
 *     false because the card was never published — not because anything was
 *     pulled. Every DM-received copy tombstoned the instant it was made.
 *   - Duplicating your OWN draft has the same shape.
 *   - A creator unpublishing their own original locked them out of their own
 *     variants.
 *
 * So the rule is: the source was LIVE at some point AND is not live now AND
 * belongs to someone else.
 *
 * "Live at some point" needs BOTH signals, because neither alone is complete:
 *
 *   - `status = 'unpublished'` — the only transition into it is
 *     published → unpublished (worlds.ts validTransitions), and it is what a
 *     moderation takedown writes (reports.ts). But a creator who pulls a card
 *     and then moves it back to draft to rework it leaves `status = 'draft'`,
 *     and their forks must stay dark.
 *   - `published_at IS NOT NULL` — stamped on first approval, never cleared,
 *     and the legacy backfill (db/index.ts) only stamped rows that were
 *     `is_published`. But 7 prod cards pulled BEFORE that backfill ran are at
 *     `status = 'unpublished'` with no stamp at all.
 *
 * A never-live card has neither: it sits at draft / pending_review / rejected
 * with a null stamp, and must not orphan anything.
 *
 * The same-creator escape hatch keeps a creator's own lineage — self-copies and
 * language variants — under their own control.
 *
 * Mirrored as SQL in `worlds.ts` (`sourceTakenDownSq`). Keep the two in sync.
 */

/** The only `worlds.status` a card reaches by being pulled after going live. */
export const WORLD_STATUS_TAKEN_DOWN = "unpublished";

export interface ForkOrphanInput {
  /** The copy's `source_world_id` — null when it isn't a fork at all. */
  sourceWorldId: string | null;
  /** The source world's `status`, or null when the source row is gone. */
  sourceStatus: string | null;
  /** The source world's `is_published` — whether it is on the hub right now. */
  sourceIsPublished: boolean | null;
  /** The source world's `published_at` — set on first publish, never cleared. */
  sourcePublishedAt: Date | string | null;
  /** The source world's creator. */
  sourceCreatorId: string | null;
  /** The copy's creator (the person looking at it). */
  worldCreatorId: string | null;
}

export function isForkOrphaned({
  sourceWorldId,
  sourceStatus,
  sourceIsPublished,
  sourcePublishedAt,
  sourceCreatorId,
  worldCreatorId,
}: ForkOrphanInput): boolean {
  if (!sourceWorldId) return false;
  // Source row is gone entirely — the copy holds its own schema and stays usable.
  if (sourceStatus === null) return false;
  // Still on the hub: nothing was pulled.
  if (sourceIsPublished) return false;

  const wasLiveOnce =
    sourceStatus === WORLD_STATUS_TAKEN_DOWN || sourcePublishedAt !== null;
  if (!wasLiveOnce) return false;

  // Your own lineage is your business — unpublishing an original must not lock
  // you out of the copies and language variants you made from it.
  if (sourceCreatorId && worldCreatorId && sourceCreatorId === worldCreatorId) {
    return false;
  }
  return true;
}
