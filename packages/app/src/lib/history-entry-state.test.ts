import assert from "node:assert/strict";
import { test } from "node:test";
import {
  readHistoryEntryState,
  resolveHistoryEntryStateTransition,
  writeHistoryEntryState,
  type HistoryEntryStateStorage,
} from "./history-entry-state.js";

class MemoryStorage implements HistoryEntryStateStorage {
  private values = new Map<string, string>();

  get length() { return this.values.size; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

interface BoardState {
  sort: "latest" | "popular";
  page: number;
}

function isBoardState(value: unknown): value is BoardState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const state = value as Partial<BoardState>;
  return (state.sort === "latest" || state.sort === "popular")
    && typeof state.page === "number"
    && Number.isInteger(state.page)
    && state.page > 0;
}

test("restores view state only for the matching history entry and scope", () => {
  const storage = new MemoryStorage();
  const fallback: BoardState = { sort: "latest", page: 1 };
  writeHistoryEntryState(storage, "entry-a", "community-board", { sort: "popular", page: 3 });
  writeHistoryEntryState(storage, "entry-a", "other-scope", "kept separate");

  assert.deepEqual(
    readHistoryEntryState(storage, "entry-a", "community-board", fallback, isBoardState),
    { found: true, value: { sort: "popular", page: 3 } },
  );
  assert.deepEqual(
    readHistoryEntryState(storage, "entry-b", "community-board", fallback, isBoardState),
    { found: false, value: fallback },
  );
});

test("rejects malformed stored values and degrades without storage or a router key", () => {
  const storage = new MemoryStorage();
  const fallback: BoardState = { sort: "latest", page: 1 };
  writeHistoryEntryState(storage, "entry-a", "community-board", { sort: "invalid", page: -1 });

  assert.deepEqual(
    readHistoryEntryState(storage, "entry-a", "community-board", fallback, isBoardState),
    { found: false, value: fallback },
  );
  assert.deepEqual(
    readHistoryEntryState(null, "entry-a", "community-board", fallback, isBoardState),
    { found: false, value: fallback },
  );
  assert.deepEqual(
    readHistoryEntryState(storage, undefined, "community-board", fallback, isBoardState),
    { found: false, value: fallback },
  );
});

test("carries view state across replacement keys but isolates pushed entries", () => {
  const storage = new MemoryStorage();
  const fallback: BoardState = { sort: "latest", page: 1 };
  const current: BoardState = { sort: "popular", page: 4 };

  assert.deepEqual(
    resolveHistoryEntryStateTransition(
      storage,
      { key: "replacement-key", index: 3 },
      { index: 3, value: current },
      "community-board",
      fallback,
      isBoardState,
    ),
    current,
  );
  assert.deepEqual(
    resolveHistoryEntryStateTransition(
      storage,
      { key: "pushed-key", index: 4 },
      { index: 3, value: current },
      "community-board",
      fallback,
      isBoardState,
    ),
    fallback,
  );
});

test("restored snapshots take precedence over replacement carry-over", () => {
  const storage = new MemoryStorage();
  const fallback: BoardState = { sort: "latest", page: 1 };
  writeHistoryEntryState(storage, "visited-key", "community-board", { sort: "latest", page: 6 });

  assert.deepEqual(
    resolveHistoryEntryStateTransition(
      storage,
      { key: "visited-key", index: 3 },
      { index: 3, value: { sort: "popular", page: 4 } },
      "community-board",
      fallback,
      isBoardState,
    ),
    { sort: "latest", page: 6 },
  );
});
