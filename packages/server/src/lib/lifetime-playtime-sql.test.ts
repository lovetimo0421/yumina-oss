import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { type SQL } from "drizzle-orm";
import { drainLifetimePlaytime, enqueueLifetimePlaytime, LIFETIME_PLAYTIME_PENDING_DDL } from "./lifetime-playtime-sql.js";

test("pending lifetime time commits with the session and drains exactly once without Redis", async () => {
  const db = new PGlite();
  const run = async (statement: SQL) => {
    const query = new PgDialect().sqlToQuery(statement);
    return db.query(query.sql, query.params);
  };
  const snapshot = async () => ({
    users: (await db.query<{ id: string; lifetime_playtime_seconds: number }>('SELECT id,lifetime_playtime_seconds FROM "user" ORDER BY id')).rows,
    pending: (await db.query<{ user_id: string; seconds: number }>('SELECT * FROM playtime_lifetime_pending ORDER BY user_id')).rows,
  });
  try {
    await db.exec(`CREATE TABLE "user"(id text PRIMARY KEY,lifetime_playtime_seconds integer NOT NULL,last_active_at timestamp);
      CREATE TABLE play_sessions(id text PRIMARY KEY,playtime_seconds integer);
      INSERT INTO "user" VALUES ('u',100);
      INSERT INTO play_sessions VALUES ('s',100);`);
    await db.exec(LIFETIME_PLAYTIME_PENDING_DDL);
    await db.exec('BEGIN; UPDATE play_sessions SET playtime_seconds=115');
    await run(enqueueLifetimePlaytime('u',15));
    await db.exec('COMMIT');
    assert.deepEqual((await snapshot()).pending,[{user_id:'u',seconds:15}]);
    await db.exec('BEGIN; UPDATE play_sessions SET playtime_seconds=130');
    await run(enqueueLifetimePlaytime('u',15));
    await db.exec('ROLLBACK');
    assert.deepEqual((await snapshot()).pending,[{user_id:'u',seconds:15}]);
    await run(enqueueLifetimePlaytime('u',5));
    // Deleting a story must not delete already earned lifetime time.
    await db.exec('DELETE FROM play_sessions');
    await run(drainLifetimePlaytime());
    assert.deepEqual(await snapshot(),{users:[{id:'u',lifetime_playtime_seconds:120}],pending:[]});
    assert.ok((await db.query<{ last_active_at: Date | null }>('SELECT last_active_at FROM "user"')).rows[0]!.last_active_at, 'crediting play time stamps last active');
    await run(drainLifetimePlaytime());
    assert.equal((await snapshot()).users[0]!.lifetime_playtime_seconds,120);
    await run(enqueueLifetimePlaytime('u',7));
    await db.exec(`CREATE FUNCTION fail_credit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected update failure'; END $$;
      CREATE TRIGGER fail_credit BEFORE UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION fail_credit();`);
    await assert.rejects(run(drainLifetimePlaytime()), /injected update failure/);
    assert.deepEqual((await snapshot()).pending,[{user_id:'u',seconds:7}]);
    await db.exec('DROP TRIGGER fail_credit ON "user"');
    await run(drainLifetimePlaytime());
    assert.equal((await snapshot()).users[0]!.lifetime_playtime_seconds,127);
    await run(enqueueLifetimePlaytime('u',4));
    await db.exec('DELETE FROM "user"');
    assert.deepEqual((await snapshot()).pending,[]);
  } finally { await db.close(); }
});
