import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import type { DrizzleDB } from "../db/index.js";
import { SESSION_MEDIA_DDL } from "../db/session-media-ddl.js";
import { copySessionStorageToBranch, createSessionStorageService } from "./session-storage-service.js";

test("a branch starts with the card's saved data as it stood at the branch point", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`
      CREATE TABLE "user" (id text PRIMARY KEY);
      CREATE TABLE user_assets(id text PRIMARY KEY,user_id text,size_bytes bigint,url text);
      CREATE TABLE worlds(id text PRIMARY KEY,name text);
      CREATE TABLE play_sessions(id text PRIMARY KEY,user_id text,world_id text,name text,parent_session_id text,branched_from_message_id text);
      CREATE TABLE messages(id text PRIMARY KEY,session_id text,created_at timestamp);
      CREATE TABLE checkpoints(id text PRIMARY KEY,session_id text,name text);
      CREATE TABLE shared_playthroughs(id text PRIMARY KEY,source_session_id text,sharer_user_id text,title text);
      INSERT INTO "user" VALUES ('alice');
      INSERT INTO worlds VALUES ('w','World');
      INSERT INTO play_sessions VALUES ('save','alice','w','Save',NULL,NULL),('now','alice','w','Now','save',NULL),('then','alice','w','Then','save',NULL);
    `);
    await pg.exec(SESSION_MEDIA_DDL);
    const db = drizzle(pg) as unknown as DrizzleDB;
    const storage = createSessionStorageService(db);

    await storage.write("alice", "save", "contacts", { kaia: ["hi"] }, 0);
    await storage.write("alice", "save", "gone", { x: 1 }, 0);
    const [{ t: between }] = (await pg.query<{ t: Date }>(`SELECT clock_timestamp() AS t`)).rows as [{ t: Date }];
    await storage.write("alice", "save", "contacts", { kaia: ["hi", "see you at 5"] }, 1);
    await storage.write("alice", "save", "gone", null, 1, true);
    await storage.write("alice", "save", "later", { y: 2 }, 0);

    // Taken from the last message: what is saved now, without the deleted key.
    await copySessionStorageToBranch(db, "save", "now", null);
    assert.deepEqual(await storage.get("alice", "now", "contacts"), { value: { kaia: ["hi", "see you at 5"] }, version: 1, exists: true });
    assert.deepEqual(await storage.get("alice", "now", "later"), { value: { y: 2 }, version: 1, exists: true });
    assert.deepEqual(await storage.get("alice", "now", "gone"), { value: null, version: 0, exists: false });

    // Taken from an earlier message: what was saved then, including a key deleted since, and not one written since.
    await copySessionStorageToBranch(db, "save", "then", between);
    assert.deepEqual(await storage.get("alice", "then", "contacts"), { value: { kaia: ["hi"] }, version: 1, exists: true });
    assert.deepEqual(await storage.get("alice", "then", "gone"), { value: { x: 1 }, version: 1, exists: true });
    assert.deepEqual(await storage.get("alice", "then", "later"), { value: null, version: 0, exists: false });

    // The branch diverges: writing there leaves the parent alone, and the copy did not spend fresh writes.
    await storage.write("alice", "then", "contacts", { kaia: [] }, 1);
    assert.deepEqual((await storage.get("alice", "save", "contacts")).value, { kaia: ["hi", "see you at 5"] });
    const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM session_storage WHERE session_id='now' AND added_at > ${between.toISOString()}::timestamptz AND key='contacts'`) as unknown as { rows: [{ n: number }] }).rows;
    assert.equal(n, 1);
  } finally { await pg.close(); }
});
