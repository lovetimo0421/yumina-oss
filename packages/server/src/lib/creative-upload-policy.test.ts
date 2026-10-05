import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { DrizzleDB } from "../db/index.js";
import { CREATIVE_UPLOAD_STATEMENTS } from "../db/creative-upload-ddl.js";
import { admitCreativeUpload, creativeUploadPolicy } from "./creative-upload-policy.js";

test("three upload tiers group middle memberships and preserve the top tier", () => {
  assert.deepEqual(["free","go","plus","pro","ultra","internal"].map(plan => creativeUploadPolicy(plan as Parameters<typeof creativeUploadPolicy>[0])),
    [{concurrency:2,priority:0},{concurrency:4,priority:1},{concurrency:4,priority:1},{concurrency:4,priority:1},{concurrency:6,priority:2},{concurrency:6,priority:2}]);
});

test("files and archive expansion share an immutable rolling admission budget", async () => {
  const pg = new PGlite();
  try {
    await pg.exec('CREATE TABLE "user"(id text PRIMARY KEY); INSERT INTO "user" VALUES (\'alice\'),(\'bob\')');
    for (let repeat=0; repeat<2; repeat++) for (const statement of CREATIVE_UPLOAD_STATEMENTS) await pg.exec(statement);
    const db = drizzle(pg) as unknown as DrizzleDB;
    const gib = 1024 ** 3;
    const admit = (source: "file" | "archive", id: string, bytes: number, owner = "alice") => db.transaction(async tx => admitCreativeUpload(tx, owner, source, id, bytes, gib));
    assert.equal(await admit("archive", "bundle", gib), "admitted");
    assert.equal(await admit("file", "file", gib), "admitted", "exact hourly boundary is allowed");
    assert.equal(await admit("file", "extra", 1), "limit");
    assert.equal(await admit("archive", "bundle", gib), "admitted", "retry at full budget is idempotent");
    assert.equal(await admit("archive", "bundle", gib-1), "conflict", "same operation cannot disguise different content size");
    assert.equal(await admit("file", "other", 1, "bob"), "admitted");
    await pg.exec("UPDATE creative_upload_admissions SET admitted_at=now()-interval '2 hours' WHERE operation_id='bundle'");
    const before = await pg.query("SELECT admitted_at FROM creative_upload_admissions WHERE operation_id='bundle'");
    assert.equal(await admit("archive", "bundle", gib), "admitted");
    assert.deepEqual(await pg.query("SELECT admitted_at FROM creative_upload_admissions WHERE operation_id='bundle'"), before, "old retry cannot refresh its admission timestamp");
    assert.equal(await admit("archive", "next", gib), "admitted", "expired bytes leave the rolling window");
    assert.equal(await admit("file", "last", 1), "limit");
    await pg.exec("INSERT INTO creative_upload_admissions(user_id,source_kind,operation_id,bytes) SELECT 'bob','file',n::text,1 FROM generate_series(1,4999) n");
    assert.equal(await admit("file", "over-count", 1, "bob"), "limit");
    assert.equal(await admit("archive", "many-inner-files", 2000, "bob"), "admitted", "archive members do not consume individual-file count");
    await pg.exec("UPDATE creative_upload_admissions SET completed_at=clock_timestamp() WHERE source_kind='file' AND operation_id='file'");
    assert.equal(await admit("file","file",gib),"conflict","a deleted committed asset cannot reuse its admission to bypass limits");
    await pg.exec("UPDATE creative_upload_admissions SET admitted_at=now()-interval '2 days' WHERE source_kind='archive'");
    assert.equal(await admit("archive","bundle",gib),"conflict","archive IDs cannot be recycled after the 24-hour job lifetime");
  } finally { await pg.close(); }
});
