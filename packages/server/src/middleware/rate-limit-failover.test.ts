import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkRateLimit, checkSideCallRateLimit, acquireConcurrency, releaseConcurrency } from "./rate-limit.js";

// ─── Redis failover guard (R3, 2026-06-09) ─────────────────────────────────
// Before this fix, a down Redis meant every rate-limited request stalled on
// the command timeout and then failed CLOSED — a sitewide outage mode. The
// failover falls back to per-instance in-memory counters with halved limits.
// The in-memory behavior is tested directly (it runs when REDIS_URL is unset,
// exactly as in this test process); the Redis-path wiring is pinned by source
// assertions because the client handle is module-level, not injectable.

test("in-memory sliding window: allows up to max, then blocks with a sane retryAfter", async () => {
  const userId = `test-user-${Date.now()}`;
  for (let i = 0; i < 3; i++) {
    assert.equal(await checkRateLimit(userId, 3), null, `request ${i + 1} of 3 should pass`);
  }
  const blocked = await checkRateLimit(userId, 3);
  assert.ok(blocked, "4th request should be rate limited");
  assert.equal(blocked.code, "RATE_LIMITED");
  assert.ok(blocked.retryAfter > 0 && blocked.retryAfter <= 60, `retryAfter ${blocked.retryAfter} out of range`);
});

test("side-call limiter uses its own window: exhausting the main pool must not block side calls, and vice versa", async () => {
  const userId = `test-side-${Date.now()}`;
  // Exhaust the main pool
  for (let i = 0; i < 3; i++) {
    assert.equal(await checkRateLimit(userId, 3), null);
  }
  assert.ok(await checkRateLimit(userId, 3), "main pool should be exhausted");
  // Side pool must still be open
  assert.equal(await checkSideCallRateLimit(userId, 3), null, "side call must not consume the main window");
  // And exhausting the side pool must not touch a fresh main-pool user
  const userId2 = `test-side2-${Date.now()}`;
  for (let i = 0; i < 3; i++) {
    assert.equal(await checkSideCallRateLimit(userId2, 3), null, `side request ${i + 1} of 3 should pass`);
  }
  const blocked = await checkSideCallRateLimit(userId2, 3);
  assert.ok(blocked, "4th side request should be rate limited");
  assert.equal(blocked.code, "RATE_LIMITED");
  assert.equal(await checkRateLimit(userId2, 3), null, "main window must be untouched by side calls");
});

test("in-memory concurrency: acquire to cap, deny, release frees a slot", async () => {
  const userId = `test-conc-${Date.now()}`;
  assert.equal(await acquireConcurrency(userId, 2), true);
  assert.equal(await acquireConcurrency(userId, 2), true);
  assert.equal(await acquireConcurrency(userId, 2), false, "3rd acquire over cap=2 must be denied");
  await releaseConcurrency(userId);
  assert.equal(await acquireConcurrency(userId, 2), true, "release must free a slot");
  await releaseConcurrency(userId);
  await releaseConcurrency(userId);
});

const here = dirname(fileURLToPath(import.meta.url));

test("Redis paths fail over (not closed): every redis branch is wrapped and falls back via alertRedisFallback + fallbackMax", () => {
  const src = readFileSync(join(here, "rate-limit.ts"), "utf8");
  // One failover catch per redis-touching operation.
  const catches = src.match(/alertRedisFallback\("/g) ?? [];
  assert.ok(catches.length >= 3, `expected ≥3 failover sites (slidingWindow, acquire, release), found ${catches.length}`);
  // Fallback limits must be halved, never zero.
  assert.match(src, /function fallbackMax/, "fallbackMax helper missing");
  assert.match(src, /memSlidingWindowCheck\(key, fallbackMax\(max\)/, "sliding-window failover must use halved limits");
  // The old fail-closed strings must be gone from the runtime path.
  assert.ok(!src.includes("failing closed"), "fail-closed path should be replaced by failover");
});

test("side completions are concurrency-gated: acquire before stream, release in finally", () => {
  // The side-call pool is 100/min with deduct-after-stream billing, so the
  // concurrency gate is the only thing bounding parallel platform-key spend.
  const src = readFileSync(join(here, "..", "routes", "completions.ts"), "utf8");
  assert.match(src, /acquireConcurrency\(concurrencyKey, SIDE_CALL_MAX_CONCURRENT\)/, "side completions must acquire a concurrency slot");
  assert.match(src, /finally \{[\s\S]*?releaseConcurrency\(concurrencyKey\)/, "concurrency slot must be released in the stream finally");
});

test("redis client config: offline queue disabled, startup connect failures are non-fatal", () => {
  const src = readFileSync(join(here, "..", "lib", "redis.ts"), "utf8");
  assert.match(src, /enableOfflineQueue: false/, "offline queue must be disabled for instant failover");
  const connectBlock = src.slice(src.indexOf("export async function connectRedis"));
  assert.match(connectBlock, /catch/, "connectRedis must catch unreachable-Redis instead of failing boot");
  assert.match(connectBlock, /captureServerError\("redis-startup-unreachable"/, "startup degradation must be captured");
});
