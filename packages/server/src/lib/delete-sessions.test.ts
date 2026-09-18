import test from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { deleteSessionsKeepingUsage } from "./delete-sessions.js";

test("session removal preserves old usage attribution and respects account ownership", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE play_sessions(id text PRIMARY KEY,user_id text,world_id text);
      CREATE TABLE usage_logs(id text PRIMARY KEY,user_id text,session_id text REFERENCES play_sessions(id) ON DELETE SET NULL,analytics_world_id text,tokens int,cost numeric);
      INSERT INTO play_sessions VALUES ('one','a','world'),('two','a','translation'),('other','b','world');
      INSERT INTO usage_logs VALUES ('old','a','one',NULL,123,4),('new','a','one','recorded',9,0),('second','a','two','',8,1),('foreign','b','other',NULL,2,3);`);
    const db = drizzle(pg);
    const remove = (scope: {sessionId:string}|{worldIds:string[]}) => db.transaction(tx => deleteSessionsKeepingUsage(q => tx.execute(q),"a",scope));
    assert.deepEqual(await remove({sessionId:"other"}),[]);
    assert.deepEqual(await remove({sessionId:"one"}),[{id:"one"}]);
    const rows = (await pg.query<{id:string;session_id:string|null;analytics_world_id:string|null;tokens:number;cost:string}>("SELECT * FROM usage_logs ORDER BY id")).rows;
    assert.equal(rows.find(r=>r.id==='old')!.analytics_world_id,'world');
    assert.equal(rows.find(r=>r.id==='new')!.analytics_world_id,'recorded');
    assert.equal(rows.find(r=>r.id==='old')!.session_id,null);
    assert.equal(rows.find(r=>r.id==='foreign')!.session_id,'other');
    assert.equal(rows.reduce((n,r)=>n+r.tokens,0),142);
    assert.equal(rows.reduce((n,r)=>n+Number(r.cost),0),8);
    assert.deepEqual(await remove({worldIds:['world','translation']}),[{id:'two'}]);
    assert.equal((await pg.query<{analytics_world_id:string}>("SELECT analytics_world_id FROM usage_logs WHERE id='second'")).rows[0]!.analytics_world_id,'translation');
    assert.deepEqual(await remove({worldIds:[]}),[]);
  } finally { await pg.close(); }
});
