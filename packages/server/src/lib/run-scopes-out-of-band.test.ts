import test from "node:test";
import assert from "node:assert/strict";
import type { GameState, Worldbook } from "@yumina/engine";
import {
  advanceRunMemories,
  closeInactiveRunMemories,
  promptHistory,
  type RunMemories,
} from "./run-scopes.js";

// ── 回合之间切走的模块 ──
//
// A card whose frontend picks the narrator (a roster button writing a
// variable) changes the active module BETWEEN turns: no keyword fires, so no
// transition is ever detected and the outgoing module's run stayed open
// forever. An open run claims every later message, so that module's pool
// swallowed whoever narrated after it — come back to her and she reads the
// other girl's conversation.

const state = (who: string): GameState =>
  ({ variables: { sucker: who }, turnCount: 0 }) as unknown as GameState;
const at = (minute: number, second = 0) =>
  new Date(Date.UTC(2026, 0, 1, 0, minute, second)).toISOString();
const row = (minute: number, role: string, content: string) => ({ role, content, createdAt: at(minute) });

const girl = (who: string): Worldbook => ({
  id: `wb-${who.toLowerCase()}`,
  name: who,
  activation: {
    mode: "conditions",
    conditions: [{ variableId: "sucker", operator: "eq", value: who }],
    conditionLogic: "any",
  },
  station: { kind: "narrator", onClose: "keep", memoryPool: `pool-${who.toLowerCase()}` },
  order: 0,
});
const A = girl("A");
const B = girl("B");
const books = [A, B];

/** One committed turn, the way routes/messages.ts drives it: once for the
 *  prompt at the input boundary, once at commit with the reply's timestamp. */
const turn = (memories: RunMemories | null, who: string, inputAt: string, replyAt: string) =>
  advanceRunMemories(memories, books, state(who), state(who), state(who), inputAt, replyAt, state(who));

test("a module switched away between turns has its span closed at the next boundary", () => {
  const afterA = turn(null, "A", at(1), at(1, 30)).memories;
  assert.equal(afterA.open?.["wb-a"]?.fromAt, at(1), "A's run opens at her input");

  const afterB = turn(afterA, "B", at(2), at(2, 30));
  assert.equal(afterB.memories.open?.["wb-a"], undefined, "A's run no longer hangs open");
  const closedA = (afterB.memories.closed ?? []).find((r) => r.bookId === "wb-a");
  assert.ok(closedA, "A's span is recorded");
  assert.equal(closedA?.fromAt, at(1));
  assert.equal(closedA?.toAt, new Date(Date.parse(at(2)) - 1).toISOString(), "closed just before B's input");
  assert.ok(
    afterB.closedRecords.some((r) => r.bookId === "wb-a"),
    "the caller hears about the close, so the archive job still runs",
  );
});

test("a module read after someone else narrated sees only its own runs", () => {
  const rows = [
    row(0, "assistant", "greeting"),
    row(1, "user", "my name is Mu"),
    row(1, "assistant", "A replies"),
  ];
  let memories = turn(null, "A", at(1), at(1, 30)).memories;

  rows.push(row(2, "user", "who am I?"));
  const promptForB = advanceRunMemories(memories, books, state("B"), state("B"), state("B"), at(2), at(2)).memories;
  assert.deepEqual(
    promptHistory(rows, promptForB, books, new Set(["wb-b"])).rows.map((r) => r.content),
    ["who am I?"],
    "B never sees A's conversation",
  );
  memories = turn(memories, "B", at(2), at(2, 30)).memories;
  rows.push(row(2, "assistant", "B replies"));

  rows.push(row(3, "user", "what was my name again?"));
  const promptForA = advanceRunMemories(memories, books, state("A"), state("A"), state("A"), at(3), at(3)).memories;
  assert.deepEqual(
    promptHistory(rows, promptForA, books, new Set(["wb-a"])).rows.map((r) => r.content),
    ["my name is Mu", "A replies", "what was my name again?"],
    "A keeps her own two turns and gains none of B's",
  );
});

test("a module still active at the boundary keeps its open run", () => {
  const afterA = turn(null, "A", at(1), at(1, 30)).memories;
  const again = turn(afterA, "A", at(2), at(2, 30));
  assert.equal(again.memories.open?.["wb-a"]?.fromAt, at(1), "same run continues");
  assert.equal(again.memories.open?.["wb-a"]?.runIndex, 1);
  assert.equal((again.memories.closed ?? []).length, 0, "nothing is archived mid-run");
});

test("an open marker for a module the card no longer has is left alone", () => {
  const orphaned: RunMemories = { open: { "wb-deleted": { fromAt: at(1), runIndex: 1 } } };
  const out = closeInactiveRunMemories(orphaned, books, state("A"), at(2));
  assert.equal(out.memories.open?.["wb-deleted"]?.fromAt, at(1), "unknown module fails open");
  assert.equal(out.closedRecords.length, 0);
});

test("a nonsense boundary changes nothing", () => {
  const open: RunMemories = { open: { "wb-a": { fromAt: at(1), runIndex: 1 } } };
  const out = closeInactiveRunMemories(open, books, state("B"), "not-a-date");
  assert.equal(out.memories, open);
  assert.equal(out.closedRecords.length, 0);
});
