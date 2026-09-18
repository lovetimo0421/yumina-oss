import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { runtimeIdentity } from "./runtime-identity.js";

type DelaySample = { p95_ms: number; max_ms: number; timer_drift_ms: number };
export function classifyRuntimeSample(sample: DelaySample): "event_loop_lag" | "server_runtime" {
  return sample.p95_ms >= 50 || sample.max_ms >= 1000 || sample.timer_drift_ms >= 1000
    ? "event_loop_lag" : "server_runtime";
}

/** Low-volume per-process heartbeat, including healthy periods. A p95-only
 * alert misses individual long freezes; timer drift also catches pauses before
 * the histogram's delayed sample runs. A stalled process reports on recovery. */
export function startRuntimeMonitor(
  report: (event: "event_loop_lag" | "server_runtime", properties: Record<string, unknown>) => void,
  intervalMs = 30_000,
): () => void {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();
  let lastTime = performance.now();
  let lastCpu = process.cpuUsage();
  let lastUtilization = performance.eventLoopUtilization();
  const timer = setInterval(() => {
    const now = performance.now(), windowMs = now - lastTime;
    const cpu = process.cpuUsage(), utilization = performance.eventLoopUtilization();
    const deltaUtilization = performance.eventLoopUtilization(utilization, lastUtilization);
    const memory = process.memoryUsage();
    const delay = {
      p95_ms: Math.round(histogram.percentile(95) / 1e6),
      max_ms: Math.round(histogram.max / 1e6),
      timer_drift_ms: Math.max(0, Math.round(windowMs - intervalMs)),
    };
    const properties = {
      ...runtimeIdentity, ...delay,
      window_ms: Math.round(windowMs),
      cpu_cores: (cpu.user + cpu.system - lastCpu.user - lastCpu.system) / (windowMs * 1000),
      event_loop_utilization: deltaUtilization.utilization,
      rss_bytes: memory.rss, heap_used_bytes: memory.heapUsed,
      uptime_seconds: Math.round(process.uptime()),
    };
    histogram.reset();
    lastTime = now; lastCpu = cpu; lastUtilization = utilization;
    try { report(classifyRuntimeSample(delay), properties); } catch { /* diagnostics cannot crash a server */ }
  }, intervalMs);
  timer.unref();
  return () => { clearInterval(timer); histogram.disable(); };
}
