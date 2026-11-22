import { Session } from "node:inspector/promises";
import type { Profiler } from "node:inspector";

/** Summarize function locations only: never log source text, arguments, heap
 * objects or the full profile. Time includes sampled wall time, not CPU usage. */
export function summarizeCpuProfile(profile: Profiler.Profile) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const parents = new Map<number, number>();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const times = new Map<number, number>();
  for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
    const id = profile.samples![i]!;
    times.set(id, (times.get(id) ?? 0) + (profile.timeDeltas?.[i] ?? 0));
  }
  const frame = (id: number) => {
    const call = nodes.get(id)?.callFrame;
    const url = call?.url ?? "";
    const source = /^(file:|node:|\/|[A-Z]:\\)/i.test(url)
      ? url.split(/[?#]/)[0]!.slice(-180) : url ? "[dynamic]" : "[native]";
    return { function: (call?.functionName || "(anonymous)").slice(0, 100), source,
      line: (call?.lineNumber ?? -1) + 1 };
  };
  return {
    window_ms: Math.round((profile.endTime - profile.startTime) / 1000),
    samples: profile.samples?.length ?? 0,
    top: [...times].filter(([id]) => nodes.get(id)?.callFrame.functionName !== "(idle)")
      .sort((a, b) => b[1] - a[1]).slice(0, 25).map(([id, time]) => {
        const stack = [frame(id)];
        let parent = parents.get(id);
        while (parent !== undefined && stack.length < 8) {
          stack.push(frame(parent)); parent = parents.get(parent);
        }
        return { sampled_ms: Math.round(time / 1000), stack };
      }),
  };
}

/** Opt-in, one short profile per process. Does not open an inspector port. */
export async function captureBoundedCpuProfile(durationMs: number) {
  const session = new Session();
  try {
    session.connect();
    await session.post("Profiler.enable");
    await session.post("Profiler.setSamplingInterval", { interval: 10_000 });
    await session.post("Profiler.start");
    await new Promise<void>(resolve => { const timer = setTimeout(resolve, durationMs); timer.unref(); });
    const { profile } = await session.post("Profiler.stop");
    return summarizeCpuProfile(profile);
  } finally { session.disconnect(); }
}

type CpuProfileSummary = ReturnType<typeof summarizeCpuProfile>;
type StallTrigger = { event_loop_utilization: number; saturated_samples: number };

/** The boot-time capture only sees the first minutes of a process, but a
 * saturated replica can tip over at any point while its sibling idles on the
 * same traffic. Fed every runtime sample, this captures the stall itself: one
 * bounded profile after `consecutive` saturated samples, then a cooldown. */
export function createStallProfiler(options: {
  captureMs: number;
  onProfile: (profile: CpuProfileSummary, trigger: StallTrigger) => void;
  onError: (error: unknown) => void;
  threshold?: number;
  consecutive?: number;
  cooldownMs?: number;
  capture?: (durationMs: number) => Promise<CpuProfileSummary>;
  now?: () => number;
}): (eventLoopUtilization: number) => void {
  const { captureMs, onProfile, onError, threshold = 0.8, consecutive = 2,
    cooldownMs = 6 * 3600_000, capture = captureBoundedCpuProfile, now = Date.now } = options;
  let saturated = 0, running = false, lastCaptureAt = -Infinity;
  return (utilization) => {
    saturated = utilization >= threshold ? saturated + 1 : 0;
    if (captureMs <= 0 || running || saturated < consecutive || now() - lastCaptureAt < cooldownMs) return;
    running = true;
    lastCaptureAt = now();
    const trigger = { event_loop_utilization: utilization, saturated_samples: saturated };
    capture(captureMs)
      .then(profile => onProfile(profile, trigger))
      .catch(onError)
      .finally(() => { running = false; saturated = 0; });
  };
}
