/**
 * Mirror the swipe row the server persists at the end of a turn into the
 * local message object, WITHOUT refetching.
 *
 * The server appends every regeneration as a new entry in `messages.swipes`
 * (and seeds a 1-element array on send), but the SSE `done` payload
 * historically carried only `swipeIndex`. The client updated
 * `activeSwipeIndex` and left the local `swipes` array stale, so until a page
 * refresh re-fetched messages:
 *   - the "N/M" swipe counter read e.g. "2/1" and swiping right on the last
 *     (stale) index fired ANOTHER regeneration instead of stepping forward;
 *   - the "view raw" (directives) toggle — which reads
 *     swipes[activeSwipeIndex].rawContent — pointed past the end of the
 *     array and disappeared.
 *
 * Pure + side-effect free so the store's SSE onDone handler stays thin and
 * this can be unit tested (same pattern as slim-messages.ts).
 */

export interface TurnSwipe {
  content: string;
  rawContent?: string;
  stateChanges?: Record<string, unknown>;
  stateSnapshot?: Record<string, unknown>;
  createdAt: string;
  model?: string;
  modelFallback?: import("@yumina/shared").ModelFallbackRecord;
  tokenCount?: number;
  creditCost?: number;
  creditBalanceAfter?: number;
}

/**
 * Append a freshly generated swipe to a message's local swipes array.
 *
 * If the local array lags the server's count (message sent from a tab opened
 * before swipe-mirroring shipped), pad with placeholders so the counter and
 * active index line up — placeholder content is fine because non-active swipe
 * content is refetched from the server on swipe anyway (see slim-messages.ts).
 */
export function appendRegenSwipe(
  priorSwipes: readonly TurnSwipe[] | undefined,
  newSwipe: TurnSwipe,
  opts: {
    /** Server's post-append active index (`swipeIndex` in the done payload). */
    serverSwipeIndex?: number;
    /** Server's post-append total (`totalSwipes` in the done payload). */
    serverTotal?: number;
    /** createdAt to stamp on padding placeholders. */
    padCreatedAt: string;
  },
): { swipes: TurnSwipe[]; activeSwipeIndex: number } {
  const swipes = [...(priorSwipes ?? [])];
  if (opts.serverTotal != null) {
    while (swipes.length < opts.serverTotal - 1) {
      swipes.push({ content: "", createdAt: opts.padCreatedAt });
    }
  }
  swipes.push(newSwipe);
  const activeSwipeIndex = Math.min(
    opts.serverSwipeIndex ?? swipes.length - 1,
    swipes.length - 1,
  );
  return { swipes, activeSwipeIndex };
}
