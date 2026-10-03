import assert from "node:assert/strict";
import test from "node:test";
import { refreshMessageWindow } from "./refresh-message-window";

const rows = Array.from({ length: 650 }, (_, i) => ({
  id: `m${String(i).padStart(4, "0")}`, createdAt: new Date(1000 * i).toISOString(), content: `row ${i}`,
}));
function loader(server: typeof rows) {
  const calls: string[] = [];
  return { calls, load: async (before?: { id: string }) => {
    calls.push(before?.id ?? "latest");
    const beforeIndex = before ? server.findIndex((row) => row.id === before.id) : server.length;
    const data = server.slice(Math.max(0, beforeIndex - 200), beforeIndex);
    return { data, meta: { hasMore: beforeIndex > 200 } };
  } };
}
test("foreground refresh preserves 450 loaded rows and reconciles old edits/deletes", async () => {
  const original = rows.slice(200);
  const server = rows.filter((row) => row.id !== "m0250").map((row) => row.id === "m0300" ? { ...row, content: "edited" } : row);
  const source = loader(server);
  const result = await refreshMessageWindow(original, source.load);
  assert.equal(source.calls.length, 3);
  assert.equal(result?.messages.length, 449);
  assert.equal(result?.messages[0]?.id, "m0200");
  assert.equal(result?.messages.find((row) => row.id === "m0300")?.content, "edited");
  assert.equal(result?.messages.some((row) => row.id === "m0250"), false);
  assert.equal(result?.hasEarlierMessages, true);
});
test("revert and a deleted oldest anchor cannot resurrect stale messages", async () => {
  const source = loader(rows.slice(201, 550));
  const result = await refreshMessageWindow(rows.slice(200), source.load);
  assert.deepEqual(result?.messages, rows.slice(201, 550));
  assert.equal(result?.hasEarlierMessages, false);
});
test("refresh adds a completed assistant response without losing the oldest loaded row", async () => {
  const source = loader(rows);
  const result = await refreshMessageWindow(rows.slice(400, 649), source.load);
  assert.deepEqual(result?.messages, rows.slice(400));
});
test("errors, repeated cursors and large disjoint advances never return partial history", async () => {
  await assert.rejects(refreshMessageWindow(rows, async () => { throw new Error("offline"); }), /offline/);
  let calls = 0;
  const repeated = await refreshMessageWindow(rows, async () => {
    calls++;
    return { data: rows.slice(-200), meta: { hasMore: true } };
  });
  assert.equal(repeated, null);
  assert.equal(calls, 2);
  const source = loader(rows);
  assert.equal(await refreshMessageWindow(rows.slice(0, 2), source.load), null);
  assert.equal(source.calls.length, 3);
});

test("refresh reconciles edits and deletions across byte-limited one-row pages", async () => {
  const existing = rows.slice(640);
  const server = rows.filter((row) => row.id !== "m0645")
    .map((row) => row.id === "m0642" ? { ...row, content: "edited large turn" } : row);
  let calls = 0;
  const result = await refreshMessageWindow(existing, async (before) => {
    calls++;
    const end = before ? server.findIndex((row) => row.id === before.id) : server.length;
    return { data: server.slice(end - 1, end), meta: { hasMore: end > 1 } };
  });
  assert.equal(calls, 9);
  assert.deepEqual(result?.messages, server.filter((row) => row.id >= "m0640"));
  assert.equal(result?.hasEarlierMessages, true);
});

test("same-millisecond turns with different microseconds retain server order regardless of ID", async () => {
  const ordered = [
    { id: "z", createdAt: "2026-01-01T00:00:00.123100Z" },
    { id: "a", createdAt: "2026-01-01T00:00:00.123900Z" },
  ];
  let calls = 0;
  const result = await refreshMessageWindow(ordered, async (before) => {
    calls++;
    return { data: [ordered[before ? 0 : 1]!], meta: { hasMore: !before } };
  });
  assert.equal(calls, 2);
  assert.deepEqual(result?.messages, ordered);
  assert.equal(result?.hasEarlierMessages, false);
});
