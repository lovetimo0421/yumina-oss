import test from "node:test";
import assert from "node:assert/strict";
import { captureBoundedCpuProfile, createStallProfiler, summarizeCpuProfile } from "./cpu-profile.js";

test("a bounded real profile identifies busy JavaScript without dumping source or request values", async () => {
  const profile = captureBoundedCpuProfile(200);
  await new Promise(resolve => setTimeout(resolve, 20));
  function syntheticBusyWork() {
    const end = performance.now() + 150;
    while (performance.now() < end) Math.sqrt(Math.random());
  }
  syntheticBusyWork();
  await new Promise(resolve => setTimeout(resolve, 70));
  const result = await profile;
  assert.ok(result.samples > 0);
  assert.ok(result.top.some(entry => entry.stack.some(frame => frame.function === "syntheticBusyWork")));
  assert.ok(result.window_ms < 2000);
});

test("profile summaries omit dynamic source URLs and query strings", () => {
  const result = summarizeCpuProfile({
    startTime: 0, endTime: 10000, samples: [1], timeDeltas: [10000],
    nodes: [{ id: 1, callFrame: { functionName: "example", scriptId: "1",
      url: "data:text/javascript,private-source", lineNumber: 0, columnNumber: 0 } }],
  });
  assert.equal(result.top[0]?.stack[0]?.source, "[dynamic]");
  assert.ok(!JSON.stringify(result).includes("private-source"));
});

test("a stall capture waits for sustained saturation, runs once, then respects the cooldown", async () => {
  let clock = 0, captures = 0;
  const profiles: unknown[] = [];
  const empty = { window_ms: 0, samples: 0, top: [] };
  const feed = createStallProfiler({
    captureMs: 30_000, cooldownMs: 1000, now: () => clock,
    capture: async () => { captures++; return empty; },
    onProfile: (_profile, trigger) => profiles.push(trigger),
    onError: error => { throw error; },
  });
  feed(0.95); feed(0.3); feed(0.95);
  assert.equal(captures, 0, "one saturated sample between healthy ones is noise");
  feed(0.9);
  feed(0.9);
  assert.equal(captures, 1, "a capture already in flight is not doubled");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(profiles, [{ event_loop_utilization: 0.9, saturated_samples: 2 }]);
  feed(0.9); feed(0.9);
  assert.equal(captures, 1, "the cooldown holds after the capture finishes");
  clock = 1000;
  feed(0.9);
  assert.equal(captures, 2);
});

test("a disabled or failing stall capture never throws into the runtime monitor", async () => {
  let captures = 0;
  const errors: unknown[] = [];
  const off = createStallProfiler({ captureMs: 0, capture: async () => { captures++; throw new Error("x"); },
    onProfile: () => {}, onError: () => {} });
  off(1); off(1); off(1);
  assert.equal(captures, 0);
  const failing = createStallProfiler({ captureMs: 1000,
    capture: async () => { throw new Error("inspector unavailable"); },
    onProfile: () => {}, onError: error => errors.push(error) });
  failing(1); failing(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(errors.length, 1);
});
