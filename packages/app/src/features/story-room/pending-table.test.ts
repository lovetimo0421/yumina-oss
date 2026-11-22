import assert from "node:assert/strict";
import test from "node:test";
import { rememberPendingTable, takePendingTable } from "./pending-table";

const store = new Map<string, string>();
(globalThis as { sessionStorage?: unknown }).sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

test("an invite's table code is read once, by the card it was for", () => {
  store.clear();
  rememberPendingTable("w1", "ab23");
  assert.equal(takePendingTable("w1"), "AB23");
  assert.equal(takePendingTable("w1"), null, "read once");
});

test("another version of the card still gets the code, once", () => {
  store.clear();
  rememberPendingTable("w1", "CD45");
  assert.equal(takePendingTable("w2"), "CD45");
  assert.equal(takePendingTable("w1"), null, "taking it clears every copy");
});

test("a bad code is ignored", () => {
  store.clear();
  rememberPendingTable("w1", "x");
  assert.equal(takePendingTable("w1"), null);
});
