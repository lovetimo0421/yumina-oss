import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import type { DrizzleDB } from "../db/index.js";
import type { SessionUser } from "./types.js";
import { ASSET_IMPORT_DDL } from "../db/asset-import-ddl.js";
import { createSessionMediaService } from "./session-media-service.js";
import { createAssetImportService, type AssetImportStorage } from "./asset-import-service.js";
import { createAssetImportRoutes } from "../routes/asset-import-router.js";
import { zipFixture, tarFixture } from "./asset-archive-fixtures.js";

async function fixture() {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE "user"(id text PRIMARY KEY);
    CREATE TABLE asset_folders(id text PRIMARY KEY,user_id text NOT NULL,name text NOT NULL,parent_folder_id text);
    CREATE TABLE user_assets(id text PRIMARY KEY,user_id text NOT NULL,type text,filename text,url text,size_bytes bigint,mime_type text,folder_id text REFERENCES asset_folders(id));
    INSERT INTO "user" VALUES ('alice'),('bob');
    INSERT INTO asset_folders VALUES ('root','alice','School',null),('bob-folder','bob','Private',null);`);
  await pg.exec(ASSET_IMPORT_DDL);
  await pg.exec(ASSET_IMPORT_DDL);
  const pgliteDb = drizzle(pg);
  const db = pgliteDb as unknown as DrizzleDB;
  const objects = new Map<string, Buffer>();
  const writes = new Map<string, number>();
  let failContent: string | null = null;
  let failRemove = false;
  let limit = 100 * 1024 * 1024;
  const media = createSessionMediaService(db, { signUpload: async () => "", signRead: async () => "", read: async () => Buffer.alloc(0), write: async () => {}, remove: async () => {} });
  const storage: AssetImportStorage = {
    signUpload: async key => key,
    head: async key => ({ contentLength: objects.get(key)!.length, etag: "snapshot" }),
    copy: async (source, destination) => { objects.set(destination, Buffer.from(objects.get(source)!)); },
    read: async key => { if (!objects.has(key)) throw new Error("offline"); return objects.get(key)!; },
    write: async (key, bytes) => {
      objects.set(key, Buffer.from(bytes));
      writes.set(key, (writes.get(key) ?? 0) + 1);
      if (bytes.toString() === failContent) { failContent = null; throw new Error("lost acknowledgement after PUT"); }
    },
    remove: async key => { if (failRemove) throw new Error("offline"); objects.delete(key); },
  };
  const dependencies = { db, storage, quota: { lockOwner: media.lockOwner, usage: media.usage, limit: async () => limit } };
  const service = createAssetImportService(dependencies);
  async function prepare(bytes: Buffer, filename = "assets.zip", folderId: string | null = "root") {
    const id = randomUUID();
    const input = { id, filename, size: bytes.length, folderId };
    const reservation = await service.reserve("alice", input);
    objects.set(reservation.uploadUrl, bytes);
    await service.uploaded("alice", id);
    await service.processNext();
    return { id, input, reservation };
  }
  return { pg, db, pgliteDb, service, dependencies, objects, writes, media, prepare, failWrite: (content: string) => { failContent = content; }, failRemove: (value: boolean) => { failRemove = value; }, limit: (value: number) => { limit = value; } };
}

test("durable imports preserve folders, freeze uploaded bytes, and retry only failed files", async () => {
  const f = await fixture();
  try {
    const bytes = zipFixture([{ name: "角色/hero.txt", data: "hero" }, { name: "背景/room.txt", data: "retry me" }, { name: "readme.txt", data: "readme" }]);
    const { id, reservation } = await f.prepare(bytes);
    const preview = await f.service.detail("alice", id);
    assert.equal(preview.status, "ready");
    assert.equal(preview.fileCount, 3);
    assert.equal((await f.media.usage("alice")).reserved, 18);
    await assert.rejects(f.service.detail("bob", id), /ARCHIVE_NOT_FOUND/);
    // Modifying the original upload after acknowledgement cannot alter the snapshot.
    f.objects.set(reservation.uploadUrl, zipFixture([{ name: "evil.txt", data: "replaced" }]));
    f.failWrite("retry me");
    await f.service.start("alice", id, { preserveFolders: true, conflict: "rename" });
    await f.service.processNext();
    const partial = await f.service.detail("alice", id);
    assert.equal(partial.status, "partial");
    assert.equal(partial.succeeded, 2);
    assert.equal(partial.failed, 1);
    assert.equal(partial.failures[0]?.path, "背景/room.txt");
    assert.equal((await f.pg.query("SELECT * FROM user_assets")).rows.length, 2);
    await f.service.retry("alice", id);
    const restarted = createAssetImportService(f.dependencies);
    await restarted.processNext();
    const done = await restarted.detail("alice", id);
    assert.equal(done.status, "completed");
    assert.equal(done.succeeded, 3);
    assert.equal((await f.pg.query("SELECT * FROM user_assets")).rows.length, 3);
    assert.equal([...f.writes.values()].filter(count => count === 1).length, 2);
    assert.equal([...f.writes.values()].filter(count => count === 2).length, 1);
    assert.equal((await f.media.usage("alice")).reserved, 0);
    const nested = await f.pg.query<{ name: string; parent_folder_id: string }>("SELECT name,parent_folder_id FROM asset_folders WHERE parent_folder_id='root' ORDER BY name");
    assert.equal(nested.rows.length, 2);
    assert(nested.rows.every(row => row.parent_folder_id === "root"));
    await assert.rejects(restarted.retry("alice", id), /ARCHIVE_NOT_RETRYABLE/);
  } finally { await f.pg.close(); }
});

test("a 70-file archive is one job; duplicate filenames support keep-both and skip", async () => {
  const f = await fixture();
  try {
    const bytes = zipFixture(Array.from({ length: 70 }, (_, i) => ({ name: `folder/file-${i}.txt`, data: `${i}` })));
    const first = await f.prepare(bytes);
    await f.service.start("alice", first.id, { preserveFolders: false, conflict: "rename" });
    const [claimed, other] = await Promise.all([f.service.processNext(), f.service.processNext()]);
    assert.equal(Number(claimed) + Number(other), 1);
    assert.equal((await f.service.detail("alice", first.id)).succeeded, 70);
    const again = await f.prepare(zipFixture([{ name: "file-0.txt", data: "new" }]));
    await f.service.start("alice", again.id, { preserveFolders: true, conflict: "rename" });
    await f.service.processNext();
    assert.equal((await f.pg.query("SELECT id FROM user_assets WHERE filename='file-0 (2).txt'")).rows.length, 1);
    const skip = await f.prepare(zipFixture([{ name: "file-0.txt", data: "skip" }]));
    await f.service.start("alice", skip.id, { preserveFolders: true, conflict: "skip" });
    await f.service.processNext();
    assert.equal((await f.service.detail("alice", skip.id)).skipped, 1);
    assert.equal((await f.pg.query("SELECT id FROM user_assets")).rows.length, 71);
  } finally { await f.pg.close(); }
});

test("quota uses unpacked bytes, recovers after space is available, and rejects foreign folders", async () => {
  const f = await fixture();
  try {
    const bytes = await tarFixture([{ name: "large.txt", data: "x".repeat(4000) }], true);
    f.limit(1000);
    await assert.rejects(f.service.reserve("alice", { id: randomUUID(), filename: "x.tgz", size: bytes.length, folderId: "bob-folder" }), /ARCHIVE_FOLDER_MISSING/);
    const { id } = await f.prepare(bytes, "x.tgz");
    assert.equal((await f.service.detail("alice", id)).errorCode, "ARCHIVE_QUOTA_EXCEEDED");
    assert.equal((await f.media.usage("alice")).reserved, 0);
    f.limit(5000);
    await f.service.retry("alice", id);
    await f.service.processNext();
    assert.equal((await f.media.usage("alice")).reserved, 4000);
    await assert.rejects(f.service.reserve("alice", { id: randomUUID(), filename: "other.zip", size: 1001, folderId: null }), /ARCHIVE_QUOTA_EXCEEDED/);
    await f.service.start("alice", id, { preserveFolders: true, conflict: "rename" });
    await f.service.processNext();
    assert.equal((await f.media.usage("alice")).used, 4000);
    assert.equal((await f.media.usage("alice")).reserved, 0);
  } finally { await f.pg.close(); }
});

test("stale worker leases resume after restart; expiry cleanup retains successful assets", async () => {
  const f = await fixture();
  try {
    const { id } = await f.prepare(zipFixture([{ name: "keep.txt", data: "keep" }, { name: "fail.txt", data: "fail" }]));
    await f.service.start("alice", id, { preserveFolders: true, conflict: "rename" });
    await f.db.execute(sql`UPDATE asset_import_jobs SET status='processing',lease_token='dead-worker',lease_expires_at=now()-interval '1 minute' WHERE id=${id}`);
    f.failWrite("fail");
    await createAssetImportService(f.dependencies).processNext();
    assert.equal((await f.service.detail("alice", id)).status, "partial");
    await f.db.execute(sql`UPDATE asset_import_jobs SET expires_at=now()-interval '1 minute',upload_expires_at=now()-interval '3 minutes' WHERE id=${id}`);
    f.failRemove(true);
    await f.service.sweep();
    assert.equal((await f.media.usage("alice")).reserved, 0);
    assert.equal((await f.service.detail("alice", id)).status, "expired");
    assert.equal((await f.pg.query<{ cleaned_at: Date | null }>("SELECT cleaned_at FROM asset_import_jobs")).rows[0]?.cleaned_at, null);
    f.failRemove(false);
    await f.service.sweep();
    assert.equal((await f.service.detail("alice", id)).status, "expired");
    assert.equal((await f.media.usage("alice")).reserved, 0);
    assert.equal(f.objects.size, 1);
    assert.equal([...f.objects.values()][0]?.toString(), "keep");
  } finally { await f.pg.close(); }
});

test("large expired archives clean in bounded batches outside transactions and exclude competing sweeps", async () => {
  const f = await fixture();
  try {
    const { id } = await f.prepare(zipFixture(Array.from({ length: 2000 }, (_, i) => ({ name: `${i}.txt`, data: "x" }))));
    await f.db.execute(sql`UPDATE asset_import_jobs SET expires_at=now()-interval '1 minute',upload_expires_at=now()-interval '3 minutes' WHERE id=${id}`);
    const originalTransaction = f.pgliteDb.transaction.bind(f.pgliteDb);
    let inTransaction = false;
    f.pgliteDb.transaction = (async (callback: Parameters<typeof f.pgliteDb.transaction>[0]) => originalTransaction(async tx => {
      inTransaction = true;
      try { return await callback(tx); }
      finally { inTransaction = false; }
    })) as typeof f.pgliteDb.transaction;
    let release!: () => void;
    const paused = new Promise<void>(resolve => { release = resolve; });
    let began!: () => void;
    const deleting = new Promise<void>(resolve => { began = resolve; });
    const originalRemove = f.dependencies.storage.remove;
    let active = 0;
    let peak = 0;
    let removed = 0;
    f.dependencies.storage.remove = async key => {
      assert.equal(inTransaction, false, "storage must never hold a database transaction idle");
      active++;
      peak = Math.max(peak, active);
      began();
      await paused;
      try { await originalRemove(key); removed++; }
      finally { active--; }
    };
    const firstSweep = f.service.sweep();
    await deleting;
    assert.equal((await f.media.usage("alice")).reserved, 0);
    await createAssetImportService(f.dependencies).sweep();
    assert.equal(removed, 0);
    assert.equal(active, 8, "another sweep must not claim a live cleanup lease");
    release();
    await firstSweep;
    assert.equal(removed, 2002);
    assert.equal(peak, 8);
    assert.equal(f.objects.size, 0);
    assert((await f.pg.query<{ cleaned_at: Date | null }>("SELECT cleaned_at FROM asset_import_jobs")).rows[0]?.cleaned_at);
  } finally { await f.pg.close(); }
});

test("cleanup rechecks worker leases after selecting stale candidates", async () => {
  const f = await fixture();
  try {
    const { id } = await f.prepare(zipFixture([{ name: "keep.txt", data: "keep" }]));
    await f.db.execute(sql`UPDATE asset_import_jobs SET status='processing',expires_at=now()-interval '1 minute',upload_expires_at=now()-interval '3 minutes',lease_token='active',lease_expires_at=now()-interval '1 minute' WHERE id=${id}`);
    const originalLock = f.dependencies.quota.lockOwner;
    const service = createAssetImportService({ ...f.dependencies, quota: { ...f.dependencies.quota, lockOwner: async (tx, userId) => {
      await originalLock(tx, userId);
      await tx.execute(sql`UPDATE asset_import_jobs SET lease_expires_at=now()+interval '2 minutes' WHERE id=${id}`);
    } } });
    let removed = 0;
    f.dependencies.storage.remove = async () => { removed++; };
    await service.sweep();
    assert.equal(removed, 0);
    assert.equal((await f.service.detail("alice", id)).status, "processing");
    assert.equal((await f.media.usage("alice")).reserved, 4);
  } finally { await f.pg.close(); }
});

test("import routes require authentication, validate payloads and isolate owners", async () => {
  const f = await fixture();
  try {
    const routes = createAssetImportRoutes({ service: f.service, available: () => true, kick: () => {}, auth: async (c, next) => {
      const id = c.req.header("x-user");
      if (!id) return c.json({ error: "Unauthorized" }, 401);
      c.set("user", { id } as SessionUser);
      await next();
    } });
    assert.equal((await routes.request("/")).status, 401);
    const mounted = new Hono().route("/api/user-assets/imports", routes);
    assert.equal((await mounted.request("/api/user-assets/imports", { headers: { "x-user": "alice" } })).status, 200);
    assert.equal((await routes.request("/", { method: "POST", headers: { "x-user": "alice", "content-type": "application/json" }, body: "{}" })).status, 400);
    const { id } = await f.prepare(zipFixture([{ name: "one.txt", data: "hello" }]));
    assert.equal((await routes.request(`/${id}`, { headers: { "x-user": "bob" } })).status, 404);
    assert.equal((await routes.request(`/${id}/start`, { method: "POST", headers: { "x-user": "bob", "content-type": "application/json" }, body: JSON.stringify({ preserveFolders: true, conflict: "rename" }) })).status, 404);
    const response = await routes.request(`/${id}`, { headers: { "x-user": "alice" } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert(!JSON.stringify(await response.json()).includes("private-asset-imports/"));
    await f.service.dismiss("alice", id);
    assert.equal((await f.service.list("alice")).length, 0);
  } finally { await f.pg.close(); }
});
