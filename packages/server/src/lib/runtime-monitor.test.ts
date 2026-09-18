import assert from "node:assert/strict";
import test from "node:test";
import { classifyRuntimeSample, startRuntimeMonitor } from "./runtime-monitor.js";

test("a severe individual freeze is reported even when the percentile looks healthy", () => {
  assert.equal(classifyRuntimeSample({ p95_ms: 32, max_ms: 1201, timer_drift_ms: 0 }), "event_loop_lag");
});
test("a timer delayed by a host pause is reported even before the histogram records it", () => {
  assert.equal(classifyRuntimeSample({ p95_ms: 20, max_ms: 30, timer_drift_ms: 120_000 }), "event_loop_lag");
});
test("sustained lag remains visible, while a healthy sample is a heartbeat", () => {
  assert.equal(classifyRuntimeSample({ p95_ms: 75, max_ms: 90, timer_drift_ms: 20 }), "event_loop_lag");
  assert.equal(classifyRuntimeSample({ p95_ms: 20, max_ms: 50, timer_drift_ms: 1 }), "server_runtime");
});

test("runtime samples identify their process and continue if a telemetry send throws", async () => {
  let count = 0;
  let finish!: (properties: Record<string, unknown>) => void;
  const next = new Promise<Record<string, unknown>>((resolve) => { finish = resolve; });
  const keepAlive = setTimeout(() => {}, 2000);
  const stop = startRuntimeMonitor((_event, properties) => {
    if (++count === 1) throw new Error("telemetry offline");
    finish(properties);
  }, 20);
  try {
    const properties = await next;
    assert.equal(properties.process_id, process.pid);
    assert.equal(typeof properties.replica_id, "string");
    assert.equal(typeof properties.boot_id, "string");
    assert.ok(Number.isFinite(properties.cpu_cores));
    assert.ok(Number.isFinite(properties.event_loop_utilization));
    assert.ok(Number(properties.rss_bytes) > 0);
  } finally { stop(); clearTimeout(keepAlive); }
});
