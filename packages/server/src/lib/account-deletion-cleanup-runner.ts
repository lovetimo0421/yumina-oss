import { randomUUID } from "node:crypto";

/**
 * Scheduling policy for the account-deletion cleanup outbox.
 *
 * 2026-09-29 incident: every 60 s tick on every replica re-selected the same
 * due jobs while the previous tick was still running them (no claim, no
 * reentrancy guard, no leader), so each job ran ~12x in parallel. Each run's
 * unindexed discovery_events purge hit the 60 s client deadline, dropped a
 * primary connection and left the backend scanning 19 GB until the role's
 * statement_timeout — ~20 such scans on the primary at once. The 1 h backoff
 * cap and missing attempt ceiling kept 69 jobs retrying forever (max 1,113).
 *
 * Invariants enforced here:
 *  - at most one tick per process at a time (reentrancy guard);
 *  - at most one runner fleet-wide (Redis lease, fail-closed on Redis errors);
 *  - at most CLEANUP_JOBS_PER_TICK jobs per tick, processed sequentially;
 *  - a job is claimed (next_attempt_at pushed out) before it runs, so no other
 *    path (post-commit immediate run, another replica) can run it concurrently;
 *  - failures back off exponentially (1 min doubling, 6 h cap, jittered) and
 *    stop after CLEANUP_MAX_ATTEMPTS, logging exactly once when parked.
 */
export const CLEANUP_MAX_ATTEMPTS = 20;
export const CLEANUP_BASE_DELAY_MS = 60_000;
export const CLEANUP_MAX_DELAY_MS = 6 * 60 * 60_000;
/** While a job runs its next_attempt_at is pushed this far out (the claim). */
export const CLEANUP_CLAIM_MS = 20 * 60_000;
/** A job that made progress but ran out of its time budget resumes this soon. */
export const CLEANUP_CONTINUE_DELAY_MS = 60_000;
export const CLEANUP_JOBS_PER_TICK = 2;
export const CLEANUP_LEASE_MS = 25 * 60_000;
export const NEEDS_ATTENTION_PREFIX = "[needs-attention] ";

/** Exponential backoff after the `attempts`-th consecutive failure:
 * 1, 2, 4, ... min, capped at 6 h, with +/-10% jitter (still capped). */
export function cleanupRetryDelayMs(attempts: number, random: () => number = Math.random): number {
  const exponent = Math.min(Math.max(0, attempts - 1), 30);
  const base = Math.min(CLEANUP_MAX_DELAY_MS, CLEANUP_BASE_DELAY_MS * 2 ** exponent);
  const jittered = Math.round(base * (0.9 + random() * 0.2));
  return Math.min(CLEANUP_MAX_DELAY_MS, Math.max(CLEANUP_BASE_DELAY_MS / 2, jittered));
}

export interface CleanupFailurePlan {
  attempts: number;
  lastError: string;
  nextAttemptAt: Date;
  /** True exactly on the failure that reaches the ceiling: log once, then stop. */
  exhausted: boolean;
}

export function planCleanupFailure(
  previousAttempts: number,
  message: string,
  now = Date.now(),
  random: () => number = Math.random,
): CleanupFailurePlan {
  const attempts = previousAttempts + 1;
  const exhausted = attempts >= CLEANUP_MAX_ATTEMPTS;
  return {
    attempts,
    exhausted,
    lastError: `${exhausted ? NEEDS_ATTENTION_PREFIX : ""}${message}`.slice(0, 2_000),
    nextAttemptAt: new Date(now + (exhausted ? CLEANUP_MAX_DELAY_MS : cleanupRetryDelayMs(attempts, random))),
  };
}

export interface CleanupLease {
  /** Resolve to a release function when this instance may run, else null. */
  acquire(): Promise<(() => Promise<void>) | null>;
}

export interface MinimalLeaseRedis {
  set(key: string, value: string, px: "PX", ttl: number, nx: "NX"): Promise<unknown>;
  eval(script: string, keys: number, ...args: (string | number)[]): Promise<unknown>;
}

const RELEASE_LEASE =
  "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end";

/** Fleet-wide single runner. No Redis configured (local dev, tests) means a
 * single process, so it runs; a Redis ERROR fails closed — duplicated runners
 * are exactly what took the primary down, and the job simply waits a tick. */
export function redisCleanupLease(
  redis: MinimalLeaseRedis | null,
  key = "leader:account-deletion-cleanup",
  ttlMs = CLEANUP_LEASE_MS,
): CleanupLease {
  return {
    async acquire() {
      if (!redis) return async () => {};
      const token = randomUUID();
      let acquired: unknown;
      try {
        acquired = await redis.set(key, token, "PX", ttlMs, "NX");
      } catch {
        return null;
      }
      if (acquired !== "OK") return null;
      return async () => {
        await redis.eval(RELEASE_LEASE, 1, key, token).catch(() => {});
      };
    },
  };
}

export interface CleanupTickDeps<Job extends { id: string }> {
  lease: CleanupLease;
  /** Jobs with attempts below the ceiling whose next_attempt_at is due. */
  listDue(limit: number): Promise<Job[]>;
  /** Atomically push next_attempt_at out; null if someone else got it first. */
  claim(job: Job): Promise<Job | null>;
  process(job: Job): Promise<void>;
  isBlocked?: () => boolean;
  limit?: number;
}

export function createCleanupTicker<Job extends { id: string }>(deps: CleanupTickDeps<Job>) {
  let running = false;
  return async function tick(): Promise<{ ran: boolean; processed: string[] }> {
    if (running || deps.isBlocked?.()) return { ran: false, processed: [] };
    running = true;
    try {
      const release = await deps.lease.acquire();
      if (!release) return { ran: false, processed: [] };
      const processed: string[] = [];
      try {
        const jobs = await deps.listDue(deps.limit ?? CLEANUP_JOBS_PER_TICK);
        for (const job of jobs) {
          const claimed = await deps.claim(job);
          if (!claimed) continue;
          await deps.process(claimed);
          processed.push(claimed.id);
        }
      } finally {
        await release();
      }
      return { ran: true, processed };
    } finally {
      running = false;
    }
  };
}
