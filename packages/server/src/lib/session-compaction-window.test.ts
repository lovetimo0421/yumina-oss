import test from "node:test";
import assert from "node:assert/strict";
import {
  selectCompactionWindow,
  selectForcedManualCompactionWindow,
  estimateMessagesTokens,
  type StoryMessageRow,
} from "./session-compaction-core.js";

// ─── Compaction window boundaries (Q2 test gap, 2026-06-10) ─────────────────
// The audit flagged "a message exactly at the token boundary could be
// double-compacted or skipped". That entire failure class reduces to one
// property: compactable + retained must PARTITION the relevant input — every
// user/assistant message lands in exactly one side, in order, none dropped.
// These tests pin that property across variable-length and degenerate shapes
// (the existing suite only used uniform synthetic messages).

function msg(id: string, role: "user" | "assistant" | "system", content: string): StoryMessageRow {
  return { id, role, content, attachments: null, createdAt: new Date("2026-01-01") } as StoryMessageRow;
}

function assertPartition(input: StoryMessageRow[], window: { compactable: StoryMessageRow[]; retained: StoryMessageRow[] }) {
  const relevant = input.filter((m) => m.role === "user" || m.role === "assistant");
  const recombined = [...window.compactable, ...window.retained];
  assert.equal(recombined.length, relevant.length, "messages lost or duplicated across the boundary");
  for (let i = 0; i < relevant.length; i++) {
    assert.equal(recombined[i]!.id, relevant[i]!.id, `order broken or message swapped at index ${i}`);
  }
  const compactableIds = new Set(window.compactable.map((m) => m.id));
  for (const r of window.retained) {
    assert.ok(!compactableIds.has(r.id), `message ${r.id} appears on BOTH sides of the boundary`);
  }
}

const OPTS = { triggerTokens: 100, recentTailTokens: 50, minCompactableTokens: 10 };

test("variable-length messages: window partitions cleanly (no loss, no double-compaction)", () => {
  const input = [
    msg("m1", "user", "a".repeat(400)),
    msg("m2", "assistant", "b".repeat(2000)),
    msg("m3", "user", "c".repeat(40)),
    msg("m4", "assistant", "d".repeat(900)),
    msg("m5", "user", "e".repeat(10)),
    msg("m6", "assistant", "f".repeat(1500)),
    msg("m7", "user", "g".repeat(300)),
    msg("m8", "assistant", "h".repeat(60)),
  ];
  const window = selectCompactionWindow(input, OPTS);
  assert.ok(window, "expected a window for an over-trigger conversation");
  assertPartition(input, window!);
  assert.ok(window!.compactable.length >= 4, "guard: compactable must stay >= 4");
  assert.ok(window!.retained.length >= 2, "guard: retained tail must stay >= 2");
});

test("single oversized message lands on exactly one side", () => {
  const input = [
    msg("m1", "user", "x".repeat(50)),
    msg("m2", "assistant", "x".repeat(50)),
    msg("m3", "user", "x".repeat(50)),
    msg("m4", "assistant", "x".repeat(50)),
    msg("m5", "user", "HUGE".repeat(5000)), // dwarfs the recentTail budget alone
    msg("m6", "assistant", "x".repeat(50)),
    msg("m7", "user", "x".repeat(50)),
  ];
  const window = selectCompactionWindow(input, OPTS);
  assert.ok(window, "expected a window");
  assertPartition(input, window!);
  const sides = [window!.compactable.some((m) => m.id === "m5"), window!.retained.some((m) => m.id === "m5")];
  assert.equal(sides.filter(Boolean).length, 1, "oversized message must be on exactly one side");
});

test("system messages are excluded but never break the partition of the rest", () => {
  const input = [
    msg("s0", "system", "sys".repeat(100)),
    msg("m1", "user", "x".repeat(800)),
    msg("m2", "assistant", "x".repeat(800)),
    msg("s1", "system", "sys"),
    msg("m3", "user", "x".repeat(800)),
    msg("m4", "assistant", "x".repeat(800)),
    msg("m5", "user", "x".repeat(800)),
    msg("m6", "assistant", "x".repeat(800)),
    msg("m7", "user", "x".repeat(800)),
    msg("m8", "assistant", "x".repeat(80)),
  ];
  const window = selectCompactionWindow(input, OPTS);
  assert.ok(window, "expected a window");
  assertPartition(input, window!);
  for (const side of [window!.compactable, window!.retained]) {
    assert.ok(side.every((m) => m.role !== "system"), "system rows must never enter the window");
  }
});

test("under-trigger and too-short conversations return null (no spurious compaction)", () => {
  const short = [msg("m1", "user", "hi"), msg("m2", "assistant", "yo"), msg("m3", "user", "ok")];
  assert.equal(selectCompactionWindow(short, OPTS), null, "<6 relevant messages must not compact");

  const small = Array.from({ length: 8 }, (_, i) => msg(`m${i}`, i % 2 ? "assistant" : "user", "tiny"));
  assert.equal(
    selectCompactionWindow(small, { ...OPTS, triggerTokens: 1_000_000 }),
    null,
    "below triggerTokens must not compact",
  );
});

test("forced manual window: retained count is exact and the partition holds", () => {
  const input = Array.from({ length: 9 }, (_, i) => msg(`m${i}`, i % 2 ? "assistant" : "user", "y".repeat(120)));
  const window = selectForcedManualCompactionWindow(input, { retainedMessageCount: 2, minCompactableMessages: 2 });
  assert.ok(window, "expected a forced window");
  assertPartition(input, window!);
  assert.equal(window!.retained.length, 2, "forced mode must retain exactly the requested count");
  assert.equal(window!.compactable.length, 7);
});

// ─── Forced compaction honors the configured raw tail (保留原文) ──────────────
// Regression: a forced manual "Compress Now" used to fall back to keeping ONLY
// the latest 2 raw messages, silently ignoring the session's recentTailTokens
// setting — so a user with 保留原文=12000 could watch their raw window collapse
// to ~1.6k tokens / 2 messages ("好像直接都 summarize 没有了"). Force must now
// keep the configured token tail and compact only what is older.

test("forced manual window (token-tail): honors the configured raw tail instead of crushing to 2", () => {
  const input = Array.from({ length: 10 }, (_, i) => msg(`m${i}`, i % 2 ? "assistant" : "user", "y".repeat(400)));
  // Budget sized to the last 5 messages → expect exactly those 5 retained.
  const tail = estimateMessagesTokens(input.slice(-5));
  const window = selectForcedManualCompactionWindow(input, { retainedTailTokens: tail });
  assert.ok(window, "expected a forced token-tail window");
  assertPartition(input, window!);
  assert.equal(window!.retained.length, 5, "tail must be sized by tokens, not crushed to 2");
  assert.ok(window!.compactable.length > 0, "must still compact the older messages");
  assert.ok(
    estimateMessagesTokens(window!.retained) >= tail,
    "retained tail must cover the configured token budget",
  );
});

test("forced manual window (token-tail): no-ops when the whole transcript fits the tail", () => {
  const input = Array.from({ length: 6 }, (_, i) => msg(`m${i}`, i % 2 ? "assistant" : "user", "y".repeat(120)));
  const oversizedTail = estimateMessagesTokens(input) * 10; // bigger than everything
  assert.equal(
    selectForcedManualCompactionWindow(input, { retainedTailTokens: oversizedTail }),
    null,
    "nothing older than the tail → genuine no-op, must NOT crush to the latest 2",
  );
});
