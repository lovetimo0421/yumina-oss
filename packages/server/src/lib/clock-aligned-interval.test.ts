import assert from "node:assert/strict";
import test from "node:test";

test("startup catch-up does not shift the global boundary, and shutdown cancels future ticks", async context => {
  const { startClockAlignedInterval } = await import("./clock-aligned-interval.js");
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-02T19:59:30Z") });
  const calls: string[] = [];
  const stop = startClockAlignedInterval(30 * 60_000, async now => { calls.push(now.toISOString()); }, error => { throw error; });
  try {
    await Promise.resolve();
    assert.deepEqual(calls, ["2026-10-02T19:59:30.000Z"]);
    context.mock.timers.tick(30_050);
    await Promise.resolve();
    assert.deepEqual(calls, ["2026-10-02T19:59:30.000Z", "2026-10-02T20:00:00.050Z"]);
    context.mock.timers.tick(30 * 60_000);
    await Promise.resolve();
    assert.equal(calls.at(-1), "2026-10-02T20:30:00.050Z");
    stop();
    context.mock.timers.tick(30 * 60_000);
    assert.equal(calls.length, 3);
  } finally { stop(); }
});

test("a busy boundary waits for the running task, then catches up without overlap", async context => {
  const { startClockAlignedInterval } = await import("./clock-aligned-interval.js");
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-02T19:59:30Z") });
  let release!: () => void;
  let calls = 0;
  const errors: unknown[] = [];
  const stop = startClockAlignedInterval(60_000, async () => {
    calls++;
    if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
    else if (calls === 2) throw new Error("temporary failure");
  }, error => errors.push(error));
  try {
    context.mock.timers.tick(30_050);
    assert.equal(calls, 1, "no concurrent copy of a slow startup sweep");
    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls, 2, "run the pending boundary immediately after startup completes");
    assert.equal(errors.length, 1);
    context.mock.timers.tick(60_000);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(calls, 3);
  } finally { stop(); }
});

test("shutdown cancels a boundary queued behind a slow task", async context => {
  const { startClockAlignedInterval } = await import("./clock-aligned-interval.js");
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.parse("2026-10-02T19:59:30Z") });
  let release!: () => void;
  let calls = 0;
  const stop = startClockAlignedInterval(60_000, async () => {
    calls++;
    await new Promise<void>(resolve => { release = resolve; });
  }, error => { throw error; });
  context.mock.timers.tick(30_050);
  stop();
  release();
  await Promise.resolve();
  await Promise.resolve();
  context.mock.timers.tick(60_000);
  assert.equal(calls, 1);
});
