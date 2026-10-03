import assert from "node:assert/strict";
import test from "node:test";
import { SandboxBootTiming } from "./sandbox-boot-timing";

test("a 45 second wall-clock boot with 40 seconds hidden records only 5 seconds in foreground", () => {
  let now = 0;
  const timing = new SandboxBootTiming(() => now, true);
  timing.mark("attached");
  now = 2_000; timing.setVisible(false);
  now = 42_000; timing.setVisible(true);
  now = 45_000; timing.mark("ready");
  assert.deepEqual(timing.snapshot(), {
    timing_version: 1, elapsed_ms: 45_000, foreground_ms: 5_000,
    background_ms: 40_000, page_visible: true, visibility_changes: 2,
    attached_ms: 0, ready_ms: 45_000,
  });
});

test("snapshots do not double-count time and repeated paints keep the first paint time", () => {
  let now = 100;
  const timing = new SandboxBootTiming(() => now, false);
  now = 200; timing.mark("loaded");
  timing.snapshot(); timing.snapshot();
  now = 300; timing.setVisible(true);
  now = 400; timing.mark("rendered");
  now = 600; timing.mark("rendered");
  assert.equal(timing.snapshot().background_ms, 200);
  assert.equal(timing.snapshot().foreground_ms, 300);
  assert.equal(timing.snapshot().rendered_ms, 300);
});
