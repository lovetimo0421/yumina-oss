import test from "node:test";
import assert from "node:assert/strict";
import type { GameState, Worldbook } from "@yumina/engine";
import { detectRunTransitions, promptHistory, scopeRowsToRuns, type RunMemories } from "./run-scopes.js";

// ── memory pools ──
//
// "A and B share one memory, C and D share another." Inside A the AI has A's
// runs AND B's, and nothing from C. The card's own narrator, in the default
// pool, still sees everything.

const state = (dungeonId: string): GameState =>
  ({ variables: { "active-dungeon-id": dungeonId }, turnCount: 0 }) as unknown as GameState;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
const row = (minute: number, role = "assistant", content = `m${minute}`) => ({ role, content, createdAt: at(minute) });

const pooled = (id: string, pool: string, dungeonId: string): Worldbook => ({
  id,
  name: id,
  activation: { mode: "conditions", conditions: [{ variableId: "active-dungeon-id", operator: "eq", value: dungeonId }], conditionLogic: "all" },
  station: { kind: "narrator", onClose: "keep", memoryPool: pool },
  order: 0,
});
const town: Worldbook = { id: "wb-town", name: "主世界", activation: { mode: "always" }, order: 1 };
const poolA = pooled("wb-a", "pool-1", "a");
const poolB = pooled("wb-b", "pool-1", "b");
const poolC = pooled("wb-c", "pool-2", "c");

test("a pooled narrator is run-tracked even when it keeps its span", () => {
  const t = detectRunTransitions([poolA, poolB, poolC, town], state(""), state("a"));
  assert.deepEqual(t.opened, ["wb-a"]);
});

test("scopeRowsToRuns unions the spans of every module named", () => {
  const memories: RunMemories = {
    closed: [
      { bookId: "wb-a", runIndex: 1, fromAt: at(10), toAt: at(20), closedAt: at(20), summaryStatus: "pending" },
      { bookId: "wb-b", runIndex: 1, fromAt: at(30), toAt: at(40), closedAt: at(40), summaryStatus: "pending" },
      { bookId: "wb-c", runIndex: 1, fromAt: at(50), toAt: at(60), closedAt: at(60), summaryStatus: "pending" },
    ],
    open: { "wb-a": { fromAt: at(70), runIndex: 2 } },
  };
  const rows = [row(5), row(15), row(35), row(55), row(75)];
  assert.deepEqual(scopeRowsToRuns(rows, memories, ["wb-a", "wb-b"]).map((r) => r.content), ["m15", "m35", "m75"]);
  assert.deepEqual(scopeRowsToRuns(rows, memories, ["wb-c"]).map((r) => r.content), ["m55"]);
});

test("promptHistory: inside A the AI remembers B's runs, not C's; the town remembers all", () => {
  const rows = [row(5, "user", "town-1"), row(12, "user", "a-1"), row(22, "user", "b-1"), row(32, "user", "c-1"), row(42, "user", "a-2")];
  const memories: RunMemories = {
    closed: [
      { bookId: "wb-a", runIndex: 1, fromAt: at(12), toAt: at(13), closedAt: at(13), summaryStatus: "pending" },
      { bookId: "wb-b", runIndex: 1, fromAt: at(22), toAt: at(23), closedAt: at(23), summaryStatus: "pending" },
      { bookId: "wb-c", runIndex: 1, fromAt: at(32), toAt: at(33), closedAt: at(33), summaryStatus: "pending" },
    ],
    open: { "wb-a": { fromAt: at(40), runIndex: 2 } },
  };
  const books = [poolA, poolB, poolC, town];
  const insideA = promptHistory(rows, memories, books, new Set(["wb-a", "wb-town"]));
  assert.deepEqual(insideA.rows.map((r) => r.content), ["a-1", "b-1", "a-2"]);
  const insideC = promptHistory(rows, { ...memories, open: { "wb-c": { fromAt: at(40), runIndex: 2 } } }, books, new Set(["wb-c", "wb-town"]));
  assert.deepEqual(insideC.rows.map((r) => r.content), ["c-1", "a-2"]);
  const inTown = promptHistory(rows, memories, books, new Set(["wb-town"]));
  assert.deepEqual(inTown.rows.map((r) => r.content), ["town-1", "a-1", "b-1", "c-1", "a-2"]);
});
