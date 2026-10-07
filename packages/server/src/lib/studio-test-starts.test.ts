import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { readFile } from "node:fs/promises";
import { and, eq, is, SQL, sql } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";

// These are real transaction/permission tests against an isolated local DB.
// Refuse a configured network database even if a developer forgets the flags.
if (process.env.DATABASE_URL?.trim()) throw new Error("Test starts regression refuses a network DATABASE_URL");
process.env.DATABASE_URL = ""; // prevents dotenv from filling a local .env URL
process.env.DATABASE_READ_URL = "";
process.env.PGLITE_DATA_DIR = "memory://"; // never use an existing on-disk database
process.env.BETTER_AUTH_SECRET ||= "studio-test-local-only-secret";
process.env.REDIS_URL = "";
process.env.NODE_ENV = "test";
const { db } = await import("../db/index.js");
const { user, worlds, playSessions, messages, checkpoints, worldPendingEdits } = await import("../db/schema.js");
const { saveTestStart, listTestStarts, runTestStart, deleteTestStart, TestStartError, STUDIO_TEST_HOLDER_PREFIX } = await import("./studio-test-starts.js");
const creatorId = `test-start-creator-${crypto.randomUUID()}`;
const playerId = `test-start-player-${crypto.randomUUID()}`;
let worldId: string;
let otherWorldId: string;
let sourceId: string;
const originalState = { worldId: "schema", variables: { hp: 4, removed: 2 }, turnCount: 3, activeGreetingId: "opening-b",
  metadata: { activeLoreSlots: ["secret"] }, ruleState: { toggledWorldbooks: { dungeon: true }, fireCounts: { gate: 1 } } };
const schema = { id: "schema", name: "Test start card", entries: [],
  variables: [{ id: "hp", name: "HP", type: "number", defaultValue: 10 }, { id: "removed", name: "Old", type: "number", defaultValue: 0 }] };
before(async () => {
  // Generate only the participating tables from the shipped Drizzle schema.
  // The legacy global bootstrap currently ALTERs unrelated absent social
  // tables; these tests need the real session/checkpoint FKs, not that system.
  const tables = [user, worlds, playSessions, messages, checkpoints, worldPendingEdits];
  const dialect = new PgDialect();
  const executeDdl = (statement: ReturnType<typeof sql>) => db.execute(sql.raw(dialect.sqlToQuery(statement.inlineParams()).sql));
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  for (const table of tables) {
    const config = getTableConfig(table);
    const columns = config.columns.map((column) => {
      const value = typeof column.default === "object" && !is(column.default, SQL) ? JSON.stringify(column.default) : column.default;
      return sql`${sql.identifier(column.name)} ${sql.raw(column.getSQLType())}${value !== undefined ? sql` DEFAULT ${value}` : sql``}${column.primary ? sql` PRIMARY KEY` : sql``}`;
    });
    await executeDdl(sql`CREATE TABLE ${sql.identifier(config.name)} (${sql.join(columns, sql`, `)})`);
  }
  for (const table of tables) for (const fk of getTableConfig(table).foreignKeys) {
    const ref = fk.reference();
    if (!tables.includes(ref.foreignTable as typeof user)) continue;
    await executeDdl(sql`ALTER TABLE ${sql.identifier(getTableConfig(table).name)} ADD FOREIGN KEY (${sql.join(ref.columns.map((column) => sql.identifier(column.name)), sql`, `)}) REFERENCES ${sql.identifier(getTableConfig(ref.foreignTable).name)} (${sql.join(ref.foreignColumns.map((column) => sql.identifier(column.name)), sql`, `)}) ON DELETE ${sql.raw(fk.onDelete ?? "no action")}`);
  }
  await db.insert(user).values([
    { id: creatorId, name: "Creator", email: `${creatorId}@test.local`, emailVerified: true },
    { id: playerId, name: "Player", email: `${playerId}@test.local`, emailVerified: true },
  ]);
  const [world] = await db.insert(worlds).values({ creatorId, name: "Card", status: "draft", schema }).returning();
  worldId = world!.id;
  const [other] = await db.insert(worlds).values({ creatorId, name: "Other card", status: "draft", schema }).returning();
  otherWorldId = other!.id;
  const [source] = await db.insert(playSessions).values({ userId: creatorId, worldId, ephemeral: true, state: originalState }).returning();
  sourceId = source!.id;
  await db.insert(messages).values({ sessionId: sourceId, role: "assistant", content: "At the gate", stateSnapshot: originalState, summaryceptionCompacted: true });
});
after(async () => {
  await db.delete(user).where(eq(user.id, creatorId));
  await db.delete(user).where(eq(user.id, playerId));
  await (db as unknown as { $client: { close: () => Promise<void> } }).$client.close();
});

test("named starts survive source deletion and are hidden from ordinary sessions", async () => {
  const saved = await saveTestStart(creatorId, worldId, sourceId, "  Before dungeon B  ");
  assert.equal(saved.name, "Before dungeon B");
  assert.equal(saved.messageCount, 1);
  const [cp] = await db.select().from(checkpoints).where(eq(checkpoints.id, saved.id));
  assert.ok(cp!.sessionId.startsWith(STUDIO_TEST_HOLDER_PREFIX));
  assert.notEqual(cp!.sessionId, sourceId);
  const [holder] = await db.select().from(playSessions).where(eq(playSessions.id, cp!.sessionId));
  assert.equal(holder!.ephemeral, true);
  assert.equal((await db.select().from(playSessions).where(and(eq(playSessions.userId, creatorId), eq(playSessions.ephemeral, false)))).length, 0);
  // Closing the ordinary playtest must not cascade into the separately held start.
  const run = await runTestStart(creatorId, worldId, saved.id);
  const fromRun = await saveTestStart(creatorId, worldId, run.id, "Exit test");
  await db.delete(playSessions).where(eq(playSessions.id, run.id));
  assert.ok((await listTestStarts(creatorId, worldId)).some((row) => row.id === fromRun.id));
});

test("every operation rejects another user, another card and ordinary checkpoint ids", async () => {
  const saved = await saveTestStart(creatorId, worldId, sourceId, "Access checks");
  const denied = (error: unknown) => error instanceof TestStartError && error.status === 404;
  await assert.rejects(() => listTestStarts(playerId, worldId), denied);
  await assert.rejects(() => saveTestStart(playerId, worldId, sourceId, "No"), denied);
  await assert.rejects(() => saveTestStart(creatorId, otherWorldId, sourceId, "No"), denied);
  await assert.rejects(() => runTestStart(playerId, worldId, saved.id), denied);
  await assert.rejects(() => runTestStart(creatorId, otherWorldId, saved.id), denied);
  await assert.rejects(() => deleteTestStart(playerId, worldId, saved.id), denied);
  await assert.rejects(() => deleteTestStart(creatorId, otherWorldId, saved.id), denied);
  const [ordinary] = await db.insert(checkpoints).values({ sessionId: sourceId, name: "Player checkpoint", messages: [], state: originalState }).returning();
  await assert.rejects(() => runTestStart(creatorId, worldId, ordinary!.id), denied);
  await assert.rejects(() => deleteTestStart(creatorId, worldId, ordinary!.id), denied);
  assert.deepEqual(await listTestStarts(creatorId, otherWorldId), []);
});

test("reruns use current creator draft with fresh message IDs and never overwrite source or published card", async () => {
  const saved = await saveTestStart(creatorId, worldId, sourceId, "Replay");
  const [before] = await db.select().from(checkpoints).where(eq(checkpoints.id, saved.id));
  await db.update(worlds).set({ status: "published" }).where(eq(worlds.id, worldId));
  const working = { ...schema, variables: [schema.variables[0], { id: "new", name: "New", type: "number", defaultValue: 42 }] };
  await db.insert(worldPendingEdits).values({ worldId, createdBy: creatorId, groupKey: worldId, status: "draft", schema: working });
  const runA = await runTestStart(creatorId, worldId, saved.id);
  const runB = await runTestStart(creatorId, worldId, saved.id);
  assert.notEqual(runA.id, runB.id);
  const [session] = await db.select().from(playSessions).where(eq(playSessions.id, runA.id));
  assert.equal(session!.ephemeral, true);
  assert.deepEqual(session!.state.variables, { hp: 4, new: 42 });
  assert.equal(session!.state.activeGreetingId, "opening-b");
  assert.deepEqual(session!.state.metadata, originalState.metadata);
  const rowsA = await db.select().from(messages).where(eq(messages.sessionId, runA.id));
  const rowsB = await db.select().from(messages).where(eq(messages.sessionId, runB.id));
  assert.equal(rowsA[0]?.content, "At the gate");
  assert.notEqual(rowsA[0]?.id, rowsB[0]?.id);
  assert.equal(rowsA[0]?.summaryceptionCompacted, false);
  await db.update(playSessions).set({ state: { ...originalState, variables: { hp: 1 } } }).where(eq(playSessions.id, runA.id));
  const [afterCheckpoint] = await db.select().from(checkpoints).where(eq(checkpoints.id, saved.id));
  assert.deepEqual(afterCheckpoint, before);
  const [live] = await db.select().from(worlds).where(eq(worlds.id, worldId));
  assert.deepEqual(live!.schema, schema);
  const [source] = await db.select().from(playSessions).where(eq(playSessions.id, sourceId));
  assert.deepEqual(source!.state, originalState);
});

test("same-name saves remain independent; explicit delete removes only the chosen holder", async () => {
  const a = await saveTestStart(creatorId, worldId, sourceId, "Same name");
  const b = await saveTestStart(creatorId, worldId, sourceId, "Same name");
  assert.notEqual(a.id, b.id);
  const [saved] = await db.select().from(checkpoints).where(eq(checkpoints.id, a.id));
  await deleteTestStart(creatorId, worldId, a.id);
  assert.equal((await db.select().from(checkpoints).where(eq(checkpoints.id, a.id))).length, 0);
  assert.equal((await db.select().from(playSessions).where(eq(playSessions.id, saved!.sessionId))).length, 0);
  assert.ok((await listTestStarts(creatorId, worldId)).some((row) => row.id === b.id));
});

test("saving rejects stale variables and metadata rather than persisting a queue timeout as current state", async () => {
  const countBefore = (await listTestStarts(creatorId, worldId)).length;
  const stale = (error: unknown) => error instanceof TestStartError && error.status === 409;
  await assert.rejects(() => saveTestStart(creatorId, worldId, sourceId, "Stale variables", { ...originalState, variables: { hp: 8 } }), stale);
  await assert.rejects(() => saveTestStart(creatorId, worldId, sourceId, "Stale metadata", { ...originalState, metadata: { activeLoreSlots: [] } }), stale);
  assert.equal((await listTestStarts(creatorId, worldId)).length, countBefore);
  await saveTestStart(creatorId, worldId, sourceId, "Settled", originalState);
});

test("installed cleanup keeps saved holders, reaps stale temporary runs, and preserves player sessions", { skip: "Hosted cleanup installation script is not exported" }, async () => {
  const saved = await saveTestStart(creatorId, worldId, sourceId, "Cleanup proof");
  const [cp] = await db.select().from(checkpoints).where(eq(checkpoints.id, saved.id));
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await db.update(playSessions).set({ updatedAt: old }).where(eq(playSessions.id, cp!.sessionId));
  const [temporary] = await db.insert(playSessions).values({ userId: creatorId, worldId, ephemeral: true, updatedAt: old }).returning();
  const [ordinary] = await db.insert(playSessions).values({ userId: playerId, worldId, ephemeral: false, updatedAt: old }).returning();
  const ddl = await readFile(new URL("../../scripts/update-test-start-cleanup.sql", import.meta.url), "utf8");
  await (db as unknown as { $client: { exec: (ddl: string) => Promise<unknown> } }).$client.exec(ddl);
  await db.execute(sql`SELECT cleanup_orphaned_playtest_sessions()`);
  assert.equal((await db.select().from(playSessions).where(eq(playSessions.id, temporary!.id))).length, 0);
  assert.equal((await db.select().from(playSessions).where(eq(playSessions.id, ordinary!.id))).length, 1);
  assert.equal((await db.select().from(checkpoints).where(eq(checkpoints.id, saved.id))).length, 1);
  assert.ok((await listTestStarts(creatorId, worldId)).some((row) => row.id === saved.id));
});
