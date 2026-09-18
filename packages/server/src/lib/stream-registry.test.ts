import test from "node:test";
import assert from "node:assert/strict";
import {
  registerStream,
  activeStreamCount,
  drainStreams,
  isShutdownAbort,
  isClientAbort,
  SHUTDOWN_ABORT_REASON,
} from "./stream-registry.js";

// ─── Stream registry (R2, 2026-06-09) ───────────────────────────────────────
// Deploys drain in-flight generations instead of killing them. These tests pin
// the registry lifecycle and, critically, the abort-reason semantics: a client
// abort (user stop / disconnect / credit exhaustion) must NEVER be confused
// with a shutdown abort — handlers skip persistence for the former and log
// usage + emit SERVER_RESTART for the latter.

test("register/unregister tracks the active count", () => {
  const before = activeStreamCount();
  const ac = new AbortController();
  const unregister = registerStream(ac);
  assert.equal(activeStreamCount(), before + 1);
  unregister();
  assert.equal(activeStreamCount(), before);
  unregister(); // double-unregister is a no-op
  assert.equal(activeStreamCount(), before);
});

test("drain with no active streams returns immediately", async () => {
  const start = Date.now();
  const result = await drainStreams(5_000);
  assert.ok(Date.now() - start < 1_000, "empty drain must not wait");
  assert.equal(result.finishedNaturally, true);
  assert.equal(result.abortedCount, 0);
});

test("drain waits for natural completion", async () => {
  const ac = new AbortController();
  const unregister = registerStream(ac);
  setTimeout(unregister, 600); // generation "finishes" mid-drain
  const result = await drainStreams(5_000);
  assert.equal(result.finishedNaturally, true);
  assert.equal(result.abortedCount, 0);
  assert.equal(ac.signal.aborted, false, "naturally-finished stream must not be aborted");
});

test("drain aborts stragglers with the shutdown reason at the deadline", async () => {
  const ac = new AbortController();
  const unregister = registerStream(ac);
  try {
    const result = await drainStreams(700);
    assert.equal(result.finishedNaturally, false);
    assert.equal(result.abortedCount, 1);
    assert.equal(ac.signal.aborted, true);
    assert.equal(ac.signal.reason, SHUTDOWN_ABORT_REASON);
    assert.equal(isShutdownAbort(ac.signal), true);
    assert.equal(isClientAbort(ac.signal), false, "shutdown abort must NOT read as client abort");
  } finally {
    unregister();
  }
});

test("client abort semantics: plain abort() and credit-abort are client aborts", () => {
  const plain = new AbortController();
  plain.abort(); // stream.onAbort path — no reason
  assert.equal(isClientAbort(plain.signal), true);
  assert.equal(isShutdownAbort(plain.signal), false);

  const fresh = new AbortController();
  assert.equal(isClientAbort(fresh.signal), false, "un-aborted signal is not a client abort");
  assert.equal(isShutdownAbort(fresh.signal), false);
});
