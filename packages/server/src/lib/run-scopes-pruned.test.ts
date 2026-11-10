import test from "node:test";
import assert from "node:assert/strict";
import type { GameState, Worldbook } from "@yumina/engine";
import { advanceRunMemories, ensureActiveRunMemories, promptHistory, rebuildRunMemories } from "./run-scopes.js";

const state = (scene: string) => ({ variables: { scene }, turnCount: 1 }) as unknown as GameState;
const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
const book = (id: string): Worldbook => ({
  id, name: id, order: 0,
  activation: { mode: "conditions", conditions: [{ variableId: "scene", operator: "eq", value: id }], conditionLogic: "all" },
  station: { kind: "narrator", memoryPool: `pool-${id}`, onClose: "keep" },
});
const books = [book("a"), book("b")];
const original = [
  { role: "assistant", content: "B PRIVATE SECRET", createdAt: at(1), stateSnapshot: state("b") },
  { role: "user", content: "return to A", createdAt: at(2) },
  { role: "assistant", content: "A returns", createdAt: at(3), stateSnapshot: state("a") },
];

test("complete snapshots preserve each pool's known history when rebuilding", () => {
  const memories = rebuildRunMemories(books, original, state("a"), state("a"), "restored", at(3));
  assert.deepEqual(promptHistory(original, memories, books, new Set(["a"])).rows.map((row) => row.content), ["A returns"]);
  assert.equal(memories.closed?.[0]?.bookId, "b");
  assert.equal(memories.closed?.[0]?.preserveTranscript, true);
  assert.equal(memories.closed?.[0]?.summary, undefined);
});

test("rebuilding a reply-activated pool cannot backdate it over another pool's input", () => {
  const rows = [
    { role: "assistant", content: "A opening", createdAt: at(1), stateSnapshot: state("a") },
    { role: "user", content: "A PRIVATE INPUT", createdAt: at(2) },
    { role: "assistant", content: "B activated by reply", createdAt: at(3), stateSnapshot: state("b") },
  ];
  const live = advanceRunMemories(ensureActiveRunMemories(null, books, state("a"), at(1)),
    books, state("a"), state("a"), state("b"), at(2), at(3)).memories;
  const rebuilt = rebuildRunMemories(books, rows, state("a"), state("b"), "restored", at(3));
  const visible = (memories: typeof rebuilt) => promptHistory(rows, memories, books, new Set(["b"])).rows.map(row => row.content);
  assert.deepEqual(visible(live), ["B activated by reply"]);
  assert.deepEqual(visible(rebuilt), visible(live));
});

test("rebuilding an input-activated pool cannot give its input to the preceding pool", () => {
  const rows = [
    { role: "assistant", content: "A opening", createdAt: at(1), stateSnapshot: state("a") },
    { role: "user", content: "B PRIVATE INPUT", createdAt: at(2) },
    { role: "assistant", content: "B reply", createdAt: at(3), stateSnapshot: state("b") },
  ];
  const live = advanceRunMemories(ensureActiveRunMemories(null, books, state("a"), at(1)),
    books, state("a"), state("b"), state("b"), at(2), at(3)).memories;
  const rebuilt = rebuildRunMemories(books, rows, state("a"), state("b"), "restored", at(3));
  const visible = (memories: typeof rebuilt) => promptHistory(rows, memories, books, new Set(["a"])).rows.map(row => row.content);
  assert.deepEqual(visible(live), ["A opening"]);
  assert.deepEqual(visible(rebuilt), visible(live));
});

test("unchanged membership preserves intervening inputs across snapshot replay", () => {
  const rows = [
    { role: "assistant", content: "A opening", createdAt: at(1), stateSnapshot: state("a") },
    { role: "user", content: "A input", createdAt: at(2) },
    { role: "assistant", content: "A reply", createdAt: at(3), stateSnapshot: state("a") },
  ];
  const rebuilt = rebuildRunMemories(books, rows, state("a"), state("a"), "restored", at(3));
  assert.deepEqual(promptHistory(rows, rebuilt, books, new Set(["a"])).rows, rows);
});

test("a pruned snapshot prefix cannot assign B's private text to the default A pool", () => {
  const pruned = original.map((row, i) => i === 0 ? { ...row, stateSnapshot: null } : row);
  const memories = rebuildRunMemories(books, pruned, state("a"), state("a"), "restored", at(3));
  // The first surviving snapshot proves ownership only from its own row.
  // Before the fix, the default A state claimed all rows from second 1 and
  // made "B PRIVATE SECRET" visible to A after checkpoint/test-start restore.
  assert.equal(memories.open?.a?.fromAt, at(3));
  assert.deepEqual(promptHistory(pruned, memories, books, new Set(["a"])).rows.map((row) => row.content), ["A returns"]);
  assert.equal(pruned[0]!.content, "B PRIVATE SECRET", "unknown history remains stored, not deleted");
});

test("when all snapshots are pruned, a pool starts at the restore boundary and sees new inputs", () => {
  const pruned = original.map((row) => ({ ...row, stateSnapshot: null }));
  const memories = rebuildRunMemories(books, pruned, state("a"), state("a"), "restored", at(4));
  assert.equal(memories.open?.a?.fromAt, at(4));
  assert.deepEqual(promptHistory(pruned, memories, books, new Set(["a"])).rows, []);
  const nextRows = [...pruned, { role: "user", content: "new input", createdAt: at(5), stateSnapshot: null }];
  assert.deepEqual(promptHistory(nextRows, memories, books, new Set(["a"])).rows.map((row) => row.content), ["new input"]);
});
