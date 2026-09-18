import { test } from "node:test";
import assert from "node:assert";
import {
  decideBase,
  isFresh,
  shouldProbe,
  parseHealth,
  serializeHealth,
  UNKNOWN_HEALTH,
  STREAM_BASE_TTL_MS,
  type StreamBaseHealth,
} from "./stream-base-health";

const NOW = 1_000_000_000;
const healthy = (at: number): StreamBaseHealth => ({ status: "healthy", checkedAt: at });
const unhealthy = (at: number): StreamBaseHealth => ({ status: "unhealthy", checkedAt: at });

// The whole point of the change: a known-bad base must NOT cost the send path
// its 10s connect deadline. That was 10 dead seconds per message in China.
test("known-unreachable base routes straight to the proxy", () => {
  assert.equal(decideBase(unhealthy(NOW), NOW), "proxy");
});

test("known-reachable base uses the direct origin (keeps the CF-cut bypass)", () => {
  assert.equal(decideBase(healthy(NOW), NOW), "direct");
});

// Never regress the fast path for a network we have no reading on.
test("no reading falls back to today's inline try-direct", () => {
  assert.equal(decideBase(UNKNOWN_HEALTH, NOW), "try-direct");
});

test("a reading older than the TTL is not trusted", () => {
  assert.equal(decideBase(unhealthy(NOW - STREAM_BASE_TTL_MS - 1), NOW), "try-direct");
  assert.equal(decideBase(healthy(NOW - STREAM_BASE_TTL_MS - 1), NOW), "try-direct");
});

test("a reading just inside the TTL is trusted", () => {
  assert.equal(decideBase(unhealthy(NOW - STREAM_BASE_TTL_MS + 1), NOW), "proxy");
});

// This is what made the VPN look broken: a stale "unhealthy" kept the client
// off the direct base. A fresh probe must be able to flip it back the moment
// the network changes.
test("a fresh healthy probe overrides an earlier unhealthy reading", () => {
  const afterVpn = healthy(NOW);
  assert.equal(decideBase(afterVpn, NOW + 1_000), "direct");
});

test("clock moving backwards is not treated as a fresh reading", () => {
  assert.equal(isFresh(healthy(NOW + 60_000), NOW), false);
  assert.equal(decideBase(healthy(NOW + 60_000), NOW), "try-direct");
});

test("probe exactly when there is no fresh answer", () => {
  assert.equal(shouldProbe(UNKNOWN_HEALTH, NOW), true);
  assert.equal(shouldProbe(healthy(NOW - STREAM_BASE_TTL_MS - 1), NOW), true);
  assert.equal(shouldProbe(healthy(NOW), NOW), false);
  assert.equal(shouldProbe(unhealthy(NOW), NOW), false);
});

test("round-trips through storage", () => {
  const h = unhealthy(NOW);
  assert.deepEqual(parseHealth(serializeHealth(h)), h);
});

test("malformed or absent storage degrades to unknown, never to a wrong base", () => {
  assert.deepEqual(parseHealth(null), UNKNOWN_HEALTH);
  assert.deepEqual(parseHealth("not json"), UNKNOWN_HEALTH);
  assert.deepEqual(parseHealth('{"status":"bogus","checkedAt":123}'), UNKNOWN_HEALTH);
  assert.deepEqual(parseHealth('{"status":"healthy"}'), UNKNOWN_HEALTH);
  assert.deepEqual(parseHealth('{"status":"healthy","checkedAt":0}'), UNKNOWN_HEALTH);
  // Legacy value written by the old sticky (a bare timestamp string).
  assert.deepEqual(parseHealth("1752600000000"), UNKNOWN_HEALTH);
});
