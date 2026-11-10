import test from "node:test";
import assert from "node:assert/strict";
import type { GameState, Worldbook } from "@yumina/engine";
import { advanceRunMemories, ensureActiveRunMemories, invalidateRunMemoryText, promptHistory, type RunMemories } from "./run-scopes.js";

const at = (hour: number) => `2026-09-06T${String(hour).padStart(2, "0")}:00:00.000Z`;
const state = (active: string[]): GameState => ({
  worldId: "world", metadata: {}, variables: { scene: active[0] ?? "" }, turnCount: 1,
  ruleState: { disabledRules: [], activeDirectives: [], cooldowns: {}, fireCounts: {}, prevVars: {}, toggledEntries: {}, toggledWorldbooks: { a: active.includes("a"), b: active.includes("b") } },
});
const book = (id: string): Worldbook => ({ id, name: id, order: 0, activation: { mode: "keywords", keywords: [id], exclusive: true }, station: { kind: "narrator", memoryPool: `private-${id}`, onClose: "archive" } });

test("keyword switching from an archived module preserves the triggering input in the new narrator prompt", () => {
  const books = [book("a"), book("b")];
  const memories: RunMemories = { open: { a: { fromAt: at(10), runIndex: 1 } } };
  const promptMemories = advanceRunMemories(memories, books, state(["a"]), state(["b"]), state(["b"]), at(11), at(11)).memories;
  const rows = [{ role: "user", content: "old A input", createdAt: at(10) }, { role: "user", content: "b: enter new dungeon", createdAt: at(11) }];
  const prompt = promptHistory(rows, promptMemories, books, new Set(["b"]));
  assert.ok(prompt.rows.some(row => row.role === "user" && row.content === rows[1]!.content), JSON.stringify(prompt));
});

test("a keyword module opened by input and closed by its reply still records the completed run", () => {
  const applied = advanceRunMemories({}, [book("b")], state([]), state(["b"]), state([]), at(11), at(12));
  assert.equal(applied.closedRecords.length, 1);
  assert.equal(applied.closedRecords[0]?.fromAt, at(11));
  assert.equal(applied.closedRecords[0]?.toAt, at(12));
});

test("regeneration cannot assign a preceding module input to a module first opened by the replaced reply", () => {
  const books = [book("a"), book("b")];
  const memories: RunMemories = { open: { b: { fromAt: at(12), runIndex: 1 } }, closed: [{ bookId: "a", runIndex: 1, fromAt: at(10), toAt: at(12), closedAt: at(12), summaryStatus: "ready", summary: "original future reply" }] };
  // Regenerate retains its existing post-reply state semantics. It rewrites
  // derived text at that reply, without backdating B to the preceding A input.
  const promptMemories = ensureActiveRunMemories(invalidateRunMemoryText(memories, at(12), "regen"), books, state(["b"]), at(12));
  assert.deepEqual(promptMemories.open?.b, memories.open?.b);
  assert.equal(promptMemories.closed?.[0]?.summary, undefined);
  assert.deepEqual(promptHistory([{ role: "user", content: "private A input", createdAt: at(11) }], promptMemories, books, new Set(["b"])).rows, []);
  const applied = advanceRunMemories(memories, books, state(["b"]), state(["b"]), state(["b"]), at(12), at(12), state(["b"]));
  const committed = invalidateRunMemoryText(applied.memories, at(12), "regen");
  assert.deepEqual(committed.open?.b, memories.open?.b);
  assert.equal(committed.closed?.[0]?.summary, undefined);
});

test("committing a reply preserves a module opened by a concurrent UI patch instead of replaying the old prompt transition", () => {
  const books: Worldbook[] = ["a", "b"].map(id => ({ ...book(id), activation: { mode: "conditions", conditions: [{ variableId: "scene", operator: "eq", value: id }], conditionLogic: "all" } }));
  const memories: RunMemories = {
    open: { b: { fromAt: at(12), runIndex: 1 } },
    closed: [{ bookId: "a", runIndex: 1, fromAt: at(10), toAt: at(12), closedAt: at(12), summaryStatus: "pending" }],
  };
  // Input at 11, UI patch from A to B at 12, unchanged reply commits at 13.
  // Send passes locked live state as previousState, its original prompt state,
  // and the reconciled final state, exactly this ordering.
  const applied = advanceRunMemories(memories, books, state(["b"]), state(["a"]), state(["b"]), at(11), at(13), state(["a"]));
  assert.deepEqual(applied.memories.open?.b, memories.open?.b);
  assert.deepEqual(applied.memories.closed, memories.closed);
  assert.deepEqual(applied.closedRecords, []);
});
