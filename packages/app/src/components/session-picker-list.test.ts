import assert from "node:assert/strict";
import test from "node:test";
import { matchesSaveLocally, normalizeSaveQuery, orderSaves, readSaveSort, writeSaveSort } from "./session-picker-list";
import { requestMessageJump, takeMessageJump } from "../lib/pending-message-jump";

const save = (id: string, patch: Partial<{ name: string; pinnedAt: string | null; messageCount: number; createdAt: string; updatedAt: string }> = {}) => ({
  id, name: patch.name ?? id, pinnedAt: patch.pinnedAt ?? null, messageCount: patch.messageCount ?? 0,
  createdAt: patch.createdAt ?? "2026-01-01T00:00:00Z", updatedAt: patch.updatedAt ?? "2026-01-01T00:00:00Z",
});

test("pinned saves come first (newest pin on top), then the chosen sort", () => {
  const saves = [
    save("a", { updatedAt: "2026-03-01T00:00:00Z", createdAt: "2026-01-03T00:00:00Z", messageCount: 5, name: "Save 10" }),
    save("b", { updatedAt: "2026-02-01T00:00:00Z", createdAt: "2026-01-01T00:00:00Z", messageCount: 50, name: "Save 2" }),
    save("c", { updatedAt: "2026-01-01T00:00:00Z", createdAt: "2026-01-02T00:00:00Z", messageCount: 20, name: "alpha", pinnedAt: "2026-04-01T00:00:00Z" }),
    save("d", { updatedAt: "2026-04-01T00:00:00Z", createdAt: "2026-01-04T00:00:00Z", messageCount: 1, name: "beta", pinnedAt: "2026-04-02T00:00:00Z" }),
  ];
  const name = (s: { name: string }) => s.name;
  assert.deepEqual(orderSaves(saves, "recent", name).map((s) => s.id), ["d", "c", "a", "b"]);
  assert.deepEqual(orderSaves(saves, "oldest", name).map((s) => s.id), ["d", "c", "b", "a"]);
  assert.deepEqual(orderSaves(saves, "messages", name).map((s) => s.id), ["d", "c", "b", "a"]);
  // Numeric collation: "Save 2" before "Save 10".
  assert.deepEqual(orderSaves(saves, "name", name).map((s) => s.id), ["d", "c", "b", "a"]);
  assert.deepEqual(orderSaves(saves.map((s) => ({ ...s, pinnedAt: null })), "name", name).map((s) => s.id), ["c", "d", "b", "a"]);
});

test("the instant match folds case and whitespace", () => {
  assert.equal(normalizeSaveQuery("  Old \n  Mill "), "Old Mill");
  assert.equal(matchesSaveLocally(["The old\n\nmill", null], "old mill"), true);
  assert.equal(matchesSaveLocally(["灯笼下的钥匙"], "钥匙"), true);
  assert.equal(matchesSaveLocally([undefined, "nothing"], "mill"), false);
});

test("the sort is remembered per user and survives blocked storage", () => {
  const store = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: {
    getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value),
  } } });
  try {
    assert.equal(readSaveSort("u1"), "recent");
    writeSaveSort("u1", "messages");
    assert.equal(readSaveSort("u1"), "messages");
    assert.equal(readSaveSort("u2"), "recent");
    store.set("yumina:save-picker-sort:u2", "bogus");
    assert.equal(readSaveSort("u2"), "recent");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { get localStorage(): Storage { throw new Error("blocked"); } } });
    assert.equal(readSaveSort("u1"), "recent");
    assert.doesNotThrow(() => writeSaveSort("u1", "name"));
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete (globalThis as { window?: unknown }).window;
  }
});

test("a requested jump is taken once, only by its own session", () => {
  requestMessageJump({ sessionId: "s1", messageId: "m9", position: 9, query: "lantern" });
  assert.equal(takeMessageJump("s2"), null);
  assert.deepEqual(takeMessageJump("s1"), { sessionId: "s1", messageId: "m9", position: 9, query: "lantern" });
  assert.equal(takeMessageJump("s1"), null);
});
