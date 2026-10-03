import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLEANUP_BASE_DELAY_MS,
  CLEANUP_JOBS_PER_TICK,
  CLEANUP_MAX_ATTEMPTS,
  CLEANUP_MAX_DELAY_MS,
  NEEDS_ATTENTION_PREFIX,
  cleanupRetryDelayMs,
  createCleanupTicker,
  planCleanupFailure,
  redisCleanupLease,
  type CleanupLease,
  type MinimalLeaseRedis,
} from "./account-deletion-cleanup-runner.js";

const noJitter = () => 0.5;

test("backoff doubles from one minute and caps at six hours", () => {
  const minutes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 20, 1_113]
    .map(attempt => cleanupRetryDelayMs(attempt, noJitter) / 60_000);
  assert.deepEqual(minutes, [1, 2, 4, 8, 16, 32, 64, 128, 256, 360, 360, 360, 360]);
  assert.equal(cleanupRetryDelayMs(1, noJitter), CLEANUP_BASE_DELAY_MS);
});

test("backoff jitter stays within +/-10% and never exceeds the cap", () => {
  for (const attempt of [1, 5, 9, 10, 50]) {
    const low = cleanupRetryDelayMs(attempt, () => 0);
    const high = cleanupRetryDelayMs(attempt, () => 0.999999);
    const mid = cleanupRetryDelayMs(attempt, noJitter);
    assert.ok(low >= mid * 0.9 - 1 && high <= Math.min(CLEANUP_MAX_DELAY_MS, mid * 1.1 + 1), `attempt ${attempt}`);
    assert.ok(high <= CLEANUP_MAX_DELAY_MS);
  }
});

test("failures are retried until the attempt ceiling, which parks the job exactly once", () => {
  const now = Date.parse("2026-09-29T00:00:00Z");
  const first = planCleanupFailure(0, "boom", now, noJitter);
  assert.deepEqual(
    { attempts: first.attempts, exhausted: first.exhausted, lastError: first.lastError, delay: first.nextAttemptAt.getTime() - now },
    { attempts: 1, exhausted: false, lastError: "boom", delay: 60_000 },
  );
  const beforeCeiling = planCleanupFailure(CLEANUP_MAX_ATTEMPTS - 2, "boom", now, noJitter);
  assert.equal(beforeCeiling.exhausted, false);
  const atCeiling = planCleanupFailure(CLEANUP_MAX_ATTEMPTS - 1, "boom", now, noJitter);
  assert.equal(atCeiling.attempts, CLEANUP_MAX_ATTEMPTS);
  assert.equal(atCeiling.exhausted, true);
  assert.equal(atCeiling.lastError, `${NEEDS_ATTENTION_PREFIX}boom`);
  assert.equal(planCleanupFailure(0, "x".repeat(5_000), now).lastError.length, 2_000);
  // Total wait before a job is parked: long enough to ride out an outage,
  // short enough that a genuinely broken job surfaces within days.
  let waited = 0;
  for (let attempts = 0; attempts < CLEANUP_MAX_ATTEMPTS - 1; attempts += 1) {
    waited += planCleanupFailure(attempts, "boom", 0, noJitter).nextAttemptAt.getTime();
  }
  assert.ok(waited > 24 * 3_600_000 && waited < 4 * 24 * 3_600_000, `${waited / 3_600_000} h`);
});

function fakeRedis() {
  const store = new Map<string, string>();
  let failing = false;
  const redis: MinimalLeaseRedis & { fail(on: boolean): void; store: Map<string, string> } = {
    store,
    fail(on) { failing = on; },
    async set(key, value) {
      if (failing) throw new Error("redis down");
      if (store.has(key)) return null;
      store.set(key, value);
      return "OK";
    },
    async eval(_script, _keys, key, token) {
      if (store.get(String(key)) === String(token)) store.delete(String(key));
      return 1;
    },
  };
  return redis;
}

test("leader lease: one holder fleet-wide, released after the tick, fail-closed on Redis errors", async () => {
  const redis = fakeRedis();
  const replicaA = redisCleanupLease(redis);
  const replicaB = redisCleanupLease(redis);
  const releaseA = await replicaA.acquire();
  assert.ok(releaseA);
  assert.equal(await replicaB.acquire(), null, "a second replica must not run while the lease is held");
  await releaseA!();
  const releaseB = await replicaB.acquire();
  assert.ok(releaseB, "the lease is free again after release");
  await releaseB!();
  redis.fail(true);
  assert.equal(await replicaA.acquire(), null, "a Redis error must not fall back to running everywhere");
  // No Redis configured at all (local dev, tests): a single process runs.
  assert.ok(await redisCleanupLease(null).acquire());
});

type Job = { id: string };

function harness(options: { due?: Job[]; lease?: CleanupLease; claimable?: Set<string>; processDelay?: Promise<void> } = {}) {
  const calls = { list: [] as number[], claimed: [] as string[], processed: [] as string[], concurrent: 0, maxConcurrent: 0 };
  const due = options.due ?? [{ id: "a" }, { id: "b" }, { id: "c" }];
  const tick = createCleanupTicker<Job>({
    lease: options.lease ?? redisCleanupLease(null),
    async listDue(limit) { calls.list.push(limit); return due.slice(0, limit); },
    async claim(job) {
      calls.claimed.push(job.id);
      return !options.claimable || options.claimable.has(job.id) ? job : null;
    },
    async process(job) {
      calls.concurrent += 1;
      calls.maxConcurrent = Math.max(calls.maxConcurrent, calls.concurrent);
      await options.processDelay;
      calls.processed.push(job.id);
      calls.concurrent -= 1;
    },
  });
  return { tick, calls };
}

test("a tick processes at most the per-tick limit, sequentially", async () => {
  const { tick, calls } = harness();
  const result = await tick();
  assert.equal(result.ran, true);
  assert.deepEqual(calls.list, [CLEANUP_JOBS_PER_TICK]);
  assert.deepEqual(calls.processed, ["a", "b"].slice(0, CLEANUP_JOBS_PER_TICK));
  assert.equal(calls.maxConcurrent, 1);
});

test("overlapping ticks in one process are no-ops instead of re-running the same jobs", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const { tick, calls } = harness({ due: [{ id: "a" }], processDelay: gate });
  const first = tick();
  // The old runner re-selected job "a" on every 60 s tick while it was still
  // running, stacking ~12 copies of the same 19 GB scan.
  const overlapping = await Promise.all([tick(), tick(), tick()]);
  assert.deepEqual(overlapping.map(result => result.ran), [false, false, false]);
  finish();
  assert.equal((await first).ran, true);
  assert.deepEqual(calls.processed, ["a"]);
  assert.equal(calls.list.length, 1);
  // Once the tick finishes the next one runs normally.
  assert.equal((await tick()).ran, true);
});

test("a job another runner already claimed is skipped, not run twice", async () => {
  const { tick, calls } = harness({ due: [{ id: "a" }, { id: "b" }], claimable: new Set(["b"]) });
  await tick();
  assert.deepEqual(calls.claimed, ["a", "b"]);
  assert.deepEqual(calls.processed, ["b"]);
});

test("without the fleet lease nothing is listed or processed", async () => {
  const redis = fakeRedis();
  const holder = await redisCleanupLease(redis).acquire();
  assert.ok(holder);
  const { tick, calls } = harness({ lease: redisCleanupLease(redis) });
  assert.equal((await tick()).ran, false);
  assert.deepEqual(calls.list, []);
  assert.deepEqual(calls.processed, []);
});

test("the lease is released even when processing throws", async () => {
  const redis = fakeRedis();
  const tick = createCleanupTicker<Job>({
    lease: redisCleanupLease(redis),
    async listDue() { return [{ id: "a" }]; },
    async claim(job) { return job; },
    async process() { throw new Error("unexpected"); },
  });
  await assert.rejects(tick(), /unexpected/);
  assert.equal(redis.store.size, 0);
  assert.ok(await redisCleanupLease(redis).acquire());
});
