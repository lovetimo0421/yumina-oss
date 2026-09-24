import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, sql } from "drizzle-orm";
import { userAssets } from "../db/schema.js";
import { userAssetFilters } from "./user-asset-filters.js";

test("folder search finds matches beyond page one; counts respect owner, folder and image type", async () => {
  const client = new PGlite();
  try {
    await client.exec(`CREATE TABLE user_assets (id TEXT, user_id TEXT, type TEXT, filename TEXT, folder_id TEXT);
      INSERT INTO user_assets SELECT i::text,'me','image','scene-'||i||'.png','night' FROM generate_series(1,60) i;
      INSERT INTO user_assets VALUES ('root','me','image','root.png',NULL),('text','me','txt','scene-not-image.txt','night'),('private','other','image','scene-private.png','night'),('sibling','me','image','scene-sibling.png','forest'),('literal','me','image','100%_moon.png','night');`);
    const database = drizzle(client);
    const query = async (folderId: string, search: string, offset = 0) => {
      const conditions = userAssetFilters("me", { type: "image", folderId, search });
      const rows = await database.select({ filename: userAssets.filename }).from(userAssets).where(and(...conditions)).orderBy(userAssets.filename).limit(24).offset(offset);
      const [count] = await database.select({ total: sql<number>`count(*)::int` }).from(userAssets).where(and(...conditions));
      return { rows, total: count?.total };
    };
    const all = await query("night", "");
    assert.equal(all.rows.length, 24); assert.equal(all.total, 61);
    const second = await query("night", "", 24);
    assert.equal(second.total, 61); assert.equal(second.rows.length, 24);
    assert.equal(all.rows.some(a => second.rows.some(b => a.filename === b.filename)), false);
    assert.deepEqual(await query("night", "scene-60"), { rows: [{ filename: "scene-60.png" }], total: 1 });
    assert.deepEqual(await query("root", ""), { rows: [{ filename: "root.png" }], total: 1 });
    assert.deepEqual(await query("night", "%_"), { rows: [{ filename: "100%_moon.png" }], total: 1 });
    assert.deepEqual(await query("night", "private"), { rows: [], total: 0 });
    assert.deepEqual(await query("night", "not-image"), { rows: [], total: 0 });
  } finally { await client.close(); }
});
