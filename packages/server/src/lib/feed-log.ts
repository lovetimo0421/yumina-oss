/**
 * Server-side slate logging (recsys Ship 1).
 *
 * Every /hub response is recorded in `feed_serves` — the ordered list of
 * worlds we actually put in front of a user, keyed by feedRequestId. The
 * client beacon (`feed_events`) says which of them were seen/clicked;
 * together they are the training log the learned ranker will consume.
 *
 * Fire-and-forget by design: this runs on the feed hot path, which is
 * CPU-sensitive (the 2026-06-05 staircase incident), so the insert is
 * never awaited and never throws. A lost row costs one training example,
 * not a user request.
 */

import { db } from "../db/index.js";
import { feedServes } from "../db/schema.js";

let warned = false;

export function logFeedServe(row: {
  id: string;
  userId: string | null;
  surface: string;
  feed: string;
  tier: string | null;
  variant: string;
  lang: string | null;
  offset: number;
  worldIds: string[];
}): void {
  if (row.worldIds.length === 0) return;
  void db
    .insert(feedServes)
    .values(row)
    .onConflictDoNothing()
    .catch((err: unknown) => {
      // Pre-DDL environment or transient failure — warn once per boot.
      if (warned) return;
      warned = true;
      console.warn("[feed-log] serve insert failed:", err instanceof Error ? err.message : err);
    });
}
