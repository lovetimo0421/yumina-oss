import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  classifyMemoryOutput, generateCompleteMemory, generateHealthySessionMemory, hasUncertainMemoryCoverage,
  MAX_MEMORY_CHARS, MEMORY_TARGET_CHARS, normalizeSessionMemory, memoryBatchTurnLimit, selectPendingMemoryBatch, shouldUpdateSessionMemory,
  TruncatedSessionMemoryError,
} from "./session-memory-core.js";

const healthy = "Core facts:\n- Mei has the copper key.\nImportant decisions and promises:\n- Lin promised to return the map at dawn.\nCurrent risks and constraints:\n- The bridge closes at sunset.";
const longText = Array.from({ length: 200 }, (_, i) => createHash("sha256").update(String(i)).digest("hex")).join("\n");
const exchange = (i: number, text = `turn ${i}`) => [
  { id: `u${i}`, role: "user", content: text },
  { id: `r${i}`, role: "assistant", content: `reply ${i}` },
];

test("a normally finished but oversized memory cannot be accepted and silently sliced", () => {
  const text = Array.from({ length: 200 }, (_, i) => createHash("sha256").update(String(i)).digest("hex")).join("\n");
  assert.ok(text.length > MAX_MEMORY_CHARS);
  assert.equal(classifyMemoryOutput({ text, stopReason: "stop", completionTokens: 4500 }), "oversized");
});

test("complete memories above the writing target save whole without a paid shortening retry", async () => {
  for (const length of [7001, 7164, 7195, 7807, 9000, MAX_MEMORY_CHARS]) {
    const text = longText.slice(0, length).trim();
    assert.ok(text.length > MEMORY_TARGET_CHARS);
    let calls = 0;
    const verdicts: string[] = [];
    const memory = await generateCompleteMemory({
      generate: async () => { calls++; return { text, completionTokens: 5000, stopReason: "stop" }; },
      onAttempt: attempt => verdicts.push(attempt.verdict),
    });
    assert.equal(calls, 1);
    assert.deepEqual(verdicts, ["ok"]);
    assert.equal(memory.text, text);
    assert.equal(normalizeSessionMemory(memory).text, text, "read-side normalization must not slice accepted output");
  }
});

test("merged triggers and failed turns remain one contiguous pending batch", () => {
  const pending = [1, 2, 3].flatMap(i => exchange(i));
  const batch = selectPendingMemoryBatch(pending);
  assert.deepEqual(batch.rows.map(row => row.id), ["u1", "r1", "u2", "r2", "u3", "r3"]);
  assert.equal(batch.processedMessageId, "r3");
  assert.equal(batch.turns, 3);
});

test("model/language changes cannot certify legacy failed or abandoned attempt positions", () => {
  for (const status of ["failed", "updating"]) {
    assert.equal(hasUncertainMemoryCoverage({ sessionMemoryStatus: status, sessionMemorySourceHash: "old-sha256" }), true);
    assert.equal(hasUncertainMemoryCoverage({ sessionMemoryStatus: status, sessionMemorySourceHash: null }), true);
    assert.equal(hasUncertainMemoryCoverage({ sessionMemoryStatus: status, sessionMemorySourceHash: "v2:owner" }), false);
  }
  assert.equal(hasUncertainMemoryCoverage({ sessionMemoryStatus: "idle", sessionMemorySourceHash: "repair:v2:owner" }), true);
  assert.equal(hasUncertainMemoryCoverage({ sessionMemoryStatus: "idle", sessionMemorySourceHash: "old-success" }), false);
});

test("bounded batches only advance across complete exchanges and can drain without gaps", () => {
  const pending = [1, 2, 3].flatMap(i => exchange(i));
  const seen: string[] = [];
  let remaining = pending;
  while (remaining.length) {
    const batch = selectPendingMemoryBatch(remaining, 70);
    assert.equal(batch.rows.at(-1)?.role, "assistant");
    seen.push(...batch.rows.map(row => row.id));
    remaining = remaining.slice(batch.rows.length);
  }
  assert.deepEqual(seen, pending.map(row => row.id));
  const incomplete = selectPendingMemoryBatch([...exchange(1), { id: "u2", role: "user", content: "pending" }]);
  assert.equal(incomplete.processedMessageId, "r1", "a row-limit cut must leave the dangling user message pending");
  assert.throws(() => selectPendingMemoryBatch(exchange(1, "x".repeat(100)), 70), /too large/);
});

test("short conversations batch up; initial, large, failed and explicit updates bypass the delay", () => {
  const base = { pendingTurns: 1, pendingChars: 100, hasMemory: true, failed: false, overBudget: false };
  assert.equal(shouldUpdateSessionMemory(base), false);
  assert.equal(shouldUpdateSessionMemory({ ...base, pendingTurns: 2 }), false);
  for (const change of [{ pendingTurns: 3 }, { pendingChars: 4000 }, { hasMemory: false }, { failed: true }, { overBudget: true }, { force: true }]) {
    assert.equal(shouldUpdateSessionMemory({ ...base, ...change }), true);
  }
  assert.equal(shouldUpdateSessionMemory({ ...base, pendingTurns: 0, force: true, failed: true }), false);
});

test("oversized normal output is rewritten once at a smaller target and saved whole", async () => {
  const attempts: Array<[number, boolean]> = [];
  const memory = await generateCompleteMemory({
    generate: async (target, recovery) => {
      attempts.push([target, recovery]);
      return { text: recovery ? healthy : longText, completionTokens: 4500, stopReason: "stop" };
    },
  });
  assert.deepEqual(attempts, [[5000, false], [1500, true]]);
  assert.deepEqual(memory, { text: healthy });
  assert.ok(memory.text.endsWith("sunset."), "the final risk must survive acceptance intact");
});

test("truncation retries once and repeated truncation saves with a warning", async () => {
  let calls = 0;
  const memory = await generateCompleteMemory({
    generate: async () => {
      calls++;
      return { text: healthy, completionTokens: 8192, stopReason: "max_tokens" };
    },
  });
  assert.deepEqual(memory, { text: healthy, warning: "truncated" });
  assert.equal(calls, 2);
});

test("recovery may exceed its writing target but never the fixed acceptance ceiling", async () => {
  for (const length of [3501, 4500, 6999, 7000, 7807, MAX_MEMORY_CHARS]) {
    const memory = await generateCompleteMemory({
      generate: async (_target, recovery) => ({ text: recovery ? longText.slice(0, length) : longText, completionTokens: 2500, stopReason: "stop" }),
    });
    assert.equal(memory.text, longText.slice(0, length).trim());
  }
  const oversized = await generateCompleteMemory({
    generate: async () => ({ text: longText.slice(0, MAX_MEMORY_CHARS + 1), completionTokens: 2500, stopReason: "stop" }),
  });
  assert.equal(oversized.text, longText.slice(0, MAX_MEMORY_CHARS).trimEnd());
  assert.equal(oversized.warning, "truncated");
});

test("the actual provider output limit and shared attempt budget remain enforced", async () => {
  assert.equal(classifyMemoryOutput({ text: healthy, completionTokens: 4000, outputLimit: 4000 }), "truncated");
  let calls = 0;
  const memory = await generateCompleteMemory({
    canRecover: () => false,
    generate: async () => { calls++; return { text: healthy, completionTokens: 4000, outputLimit: 4000 }; },
  });
  assert.deepEqual(memory, { text: healthy, warning: "truncated" });
  assert.equal(calls, 1, "exhausted shared budgets must not add another repair attempt");
});

test("size-failed backlogs shrink to whole exchanges without losing pending evidence", () => {
  const rows = [1, 2, 3, 4, 5, 6].flatMap(i => exchange(i));
  const error = new TruncatedSessionMemoryError().message;
  assert.equal(memoryBatchTurnLimit(0, null), 3);
  assert.equal(memoryBatchTurnLimit(1, error), 2);
  assert.equal(memoryBatchTurnLimit(3, error), 1);
  let pending = rows;
  const seen: string[] = [];
  for (const [retries, reason] of [[3, error], [0, null], [0, null]] as const) {
    const batch = selectPendingMemoryBatch(pending, 60000, memoryBatchTurnLimit(retries, reason));
    assert.equal(batch.rows.at(-1)?.role, "assistant");
    seen.push(...batch.rows.map(r => r.id));
    pending = pending.slice(batch.rows.length);
  }
  assert.deepEqual(seen, rows.map(r => r.id));
  assert.equal(pending.length, 0);
});

test("repetitive truncation still uses the semantic fallback, with at most two total attempts", async () => {
  let calls = 0;
  const repetitive = "- 重复的记忆没有新事实。".repeat(900);
  const memory = await generateHealthySessionMemory({
    primaryModel: "primary", fallbackModel: "fallback", canRetry: async () => calls < 2,
    generate: async model => generateCompleteMemory({
      canRecover: () => calls < 2,
      generate: async () => {
        calls++;
        return { text: model === "primary" ? repetitive : healthy, completionTokens: model === "primary" ? 8192 : 100, stopReason: model === "primary" ? "max_tokens" : "stop" };
      },
    }),
  });
  assert.equal(memory.text, healthy);
  assert.equal(calls, 2);
});
