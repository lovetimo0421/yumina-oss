import assert from "node:assert/strict";
import test from "node:test";
import { refreshMessageWindow } from "./refresh-message-window";
import { reconcileSessionStateConfirmation } from "../../lib/session-state-confirmation";

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

const checkpointMessages = () => [{
  id: "opening", createdAt: "2026-10-05T20:00:00.000Z", content: "Synthetic opening",
  metadata: { usage: { input: 12, output: 8 }, tags: ["opening", "room"], note: null as string | null },
}];
function checkpointSnapshot(messages: readonly unknown[]) {
  const gameState = { room: { rev: 1 } };
  const before = { session: { id: "room", state: { variables: gameState, turnCount: 0 } }, gameState, messages };
  const requested = { room: { rev: 2 } };
  return { before, requested, confirmed: { ...before.session.state, variables: requested } };
}
function jsonCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

test("unchanged JSON foreground refresh accepts a pending checkpoint PATCH acknowledgement", async () => {
  const messages = checkpointMessages();
  const { before, requested, confirmed } = checkpointSnapshot(messages);
  let current = before;
  let acknowledge!: () => void;
  const response = new Promise<void>(resolve => { acknowledge = resolve; });
  const pending = response.then(() => reconcileSessionStateConfirmation("room", before, current, requested, confirmed));
  const refreshed = await refreshMessageWindow(messages, async () => ({ data: jsonCopy(messages), meta: { hasMore: false } }));
  assert.ok(refreshed);
  current = { ...current, messages: refreshed.messages };
  acknowledge();
  assert.equal(await pending, confirmed);
  assert.equal(refreshed.messages, messages);
  assert.equal(refreshed.messages[0], messages[0]);
});

test("unchanged multi-page JSON refresh retains history identity and reports pagination metadata", async () => {
  const existing = rows.slice(200);
  const source = loader(jsonCopy(rows));
  const refreshed = await refreshMessageWindow(existing, source.load);
  assert.equal(source.calls.length, 3);
  assert.equal(refreshed?.messages, existing);
  assert.equal(refreshed?.hasEarlierMessages, true);

  const allLoaded = rows.slice();
  const complete = await refreshMessageWindow(allLoaded, loader(jsonCopy(rows)).load);
  assert.equal(complete?.messages, allLoaded);
  assert.equal(complete?.hasEarlierMessages, false);
});

test("JSON object insertion order does not invalidate unchanged message history", async () => {
  const messages = checkpointMessages();
  const original = messages[0]!;
  const reordered = [{
    metadata: { note: null, tags: ["opening", "room"], usage: { output: 8, input: 12 } },
    content: original.content, createdAt: original.createdAt, id: original.id,
  }];
  const refreshed = await refreshMessageWindow(messages, async () => ({ data: jsonCopy(reordered) }));
  assert.equal(refreshed?.messages, messages);
});

test("unchanged readonly history retains identity while pagination metadata changes", async () => {
  const messages = Object.freeze(checkpointMessages());
  for (const hasMore of [true, false]) {
    const refreshed = await refreshMessageWindow(messages, async () => ({ data: jsonCopy([...messages]), meta: { hasMore } }));
    assert.equal(refreshed?.messages, messages);
    assert.equal(refreshed?.hasEarlierMessages, hasMore);
  }
});

test("authoritative message content, metadata and history changes invalidate a pending checkpoint ACK", async () => {
  const messages = checkpointMessages();
  const { before, requested, confirmed } = checkpointSnapshot(messages);
  const changes = [
    [{ ...messages[0]!, content: "Edited opening" }],
    [{ ...messages[0]!, metadata: { ...messages[0]!.metadata, usage: { input: 12, output: 9 } } }],
    [{ ...messages[0]!, metadata: { ...messages[0]!.metadata, tags: ["room", "opening"] } }],
    [{ ...messages[0]!, metadata: { ...messages[0]!.metadata, tags: ["opening"] } }],
    [{ ...messages[0]!, metadata: { ...messages[0]!.metadata, note: "Changed" } }],
    [],
    [...messages, { ...messages[0]!, id: "new-turn", createdAt: "2026-10-05T20:00:01.000Z" }],
  ];
  for (const server of changes) {
    const refreshed = await refreshMessageWindow(messages, async () => ({ data: jsonCopy(server) }));
    assert.ok(refreshed);
    assert.deepEqual(refreshed.messages, server);
    assert.notEqual(refreshed.messages, messages);
    assert.equal(reconcileSessionStateConfirmation("room", before, { ...before, messages: refreshed.messages }, requested, confirmed), null);
  }
});

test("new or removed JSON object keys remain authoritative even when key counts match", async () => {
  const extra: Record<string, boolean> = { left: true };
  const messages = checkpointMessages().map(message => ({ ...message, extra }));
  const server = messages.map(message => ({ ...message, extra: { right: true } }));
  const refreshed = await refreshMessageWindow(messages, async () => ({ data: jsonCopy(server) }));
  assert.deepEqual(refreshed?.messages, server);
  assert.notEqual(refreshed?.messages, messages);
});

test("unchanged refresh preserves session switch, rewind, restore and newer state protections", async () => {
  const messages = checkpointMessages();
  const { before, requested, confirmed } = checkpointSnapshot(messages);
  const refreshed = await refreshMessageWindow(messages, async () => ({ data: jsonCopy(messages) }));
  assert.ok(refreshed);
  const current = { ...before, messages: refreshed.messages };
  const competingSnapshots = [
    { ...current, session: { ...before.session, id: "other" } },
    { ...current, messages: [] },
    { ...current, messages: jsonCopy(messages) },
    { ...current, session: { ...before.session, state: jsonCopy(before.session.state) } },
    { ...current, gameState: { room: { rev: 3 } } },
  ];
  for (const competing of competingSnapshots) {
    assert.equal(reconcileSessionStateConfirmation("room", before, competing, requested, confirmed), null);
  }
});
