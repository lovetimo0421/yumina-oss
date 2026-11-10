import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and } from "drizzle-orm";
import type { DrizzleDB } from "../db/index.js";
import { userAssets } from "../db/schema.js";
import { userAssetFilters } from "./user-asset-filters.js";
import { summarizeAssetFolderTrees } from "./asset-folder-tree.js";

test("bound folders show imported descendants, with cycle-safe and owner-scoped counts/previews", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`CREATE TABLE asset_folders(id text PRIMARY KEY,user_id text,parent_folder_id text);
      CREATE TABLE user_assets(id text PRIMARY KEY,user_id text,folder_id text,filename text,type text,created_at timestamp DEFAULT now());
      INSERT INTO asset_folders VALUES ('bound-root','me','child'),('child','me','bound-root'),('grandchild','me','child'),('foreign','other','bound-root'),('outside','me',null);
      INSERT INTO user_assets SELECT i::text,'me','grandchild','image-'||i||'.png','image',now() FROM generate_series(1,6) i;
      INSERT INTO user_assets VALUES ('sound','me','child','bgm.mp3','audio',now()),('hidden','other','foreign','private.png','image',now()),('unbound','me','outside','other.png','image',now());`);
    const db = drizzle(pg) as unknown as DrizzleDB;
    const summary = await summarizeAssetFolderTrees(db, "me", ["bound-root"]);
    assert.deepEqual(summary.counts, [{ folderId: "bound-root", count: 7 }]);
    assert.equal(summary.previews.length, 4);
    assert(summary.previews.every(item => item.folder_id === "bound-root" && /^[1-6]$/.test(item.id)));
    const recursive = await db.select({ id: userAssets.id }).from(userAssets).where(and(...userAssetFilters("me", { folderId: "bound-root", recursive: true })));
    assert.equal(recursive.length, 7);
    const direct = await db.select({ id: userAssets.id }).from(userAssets).where(and(...userAssetFilters("me", { folderId: "bound-root" })));
    assert.equal(direct.length, 0, "normal library navigation still lists one directory at a time");
    assert.deepEqual(await summarizeAssetFolderTrees(db, "me", ["foreign"]), { counts: [], previews: [] });
  } finally { await pg.close(); }
});
