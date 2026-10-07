import test from "node:test";
import assert from "node:assert/strict";
import type { GameState, Worldbook } from "@yumina/engine";
import { advanceRunMemories, applyRunTransitions, attachRunSummary, ensureActiveRunMemories, invalidateRunMemoryText, promptHistory, rebuildRunMemories, restoreRunMemories, buildContextInputBlocks, type RunMemories } from "./run-scopes.js";

const at = (hour: number) => `2026-09-06T${String(hour).padStart(2, "0")}:00:00.000Z`;
const state = { variables: {}, turnCount: 0 } as GameState;
const narrator: Worldbook = { id: "n", name: "Narrator", order: 0, activation: { mode: "always" }, station: { kind: "narrator", memoryPool: "private", onClose: "archive" } };
const output = { bookId: "worker", index: 1, at: at(10), status: "ready" as const, text: "known fact" };
const record = { bookId: "n", runIndex: 1, fromAt: at(10), toAt: at(13), closedAt: at(13), summaryStatus: "ready" as const, summary: "future event", generation: "old" };

test("transitions preserve ready and pending worker slots and timeline identity", () => {
  const memories: RunMemories = { generation: "old", workers: [output, { ...output, index: 2, status: "pending" }] };
  const opened = applyRunTransitions(memories, { opened: ["n"], closed: [] }, at(10));
  const closed = applyRunTransitions(opened.memories, { opened: [], closed: ["n"] }, at(13));
  assert.deepEqual(closed.memories.workers, memories.workers);
  assert.equal(closed.memories.generation, "old");
  assert.equal(closed.closedRecords[0]?.generation, "old");
});

test("initially active pooled narrator receives the opening and current player input", () => {
  const memories = ensureActiveRunMemories(null, [narrator], state, at(10));
  const rows = [{ role: "assistant", content: "opening", createdAt: at(10) }, { role: "user", content: "hello", createdAt: at(11) }];
  assert.deepEqual(promptHistory(rows, memories, [narrator], new Set(["n"])).rows, rows);
  assert.equal(ensureActiveRunMemories(memories, [narrator], state, at(12)), memories, "steady turns do not reset the span");
});

test("legacy sessions start an untracked pool at the current input, not another module's history", () => {
  const memories = ensureActiveRunMemories({ workers: [output] }, [narrator], state, at(11));
  const rows = [{ role: "user", content: "private to another module", createdAt: at(10) }, { role: "user", content: "hello", createdAt: at(11) }];
  assert.deepEqual(promptHistory(rows, memories, [narrator], new Set(["n"])).rows, [rows[1]]);
  assert.deepEqual(memories.workers, [output]);
});

test("rewind inside an archived run reopens it and excludes future summaries and worker outputs", () => {
  const memories: RunMemories = { generation: "old", closed: [record], workers: [output, { ...output, index: 2, at: at(12) }, { ...output, index: 3, status: "pending" }] };
  const restored = restoreRunMemories(memories, [narrator], state, at(11), "new");
  assert.equal(restored.generation, "new");
  assert.deepEqual(restored.open?.n, { fromAt: at(10), runIndex: 1 });
  assert.deepEqual(restored.closed ?? [], []);
  assert.deepEqual(restored.workers, [output]);
  assert.equal(attachRunSummary(restored, record, "late stale summary"), null);
});

test("rewind before a run removes its future subscription even when source module is inactive", () => {
  const source: Worldbook = { ...narrator, id: "source", activation: { mode: "manual" } };
  const subscriber: Worldbook = { ...narrator, station: { kind: "narrator", inputs: [{ kind: "memory", from: "source" }] } };
  const restored = restoreRunMemories({ closed: [{ ...record, bookId: "source" }] }, [subscriber, source], state, at(9), "new");
  assert.deepEqual(buildContextInputBlocks({ worldbooks: [subscriber, source], activeBookIds: new Set(["n"]), memories: restored, alreadyInHistory: new Set(), rows: [], state }), []);
});

test("branch preserves completed earlier memories without mutating parent or retaining pending jobs", () => {
  const earlier = { ...record, toAt: at(11), closedAt: at(11) };
  const parent: RunMemories = { generation: "parent", closed: [earlier, { ...record, runIndex: 2, summaryStatus: "pending" }], workers: [output] };
  const before = structuredClone(parent);
  const branch = restoreRunMemories(parent, [narrator], state, at(12), "branch");
  assert.equal(branch.closed?.[0]?.summary, "future event");
  assert.equal(branch.closed?.length, 1);
  assert.deepEqual(parent, before);
  assert.equal(attachRunSummary(branch, earlier, "late parent result"), null);
});

test("restarting clears all derived results, rotates identity and opens the initial narrator", () => {
  const reset = restoreRunMemories(null, [narrator], state, at(10), "restart");
  assert.deepEqual(reset.workers, []);
  assert.deepEqual(reset.closed ?? [], []);
  assert.deepEqual(reset.open?.n, { fromAt: at(10), runIndex: 1 });
});

const manual: Worldbook = { ...narrator, activation: { mode: "keywords", keywords: ["enter"] } };
const enabled = { ...state, ruleState: { toggledWorldbooks: { n: true } } } as unknown as GameState;

test("keyword activation owns the triggering input, while reply activation starts at reply", () => {
  const early = advanceRunMemories(null, [manual], state, enabled, enabled, at(10), at(11));
  assert.equal(early.memories.open?.n?.fromAt, at(10));
  const late = advanceRunMemories(null, [manual], state, state, enabled, at(10), at(11));
  assert.equal(late.memories.open?.n?.fromAt, at(11));
});

test("a UI reopening after the keyword switch retains its committed boundary", () => {
  const a: Worldbook = { ...manual, id: "a" };
  const b: Worldbook = { ...manual, id: "b" };
  const active = (id: string) => ({ ...state, ruleState: { toggledWorldbooks: { [id]: true } } }) as unknown as GameState;
  const original = { open: { a: { fromAt: at(12), runIndex: 2 } } };
  const applied = advanceRunMemories(original, [a, b], active("a"), active("b"), active("a"), at(11), at(13), active("a"));
  assert.deepEqual(applied.memories.open?.a, original.open.a);
  assert.equal(applied.closedRecords.length, 1);
  assert.equal(applied.closedRecords[0]?.bookId, "b");
});

test("snapshot replay reconstructs private membership without inventing an archive", () => {
  const rows = [
    { role: "assistant", content: "outside", createdAt: at(9), stateSnapshot: state },
    { role: "user", content: "enter", createdAt: at(10), stateSnapshot: enabled },
    { role: "assistant", content: "inside", createdAt: at(11), stateSnapshot: enabled },
    { role: "assistant", content: "leave", createdAt: at(12), stateSnapshot: state },
  ];
  const restored = rebuildRunMemories([manual], rows, state, state, "replay", at(12));
  assert.equal(restored.closed?.[0]?.fromAt, at(10));
  assert.equal(restored.closed?.[0]?.preserveTranscript, true);
  assert.deepEqual(promptHistory(rows, restored, [manual], new Set()).rows, rows);
});

test("text rewrites retain private spans but discard stale derived text and pending results", () => {
  const memories: RunMemories = { generation: "old", closed: [record], workers: [output, { ...output, index: 2, at: at(12) }, { ...output, index: 3, status: "pending" }] };
  const result = invalidateRunMemoryText(memories, at(11), "edited");
  assert.equal(result.closed?.[0]?.summary, undefined);
  assert.equal(result.closed?.[0]?.preserveTranscript, true);
  assert.equal(result.closed?.[0]?.fromAt, record.fromAt);
  assert.deepEqual(result.workers, [output]);
  assert.equal(attachRunSummary(result, record, "stale"), null);
  assert.equal(memories.closed?.[0]?.summary, "future event");
});
