import assert from "node:assert/strict";
import test from "node:test";
import {
  CHUNK_PROBE_BACKOFF_MS,
  recoverFromChunkError,
  shouldReloadForChunkError,
  type ChunkRecoveryDeps,
} from "./stale-chunk-reload";

// Regression pin: Safari reports ANY failed fetch as "Load failed", so it must
// stay in the matcher (it is how weak-network chunk failures reach recovery),
// while unrelated errors must not match.
test("shouldReloadForChunkError matches Safari's generic network failure", () => {
  assert.equal(shouldReloadForChunkError("Load failed"), true);
  assert.equal(shouldReloadForChunkError("TypeError: Load failed"), true);
  assert.equal(shouldReloadForChunkError("undefined is not a function"), false);
  assert.equal(shouldReloadForChunkError(null), false);
});

type ProbeScript = boolean[];

function makeDeps(script: {
  probe: ProbeScript;
  online?: boolean[];
  reloadResult?: boolean;
}) {
  const calls = {
    probeUrls: [] as string[],
    delays: [] as number[],
    onlineWaits: [] as number[],
    reloadReasons: [] as string[],
  };
  let probeIdx = 0;
  let onlineIdx = 0;
  const deps: ChunkRecoveryDeps = {
    probe: async (url) => {
      calls.probeUrls.push(url);
      const result = script.probe[Math.min(probeIdx, script.probe.length - 1)]!;
      probeIdx += 1;
      return result;
    },
    delay: async (ms) => {
      calls.delays.push(ms);
    },
    isOnline: () => {
      const seq = script.online ?? [true];
      const result = seq[Math.min(onlineIdx, seq.length - 1)]!;
      onlineIdx += 1;
      return result;
    },
    waitForOnline: async (timeoutMs) => {
      calls.onlineWaits.push(timeoutMs);
      return true;
    },
    reload: (reason) => {
      calls.reloadReasons.push(reason);
      return script.reloadResult ?? true;
    },
  };
  return { deps, calls };
}

test("reloads as soon as a probe confirms the network path works", async () => {
  const { deps, calls } = makeDeps({ probe: [true] });
  const outcome = await recoverFromChunkError(new Error("Load failed"), deps);
  assert.equal(outcome, "reloading");
  assert.equal(calls.reloadReasons.length, 1);
  assert.equal(calls.delays.length, 0);
});

test("retries with backoff while probes fail, then reloads on recovery", async () => {
  const { deps, calls } = makeDeps({ probe: [false, false, true] });
  const outcome = await recoverFromChunkError(new Error("Load failed"), deps);
  assert.equal(outcome, "reloading");
  assert.deepEqual(calls.delays, CHUNK_PROBE_BACKOFF_MS.slice(0, 2));
  assert.equal(calls.reloadReasons.length, 1);
});

test("gives up without reloading when the network never recovers", async () => {
  const { deps, calls } = makeDeps({ probe: [false] });
  const outcome = await recoverFromChunkError(new Error("Load failed"), deps);
  assert.equal(outcome, "give-up");
  assert.equal(calls.reloadReasons.length, 0);
  // One probe per attempt: initial + one per backoff step.
  assert.equal(calls.probeUrls.length, CHUNK_PROBE_BACKOFF_MS.length + 1);
  assert.deepEqual(calls.delays, CHUNK_PROBE_BACKOFF_MS);
});

test("waits for the browser to come back online before probing", async () => {
  const { deps, calls } = makeDeps({ probe: [true], online: [false, true] });
  const outcome = await recoverFromChunkError(new Error("Load failed"), deps);
  assert.equal(outcome, "reloading");
  assert.equal(calls.onlineWaits.length, 1);
});

test("gives up when the reload budget is exhausted even though the network works", async () => {
  const { deps, calls } = makeDeps({ probe: [true], reloadResult: false });
  const outcome = await recoverFromChunkError(new Error("Load failed"), deps);
  assert.equal(outcome, "give-up");
  assert.equal(calls.reloadReasons.length, 1);
});

test("probes the failing chunk URL when the error message names one", async () => {
  const { deps, calls } = makeDeps({ probe: [true] });
  await recoverFromChunkError(
    new Error(
      "Failed to fetch dynamically imported module: https://yumina.io/assets/chat-BqK3x9.js"
    ),
    deps
  );
  assert.equal(calls.probeUrls[0], "https://yumina.io/assets/chat-BqK3x9.js");
});

test("falls back to probing /index.html when no chunk URL is present", async () => {
  const { deps, calls } = makeDeps({ probe: [true] });
  await recoverFromChunkError(new Error("Load failed"), deps);
  assert.equal(calls.probeUrls[0], "/index.html");
});
