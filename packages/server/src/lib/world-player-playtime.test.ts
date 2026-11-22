import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { averageWorldPlayerPlaytime } from "./world-player-playtime.js";

test("average playtime counts a player once across saves and translations", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE worlds (id text PRIMARY KEY, language_group_id text);
      CREATE TABLE play_sessions (user_id text, world_id text, playtime_seconds integer, ephemeral boolean);
      INSERT INTO worlds VALUES ('en','family'),('zh','family'),('other',NULL),('empty',NULL);
      INSERT INTO play_sessions VALUES
        ('a','en',3600,false),('a','en',1800,false),('a','zh',1800,false),
        ('b','zh',3600,false),('c','en',0,false),
        ('tester','en',99999,true),('a','other',60,false);
    `);
    const read = async (id: string) => {
      const q = new PgDialect().sqlToQuery(sql`SELECT ${averageWorldPlayerPlaytime(id)} AS seconds`);
      return (await db.query<{ seconds: number }>(q.sql, q.params)).rows[0]!.seconds;
    };
    // 10,800 seconds / 3 people, not 5 saves. The zero-time player counts once.
    assert.equal(await read('en'), 3600);
    assert.equal(await read('zh'), 3600);
    assert.equal(await read('other'), 60);
    assert.equal(await read('empty'), 0);
    assert.equal(await read("en' OR true --"), 0);
    await db.exec("INSERT INTO play_sessions VALUES ('a','en',0,false)");
    assert.equal(await read('en'), 3600);
  } finally { await db.close(); }
});
