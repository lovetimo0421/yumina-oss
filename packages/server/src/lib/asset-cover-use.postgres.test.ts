import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { coverRefs, worldsUsingAsCover } from "./asset-cover-use.js";
import type { WorldEditExecutor } from "./pending-edit.js";

test("coverRefs lists every stored spelling once", () => {
  assert.deepEqual(coverRefs("a1", "users/u/image/a1-x.png"), ["users/u/image/a1-x.png", "a1", "@asset:a1", "/cdn/a1"]);
});

// Opt-in only, like the other *.postgres tests. All SQL runs in a new schema that is dropped afterwards.
const connectionString = process.env.ASSET_COVER_TEST_DATABASE_URL;
test("a file still used as any card's cover is reported", { skip: !connectionString, timeout: 60_000 }, async () => {
  const schema = `asset_cover_test_${randomUUID().replaceAll("-", "")}`;
  const pool = new pg.Pool({ connectionString, max: 1 });
  const db = drizzle(pool);
  const scope = sql.raw(`SET LOCAL search_path TO "${schema}", pg_catalog`);
  const run = <T>(fn: (tx: WorldEditExecutor) => Promise<T>) => db.transaction(async (tx) => { await tx.execute(scope); return fn(tx as unknown as WorldEditExecutor); });
  try {
    await db.execute(sql.raw(`CREATE SCHEMA "${schema}"`));
    await run(async (tx) => {
      await tx.execute(sql.raw(`
        CREATE TABLE worlds(id text PRIMARY KEY, name text, thumbnail_url text, landscape_cover_url text, gallery_images jsonb DEFAULT '[]');
        CREATE TABLE world_pending_edits(id text PRIMARY KEY, world_id text, thumbnail_url text);
        INSERT INTO worlds VALUES
          ('zh', '第二恩惠', 'users/u/image/old-cover.png', NULL, '[]'),
          ('en', 'Second Falna', 'worlds/en/image/new.webp', 'worlds/en/image/wide.webp', '["users/u/image/shot.png"]'),
          ('legacy', 'Legacy', '@asset:legacy-id', NULL, NULL),
          ('other', 'Other', NULL, NULL, '{}');
        INSERT INTO world_pending_edits VALUES ('p1', 'other', 'users/u/image/proposed.png');`));
    });
    const names = async (id: string, url: string) => (await run((tx) => worldsUsingAsCover(tx, id, url))).map((w) => w.name).sort();
    assert.deepEqual(await names("old-id", "users/u/image/old-cover.png"), ["第二恩惠"], "portrait cover");
    assert.deepEqual(await names("wide-id", "worlds/en/image/wide.webp"), ["Second Falna"], "landscape cover");
    assert.deepEqual(await names("shot-id", "users/u/image/shot.png"), ["Second Falna"], "gallery image");
    assert.deepEqual(await names("legacy-id", "users/u/image/whatever.png"), ["Legacy"], "@asset: spelling");
    assert.deepEqual(await names("prop-id", "users/u/image/proposed.png"), ["Other"], "pending-review cover");
    assert.deepEqual(await names("free-id", "users/u/image/unused.png"), [], "unused file can be deleted");
  } finally {
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)).catch(() => {});
    await pool.end();
  }
});
