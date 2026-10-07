import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PgDialect } from "drizzle-orm/pg-core";
import { nativeGameStatsQuery } from "./native-game-stats-query.js";
import { reviewPlaytimeQuery } from "./review-playtime.js";

test("native totals preserve review history and immediately add new native time without adding wrapper time twice", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE TABLE worlds(id text PRIMARY KEY,game_path text,creator_id text,is_published boolean,language_group_id text,source_world_id text);
      CREATE TABLE play_sessions(user_id text,world_id text,playtime_seconds integer,ephemeral boolean);
      CREATE TABLE native_game_playtime(id text PRIMARY KEY,game_id text,subject text,active_ms bigint);
      CREATE TABLE native_game_playtime_history(game_id text,subject text,legacy_ms bigint,native_ms bigint);
      CREATE TABLE game_guest_links(guest_id text PRIMARY KEY,user_id text);
      CREATE TABLE usage_logs(id text PRIMARY KEY,user_id text,endpoint text);
      INSERT INTO worlds VALUES ('en','/pvz/','creator',true,'family',NULL),('zh','/pvz','creator',true,'family',NULL),
        ('krew','/krew/','creator',true,NULL,NULL),('story',NULL,'creator',true,NULL,NULL);
      INSERT INTO play_sessions VALUES ('reviewer','en',10012,false),('reviewer','story',90,false);
      INSERT INTO native_game_playtime VALUES ('host:1','pvz','reviewer',447838);
      INSERT INTO native_game_playtime_history VALUES ('pvz','reviewer',10012000,447838);
    `);
    const read = async (query: ReturnType<typeof nativeGameStatsQuery>) => {
      const q = new PgDialect().sqlToQuery(query);
      return (await db.query<{seconds:number;user_id?:string;id?:string;interactions?:number}>(q.sql,q.params)).rows;
    };
    const total = async (id='en') => (await read(nativeGameStatsQuery([id])))[0]!;
    const personal = async (id='en',users=['reviewer'],path='/pvz/') => read(reviewPlaytimeQuery(id,users,path));
    assert.deepEqual(await total(),{id:'en',seconds:10012,interactions:0});
    assert.deepEqual(await personal(),[{user_id:'reviewer',seconds:10012}]);
    await db.exec("UPDATE native_game_playtime SET active_ms=active_ms+60000; UPDATE play_sessions SET playtime_seconds=90000 WHERE world_id='en';");
    assert.equal((await total()).seconds,10072);
    assert.equal((await total('zh')).seconds,10072);
    assert.deepEqual(await personal('zh'),[{user_id:'reviewer',seconds:10072}]);
    assert.deepEqual(await personal('en',[]),[]);
    assert.deepEqual(await personal('en',["reviewer' OR true --"]),[]);
    assert.deepEqual(await personal('story',['reviewer'],''),[{user_id:'reviewer',seconds:90}]);

    // A guest link changes ownership; it must not add the same historic
    // account/guest period twice. New native increments still count once.
    await db.exec(`INSERT INTO native_game_playtime_history VALUES ('pvz','guest:prior',0,120000);
      INSERT INTO native_game_playtime VALUES ('host:guest','pvz','guest:prior',150000);
      INSERT INTO game_guest_links VALUES ('guest:prior','reviewer');`);
    assert.equal((await total()).seconds,10102);
    assert.deepEqual(await personal(),[{user_id:'reviewer',seconds:10102}]);
    // New visitors, history-only visitors and Krew are independent.
    await db.exec(`INSERT INTO native_game_playtime VALUES ('solo:new','pvz','new',30000),('host:k','krew','new',80000);
      INSERT INTO native_game_playtime_history VALUES ('pvz','old',90000,0);
      INSERT INTO native_game_playtime VALUES ('host:owner','pvz','creator',500000);
      INSERT INTO native_game_playtime_history VALUES ('pvz','creator',900000,400000);`);
    assert.equal((await total()).seconds,10222);
    assert.equal((await total('krew')).seconds,80);
    const authors = await personal('en',['reviewer','old','new']);
    assert.equal(authors.reduce((n,r)=>n+Number(r.seconds),0),Number((await total()).seconds));
  } finally { await db.close(); }
});
