import assert from "node:assert/strict";
import test from "node:test";
import { isTranscriptPosition } from "../../sandbox/chat/transcript-position-types";
import { loadTranscriptPosition, saveTranscriptPosition } from "./transcript-position-storage";

test("checkpoints survive storage round trips, reject malformed values and remain account-scoped", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  } });
  const position = { version: 1 as const, sessionId: "s1", mode: "reading" as const,
    anchorId: "m100", offset: -20, top: 1000, expanded: true, loadedCount: 400 };
  try {
    saveTranscriptPosition("account-a", position);
    assert.deepEqual(loadTranscriptPosition("account-a", "s1"), position);
    assert.equal(loadTranscriptPosition("account-b", "s1"), null);
    assert.equal(loadTranscriptPosition("account-a", "s2"), null);
    for (const invalid of [{ ...position, top: Infinity }, { ...position, loadedCount: 1e9 }, { ...position, anchorId: {} }, { ...position, mode: "else" }]) {
      assert.equal(isTranscriptPosition(invalid), false);
    }
    for (let i = 0; i < 40; i++) saveTranscriptPosition("account-a", { ...position, sessionId: `session${i}` });
    assert.equal(Object.keys(JSON.parse([...values.values()][0]!)).length, 32);
    assert.equal(loadTranscriptPosition("account-a", "s1"), null);
  } finally {
    if (previous) Object.defineProperty(globalThis, "sessionStorage", previous); else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});
