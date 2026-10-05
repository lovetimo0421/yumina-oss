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
import { createAssetImportService, type AssetImportDependencies, type AssetImportStorage } from "./asset-import-service.js";
import { createAssetImportRoutes } from "../routes/asset-import-router.js";
import { zipFixture, tarFixture } from "./asset-archive-fixtures.js";
import { AssetImportError } from "./asset-archive.js";
import { claimAssetImportJob, lockAssetImportLease, renewAssetImportLease, type AssetImportJobRow } from "./asset-import-queue.js";

async function fixture() {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE "user"(id text PRIMARY KEY);
    CREATE TABLE asset_folders(id text PRIMARY KEY,user_id text NOT NULL,name text NOT NULL,parent_folder_id text);
    CREATE TABLE user_assets(id text PRIMARY KEY,user_id text NOT NULL,type text,filename text,url text,size_bytes bigint,mime_type text,folder_id text REFERENCES asset_folders(id));
    CREATE TABLE test_upload_admissions(user_id text,operation_id text,bytes bigint,storage_limit bigint,admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(user_id,operation_id));
    INSERT INTO "user" VALUES ('alice'),('bob'),('carol');
    INSERT INTO asset_folders VALUES ('root','alice','School',null),('bob-folder','bob','Private',null);`);
  await pg.exec(ASSET_IMPORT_DDL);
  await pg.exec(ASSET_IMPORT_DDL);
  const pgliteDb = drizzle(pg);
  const db = pgliteDb as unknown as DrizzleDB;
  const objects = new Map<string, Buffer>();
  const writes = new Map<string, number>();
  const reads = new Map<string, number>();
  const priorities = new Map<string, number>();
  let denyAdmission = false;
  let failContent: string | null = null;
  let failRemove = false;
  let limit = 100 * 1024 * 1024;
  const media = createSessionMediaService(db, { signUpload: async () => "", signRead: async () => "", read: async () => Buffer.alloc(0), write: async () => {}, remove: async () => {} });
  const storage: AssetImportStorage = {
    signUpload: async key => key,
    head: async key => ({ contentLength: objects.get(key)!.length, etag: "snapshot" }),
    copy: async (source, destination) => { objects.set(destination, Buffer.from(objects.get(source)!)); },
    read: async key => { reads.set(key, (reads.get(key) ?? 0) + 1); if (!objects.has(key)) throw new Error("offline"); return objects.get(key)!; },
    write: async (key, bytes) => {
      objects.set(key, Buffer.from(bytes));
      writes.set(key, (writes.get(key) ?? 0) + 1);
      if (bytes.toString() === failContent) { failContent = null; throw new Error("lost acknowledgement after PUT"); }
    },
    remove: async key => { if (failRemove) throw new Error("offline"); objects.delete(key); },
  };
  const dependencies: AssetImportDependencies = {
    db, storage, quota: { lockOwner: media.lockOwner, usage: media.usage, limit: async () => limit },
    uploadPolicy: {
      priority: async userId => priorities.get(userId) ?? 0,
      admit: async (tx, userId, operationId, bytes, storageLimit) => {
        // A transactional contract double for the separately owned shared ledger.
        const old = await tx.execute(sql`SELECT bytes FROM test_upload_admissions WHERE user_id=${userId} AND operation_id=${operationId}`);
        if (old.rows.length) {
          assert.equal(Number((old.rows[0] as { bytes: string }).bytes), bytes);
          return;
        }
        if (denyAdmission) throw new AssetImportError("ARCHIVE_RATE_LIMIT", 429);
        await tx.execute(sql`INSERT INTO test_upload_admissions(user_id,operation_id,bytes,storage_limit) VALUES(${userId},${operationId},${bytes},${storageLimit})`);
      },
    },
  };
  const service = createAssetImportService(dependencies);
  async function prepare(bytes: Buffer, filename = "assets.zip", folderId: string | null = "root", userId = "alice") {
    const id = randomUUID();
    const input = { id, filename, size: bytes.length, folderId };
    const reservation = await service.reserve(userId, input);
    objects.set(reservation.uploadUrl, bytes);
    await service.uploaded(userId, id);
    await service.processNext();
    return { id, input, reservation };
  }
  return { pg, db, pgliteDb, service, dependencies, objects, writes, reads, priorities, media, prepare,
    denyAdmission: (value: boolean) => { denyAdmission = value; },
    failWrite: (content: string) => { failContent = content; }, failRemove: (value: boolean) => { failRemove = value; }, limit: (value: number) => { limit = value; } };
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
    assert.equal([...f.reads.values()].reduce((a, b) => a + b, 0), 1);
    await assert.rejects(f.service.retry("alice", id), /ARCHIVE_QUOTA_EXCEEDED/);
    assert.equal((await f.pg.query("SELECT * FROM asset_import_retries")).rows.length, 0);
    // Repeatable installation must not mistake a cached quota-failed manifest
    // for an import the user has already confirmed.
    await f.pg.exec(ASSET_IMPORT_DDL);
    const cached = (await f.pg.query<{ manifest_validated_at: Date | null; confirmed_at: Date | null }>("SELECT manifest_validated_at,confirmed_at FROM asset_import_jobs")).rows[0]!;
    assert(cached.manifest_validated_at);
    assert.equal(cached.confirmed_at, null);
    f.limit(5000);
    await f.service.retry("alice", id);
    assert.equal((await f.service.detail("alice", id)).status, "ready");
    assert.equal(await f.service.processNext(), false, "restored manifest must not skip user confirmation");
    await f.service.retry("alice", id);
    assert.equal((await f.pg.query("SELECT * FROM asset_import_retries")).rows.length, 1);
    assert.equal([...f.reads.values()].reduce((a, b) => a + b, 0), 1, "capacity retries must not re-read or inflate the archive");
    assert.equal((await f.pg.query("SELECT * FROM test_upload_admissions")).rows.length, 0);
    assert.equal((await f.pg.query("SELECT * FROM user_assets")).rows.length, 0);
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

test("archive admission uses validated expanded bytes at confirmation and remains immutable across retries", async () => {
  const f = await fixture();
  try {
    const failedContent = "r".repeat(3000);
    const { id } = await f.prepare(await tarFixture([{ name: "keep.txt", data: "k".repeat(2000) }, { name: "retry.txt", data: failedContent }], true), "files.tgz");
    await f.db.execute(sql`UPDATE asset_import_jobs SET created_at=now()-interval '3 hours' WHERE id=${id}`);
    assert.equal((await f.pg.query("SELECT * FROM test_upload_admissions")).rows.length, 0);
    f.denyAdmission(true);
    await assert.rejects(f.service.start("alice", id, { preserveFolders: true, conflict: "rename" }), /ARCHIVE_RATE_LIMIT/);
    const rejected = (await f.pg.query<AssetImportJobRow>("SELECT * FROM asset_import_jobs WHERE id=$1", [id])).rows[0]!;
    assert.equal(rejected.status, "ready");
    assert.equal(rejected.confirmed_at, null);
    assert.equal((await f.pg.query("SELECT * FROM test_upload_admissions")).rows.length, 0);
    f.denyAdmission(false);
    f.priorities.set("alice", 1);
    await Promise.all([
      f.service.start("alice", id, { preserveFolders: true, conflict: "rename" }),
      f.service.start("alice", id, { preserveFolders: true, conflict: "rename" }),
    ]);
    const admitted = (await f.pg.query<{ bytes: string; storage_limit: string; admitted_at: Date }>("SELECT * FROM test_upload_admissions")).rows;
    assert.equal(admitted.length, 1);
    assert.equal(Number(admitted[0]!.bytes), 5000);
    assert.equal(Number(admitted[0]!.storage_limit), 100 * 1024 * 1024, "the already-resolved capacity reaches the shared policy");
    assert(Date.now() - new Date(admitted[0]!.admitted_at).getTime() < 10_000);
    f.failWrite(failedContent);
    await f.service.processNext();
    assert.equal((await f.service.detail("alice", id)).status, "partial");
    // Advance the logical admission age, without waiting or changing job identity.
    await f.db.execute(sql`UPDATE test_upload_admissions SET admitted_at=now()-interval '2 hours'`);
    const oldTime = (await f.pg.query<{ admitted_at: Date }>("SELECT admitted_at FROM test_upload_admissions")).rows[0]!.admitted_at;
    await f.db.execute(sql`UPDATE asset_import_jobs SET queued_at=now()-interval '2 hours' WHERE id=${id}`);
    f.priorities.set("alice", 2);
    f.denyAdmission(true); // Existing admissions must be reusable even if new work is blocked.
    await f.service.retry("alice", id);
    await f.service.retry("alice", id);
    const queued = (await f.pg.query<AssetImportJobRow>("SELECT * FROM asset_import_jobs WHERE id=$1", [id])).rows[0]!;
    assert.equal(queued.priority, 2);
    assert.equal(Number(queued.reserved_bytes), 3000);
    assert(new Date(queued.queued_at!).getTime() > new Date(oldTime).getTime());
    assert.deepEqual((await f.pg.query<{ admitted_at: Date }>("SELECT * FROM test_upload_admissions")).rows.map(row => row.admitted_at), [oldTime]);
    assert.equal((await f.pg.query("SELECT * FROM asset_import_retries")).rows.length, 1);
    await f.service.processNext();
    assert.equal((await f.service.detail("alice", id)).status, "completed");
    assert.equal((await f.pg.query("SELECT * FROM user_assets")).rows.length, 2);
  } finally { await f.pg.close(); }
});

test("confirmed legacy retries require admission and a rejection rolls back retry bookkeeping", async () => {
  const f = await fixture();
  try {
    const { id } = await f.prepare(zipFixture([{ name: "keep.txt", data: "keep" }, { name: "fail.txt", data: "fail" }]));
    await f.service.start("alice", id, { preserveFolders: false, conflict: "skip" });
    f.failWrite("fail");
    await f.service.processNext();
    await f.db.execute(sql`DELETE FROM test_upload_admissions`); // An already-confirmed pre-ledger job.
    f.denyAdmission(true);
    await assert.rejects(f.service.retry("alice", id), /ARCHIVE_RATE_LIMIT/);
    assert.equal((await f.pg.query("SELECT * FROM asset_import_retries")).rows.length, 0);
    assert.equal((await f.service.detail("alice", id)).status, "partial");
    assert.equal((await f.service.detail("alice", id)).failed, 1);
    f.denyAdmission(false);
    await f.service.retry("alice", id);
    const admission = (await f.pg.query<{ bytes: string }>("SELECT bytes FROM test_upload_admissions")).rows[0]!;
    assert.equal(Number(admission.bytes), 8, "admission uses the original validated total, not only remaining bytes");
    const job = await f.service.detail("alice", id);
    assert.equal(job.preserveFolders, false);
    assert.equal(job.conflict, "skip");
    assert.equal(job.status, "queued");
    await f.service.processNext();
    assert.equal((await f.service.detail("alice", id)).succeeded, 2);
  } finally { await f.pg.close(); }
});

test("retry cooldown, per-job cap and per-owner cap apply only to accepted retry transitions", async () => {
  const f = await fixture();
  try {
    const { id } = await f.prepare(zipFixture([{ name: "file.txt", data: "hello" }]));
    await f.service.start("alice", id, { preserveFolders: true, conflict: "rename" });
    f.dependencies.storage.read = async () => { throw new Error("temporarily unavailable"); };
    await f.service.processNext();
    await f.service.retry("alice", id);
    await f.service.retry("alice", id); // Lost response while queued: no second attempt.
    assert.equal((await f.pg.query("SELECT * FROM asset_import_retries")).rows.length, 1);
    await f.service.processNext();
    await assert.rejects(f.service.retry("alice", id), error => error instanceof AssetImportError && error.status === 429);
    for (let i = 1; i < 5; i++) {
      await f.db.execute(sql`UPDATE asset_import_retries SET accepted_at=now()-interval '1 minute' WHERE job_id=${id}`);
      await f.service.retry("alice", id);
      await f.service.processNext();
    }
    await f.db.execute(sql`UPDATE asset_import_retries SET accepted_at=now()-interval '1 minute' WHERE job_id=${id}`);
    await assert.rejects(f.service.retry("alice", id), /ARCHIVE_RATE_LIMIT/);
    const second = await f.prepare(zipFixture([{ name: "second.txt", data: "two" }]));
    for (let i = 0; i < 5; i++) {
      await f.db.execute(sql`UPDATE asset_import_retries SET accepted_at=now()-interval '1 minute' WHERE job_id=${second.id}`);
      await f.service.retry("alice", second.id);
      await f.service.processNext();
    }
    const third = await f.prepare(zipFixture([{ name: "third.txt", data: "three" }]));
    await assert.rejects(f.service.retry("alice", third.id), /ARCHIVE_RATE_LIMIT/);
    assert.equal((await f.pg.query("SELECT * FROM asset_import_retries WHERE user_id='alice'")).rows.length, 10);
    const bob = await f.prepare(zipFixture([{ name: "bob.txt", data: "bob" }]), "bob.zip", null, "bob");
    await f.service.retry("bob", bob.id);
    assert.equal((await f.service.detail("bob", bob.id)).status, "queued_inspect");
    // Once the rolling hour expires a new attempt is allowed; the source/job is unchanged.
    await f.db.execute(sql`UPDATE asset_import_retries SET accepted_at=now()-interval '61 minutes' WHERE user_id='alice'`);
    await f.service.retry("alice", id);
    assert.equal((await f.service.detail("alice", id)).status, "queued");
  } finally { await f.pg.close(); }
});

test("failed retries cannot exceed four active jobs and concurrent duplicate retries consume one slot", async () => {
  const f = await fixture();
  try {
    const { id } = await f.prepare(zipFixture([{ name: "retry.txt", data: "retry" }]));
    await f.service.start("alice", id, { preserveFolders: true, conflict: "rename" });
    f.dependencies.storage.read = async () => { throw new Error("offline"); };
    await f.service.processNext();
    const pending: string[] = [];
    for (let i = 0; i < 4; i++) {
      const input = { id: randomUUID(), filename: `${i}.zip`, size: 100, folderId: null };
      await f.service.reserve("alice", input);
      pending.push(input.id);
    }
    await assert.rejects(f.service.retry("alice", id), /ARCHIVE_RATE_LIMIT/);
    assert.equal((await f.pg.query("SELECT * FROM asset_import_retries")).rows.length, 0);
    await f.service.dismiss("alice", pending[0]!);
    await Promise.all([f.service.retry("alice", id), f.service.retry("alice", id)]);
    assert.equal((await f.pg.query("SELECT * FROM asset_import_retries")).rows.length, 1);
    assert.equal((await f.pg.query("SELECT * FROM asset_import_jobs WHERE status IN ('uploading','queued')")).rows.length, 4);
  } finally { await f.pg.close(); }
});

test("server-resolved membership priority orders fresh work and is refreshed on enqueue", async () => {
  const f = await fixture();
  try {
    f.priorities.set("alice", 2);
    f.priorities.set("bob", 1);
    f.priorities.set("carol", 2);
    const alice = await f.prepare(zipFixture([{ name: "alice.txt", data: "a" }]));
    const bob = await f.prepare(zipFixture([{ name: "bob.txt", data: "b" }]), "bob.zip", null, "bob");
    const carol = await f.prepare(zipFixture([{ name: "carol.txt", data: "c" }]), "carol.zip", null, "carol");
    f.priorities.set("alice", 0); // The membership snapshot from inspection is not reused.
    for (const [owner, job] of [["alice", alice], ["bob", bob], ["carol", carol]] as const) {
      await f.service.start(owner, job.id, { preserveFolders: true, conflict: "rename" });
    }
    const first = await claimAssetImportJob(f.db);
    const second = await claimAssetImportJob(f.db);
    const third = await claimAssetImportJob(f.db);
    assert.deepEqual([first?.user_id, second?.user_id, third?.user_id], ["carol", "bob", "alice"]);
    assert.deepEqual([first?.priority, second?.priority, third?.priority], [2, 1, 0]);
    assert.equal(await claimAssetImportJob(f.db), null);
  } finally { await f.pg.close(); }
});

test("waiting free jobs overtake fresh paid jobs without allowing a second lease for their owner", async () => {
  const f = await fixture();
  try {
    const first = await f.prepare(zipFixture([{ name: "first.txt", data: "1" }]));
    const second = await f.prepare(zipFixture([{ name: "second.txt", data: "2" }]));
    f.priorities.set("bob", 2);
    const bob = await f.prepare(zipFixture([{ name: "bob.txt", data: "b" }]), "bob.zip", null, "bob");
    await f.service.start("alice", first.id, { preserveFolders: true, conflict: "rename" });
    await f.service.start("alice", second.id, { preserveFolders: true, conflict: "rename" });
    await f.service.start("bob", bob.id, { preserveFolders: true, conflict: "rename" });
    await f.db.execute(sql`UPDATE asset_import_jobs SET queued_at=now()-interval '3 minutes' WHERE id=${first.id}`);
    const claims = await Promise.all([claimAssetImportJob(f.db), claimAssetImportJob(f.db)]);
    assert(claims.some(job => job?.id === first.id));
    assert.equal(claims.filter(job => job?.user_id === "alice").length, 1);
    // A contender that skipped the owner lock may already have claimed Bob.
    const bobClaim = claims.find(job => job?.user_id === "bob") ?? await claimAssetImportJob(f.db);
    assert.equal(bobClaim?.id, bob.id);
    assert.equal(await claimAssetImportJob(f.db), null);
    assert.equal((await f.service.detail("alice", second.id)).status, "queued");
  } finally { await f.pg.close(); }
});

test("different replicas serialize one owner, allow another owner, and cannot revive an expired lease", async () => {
  const f = await fixture();
  let release!: () => void;
  let running: Promise<boolean> | undefined;
  try {
    const first = await f.prepare(zipFixture([{ name: "first.txt", data: "first" }]));
    const second = await f.prepare(zipFixture([{ name: "second.txt", data: "second" }]));
    const bob = await f.prepare(zipFixture([{ name: "bob.txt", data: "bob" }]), "bob.zip", null, "bob");
    await f.service.start("alice", first.id, { preserveFolders: true, conflict: "rename" });
    await f.service.start("bob", bob.id, { preserveFolders: true, conflict: "rename" });
    const source = `private-asset-imports/alice/${first.id}/source`;
    const originalRead = f.dependencies.storage.read;
    const pause = new Promise<void>(resolve => { release = resolve; });
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    f.dependencies.storage.read = async (key, max) => {
      if (key === source) { began(); await pause; }
      return originalRead(key, max);
    };
    running = f.service.processNext();
    await started;
    const oldLease = (await f.pg.query<AssetImportJobRow>("SELECT * FROM asset_import_jobs WHERE id=$1", [first.id])).rows[0]!;
    assert.equal(await renewAssetImportLease(f.db, f.media.lockOwner, oldLease), true);
    f.priorities.set("alice", 2);
    await f.service.start("alice", second.id, { preserveFolders: true, conflict: "rename" });
    const replica = createAssetImportService(f.dependencies);
    assert.equal(await replica.processNext(), true);
    assert.equal((await replica.detail("bob", bob.id)).status, "completed");
    assert.equal((await replica.detail("alice", second.id)).status, "queued");
    assert.equal(await replica.processNext(), false, "a valid owner lease excludes even a higher-priority sibling job");
    await f.db.execute(sql`UPDATE asset_import_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=${first.id}`);
    assert.equal(await replica.processNext(), true); // Alice's higher-priority second job can now run.
    assert.equal((await replica.detail("alice", second.id)).status, "completed");
    assert.equal(await renewAssetImportLease(f.db, f.media.lockOwner, oldLease), false, "an expired token must not resurrect its lease");
    await assert.rejects(f.db.transaction(async tx => {
      await f.media.lockOwner(tx, "alice");
      await lockAssetImportLease(tx, oldLease);
    }), /ARCHIVE_INTERRUPTED/);
    release();
    await running;
    assert.equal((await replica.detail("alice", first.id)).status, "processing", "stale failure handling must not release a replacement worker's reservation");
    assert.equal(await replica.processNext(), true);
    assert.equal((await replica.detail("alice", first.id)).status, "completed");
    assert.equal((await f.pg.query("SELECT * FROM user_assets")).rows.length, 3);
    assert([...f.writes.values()].every(count => count === 1));
  } finally { release?.(); await running?.catch(() => {}); await f.pg.close(); }
});

test("a replacement worker can finish before the old worker returns without duplicate writes or stale status", async () => {
  const f = await fixture();
  let release!: () => void;
  let running: Promise<boolean> | undefined;
  try {
    const { id } = await f.prepare(zipFixture([{ name: "one.txt", data: "once" }]));
    await f.service.start("alice", id, { preserveFolders: true, conflict: "rename" });
    const originalRead = f.dependencies.storage.read;
    const pause = new Promise<void>(resolve => { release = resolve; });
    let began!: () => void;
    const started = new Promise<void>(resolve => { began = resolve; });
    let firstRead = true;
    f.dependencies.storage.read = async (key, max) => {
      if (firstRead) { firstRead = false; began(); await pause; }
      return originalRead(key, max);
    };
    running = f.service.processNext();
    await started;
    const oldLease = (await f.pg.query<AssetImportJobRow>("SELECT * FROM asset_import_jobs WHERE id=$1", [id])).rows[0]!;
    await f.db.execute(sql`UPDATE asset_import_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=${id}`);
    assert.equal(await createAssetImportService(f.dependencies).processNext(), true);
    assert.equal((await f.service.detail("alice", id)).status, "completed");
    assert.equal(await renewAssetImportLease(f.db, f.media.lockOwner, oldLease), false);
    release();
    await running;
    assert.equal((await f.service.detail("alice", id)).status, "completed");
    assert.equal((await f.pg.query("SELECT * FROM user_assets")).rows.length, 1);
    assert.deepEqual([...f.writes.values()], [1]);
  } finally { release?.(); await running?.catch(() => {}); await f.pg.close(); }
});

test("repeatable schema upgrades recover proven legacy confirmation without conflating it with validation", async () => {
  const f = await fixture();
  try {
    const preview = await f.prepare(zipFixture([{ name: "preview.txt", data: "preview" }]));
    const confirmed = await f.prepare(zipFixture([{ name: "confirmed.txt", data: "confirmed" }]));
    await f.service.start("alice", confirmed.id, { preserveFolders: true, conflict: "rename" });
    await f.pg.exec(`ALTER TABLE asset_import_jobs DROP COLUMN manifest_validated_at;
      ALTER TABLE asset_import_jobs DROP COLUMN confirmed_at;
      ALTER TABLE asset_import_jobs DROP COLUMN queued_at;
      ALTER TABLE asset_import_jobs DROP COLUMN priority;
      DROP TABLE asset_import_retries;`);
    await f.pg.exec(ASSET_IMPORT_DDL);
    await f.pg.exec(ASSET_IMPORT_DDL);
    const jobs = (await f.pg.query<AssetImportJobRow>("SELECT * FROM asset_import_jobs")).rows;
    const ready = jobs.find(job => job.id === preview.id)!;
    const queued = jobs.find(job => job.id === confirmed.id)!;
    assert(ready.manifest_validated_at);
    assert.equal(ready.confirmed_at, null);
    assert(queued.manifest_validated_at);
    assert(queued.confirmed_at);
    assert(queued.queued_at);
    assert.equal(queued.priority, 0);
  } finally { await f.pg.close(); }
});

test("an invalid suffix never leaves a reusable partial manifest, and zero-byte files still receive an admission", async () => {
  const f = await fixture();
  try {
    const invalid = await f.prepare(zipFixture([{ name: "good.txt", data: "valid" }, { name: "../bad.txt", data: "invalid" }]));
    const rejected = (await f.pg.query<AssetImportJobRow>("SELECT * FROM asset_import_jobs WHERE id=$1", [invalid.id])).rows[0]!;
    assert.equal(rejected.status, "failed");
    assert.equal(rejected.manifest_validated_at, null);
    assert.equal((await f.pg.query("SELECT * FROM asset_import_entries")).rows.length, 0);
    const emptyFile = await f.prepare(zipFixture([{ name: "empty.txt", data: "" }]));
    await f.service.start("alice", emptyFile.id, { preserveFolders: true, conflict: "rename" });
    assert.equal(Number((await f.pg.query<{ bytes: string }>("SELECT bytes FROM test_upload_admissions")).rows[0]!.bytes), 0);
    await f.service.processNext();
    assert.equal((await f.service.detail("alice", emptyFile.id)).succeeded, 1);
  } finally { await f.pg.close(); }
});
