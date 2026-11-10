import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql, type SQL } from "drizzle-orm";
import type { DrizzleDB } from "../db/index.js";
import { ASSET_IMPORT_DDL } from "../db/asset-import-ddl.js";
import { claimAssetImportJob, lockAssetImportLease, renewAssetImportLease, type AssetImportExecutor } from "./asset-import-queue.js";
import { createAssetImportService, type AssetImportStorage } from "./asset-import-service.js";

// Opt-in only. The ordinary isolated test launcher does not forward this URL.
// All SQL runs in a newly created schema; no application tables are touched.
const connectionString = process.env.ARCHIVE_QUEUE_TEST_DATABASE_URL;
test("PostgreSQL connections serialize owner claims, renewal and accepted retries", { skip: !connectionString, timeout: 90_000 }, async () => {
  const schema = `archive_queue_test_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^archive_queue_test_[a-f0-9]{32}$/);
  const pools = Array.from({ length: 4 }, () => new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000, statement_timeout: 15_000 }));
  const raw = pools.map(pool => drizzle(pool));
  const scope = sql.raw(`SET LOCAL search_path TO "${schema}", pg_catalog`);
  // SET LOCAL per transaction also works through a transaction-mode pooler.
  const databases = raw.map(db => ({
    execute: (query: SQL) => db.transaction(async tx => { await tx.execute(scope); return tx.execute(query); }),
    transaction: (fn: (tx: AssetImportExecutor) => Promise<unknown>) => db.transaction(async tx => { await tx.execute(scope); return fn(tx as unknown as AssetImportExecutor); }),
  }) as unknown as DrizzleDB);
  const [db1, db2, db3] = databases;
  const lockOwner = async (tx: AssetImportExecutor, userId: string) => { await tx.execute(sql`SELECT id FROM "user" WHERE id=${userId} FOR UPDATE`); };
  let created = false;
  try {
    await raw[3]!.execute(sql.raw(`CREATE SCHEMA "${schema}"`));
    created = true;
    await raw[3]!.transaction(async tx => {
      await tx.execute(scope);
      await tx.execute(sql.raw('CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO "user" VALUES (\'alice\'),(\'bob\');'));
      await tx.execute(sql.raw(ASSET_IMPORT_DDL));
    });
    const addJobs = async () => db1!.execute(sql`INSERT INTO asset_import_jobs(id,user_id,filename,input_bytes,status,queued_at)
      VALUES ('a1','alice','a.zip',1,'queued_inspect',now()),('a2','alice','b.zip',1,'queued_inspect',now()),('b1','bob','c.zip',1,'queued_inspect',now())`);
    // Repeated simultaneous callers use three independent database connections.
    for (let round = 0; round < 5; round++) {
      await db1!.execute(sql`DELETE FROM asset_import_jobs`);
      await addJobs();
      const claims = (await Promise.all([db1!, db2!, db3!].map(claimAssetImportJob))).filter(job => job !== null);
      assert.equal(claims.length, 2);
      assert.deepEqual(claims.map(job => job.user_id).sort(), ["alice", "bob"]);
      assert.equal(await claimAssetImportJob(db3!), null);
    }
    const rows = await db1!.execute(sql`SELECT * FROM asset_import_jobs WHERE user_id='alice' AND status='inspecting'`);
    const old = rows.rows[0] as unknown as NonNullable<Awaited<ReturnType<typeof claimAssetImportJob>>>;
    assert.equal(await renewAssetImportLease(db2!, lockOwner, old), true);
    await db1!.execute(sql`UPDATE asset_import_jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=${old.id}`);
    const renewed = await Promise.all([renewAssetImportLease(db2!, lockOwner, old), claimAssetImportJob(db3!)]);
    assert.equal(renewed[0], false);
    // A claim can skip the briefly locked owner and be picked up next tick.
    const replacement = renewed[1] ?? await claimAssetImportJob(db3!);
    assert(replacement);
    assert.equal(replacement.user_id, "alice");
    assert.notEqual(replacement.lease_token, old.lease_token);
    await assert.rejects(db1!.transaction(async tx => {
      await lockOwner(tx, old.user_id);
      await lockAssetImportLease(tx, old);
    }), /ARCHIVE_INTERRUPTED/);

    // Hold the owner row: a claimant must skip it and still serve another owner.
    await db1!.execute(sql`DELETE FROM asset_import_jobs`);
    await addJobs();
    let unlock!: () => void;
    let locked!: () => void;
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const held = db1!.transaction(async tx => { await lockOwner(tx, "alice"); locked(); await release; });
    await acquired;
    try {
      const available = await claimAssetImportJob(db2!);
      assert.equal(available?.user_id, "bob");
    } finally { unlock(); await held; }

    await db1!.execute(sql`DELETE FROM asset_import_jobs`);
    await db1!.execute(sql`INSERT INTO asset_import_jobs(id,user_id,filename,input_bytes,status,error_code,expanded_bytes,file_count,manifest_validated_at)
      VALUES ('retry','alice','retry.zip',1,'failed','ARCHIVE_QUOTA_EXCEEDED',1,1,now())`);
    await db1!.execute(sql`INSERT INTO asset_import_entries(job_id,ordinal,path,size_bytes,mime_type,asset_type,asset_id)
      VALUES ('retry',0,'a.txt',1,'text/plain','text','asset')`);
    const unusedStorage = new Proxy({}, { get: () => async () => { throw new Error("Retry must reuse the validated manifest"); } }) as AssetImportStorage;
    const services = [db1!, db2!, db3!].map(db => createAssetImportService({
      db, storage: unusedStorage,
      quota: { lockOwner, usage: async () => ({ used: 0, reserved: 0 }), limit: async () => 100 },
      uploadPolicy: { priority: async () => 0, admit: async () => { throw new Error("Unconfirmed retry must not admit"); } },
    }));
    const retries = await Promise.all(services.map(service => service.retry("alice", "retry")));
    assert(retries.every(job => job.status === "ready"));
    const accepted = await db1!.execute(sql`SELECT count(*)::int AS count FROM asset_import_retries`);
    assert.equal((accepted.rows[0] as { count: number }).count, 1);
    const marker = await db1!.execute(sql`SELECT confirmed_at FROM asset_import_jobs WHERE id='retry'`);
    assert.equal((marker.rows[0] as { confirmed_at: unknown }).confirmed_at, null);
  } finally {
    try {
      if (created) await raw[3]!.execute(sql.raw(`DROP SCHEMA "${schema}" CASCADE`));
    } finally { await Promise.all(pools.map(pool => pool.end())); }
  }
});
