import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { nativeGamePlaytimeQuery } from "./native-game-playtime-query.js";
import { sql } from "drizzle-orm";
import { NATIVE_PLAYTIME_HISTORY_DDLS, NATIVE_PLAYTIME_HISTORY_SNAPSHOT } from "../db/native-game-playtime-history-ddl.js";

test("history snapshot excludes Studio, preserves native watermarks, and never moves on retry", async () => {
  const db=new PGlite();
  try {
    await db.exec(`CREATE TABLE worlds(id text PRIMARY KEY,game_path text);
      CREATE TABLE play_sessions(user_id text,world_id text,playtime_seconds integer,ephemeral boolean);
      CREATE TABLE native_game_playtime(id text PRIMARY KEY,game_id text,subject text,active_ms bigint);
      CREATE TABLE game_guest_links(guest_id text PRIMARY KEY,user_id text);
      INSERT INTO worlds VALUES ('en','/pvz/'),('zh','/pvz'),('krew','/krew'),('story',NULL),('unknown','/other/');
      INSERT INTO play_sessions VALUES ('a','en',60,false),('a','zh',120,false),('a','en',90000,true),
        ('a','story',80000,false),('a','unknown',90000,false),('a','en',-10,false),('b','krew',20,false);
      INSERT INTO native_game_playtime VALUES ('h1','pvz','a',30000),('h2','pvz','a',45000),('g','pvz','guest:one',90000),('k','krew','b',45000);`);
    const schema=await readFile(new URL('../db/native-game-playtime-history.sql',import.meta.url),'utf8');
    const capture=await readFile(new URL('../db/native-game-playtime-history-snapshot.sql',import.meta.url),'utf8');
    const normalize=(value:string)=>value.replace(/--[^\n]*/g,'').replace(/\s/g,'').replace(/;$/,'');
    assert.equal(normalize(NATIVE_PLAYTIME_HISTORY_SNAPSHOT),normalize(capture));
    assert.equal(normalize(NATIVE_PLAYTIME_HISTORY_DDLS.join(';')),normalize(schema));
    await db.exec(schema);
    await db.exec(capture);
    const baseline=await db.query('SELECT game_id,subject,legacy_ms::text,native_ms::text FROM native_game_playtime_history ORDER BY game_id,subject');
    assert.deepEqual(baseline.rows,[
      {game_id:'krew',subject:'b',legacy_ms:'20000',native_ms:'45000'},
      {game_id:'pvz',subject:'a',legacy_ms:'180000',native_ms:'75000'},
      {game_id:'pvz',subject:'guest:one',legacy_ms:'0',native_ms:'90000'},
    ]);
    await db.exec("UPDATE native_game_playtime SET active_ms=active_ms+5000; UPDATE play_sessions SET playtime_seconds=900000;");
    for (const ddl of NATIVE_PLAYTIME_HISTORY_DDLS) await db.exec(ddl);
    await db.exec(NATIVE_PLAYTIME_HISTORY_SNAPSHOT);
    assert.deepEqual((await db.query('SELECT game_id,subject,legacy_ms::text,native_ms::text FROM native_game_playtime_history ORDER BY game_id,subject')).rows,baseline.rows);
    assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM native_game_playtime_cutovers')).rows[0]!.n,1);
    const q=new PgDialect().sqlToQuery(nativeGamePlaytimeQuery(sql`'pvz','krew'`));
    assert.deepEqual((await db.query(q.sql,q.params)).rows.sort((a:any,b:any)=>a.user_id.localeCompare(b.user_id)),[
      {game_id:'pvz',user_id:'a',seconds:190}, {game_id:'krew',user_id:'b',seconds:50}, {game_id:'pvz',user_id:'guest:one',seconds:95},
    ]);
    // Rollback must undo the receipt together with its baseline.
    await db.exec('TRUNCATE native_game_playtime_history,native_game_playtime_cutovers;');
    await db.exec('BEGIN;');
    await db.exec(capture);await db.exec('ROLLBACK;');
    assert.equal((await db.query<{n:number}>('SELECT count(*)::int AS n FROM native_game_playtime_cutovers')).rows[0]!.n,0);
  } finally { await db.close(); }
});
