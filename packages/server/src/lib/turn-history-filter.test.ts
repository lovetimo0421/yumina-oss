import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { and, eq, lte, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { messages } from "../db/schema.js";
import { buildTurnHistoryFilter } from "./turn-history-filter.js";

test("failed history is excluded while the exact active retry respects session, role and memory boundaries", async () => {
  const client = new PGlite();
  const dialect = new PgDialect();
  try {
    await client.exec(`
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, status TEXT, created_at TIMESTAMP, compacted BOOLEAN);
      INSERT INTO messages VALUES
        ('complete', 's1', 'assistant', 'complete', '2026-09-01', false),
        ('abandoned', 's1', 'user', 'failed', '2026-09-02', false),
        ('retry', 's1', 'user', 'failed', '2026-09-03', false),
        ('failed-assistant', 's1', 'assistant', 'failed', '2026-09-03', false),
        ('other-session', 's2', 'user', 'failed', '2026-09-03', false),
        ('compacted-retry', 's1', 'user', 'failed', '2026-09-03', true),
        ('later', 's1', 'assistant', 'complete', '2026-09-05', false);
    `);
    const ids = async (activeId?: string, upTo?: Date) => {
      const where = and(
        buildTurnHistoryFilter("s1", [eq(messages.compacted, false)], activeId),
        upTo ? lte(messages.createdAt, upTo) : undefined,
      );
      const query = dialect.sqlToQuery(sql`SELECT id FROM ${messages} WHERE ${where} ORDER BY id`);
      const result = await client.query<{ id: string }>(query.sql, query.params);
      return result.rows.map((row) => row.id);
    };
    assert.deepEqual(await ids(), ["complete", "later"]);
    assert.deepEqual(await ids("retry"), ["complete", "later", "retry"]);
    assert.deepEqual(await ids("failed-assistant"), ["complete", "later"]);
    assert.deepEqual(await ids("other-session"), ["complete", "later"]);
    assert.deepEqual(await ids("compacted-retry"), ["complete", "later"]);
    assert.deepEqual(await ids("retry", new Date("2026-09-04T00:00:00Z")), ["complete", "retry"]);
    assert.deepEqual(await ids("retry", new Date("2026-09-02T00:00:00Z")), ["complete"]);
  } finally {
    await client.close();
  }
});

test("send forwards the actual persisted user id and all prompt history uses the shared filter", () => {
  const routes = readFileSync(new URL("../routes/messages.ts", import.meta.url), "utf8");
  assert.match(routes, /loadBoundedRawHistory\(sessionId, turnMemory, \{ activeUserMessageId: userMsg\?\.id \}\)/);
  const memory = readFileSync(new URL("./turn-memory.ts", import.meta.url), "utf8");
  assert.match(memory, /buildTurnHistoryFilter\(sessionId, turn\.historyConditions, activeUserMessageId\)/);
  assert.match(memory, /buildRawHistoryWhere\(sessionId, turn, opts\.activeUserMessageId\)/);
  assert.match(memory, /buildRawHistoryWhere\(sessionId, turn, opts\?\.activeUserMessageId\)/);
});
