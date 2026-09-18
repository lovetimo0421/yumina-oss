import test from "node:test";
import assert from "node:assert/strict";
import { singleFlight } from "./single-flight.js";

// ─── Cache stampede (2026-08-15 502 incident) ───────────────────────────────
// model-price-cache's ensureLoaded() stamped `lastLoaded` only after its
// refresh resolved, so every caller that reached the staleness check first
// started its own refresh. loadMemoryUsage fans out with
// `Promise.all(rows.map(async … calculateCost …))` over thousands of usage
// rows, all of which enter that check in the same tick — 390 identical
// model-price SELECTs fired in one second, drained the 100-connection pool and
// starved the process. These tests pin the collapse.

/** A refresh that stays pending until the test releases it. */
function deferred() {
  let resolve!: (v: number) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<number>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("a burst of concurrent callers runs the work exactly once", async () => {
  let runs = 0;
  const gate = deferred();
  const run = singleFlight(async () => {
    runs++;
    return gate.promise;
  });

  // 500 callers in the same tick — the shape Promise.all(rows.map(...)) creates.
  const all = Promise.all(Array.from({ length: 500 }, () => run()));
  gate.resolve(42);
  const results = await all;

  assert.equal(runs, 1, "the underlying refresh must not stampede");
  assert.deepEqual(new Set(results), new Set([42]), "every caller gets the shared result");
});

test("a later call after settling starts a fresh run", async () => {
  let runs = 0;
  const run = singleFlight(async () => {
    runs++;
    return runs;
  });

  assert.equal(await run(), 1);
  assert.equal(await run(), 2, "the slot must be released once the run settles");
  assert.equal(runs, 2);
});

test("a failed run is not cached — the next caller retries", async () => {
  let runs = 0;
  const run = singleFlight(async () => {
    runs++;
    if (runs === 1) throw new Error("db down");
    return runs;
  });

  await assert.rejects(run(), /db down/);
  assert.equal(await run(), 2, "a rejection must not poison the slot forever");
});

test("everyone in a failing burst sees the same rejection, and it runs once", async () => {
  let runs = 0;
  const gate = deferred();
  const run = singleFlight(async () => {
    runs++;
    return gate.promise;
  });

  const all = Promise.allSettled(Array.from({ length: 50 }, () => run()));
  gate.reject(new Error("boom"));
  const settled = await all;

  assert.equal(runs, 1);
  assert.ok(settled.every((r) => r.status === "rejected"), "all callers observe the failure");
});
