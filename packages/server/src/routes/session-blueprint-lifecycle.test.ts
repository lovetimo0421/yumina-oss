import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { checkpoints, messages, playSessions, sessionLoreEntries, sessionStorageEntries, summaryceptionSnippets, user, userLibrary, userPersonas, userWorldPersonas, worldMemories, worlds } from "../db/schema.js";
import { branchSession, revertSession, sessionRoutes } from "./sessions.js";
import { promptHistory, type RunMemories } from "../lib/run-scopes.js";
import { GameStateManager, type WorldDefinition } from "@yumina/engine";
import { runTestStart, saveTestStart } from "../lib/studio-test-starts.js";

// Run the real route orchestration and SQL against an isolated, ephemeral
// PostgreSQL fixture. The shared/configured database is never queried.
test("blueprint memory follows session creation, rewind, restart, branches and checkpoints", async (t) => {
  const client = new PGlite();
  const local = drizzle(client);
  for (const method of ["select", "insert", "update", "delete", "execute", "transaction"] as const) {
    t.mock.method(db, method, (...args: unknown[]) => (local[method] as (...values: unknown[]) => unknown).apply(local, args));
  }
  try {
    // `user` because branch and revert both read the account row to stamp
    // persona metadata onto restored state — added to those paths after this
    // fixture was written, which is why both subtests died on a missing table.
    for (const table of [playSessions, messages, worlds, checkpoints, user, userPersonas, userWorldPersonas, userLibrary, worldMemories, summaryceptionSnippets, sessionLoreEntries, sessionStorageEntries]) {
      const config = getTableConfig(table);
      const columns = config.columns.map((column) => {
        const type = column.getSQLType().startsWith("vector") ? "text" : column.getSQLType();
        const fallback = type === "timestamp" ? " DEFAULT CURRENT_TIMESTAMP" : type === "boolean" ? " DEFAULT FALSE" : type === "integer" ? " DEFAULT 0" : "";
        return `"${column.name}" ${type}${column.primary ? " PRIMARY KEY" : ""}${fallback}`;
      });
      await client.exec(`CREATE TABLE "${config.name}" (${columns.join(", ")})`);
    }
    // Checkpoint restore locks the authenticated account before restoring its
    // media/storage references, so the fixture needs that account row too.
    await local.insert(user).values({ id: "u", name: "Player", email: "player@test.local" });
    const world: WorldDefinition = {
      id: "world", name: "Station test", version: "1.0.0", author: "test", description: "",
      entries: [{ id: "g", name: "Opening", role: "greeting", section: "system-presets", content: "Opening", enabled: true, alwaysSend: false, keywords: [], conditions: [], conditionLogic: "all", position: 0 }],
      variables: [], rules: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 1000, temperature: 1 },
      worldbooks: [{ id: "n", name: "Narrator", order: 0, activation: { mode: "always" }, station: { kind: "narrator", memoryPool: "private", onClose: "keep" } }],
    };
    await local.insert(worlds).values({ id: "world", creatorId: "u", name: world.name, status: "draft", schema: world as unknown as Record<string, unknown> });
    const call = async (path: string, params: Record<string, string>, body: unknown = {}) => {
      const route = sessionRoutes.routes.find((candidate) => candidate.method === "POST" && candidate.path === path);
      assert.ok(route, path);
      return await route.handler({
        get: () => ({ id: "u", name: "Player" }),
        req: { param: (key: string) => params[key], json: async () => body },
        json: (data: unknown, status = 200) => ({ data, status }),
      } as never, async () => {}) as unknown as { data: any; status: number };
    };
    const created = await call("/", {}, { worldId: "world", ephemeral: true });
    assert.equal(created.status, 201);
    const sessionId = created.data.data.id as string;
    const getSession = async (id = sessionId) => (await local.select().from(playSessions).where(eq(playSessions.id, id)))[0]!;
    const greeting = (await local.select().from(messages).where(eq(messages.sessionId, sessionId)))[0]!;
    const ledger = (await getSession()).runMemories as RunMemories;
    assert.equal(ledger.open?.n?.fromAt, greeting.createdAt!.toISOString());
    assert.deepEqual(promptHistory([greeting], ledger, world.worldbooks, new Set(["n"])).rows.map((row) => row.content), ["Opening"]);

    const start = greeting.createdAt!.getTime();
    const at = (seconds: number) => new Date(start + seconds * 1000).toISOString();
    const state = new GameStateManager(world).getSnapshot();
    await local.insert(messages).values([
      { id: "pivot", sessionId, role: "assistant", content: "Surviving event", stateSnapshot: state as unknown as Record<string, unknown>, createdAt: new Date(at(1)) },
      { id: "future", sessionId, role: "assistant", content: "Future event", stateSnapshot: state as unknown as Record<string, unknown>, createdAt: new Date(at(3)) },
    ]);
    const old: RunMemories = {
      ...ledger, generation: "old-timeline",
      workers: [
        { bookId: "worker", index: 1, at: at(0), status: "ready", text: "Past", generation: "old-timeline" },
        { bookId: "worker", index: 2, at: at(2), status: "ready", text: "Future", generation: "old-timeline" },
        { bookId: "worker", index: 3, at: at(0), status: "pending", generation: "old-timeline" },
      ],
    };
    await local.update(playSessions).set({ runMemories: old as unknown as Record<string, unknown> }).where(eq(playSessions.id, sessionId));
    await local.insert(sessionLoreEntries).values({
      id: "parent-lore",
      sessionId,
      kind: "created",
      name: "Current age",
      content: "The protagonist is now 25 years old.",
      enabled: true,
      alwaysSend: true,
      keywords: [],
      matchWholeWords: false,
    });

    await t.test("branch keeps eligible memories and open pool history without copying pending or future workers", async () => {
      const result = await branchSession({ userId: "u", sessionId, messageId: "pivot" });
      assert.equal(result.status, 201);
      const branch = await getSession(result.body.data!.sessionId);
      const memories = branch.runMemories as RunMemories;
      assert.notEqual(memories.generation, old.generation);
      assert.equal(memories.open?.n?.fromAt, ledger.open?.n?.fromAt);
      assert.deepEqual(memories.workers?.map((row) => row.text), ["Past"]);
      const copiedLore = await local.select().from(sessionLoreEntries).where(eq(sessionLoreEntries.sessionId, branch.id));
      assert.equal(copiedLore.length, 1);
      assert.notEqual(copiedLore[0]!.id, "parent-lore");
      assert.equal(copiedLore[0]!.content, "The protagonist is now 25 years old.");
    });

    await t.test("a failed rewind rolls back message deletion along with memory changes", async () => {
      await client.exec(`CREATE FUNCTION fail_timeline_save() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'simulated timeline write failure'; END $$;
        CREATE TRIGGER fail_timeline_save BEFORE UPDATE ON play_sessions FOR EACH ROW EXECUTE FUNCTION fail_timeline_save();`);
      try {
        await assert.rejects(revertSession({ userId: "u", sessionId, messageId: "pivot" }));
        assert.ok((await local.select().from(messages).where(eq(messages.id, "future")))[0]);
        assert.equal(((await getSession()).runMemories as RunMemories).generation, "old-timeline");
      } finally {
        await client.exec("DROP TRIGGER fail_timeline_save ON play_sessions; DROP FUNCTION fail_timeline_save()");
      }
    });

    await t.test("rewind prunes derived context in the same transaction as messages", async () => {
      const result = await revertSession({ userId: "u", sessionId, messageId: "pivot" });
      assert.equal(result.status, 200);
      const memories = (await getSession()).runMemories as RunMemories;
      assert.notEqual(memories.generation, old.generation);
      assert.deepEqual(memories.workers?.map((row) => row.text), ["Past"]);
      assert.deepEqual(result.body.data!.messages.map((row: any) => row.content), ["Opening", "Surviving event"]);
    });

    await t.test("restart clears previous workers while the new opening remains in its pool", async () => {
      const before = (await getSession()).runMemories as RunMemories;
      const result = await call("/:id/restart", { id: sessionId });
      assert.equal(result.status, 200);
      const after = (await getSession()).runMemories as RunMemories;
      assert.notEqual(after.generation, before.generation);
      assert.deepEqual(after.workers, []);
      const rows = await local.select().from(messages).where(eq(messages.sessionId, sessionId));
      assert.equal(rows.length, 1);
      assert.equal(after.open?.n?.fromAt, rows[0]!.createdAt!.toISOString());
      assert.equal(promptHistory(rows, after, world.worldbooks, new Set(["n"])).rows.length, 1);
    });

    await t.test("checkpoint restores its own spans rather than current-timeline worker context", async () => {
      const before = (await getSession()).runMemories as RunMemories;
      await local.insert(checkpoints).values({ id: "cp", sessionId, name: "saved", state: state as unknown as Record<string, unknown>, messages: [
        { id: "cp-msg", role: "assistant", content: "Checkpoint event", createdAt: at(1), stateSnapshot: state },
      ] });
      const result = await call("/:id/checkpoints/:checkpointId/restore", { id: sessionId, checkpointId: "cp" });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      const memories = (await getSession()).runMemories as RunMemories;
      assert.notEqual(memories.generation, before.generation);
      assert.equal(memories.workers?.length ?? 0, 0);
      const rows = await local.select().from(messages).where(eq(messages.sessionId, sessionId));
      assert.deepEqual(promptHistory(rows, memories, world.worldbooks, new Set(["n"])).rows.map((row) => row.content), ["Checkpoint event"]);
    });

    await t.test("saved studio starts rebuild their pool from the saved opening without future source memory", async () => {
      const sourceResult = await call("/", {}, { worldId: "world", ephemeral: true });
      assert.equal(sourceResult.status, 201);
      const source = sourceResult.data.data as typeof playSessions.$inferSelect;
      const saved = await saveTestStart("u", "world", source.id, "Saved opening", source.state);
      const future: RunMemories = {
        generation: "source-future",
        workers: [{ bookId: "worker", index: 1, at: at(10), status: "ready", text: "Future source worker" }],
      };
      await local.update(playSessions).set({ summary: "Future source summary", runMemories: future as unknown as Record<string, unknown> })
        .where(eq(playSessions.id, source.id));
      const replay = await runTestStart("u", "world", saved.id);
      const fresh = await getSession(replay.id);
      const memories = fresh.runMemories as RunMemories;
      const rows = await local.select().from(messages).where(eq(messages.sessionId, fresh.id));
      assert.notEqual(fresh.id, source.id);
      assert.equal(fresh.ephemeral, true);
      assert.equal(fresh.summary, null);
      assert.equal(fresh.sessionMemory, null);
      assert.notEqual(memories.generation, future.generation);
      assert.equal(memories.workers?.length ?? 0, 0);
      assert.equal(memories.open?.n?.fromAt, rows[0]!.createdAt!.toISOString());
      assert.deepEqual(promptHistory(rows, memories, world.worldbooks, new Set(["n"])).rows.map((row) => row.content), ["Opening"]);
      // Replaying an immutable saved start never resets the current source.
      assert.equal((await getSession(source.id)).summary, "Future source summary");
      assert.equal(((await getSession(source.id)).runMemories as RunMemories).workers?.[0]?.text, "Future source worker");
    });
  } finally {
    t.mock.restoreAll();
    await client.close();
  }
});
