import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { worldPlaytimeQuery } from "./world-playtime-query.js";

test("public playtime groups language versions once and excludes creator and Studio sessions", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE worlds (id text PRIMARY KEY, language_group_id text, creator_id text);
      CREATE TABLE play_sessions (user_id text, world_id text, playtime_seconds integer, ephemeral boolean);
      INSERT INTO worlds VALUES ('en','family','author'),('zh','family','author'),('other',NULL,'author'),('new',NULL,'author');
      INSERT INTO play_sessions VALUES ('a','en',60,false),('a','zh',120,false),('b','en',180,false),
        ('author','en',9000,false),('a','zh',9000,true),('a','other',45,false),('a','en',-10,false);
    `);
    const read = async (ids: string[]) => {
      const query = new PgDialect().sqlToQuery(worldPlaytimeQuery(ids));
      return (await db.query(query.sql, query.params)).rows;
    };
    assert.deepEqual((await read(['en','zh','other','new'])).sort((a: any,b: any)=>a.id.localeCompare(b.id)), [
      { id:'en', seconds:360 }, { id:'new', seconds:0 }, { id:'other', seconds:45 }, { id:'zh', seconds:360 },
    ]);
    assert.deepEqual(await read([]), []);
    assert.deepEqual(await read(["en' OR true --"]), []);
  } finally { await db.close(); }
});
