import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { reviewPlaytimeQuery } from "./review-playtime.js";

test("review playtime sums only the author's real sessions in the world's language family", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE worlds (id text PRIMARY KEY, language_group_id text);
      CREATE TABLE play_sessions (user_id text, world_id text, playtime_seconds integer, ephemeral boolean);
      INSERT INTO worlds VALUES ('en','family'), ('zh','family'), ('other',NULL), ('standalone',NULL);
      INSERT INTO play_sessions VALUES
        ('alice','en',60,false), ('alice','en',120,false), ('alice','zh',180,false),
        ('alice','en',900,true), ('alice','other',999,false), ('bob','en',20,false),
        ('alice','standalone',30,false), ('zero','en',0,false);
    `);
    const read = async (world: string, users: string[]) => {
      const q = new PgDialect().sqlToQuery(reviewPlaytimeQuery(world, users));
      return (await db.query<{ user_id: string; seconds: number }>(q.sql, q.params)).rows
        .sort((a, b) => a.user_id.localeCompare(b.user_id));
    };
    assert.deepEqual(await read('en', ['alice', 'bob', 'zero', 'unplayed']), [
      { user_id: 'alice', seconds: 360 }, { user_id: 'bob', seconds: 20 }, { user_id: 'zero', seconds: 0 },
    ]);
    assert.deepEqual(await read('zh', ['alice']), [{ user_id: 'alice', seconds: 360 }]);
    assert.deepEqual(await read('standalone', ['alice']), [{ user_id: 'alice', seconds: 30 }]);
    assert.deepEqual(await read('missing', ['alice']), []);
    assert.deepEqual(await read('en', []), []);
    assert.deepEqual(await read('en', ["alice' OR true --"]), []);
  } finally {
    await db.close();
  }
});
