import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  selectLaggedIncrementalTurn,
  selectLaggedRebuildWindow,
} from "./session-memory-core.js";

const here = dirname(fileURLToPath(import.meta.url));

// The lag-one invariant: session memory must never include the newest visible
// assistant reply. The incremental updater folds the exchange BEFORE the reply
// that just finished; the full rebuild stops before the last exchange. This
// keeps a regenerate/swipe of the newest reply unbiased by its own content.

type Row = {
  id: string;
  role: string;
  content: string;
  stateSnapshot?: Record<string, unknown> | null;
};

const row = (id: string, role: string, content: string, stateSnapshot?: Record<string, unknown>): Row => ({
  id,
  role,
  content,
  stateSnapshot: stateSnapshot ?? null,
});

const transcript: Row[] = [
  row("greet", "assistant", "greeting", { variables: { hp: 10 } }),
  row("u1", "user", "a"),
  row("r1", "assistant", "reply one", { variables: { hp: 9 } }),
  row("u2", "user", "b"),
  row("r2", "assistant", "reply two", { variables: { hp: 8 } }),
];

test("selectLaggedIncrementalTurn folds the exchange before the newest reply", () => {
  const turn = selectLaggedIncrementalTurn(transcript, "r2");
  assert.ok(turn);
  assert.equal(turn.assistantMessageId, "r1");
  assert.equal(turn.assistantMessage, "reply one");
  assert.equal(turn.userMessage, "a");
  assert.deepEqual(turn.stateSnapshot, { variables: { hp: 9 } });
});

test("selectLaggedIncrementalTurn returns null when the newest reply is the first assistant message", () => {
  const turn = selectLaggedIncrementalTurn([row("u1", "user", "a"), row("r1", "assistant", "reply one")], "r1");
  assert.equal(turn, null);
});

test("selectLaggedIncrementalTurn folds a greeting (no preceding user message) with an empty user side", () => {
  const rows = [row("greet", "assistant", "greeting"), row("u1", "user", "a"), row("r1", "assistant", "reply one")];
  const turn = selectLaggedIncrementalTurn(rows, "r1");
  assert.ok(turn);
  assert.equal(turn.assistantMessageId, "greet");
  assert.equal(turn.userMessage, "");
});

test("selectLaggedIncrementalTurn falls back to the last assistant when the current id is unknown", () => {
  const turn = selectLaggedIncrementalTurn(transcript, "deleted-id");
  assert.ok(turn);
  assert.equal(turn.assistantMessageId, "r1");
});

test("selectLaggedIncrementalTurn ignores system rows and handles empty transcripts", () => {
  assert.equal(selectLaggedIncrementalTurn([], "x"), null);
  assert.equal(selectLaggedIncrementalTurn([row("s1", "system", "sys"), row("u1", "user", "a")], "x"), null);
  const rows = [
    row("greet", "assistant", "greeting"),
    row("s1", "system", "sys"),
    row("u1", "user", "a"),
    row("r1", "assistant", "reply one"),
  ];
  const turn = selectLaggedIncrementalTurn(rows, "r1");
  assert.equal(turn?.assistantMessageId, "greet");
});

test("selectLaggedRebuildWindow stops before the last exchange", () => {
  const window = selectLaggedRebuildWindow(transcript);
  assert.deepEqual(window.rows.map((r) => r.id), ["greet", "u1", "r1"], "excludes the last exchange (u2 + r2)");
  assert.equal(window.processedMessageId, "r1");
});

test("selectLaggedRebuildWindow is empty when there is at most one assistant reply", () => {
  assert.deepEqual(selectLaggedRebuildWindow([]), { rows: [], processedMessageId: null });
  assert.deepEqual(selectLaggedRebuildWindow([row("u1", "user", "a")]), { rows: [], processedMessageId: null });
  assert.deepEqual(
    selectLaggedRebuildWindow([row("u1", "user", "a"), row("r1", "assistant", "reply one")]),
    { rows: [], processedMessageId: null },
  );
});

test("incremental + rebuild code paths both go through the lagged selectors", () => {
  const src = readFileSync(join(here, "session-memory.ts"), "utf8");
  assert.match(src, /const safeTip = replies\[1\]/, "incremental range must stop at the second-newest reply");
  assert.match(src, /pendingMemoryRange\(row.id, safeTip.id, cursor\?\.id \?\? null\)/, "pending range must use that lagged boundary");
  assert.match(src, /selectPendingMemoryBatch\(transcriptRows[,)]/, "incremental update must process the contiguous pending batch");
  assert.match(src, /selectLaggedRebuildWindow\(/, "full rebuild must exclude the last exchange");
  assert.match(src, /\.limit\(MAX_REBUILD_TRANSCRIPT_ROWS\)/, "full rebuild must not load unbounded history");
  assert.match(src, /\.limit\(MAX_INCREMENTAL_TRANSCRIPT_ROWS\)/, "per-turn updates must not load unbounded history");

  const rebuildBlock = src.slice(
    src.indexOf("async function regenerateSessionMemoryForSessionNow"),
    src.indexOf("export function regenerateSessionMemoryForSession"),
  );
  assert.doesNotMatch(
    rebuildBlock,
    /eq\(messages\.compacted, false\)/,
    "manual regeneration must include compacted history instead of returning an empty success",
  );
});

test("all session-context generators fail closed instead of crossing from BYOK to official keys", () => {
  const files = [
    "session-memory.ts",
    "session-compaction.ts",
    "summaryception.ts",
  ];

  for (const file of files) {
    const src = readFileSync(join(here, file), "utf8");
    assert.match(
      src,
      /resolveProviderForModel\([\s\S]*?allowOfficialFallback:\s*false/,
      `${file} must not silently route private-mode memory through an official key`,
    );
  }
});
