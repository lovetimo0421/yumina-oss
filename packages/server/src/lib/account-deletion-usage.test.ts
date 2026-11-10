import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { preserveDeletedAccountTotals } from "./account-deletion-usage.js";

async function setup(withLegacyFk: boolean) {
  const database = new PGlite();
  const fk = withLegacyFk ? `REFERENCES "user"(id) ON DELETE CASCADE` : "";
  await database.exec(`
    CREATE TABLE "user" (id TEXT PRIMARY KEY, created_at TIMESTAMP NOT NULL DEFAULT NOW(), lifetime_playtime_seconds INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE usage_logs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL ${fk}, prompt_tokens INTEGER NOT NULL);
    CREATE TABLE analytics_play_intervals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
    CREATE TABLE daily_user_activity (user_id TEXT NOT NULL, activity_date DATE NOT NULL, play_messages INTEGER NOT NULL, PRIMARY KEY (user_id, activity_date));
    CREATE TABLE account_deletions (id TEXT PRIMARY KEY, deleted_at TIMESTAMP NOT NULL DEFAULT NOW(), account_created_at TIMESTAMP, lifetime_playtime_seconds BIGINT NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'deletion');
    INSERT INTO "user" (id, created_at, lifetime_playtime_seconds) VALUES ('leaver', '2026-10-01', 5400), ('stayer', '2026-09-01', 60);
    INSERT INTO usage_logs VALUES ('u1', 'leaver', 100), ('u2', 'leaver', 200), ('u3', 'stayer', 7);
    INSERT INTO analytics_play_intervals VALUES ('i1', 'leaver'), ('i2', 'stayer');
    INSERT INTO daily_user_activity VALUES ('leaver', '2026-10-02', 4), ('stayer', '2026-10-02', 1);
  `);
  return database;
}

test("deletion keeps usage, playtime and the deletion itself in platform totals", async () => {
  const database = await setup(false);
  try {
    const db = drizzle(database);
    const { actorId, tables } = await preserveDeletedAccountTotals(db, "leaver");
    await database.exec(`DELETE FROM "user" WHERE id = 'leaver'`);

    assert.match(actorId, /^deleted:[0-9a-f-]{36}$/);
    // analytics_activity doesn't exist here and is skipped, not an error.
    assert.deepEqual(tables.sort(), ["analytics_play_intervals", "daily_user_activity", "usage_logs"]);
    const usage = await database.query<{ total: number; leftovers: number }>(
      `SELECT SUM(prompt_tokens)::int AS total, COUNT(*) FILTER (WHERE user_id = 'leaver')::int AS leftovers FROM usage_logs`,
    );
    assert.deepEqual(usage.rows[0], { total: 307, leftovers: 0 });
    const kept = await database.query<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM analytics_play_intervals WHERE user_id = '${actorId}') + (SELECT COUNT(*) FROM daily_user_activity WHERE user_id = '${actorId}')::int AS n`,
    );
    assert.equal(Number(kept.rows[0]!.n), 2);
    const ledger = await database.query<{ seconds: number; source: string; created: string }>(
      `SELECT lifetime_playtime_seconds::int AS seconds, source, account_created_at::date::text AS created FROM account_deletions`,
    );
    assert.deepEqual(ledger.rows, [{ seconds: 5400, source: "deletion", created: "2026-10-01" }]);
  } finally {
    await database.close();
  }
});

test("each deletion gets its own unlinkable actor", async () => {
  const database = await setup(false);
  try {
    const db = drizzle(database);
    const first = await preserveDeletedAccountTotals(db, "leaver");
    const second = await preserveDeletedAccountTotals(db, "stayer");
    assert.notEqual(first.actorId, second.actorId);
  } finally {
    await database.close();
  }
});

test("a table that still has the legacy user FK is left to its cascade", async () => {
  const database = await setup(true);
  try {
    const db = drizzle(database);
    const { tables } = await preserveDeletedAccountTotals(db, "leaver");
    assert.ok(!tables.includes("usage_logs"));
    await database.exec(`DELETE FROM "user" WHERE id = 'leaver'`);
    const usage = await database.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM usage_logs`);
    assert.equal(usage.rows[0]!.n, 1);
  } finally {
    await database.close();
  }
});
