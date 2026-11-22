/**
 * Runs everything in the card translator that evaluates the card's own regexes (card-translate-literals.ts), off
 * the main thread. Each evaluation is stamped into shared memory (which pattern, since when), so runner.ts can see
 * a pattern that runs too long, stop this worker and go on without that pattern.
 */
import { parentPort, workerData } from "node:worker_threads";
import { cardLiterals, formatMarkers, lostMarkers, lostPatterns, patternClock, patternSample, restoreMarkers } from "../card-translate-literals.js";
import { CLOCK_KEY_LENGTH, CLOCK_KEY_MAX, CLOCK_RUNNING, type PatternCheck, type PatternJob, type PatternOutcome } from "./protocol.js";

const { buffer } = workerData as { buffer: SharedArrayBuffer };
const ints = new Int32Array(buffer, 0, 2);
const since = new Float64Array(buffer, 8, 1);
const key = new Uint16Array(buffer, 16, CLOCK_KEY_MAX);
let lastKey = "";

patternClock.enter = (source: string) => {
  if (source !== lastKey) {
    const n = Math.min(source.length, CLOCK_KEY_MAX);
    for (let i = 0; i < n; i++) key[i] = source.charCodeAt(i);
    Atomics.store(ints, CLOCK_KEY_LENGTH, n);
    lastKey = source;
  }
  since[0] = Date.now();
  Atomics.store(ints, CLOCK_RUNNING, 1);
};
patternClock.leave = () => { Atomics.store(ints, CLOCK_RUNNING, 0); };

function run(job: PatternJob): unknown {
  switch (job.op) {
    case "literals": return cardLiterals(job.schema, { all: job.skipAll, sources: new Set(job.skip) });
    case "markers": return formatMarkers(job.texts, job.patterns);
    case "check": return {
      lost: lostPatterns(job.src, job.out, job.patterns, job.opening).map((p) => ({ src: p.src, sample: patternSample(job.src, p) })),
      markers: lostMarkers(job.src, job.out, job.patterns),
    } satisfies PatternCheck;
    case "restore": return restoreMarkers(job.src, job.out, { values: new Set(), keys: new Set(job.keys), patterns: job.patterns, scans: [], listed: new Set() }, job.opening);
  }
}

parentPort?.on("message", (job: PatternJob) => {
  let outcome: PatternOutcome;
  try { outcome = { id: job.id, ok: true, value: run(job) }; } catch (err) { outcome = { id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) }; }
  patternClock.leave();
  parentPort!.postMessage(outcome);
});
parentPort?.postMessage({ ready: true });
