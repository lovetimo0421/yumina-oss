/** Native Realtime maximum60min plus conservative5min observation margin.
 * https://developers.openai.com/api/docs/guides/realtime-conversations
 * Store expiry compares timestamps in database UTC, never a client clock. */
export const PILOT_HARD_EXPIRY_MINUTES = 65;
export const PILOT_EXPIRY_ENDPOINT = "voice-pilot-hard-expiry-accounting-incomplete";
export const PILOT_OWNERSHIP_ENDPOINT = "voice-pilot-cleanup-ownership";
export type PilotCleanupStatus = "closed" | "hard-expired-accounting-incomplete" | "pending";
export interface PilotCleanupResult { status: PilotCleanupStatus; retryAfterMs?: number }
export interface PilotOwnership { admitted: boolean; status: PilotCleanupStatus }
export const validPilotCallId = (value: string) => /^[A-Za-z0-9_-]{1,200}$/.test(value);
/** One provider attempt per round, shared by manual/local/sweep cleanup. */
export function pilotCleanupRetryMs(attempt: number): number {
  return Math.min(300_000, 15_000 * 2 ** Math.min(5, Math.max(0, attempt - 1)));
}
