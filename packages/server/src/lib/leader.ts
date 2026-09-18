import { redis } from "./redis.js";
import { posthog } from "./posthog.js";
import { withDatabaseQueryTimeout } from "../db/query-deadline.js";

/**
 * Background-job coordination: region allowlist + fleet-wide leader lock.
 *
 * Why this exists (2026-07-06 incident): orphaned Railway containers in
 * asia-southeast1/europe-west4/us-east4 — invisible in the dashboard, spawned
 * 2026-06-17 by a platform-side event — ran their own copies of every interval
 * job against the production DB on stale code for 2.5 weeks. Separately, even
 * the two LEGITIMATE us-west replicas each run every interval job, doubling
 * background DB load for no benefit (all jobs are idempotent but not free).
 *
 * Defense in two layers:
 *  1. Region allowlist — an instance whose RAILWAY_REPLICA_REGION isn't in
 *     ALLOWED_REGIONS refuses to run background jobs and reports itself.
 *     A future zombie becomes inert and self-announcing.
 *  2. runExclusive() — a Redis SET NX EX lease so each job runs on exactly
 *     one instance per window. TTL-based (never released early): pick a TTL
 *     just under the job's interval so the next window elects fresh.
 */

export const INSTANCE_REGION =
  process.env.RAILWAY_REPLICA_REGION ?? process.env.RAILWAY_REGION ?? "unknown";

// "unknown" (no Railway env → local dev / tests) is always allowed: dev
// servers must run their own jobs against dev DBs.
const ALLOWED_REGIONS = (process.env.ALLOWED_REGIONS ?? "us-west2")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const isRogueInstance =
  process.env.NODE_ENV === "production" &&
  INSTANCE_REGION !== "unknown" &&
  !ALLOWED_REGIONS.includes(INSTANCE_REGION);

/**
 * Call once at startup. Logs + emits `rogue_instance_detected` so a zombie
 * shows up in PostHog within a minute of booting instead of after weeks of
 * telemetry archaeology. Serving user traffic is intentionally NOT blocked —
 * a mis-set ALLOWED_REGIONS must degrade to "jobs pause", never "site down".
 */
export function reportIfRogue(): boolean {
  if (!isRogueInstance) return false;
  console.error(
    `[ROGUE] Instance region "${INSTANCE_REGION}" is not in ALLOWED_REGIONS [${ALLOWED_REGIONS.join(", ")}] — all background jobs disabled on this instance.`,
  );
  posthog.capture({
    distinctId: "server",
    event: "rogue_instance_detected",
    properties: { region: INSTANCE_REGION, allowed_regions: ALLOWED_REGIONS.join(",") },
  });
  return true;
}

/**
 * Run `fn` on exactly one instance per `ttlSeconds` window, fleet-wide.
 *
 * - Lock is NOT released after fn: the TTL is the schedule. Use a TTL just
 *   under the job interval (e.g. 25 min for a 30-min interval) so exactly one
 *   election happens per tick even when replicas' timers drift.
 * - Redis unreachable → fail-open (run on every replica, the pre-lock
 *   behavior). Every gated job is idempotent by design, so duplicates cost
 *   load, not correctness — and a Redis blip must never silently stop the
 *   payout/recovery/rollup machinery.
 * - Rogue instances never run regardless of lock state.
 *
 * Returns true when this instance ran the job.
 */
export async function runExclusive(
  job: string,
  ttlSeconds: number,
  fn: () => Promise<void>,
  opts?: { failClosed?: boolean },
): Promise<boolean> {
  if (isRogueInstance) return false;
  if (redis) {
    try {
      const acquired = await redis.set(`leader:${job}`, INSTANCE_REGION, "EX", ttlSeconds, "NX");
      if (acquired !== "OK") return false;
    } catch {
      // Spending money (model-sync GPU rentals) requires an exclusive lease.
      if (opts?.failClosed) return false;
      // fall through — see fail-open note above
    }
  } else if (opts?.failClosed) {
    return false;
  }
  // Scheduled maintenance can legitimately outlast a web query, but it must
  // still release a broken connection instead of waiting indefinitely.
  await withDatabaseQueryTimeout(300_000, fn);
  return true;
}
