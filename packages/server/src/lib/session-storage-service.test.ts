import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { DrizzleDB } from "../db/index.js";
import type { SessionUser } from "./types.js";
import { SESSION_MEDIA_DDL } from "../db/session-media-ddl.js";
import { createSessionMediaService } from "./session-media-service.js";
import { createSessionStorageService, restoreSessionStorage, SESSION_STORAGE_LIMITS } from "./session-storage-service.js";
import { createSessionMediaRoutes } from "../routes/session-media-router.js";

test("session JSON storage: real database isolation, conflict handling, snapshots and limits", async (t) => {
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
      INSERT INTO "user" VALUES ('alice'),('bob');
      INSERT INTO worlds VALUES ('new-world','Any new world');
      INSERT INTO play_sessions VALUES ('save','alice','new-world','Save',NULL,NULL),('bob-save','bob','new-world','Bob',NULL,NULL);
    `);
    await pg.exec(SESSION_MEDIA_DDL);
    await pg.exec(SESSION_MEDIA_DDL);
    const db = drizzle(pg) as unknown as DrizzleDB;
    const storage = createSessionStorageService(db);
    const media = createSessionMediaService(db, {
      signUpload: async () => "", signRead: async () => "", read: async () => Buffer.alloc(0),
      write: async () => {}, remove: async () => {},
    });
    const routes = createSessionMediaRoutes({ db, sessionMedia: media, sessionMediaLimit: async () => 1000000,
      sessionMediaUploadsEnabled: () => false, isS3Configured: () => false,
      authMiddleware: async (c, next) => {
        const id = c.req.header("x-test-user");
        if (!id) return c.json({ error: "Unauthorized" }, 401);
        c.set("user", { id } as SessionUser);
        await next();
      },
    });
    const endpoint = "/session/save/storage/gallery";
    const headers = { "x-test-user": "alice", "content-type": "application/json" };

    await t.test("new worlds work without a media pilot or object bucket; reads are private", async () => {
      assert.equal((await routes.request(endpoint)).status, 401);
      assert.equal((await routes.request(endpoint, { headers: { "x-test-user": "bob" } })).status, 404);
      const response = await routes.request(endpoint, { headers });
      assert.equal(response.headers.get("cache-control"), "private, no-store");
      assert.deepEqual((await response.json() as { data: unknown }).data, { value: null, version: 0, exists: false });
      const put = await routes.request(endpoint, { method: "PUT", headers, body: JSON.stringify({ value: { coverEntryId: "portrait" }, expectedVersion: 0 }) });
      assert.equal(put.status, 200);
      assert.deepEqual(await storage.get("alice", "save", "gallery"), { value: { coverEntryId: "portrait" }, version: 1, exists: true });
      assert.deepEqual(await storage.get("bob", "bob-save", "gallery"), { value: null, version: 0, exists: false });
      assert.equal((await routes.request(endpoint, { method: "PUT", headers, body: JSON.stringify({ value: {}, expectedVersion: 0 }) })).status, 409);
      assert.equal((await routes.request(endpoint, { method: "PUT", headers, body: JSON.stringify({ value: {} }) })).status, 400);
    });

    await t.test("two clients cannot silently replace one another; deletion cannot reset CAS", async () => {
      const writes = await Promise.allSettled([
        storage.write("alice", "save", "gallery", { title: "PC" }, 1),
        storage.write("alice", "save", "gallery", { title: "Phone" }, 1),
      ]);
      assert.equal(writes.filter(r => r.status === "fulfilled").length, 1);
      assert.equal(writes.filter(r => r.status === "rejected").length, 1);
      const removed = await storage.write("alice", "save", "gallery", null, 2, true);
      assert.deepEqual(removed, { value: null, version: 3, exists: false });
      await assert.rejects(storage.write("alice", "save", "gallery", "stale", 0), /SESSION_STORAGE_CONFLICT/);
      await assert.rejects(storage.write("alice", "save", "gallery", "stale", 2), /SESSION_STORAGE_CONFLICT/);
      assert.deepEqual(await storage.write("alice", "save", "gallery", null, 3), { value: null, version: 4, exists: true });
    });

    await t.test("checkpoint restore and immutable shares preserve values and invalidate every stale key", async () => {
      await storage.write("alice", "save", "gallery", { title: "snapshot" }, 4);
      await pg.exec(`INSERT INTO checkpoints VALUES ('cp','save','Checkpoint'); INSERT INTO shared_playthroughs VALUES ('share','save','alice','Shared');`);
      await storage.write("alice", "save", "gallery", { title: "later" }, 5);
      await storage.write("alice", "save", "after-checkpoint", true, 0);
      assert.deepEqual((await storage.readShared("share", "gallery")).value, { title: "snapshot" });
      assert.equal((await storage.readShared("share", "after-checkpoint")).exists, false);
      await db.transaction(async tx => {
        await media.restore(tx, "alice", "save", "cp");
        await restoreSessionStorage(tx, "save", "cp");
      });
      const restored = await storage.get("alice", "save", "gallery");
      assert.deepEqual(restored.value, { title: "snapshot" });
      assert.equal(restored.version, 7);
      assert.deepEqual(await storage.get("alice", "save", "after-checkpoint"), { value: null, version: 2, exists: false });
      await assert.rejects(storage.write("alice", "save", "after-checkpoint", "stale", 1), /CONFLICT/);
      await assert.rejects(storage.write("alice", "save", "after-checkpoint", "stale", 0), /CONFLICT/);
      await assert.rejects(storage.write("alice", "save", "gallery", "stale", 6), /CONFLICT/);
    });

    await t.test("branches preserve inherited history and never copy across accounts", async () => {
      await pg.exec(`INSERT INTO messages VALUES ('cutoff','save',clock_timestamp() AT TIME ZONE 'UTC');`);
      await storage.write("alice", "save", "gallery", "after fork", 7);
      await pg.exec(`INSERT INTO play_sessions VALUES ('branch','alice','new-world','Branch','save','cutoff');
        INSERT INTO play_sessions VALUES ('foreign','bob','new-world','Foreign','save','cutoff');
        INSERT INTO messages SELECT 'inherited','branch',created_at FROM messages WHERE id='cutoff';
        INSERT INTO play_sessions VALUES ('grandchild','alice','new-world','Grandchild','branch','inherited');`);
      assert.deepEqual((await storage.get("alice", "branch", "gallery")).value, { title: "snapshot" });
      assert.deepEqual((await storage.get("alice", "grandchild", "gallery")).value, { title: "snapshot" });
      assert.equal((await storage.get("bob", "foreign", "gallery")).exists, false);
      assert.equal((await storage.get("alice", "branch", "after-checkpoint")).exists, false);
    });

    await t.test("identical acknowledged writes do not consume history or reset versions", async () => {
      const before = await storage.write("alice", "save", "unchanged", { title: "same", nested: { n: 1 } }, 0);
      const after = await storage.write("alice", "save", "unchanged", { nested: { n: 1 }, title: "same" }, before.version);
      assert.deepEqual(after, before);
      const rows = await pg.query<{ count: number }>(`SELECT count(*)::int AS count FROM session_storage WHERE session_id='save' AND key='unchanged'`);
      assert.equal(rows.rows[0]?.count, 1);
      await assert.rejects(storage.write("alice", "save", "unchanged", before.value, 0), /CONFLICT/);
    });

    await t.test("restore preserves CAS and branches without duplicating unchanged history; changed restore respects capacity atomically", async () => {
      await pg.exec(`INSERT INTO "user" VALUES ('restorer');
        INSERT INTO play_sessions VALUES ('restore-limit','restorer','new-world','Restore limit',NULL,NULL);`);
      await storage.write("restorer", "restore-limit", "gallery", "checkpoint", 0);
      await pg.exec(`INSERT INTO checkpoints VALUES ('before-change','restore-limit','Before change');`);
      await storage.write("restorer", "restore-limit", "gallery", "current", 1);
      await pg.exec(`INSERT INTO checkpoints VALUES ('unchanged-cp','restore-limit','Unchanged');
        INSERT INTO messages VALUES ('unchanged-cutoff','restore-limit',clock_timestamp() AT TIME ZONE 'UTC');
        INSERT INTO session_media_documents(id,session_id,value,version) VALUES ('keep-media-document','restore-limit','{"title":"current"}',1);
        INSERT INTO session_storage(id,session_id,key,value,version,size_bytes,removed_at,added_at)
        SELECT 'restore-history-'||n,'restore-limit','gallery','null',n+2,32768,now()-interval '2 hours',now()-interval '3 hours' FROM generate_series(1,511) n;
        INSERT INTO session_storage(id,session_id,key,value,version,size_bytes,removed_at,added_at)
        SELECT 'restore-history-last','restore-limit','gallery','null',514,
          ${SESSION_STORAGE_LIMITS.historyBytes}-(SELECT sum(size_bytes) FROM session_storage WHERE session_id='restore-limit'),
          now()-interval '2 hours',now()-interval '3 hours';`);
      const history = () => pg.query<{ count: number; bytes: number; added_at: string }>(`
        SELECT count(*)::int AS count,sum(size_bytes)::int AS bytes,
          (SELECT added_at::text FROM session_storage WHERE session_id='restore-limit' AND key='gallery' AND removed_at IS NULL) AS added_at
        FROM session_storage WHERE session_id='restore-limit'`);
      const before = (await history()).rows[0];
      for (let i = 0; i < 3; i++) {
        await db.transaction(async tx => {
          await media.restore(tx, "restorer", "restore-limit", "unchanged-cp");
          await restoreSessionStorage(tx, "restore-limit", "unchanged-cp");
        });
      }
      assert.deepEqual((await history()).rows[0], before, "unchanged restore retains history bytes, row count and timeline");
      const current = await storage.get("restorer", "restore-limit", "gallery");
      assert.equal(current.version, 517);
      assert.equal(current.value, "current");
      await assert.rejects(storage.write("restorer", "restore-limit", "gallery", "stale", 2), /CONFLICT/);
      // The current value was installed before the cutoff. A restore that only
      // changed its CAS version must not move its timeline past that cutoff.
      await pg.exec(`INSERT INTO play_sessions VALUES ('unchanged-branch','restorer','new-world','Branch','restore-limit','unchanged-cutoff');`);
      assert.equal((await storage.get("restorer", "unchanged-branch", "gallery")).value, "current");
      await pg.exec(`INSERT INTO session_media_documents(id,session_id,value,version) VALUES ('atomic-document','restore-limit','{"title":"preserve"}',2);`);
      await assert.rejects(db.transaction(async tx => {
        await media.restore(tx, "restorer", "restore-limit", "before-change");
        await restoreSessionStorage(tx, "restore-limit", "before-change");
      }), /SESSION_STORAGE_QUOTA_EXCEEDED/);
      assert.deepEqual(await storage.get("restorer", "restore-limit", "gallery"), current);
      assert.deepEqual((await history()).rows[0], before);
      const activeDocument = await pg.query<{ id: string }>(`SELECT id FROM session_media_documents WHERE session_id='restore-limit' AND removed_at IS NULL`);
      assert.equal(activeDocument.rows[0]?.id, "atomic-document", "failure rolls back earlier media restoration too");
    });

    await t.test("changed restore cannot bypass the account write rate", async () => {
      await pg.exec(`INSERT INTO "user" VALUES ('rate-restorer');
        INSERT INTO play_sessions VALUES ('restore-rate','rate-restorer','new-world','Restore rate',NULL,NULL);`);
      await storage.write("rate-restorer", "restore-rate", "gallery", "before", 0);
      await pg.exec(`INSERT INTO checkpoints VALUES ('rate-cp','restore-rate','Checkpoint');`);
      await storage.write("rate-restorer", "restore-rate", "gallery", "after", 1);
      await pg.exec(`INSERT INTO session_storage(id,session_id,key,value,version,size_bytes,removed_at)
        SELECT 'restore-rate-'||n,'restore-rate','gallery','null',n+2,0,clock_timestamp() FROM generate_series(1,998) n;`);
      await assert.rejects(db.transaction(async tx => {
        await media.restore(tx, "rate-restorer", "restore-rate", "rate-cp");
        await restoreSessionStorage(tx, "restore-rate", "rate-cp");
      }), /SESSION_STORAGE_RATE_LIMIT/);
      assert.deepEqual(await storage.get("rate-restorer", "restore-rate", "gallery"), { value: "after", version: 2, exists: true });
    });

    await t.test("metadata guards reject images, local URLs, oversized JSON and invalid keys", async () => {
      await assert.rejects(storage.write("alice", "save", "bad/key", {}, 0), /INVALID_KEY/);
      await assert.rejects(storage.write("alice", "save", "bad", undefined, 0), /INVALID_VALUE/);
      await assert.rejects(storage.write("alice", "save", "bad", { image: "data:image/png;base64,YWJj" }, 0), /USE_MEDIA_API/);
      await assert.rejects(storage.write("alice", "save", "bad", { image: "blob:local-image" }, 0), /USE_MEDIA_API/);
      await assert.rejects(storage.write("alice", "save", "bad", "x".repeat(SESSION_STORAGE_LIMITS.valueBytes), 0), /VALUE_TOO_LARGE/);
      await assert.rejects(storage.write("bob", "save", "bad", {}, 0), /NOT_FOUND/);
      await assert.rejects(storage.write("alice", "save", "bad", {}, -1), /INVALID_VERSION/);
      assert.equal((await routes.request(endpoint, { method: "DELETE", headers: { ...headers, "x-test-user": "bob" }, body: JSON.stringify({ expectedVersion: 8 }) })).status, 404);
    });

    await t.test("live size, key count, historical growth and hourly writes are bounded", async () => {
      await pg.exec(`INSERT INTO play_sessions VALUES ('limits','alice','new-world','Limits',NULL,NULL);
        INSERT INTO session_storage(id,session_id,key,value,version,size_bytes)
        SELECT 'large-'||n,'limits','large-'||n,'null',1,32768 FROM generate_series(1,8) n;`);
      await assert.rejects(storage.write("alice", "limits", "overflow", "x", 0), /QUOTA_EXCEEDED/);
      await pg.exec(`DELETE FROM session_storage WHERE session_id='limits';
        INSERT INTO session_storage(id,session_id,key,value,version,size_bytes,deleted)
        SELECT 'key-'||n,'limits','key-'||n,'null',1,0,true FROM generate_series(1,128) n;`);
      await assert.rejects(storage.write("alice", "limits", "overflow", 1, 0), /QUOTA_EXCEEDED/);
      await pg.exec(`DELETE FROM session_storage WHERE session_id='limits';
        INSERT INTO session_storage(id,session_id,key,value,version,size_bytes,removed_at)
        SELECT 'history-'||n,'limits','past','null',n,32768,clock_timestamp() FROM generate_series(1,512) n;`);
      await assert.rejects(storage.write("alice", "limits", "overflow", "x", 0), /QUOTA_EXCEEDED/);
      await pg.exec(`DELETE FROM session_storage WHERE session_id='limits';
        INSERT INTO session_storage(id,session_id,key,value,version,size_bytes,removed_at)
        SELECT 'rate-'||n,'limits','past','null',n,0,clock_timestamp() FROM generate_series(1,1000) n;`);
      await assert.rejects(storage.write("alice", "limits", "overflow", {}, 0), /RATE_LIMIT/);
    });
  } finally { await pg.close(); }
});
