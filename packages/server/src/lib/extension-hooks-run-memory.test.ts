import assert from "node:assert/strict";
import test, { before, beforeEach, after } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import type { GameState, WorldDefinition } from "@yumina/engine";
import type { RunMemories, RunRecord } from "./run-scopes.js";

// Dependency initialization may construct the normal server pool, but no
// operation below uses it. Explicitly prevent .env from selecting real services.
Object.assign(process.env, { DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test", DATABASE_READ_URL: "", REDIS_URL: "", POSTHOG_API_KEY: "", BETTER_AUTH_SECRET: "unit-test-only", NODE_ENV: "test" });
const { runExtensionInvalidation, registerExtensionHooks } = await import("./extension-hooks.js");
const { SESSION_MEMORY_EXTENSION_KEY } = await import("@yumina/shared");
const { attachRunSummary } = await import("./run-scopes.js");
const { finishSlot } = await import("./worker-station.js");
const { messages } = await import("../db/schema.js");
const client = new PGlite();
const database = drizzle(client) as unknown as NonNullable<Parameters<typeof runExtensionInvalidation>[2]>;
const at = (minute: number) => new Date(Date.UTC(2026, 0, 1, 0, minute));
const state = (module: string): GameState => ({ worldId: "world", variables: { active: module }, turnCount: 3, metadata: { retained: true } }) as unknown as GameState;
const record = (from: number, to: number, summaryStatus: RunRecord["summaryStatus"] = "ready"): RunRecord => ({ generation: "old", bookId: "a", runIndex: from, fromAt: at(from).toISOString(), toAt: at(to).toISOString(), closedAt: at(to).toISOString(), summary: `OLD_${to}`, summaryStatus });
const old: RunMemories = {
  generation: "old", open: { a: { fromAt: at(40).toISOString(), runIndex: 4 } },
  closed: [record(1, 10), record(11, 20), record(21, 30), record(2, 4, "pending")],
  workers: [
    { generation: "old", bookId: "worker", index: 1, at: at(5).toISOString(), status: "ready", text: "SAFE" },
    { generation: "old", bookId: "worker", index: 2, at: at(20).toISOString(), status: "ready", text: "STALE" },
    { generation: "old", bookId: "worker", index: 3, at: at(6).toISOString(), status: "pending" },
  ],
};
const worldDef = { id: "world", name: "Test", variables: [{ id: "active", name: "Active", type: "string", defaultValue: "a" }], entries: [], rules: [], components: [], settings: {}, worldbooks: ["a", "b"].map(id => ({ id, name: id, order: 0, runScoped: true, activation: { mode: "conditions", conditions: [{ variableId: "active", operator: "eq", value: id }], conditionLogic: "all" } })) } as unknown as WorldDefinition;
const read = async () => (await client.query<{ state: GameState; run_memories: RunMemories; summary: string | null }>("SELECT state, run_memories, summary FROM play_sessions WHERE id='s1'")).rows[0]!;
before(async () => {
  await client.exec("CREATE TABLE play_sessions (id TEXT PRIMARY KEY, state JSONB, run_memories JSONB, summary TEXT, updated_at TIMESTAMP); CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, created_at TIMESTAMP, state_snapshot JSONB, content TEXT);");
});
beforeEach(async () => {
  await client.exec("DELETE FROM messages; DELETE FROM play_sessions;");
  await client.query("INSERT INTO play_sessions VALUES ('s1', $1, $2, 'unchanged extension summary', NOW())", [JSON.stringify(state("a")), JSON.stringify(old)]);
});
after(async () => client.close());

for (const reason of ["message-edited", "message-deleted", "message-swiped"] as const) {
  test(`${reason} invalidates derived text at and after the changed message and rotates generation`, async () => {
    await runExtensionInvalidation({ reason, sessionId: "s1", messageFlags: { createdAt: at(20) } }, undefined, database);
    const row = await read();
    assert.notEqual(row.run_memories.generation, "old");
    assert.deepEqual(row.run_memories.open, old.open);
    assert.equal(row.run_memories.closed![0]!.summary, "OLD_10");
    for (const item of row.run_memories.closed!.slice(1)) {
      assert.equal(item.summary, undefined);
      assert.equal(item.summaryStatus, "failed");
      assert.equal(item.preserveTranscript, true);
    }
    assert.deepEqual(row.run_memories.closed!.map(item => [item.fromAt, item.toAt]), old.closed!.map(item => [item.fromAt, item.toAt]));
    assert.deepEqual(row.run_memories.workers!.map(item => item.text), ["SAFE"]);
    assert.deepEqual(row.state, state("a"));
    assert.equal(row.summary, "unchanged extension summary");
    assert.equal(attachRunSummary(row.run_memories, old.closed![1]!, "LATE STALE SUMMARY"), null);
    await finishSlot("s1", old.workers![2]!, "LATE STALE WORKER", database);
    assert.deepEqual((await read()).run_memories, row.run_memories);
  });
}

test("missing message timestamp conservatively invalidates every derived result", async () => {
  await runExtensionInvalidation({ reason: "message-deleted", sessionId: "s1" }, undefined, database);
  const row = await read();
  assert.ok(row.run_memories.closed!.every(item => item.summary === undefined && item.preserveTranscript));
  assert.deepEqual(row.run_memories.workers, []);
});

test("swipe state and rebuilt module spans persist in the same transaction", async () => {
  const restored = state("b");
  await client.query("INSERT INTO messages (id,session_id,role,created_at,state_snapshot) VALUES ('greet','s1','assistant',$1,$2), ('user','s1','user',$3,NULL), ('changed','s1','assistant',$4,$5), ('foreign','s2','assistant',$6,$7)", [at(1), JSON.stringify(state("a")), at(19), at(20), JSON.stringify(restored), at(30), JSON.stringify(state("a"))]);
  await runExtensionInvalidation({ reason: "message-swiped", sessionId: "s1", worldDef, messageFlags: { createdAt: at(20) } }, { state: restored, summary: "extra caller field" }, database);
  const row = await read();
  assert.deepEqual(row.state, restored, "the caller's complete restored state must not be normalized or overwritten");
  assert.equal(row.summary, "extra caller field");
  assert.notEqual(row.run_memories.generation, "old");
  assert.equal(row.run_memories.open?.a, undefined);
  assert.ok(row.run_memories.open?.b);
  assert.equal(row.run_memories.open!.b!.fromAt, at(20).toISOString(), "restore scopes B from its first proven active snapshot");
  assert.ok(row.run_memories.closed!.every(item => item.summary === undefined && item.preserveTranscript));
  assert.ok(!row.run_memories.workers?.length);
});

test("failed atomic write rolls back the message mutation, invalidation and caller state together", async () => {
  await client.exec("ALTER TABLE play_sessions ADD CONSTRAINT reject_summary CHECK (summary <> 'rejected')");
  await client.exec("INSERT INTO messages (id,session_id,content) VALUES ('changed','s1','original')");
  let mutated = false;
  try {
    await assert.rejects(runExtensionInvalidation({ reason: "message-swiped", sessionId: "s1", messageFlags: { createdAt: at(20) } }, { state: state("b"), summary: "rejected" }, database, async (tx) => {
      await tx.update(messages).set({ content: "edited" }).where(eq(messages.id, "changed"));
      mutated = true;
      return { messageFlags: { createdAt: at(20) } };
    }));
    assert.equal(mutated, true);
    assert.equal((await client.query<{ content: string }>("SELECT content FROM messages WHERE id='changed'")).rows[0]!.content, "original");
    assert.deepEqual((await read()).state, state("a"));
    assert.deepEqual((await read()).run_memories, old);
  } finally { await client.exec("ALTER TABLE play_sessions DROP CONSTRAINT reject_summary"); }
});

test("a worker finishing while a message is mutated cannot write into the committed new generation", async () => {
  await client.exec("INSERT INTO messages (id,session_id,content) VALUES ('changed','s1','original')");
  let signalMutation!: () => void;
  let releaseMutation!: () => void;
  const mutationStarted = new Promise<void>(resolve => { signalMutation = resolve; });
  const allowCommit = new Promise<void>(resolve => { releaseMutation = resolve; });
  const mutation = runExtensionInvalidation({ reason: "message-edited", sessionId: "s1" }, undefined, database, async (tx) => {
    await tx.update(messages).set({ content: "edited" }).where(eq(messages.id, "changed"));
    signalMutation();
    await allowCommit;
    return { messageFlags: { createdAt: at(20) } };
  });
  await mutationStarted;
  const lateWorker = finishSlot("s1", old.workers![2]!, "STALE COMPLETION", database);
  releaseMutation();
  await Promise.all([mutation, lateWorker]);
  const row = await read();
  assert.notEqual(row.run_memories.generation, "old");
  assert.deepEqual(row.run_memories.workers!.map(item => item.text), ["SAFE"]);
  assert.equal(row.run_memories.closed![0]!.summary, "OLD_10", "post-mutation message flags set the actual cutoff");
  assert.equal((await client.query<{ content: string }>("SELECT content FROM messages WHERE id='changed'")).rows[0]!.content, "edited");
});

test("extension cleanup shares the atomic write and its follow-up sees committed memory and state", async () => {
  let observedCommit = false;
  registerExtensionHooks(SESSION_MEMORY_EXTENSION_KEY, { invalidate: () => ({
    sessionFields: { summary: null },
    runAfter: async () => {
      const row = await read();
      assert.equal(row.summary, null);
      assert.deepEqual(row.state, state("b"));
      assert.notEqual(row.run_memories.generation, "old");
      observedCommit = true;
    },
  }) });
  await runExtensionInvalidation({ reason: "message-swiped", sessionId: "s1", messageFlags: { createdAt: at(20) } }, { state: state("b") }, database);
  assert.equal(observedCommit, true);
});
