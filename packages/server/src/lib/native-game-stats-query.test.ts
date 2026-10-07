import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { nativeGameStatsQuery } from "./native-game-stats-query.js";

test("native statistics share language totals, include guests, and exclude creators and unsuccessful AI attempts", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE worlds (id text PRIMARY KEY, game_path text, creator_id text, is_published boolean, language_group_id text, source_world_id text);
      CREATE TABLE native_game_playtime (id text PRIMARY KEY, game_id text, subject text, active_ms bigint);
      CREATE TABLE native_game_playtime_history (game_id text, subject text, legacy_ms bigint, native_ms bigint);
      CREATE TABLE game_guest_links (guest_id text PRIMARY KEY, user_id text);
      CREATE TABLE usage_logs (id text PRIMARY KEY, user_id text, endpoint text);
      INSERT INTO worlds (id,game_path,creator_id,is_published) VALUES ('pvz-en','/pvz/','author',true),('pvz-zh','/pvz','author',true),
        ('krew','/krew','krew-author',true),('unsupported','/other/','author',true),('chat',NULL,'author',true);
      UPDATE worlds SET language_group_id='pvz-family' WHERE id IN ('pvz-en','pvz-zh');
      INSERT INTO worlds VALUES ('pvz-fr','/pvz/','translator',false,'pvz-family',NULL),
        ('personal-copy','/pvz/','player',false,'pvz-family','pvz-en');
      INSERT INTO game_guest_links VALUES ('guest:linked','player'),('guest:owner','author');
      INSERT INTO native_game_playtime VALUES
        ('host:1','pvz','player',60000),('host:2','pvz','guest:one',120000),
        ('solo:3','pvz','guest:linked',180000),('solo:4','pvz','author',900000),
        ('host:5','pvz','guest:owner',900000),('host:6','krew','guest:one',45000),('host:7','pvz','translator',900000);
      INSERT INTO usage_logs VALUES ('1','player','pvz-dave'),('2','player','pvz-dave'),
        ('3','player','pvz-dave-unheard'),('4','author','pvz-dave'),('5','player','send'),('6','translator','pvz-dave');
    `);
    const read = async (ids: string[]) => {
      const query = new PgDialect().sqlToQuery(nativeGameStatsQuery(ids));
      return (await db.query(query.sql, query.params)).rows;
    };
    assert.deepEqual((await read(['pvz-en','pvz-zh','krew','unsupported','chat'])).sort((a:any,b:any)=>a.id.localeCompare(b.id)), [
      {id:'krew',seconds:45,interactions:0},
      {id:'pvz-en',seconds:360,interactions:2},
      {id:'pvz-zh',seconds:360,interactions:2},
    ]);
    assert.deepEqual(await read([]),[]);
    assert.deepEqual(await read(["pvz-en' OR true --"]),[]);
    await db.exec("DELETE FROM native_game_playtime; DELETE FROM usage_logs;");
    assert.deepEqual(await read(['pvz-en']),[{id:'pvz-en',seconds:0,interactions:0}]);
  } finally { await db.close(); }
});
