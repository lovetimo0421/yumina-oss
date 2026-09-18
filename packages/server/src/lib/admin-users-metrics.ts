/** Prepared Users metrics. No database/vendor imports: API reads never refresh facts. */

// Budget applies to ONE month or ONE per-user aggregate, never all daily history.
export const USERS_METRICS_MAX_BYTES = 64 * 1024 * 1024;
export const USERS_METRICS_MAX_ROWS = 100_000;
export const USERS_CREATOR_NOTE = "Creator interactions count other players' recorded play generations in currently owned worlds; self-play is excluded. Deleted worlds and missing historical world attribution are excluded. Studio includes authoring and playtests. All-time game time uses lifetime account counters plus non-overlapping linked game time; date ranges use timestamped intervals only. Activity groups overlap. Tokens include all recorded AI calls and BYOK. Cost uses recorded provider charges where available, reference prices elsewhere, excluding BYOK. Historical estimates are not cache-adjusted invoices. Unpriced usage is shown separately.";

export type UsersCostRow = [model: string, observedUsd: number, observedRequests: number, fallbackInput: number, fallbackOutput: number, fallbackRequests: number];

export interface UsersMetricRow {
  userId: string;
  day: string;
  messages: number;
  studioMessages: number;
  byokMessages: number;
  models: Array<[model: string, requests: number, input: number, output: number, platformInput: number, platformOutput: number]>;
  costs?: UsersCostRow[];
  lastActiveAt: string | null;
  player: boolean;
  creator: boolean;
  community: boolean;
  active: boolean;
  worldMessages: Array<[worldId: string, messages: number]>;
  playtimeSeconds: number;
  standaloneSeconds?: number;
}
export interface UsersMetricSource {
  available: boolean;
  through: string | null;
  note: string;
}
export interface UsersMetricBucket {
  generatedAt: string;
  through: string;
  rows: UsersMetricRow[];
  sources: { usage: UsersMetricSource; activity: UsersMetricSource; playtime: UsersMetricSource };
}
export interface UsersMetricsSnapshot {
  version: 1;
  discoveredAt: string;
  months: string[];
  buckets: Record<string, UsersMetricBucket>;
  aggregate?: UsersMetricBucket;
  today?: UsersMetricBucket;
  preparedComplete?: boolean;
}
export function validateUsersBucket(bucket: UsersMetricBucket): void {
  if (!bucket || !Array.isArray(bucket.rows) || bucket.rows.length > USERS_METRICS_MAX_ROWS ||
      !Number.isFinite(Date.parse(bucket.generatedAt)) || !Number.isFinite(Date.parse(bucket.through)) ||
      !bucket.sources?.usage || !bucket.sources.activity || !bucket.sources.playtime) throw new Error("Invalid Users metric bucket");
  const seen = new Set<string>();
  for (const row of bucket.rows) {
    const key = row.userId + ":" + row.day;
    if (!row.userId || !/^\d{4}-\d{2}-\d{2}$/.test(row.day) || seen.has(key) || !Array.isArray(row.models) ||
        !Array.isArray(row.worldMessages) || row.worldMessages.some(w => typeof w[0] !== "string" || typeof w[1] !== "number" || !Number.isSafeInteger(w[1]) || w[1] < 0) ||
        [row.messages, row.studioMessages, row.byokMessages, row.playtimeSeconds].some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0) ||
        row.models.some(m => m.length !== 6 || typeof m[0] !== "string" || m.slice(1).some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0) || m[4] > m[2] || m[5] > m[3]) ||
        (row.costs !== undefined && (!Array.isArray(row.costs) || row.costs.some(c => c.length !== 6 || typeof c[0] !== "string" || c.slice(1).some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0)))) ||
        (row.standaloneSeconds !== undefined && (!Number.isFinite(row.standaloneSeconds) || row.standaloneSeconds < 0 || row.standaloneSeconds > row.playtimeSeconds + .001)) ||
        [row.player, row.creator, row.community, row.active].some(b => typeof b !== "boolean") ||
        (row.lastActiveAt !== null && !Number.isFinite(Date.parse(row.lastActiveAt)))) throw new Error("Invalid Users metric row");
    seen.add(key);
  }
}
