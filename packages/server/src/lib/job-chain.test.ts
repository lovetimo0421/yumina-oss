import test from "node:test";
import assert from "node:assert/strict";
import { enqueueKeyedJob } from "./job-chain.js";

// ─── Job-chain unhandled-rejection regression (2026-06-11) ──────────────────
// A failed background job used to log twice: once via the caller's .catch and
// once as [UNHANDLED REJECTION]. The map stored a `.finally()`-derived promise
// that re-propagates the job's rejection and never gets a handler. The stored
// entry must swallow rejections; the caller-facing promise must still reject
// so existing .catch logging keeps working, and the chain must stay usable.

const flushAsync = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

test("a rejected job rejects the caller promise without firing unhandledRejection", async () => {
  const chains = new Map<string, Promise<unknown>>();
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    let caught: unknown;
    await enqueueKeyedJob(chains, "session-1", () => Promise.reject(new Error("boom"))).catch((err) => {
      caught = err;
    });
    await flushAsync();
    assert.ok(caught instanceof Error && caught.message === "boom", "caller promise must reject with the job error");
    assert.equal(unhandled.length, 0, "stored chain entry must not fire unhandledRejection");
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }
});

test("a failed job does not poison the chain: later jobs run FIFO and the map is cleaned", async () => {
  const chains = new Map<string, Promise<unknown>>();
  const unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    const order: string[] = [];
    const first = enqueueKeyedJob(chains, "session-1", async () => {
      order.push("first");
      throw new Error("boom");
    }).catch(() => {
      order.push("first-caught");
    });
    const second = enqueueKeyedJob(chains, "session-1", async () => {
      order.push("second");
      return "ok";
    });
    await first;
    assert.equal(await second, "ok");
    assert.deepEqual(order, ["first", "first-caught", "second"], "jobs must run FIFO; failure must reach the caller");
    await flushAsync();
    assert.equal(unhandled.length, 0, "no unhandled rejections across a failed-then-successful chain");
    assert.equal(chains.size, 0, "settled chain must be removed from the map");
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
  }
});

test("independent keys do not serialize against each other", async () => {
  const chains = new Map<string, Promise<unknown>>();
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const order: string[] = [];
  const first = enqueueKeyedJob(chains, "session-1", async () => {
    await firstGate;
    order.push("session-1");
  });
  const second = enqueueKeyedJob(chains, "session-2", async () => {
    order.push("session-2");
  });
  await second;
  releaseFirst();
  await first;
  assert.deepEqual(order, ["session-2", "session-1"], "a busy key must not block other keys");
  await flushAsync();
  assert.equal(chains.size, 0);
});
