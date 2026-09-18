import test from "node:test";
import assert from "node:assert/strict";
import { captureBoundedCpuProfile, summarizeCpuProfile } from "./cpu-profile.js";

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
