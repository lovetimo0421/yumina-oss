import { MAX_STORY_MEMORY, resolveStoryMemory } from "@yumina/shared";

/** Display metadata only: null means inherit the account's effective window.
 * Keep the rollout decision on the server, exactly as generation resolves it. */
export function profileStoryMemoryDefault(createdAt: Date | null, rolloutAt?: string, carriedOverDefault?: number): number | null {
  const instant = rolloutAt ? Date.parse(rolloutAt) : Number.NaN;
  const result = resolveStoryMemory({
    maxContext: MAX_STORY_MEMORY,
    accountCreatedAt: createdAt,
    newAccountsFrom: Number.isFinite(instant) ? new Date(instant) : null,
    carriedOverDefault: carriedOverDefault ?? null,
  });
  return result.source === "new-account-default" || result.source === "carried-over-default" ? result.tokens : null;
}
