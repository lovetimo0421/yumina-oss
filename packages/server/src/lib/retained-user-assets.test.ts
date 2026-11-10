import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { sql } from "drizzle-orm";

// In-memory database only; imports that initialize the database come after.
process.env.DATABASE_URL = " ";
process.env.DATABASE_READ_URL = "";
process.env.PGLITE_DATA_DIR = "memory://";
process.env.BETTER_AUTH_SECRET = "isolated-retained-assets";
process.env.REDIS_URL = "";
process.env.NODE_ENV = "test";
const { db, ensureWorldsSchemaDerived } = await import("../db/index.js");
const { WORLD_VERSION_SCHEMA_SQL, WORLDS_TABLE_SQL } = await import("../db/world-version-schema.js");
const { checkpointWorld } = await import("./world-version-store.js");
const { worldsUsingAssetContent, urlServedElsewhere, retainUserAsset, sweepRetainedUserAssets } = await import("./retained-user-assets.js");

const owner = "owner";
const assetId = "2ab61d99-2021-8b22-a6c7-1fa2ed1b6702";
const url = `users/${owner}/registered/786372bf861e85cd`;
const card = (image?: string) => ({ id: "card", name: "Card", version: "1.0.0", entries: [], variables: [], rules: [], components: [], ...(image ? { image } : {}) });

before(async () => {
  for (const ddl of [
    WORLDS_TABLE_SQL,
    `CREATE TABLE world_versions (id text PRIMARY KEY, world_id text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      created_by text NOT NULL, name text NOT NULL, note text, schema jsonb NOT NULL, created_at timestamp NOT NULL DEFAULT now())`,
    `CREATE TABLE world_pending_edits (id text PRIMARY KEY, world_id text NOT NULL UNIQUE REFERENCES worlds(id) ON DELETE CASCADE,
      created_by text NOT NULL, group_key text NOT NULL, schema jsonb NOT NULL, thumbnail_url text, age_rating text, is_nsfw boolean,
      reasons jsonb NOT NULL DEFAULT '[]', status text NOT NULL DEFAULT 'draft', submitted_at timestamp, reviewed_by text, reviewed_at timestamp,
      rejection_reason text, rejection_detail text, base_updated_at timestamp, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now())`,
    `CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY)`,
    `CREATE TABLE asset_folders (id text PRIMARY KEY, user_id text NOT NULL, name text NOT NULL, parent_folder_id text, created_at timestamp DEFAULT now())`,
    `CREATE TABLE user_assets (id text PRIMARY KEY, user_id text NOT NULL REFERENCES "user"(id), type text NOT NULL, filename text NOT NULL,
      url text NOT NULL, size_bytes integer, mime_type text, folder_id text REFERENCES asset_folders(id) ON DELETE SET NULL,
      source_asset_id text, is_public boolean NOT NULL DEFAULT false, created_at timestamp DEFAULT now())`,
    `CREATE TABLE assets (id text PRIMARY KEY, world_id text, type text, filename text, url text NOT NULL, size_bytes integer, mime_type text, created_at timestamp DEFAULT now())`,
    `CREATE TABLE asset_references (id text PRIMARY KEY, world_id text NOT NULL, asset_id text NOT NULL, created_at timestamp DEFAULT now())`,
  ].flatMap((ddl) => ddl.split(";").map((part) => part.trim()).filter(Boolean))) await db.execute(sql.raw(ddl));
  for (const statement of WORLD_VERSION_SCHEMA_SQL.split(";").filter((s) => s.trim())) await db.execute(sql.raw(statement));
  await ensureWorldsSchemaDerived();
  await db.execute(sql`INSERT INTO "user" (id) VALUES (${owner}), ('someone')`);
});

after(async () => {
  const client = (db as unknown as { $client: { close: () => Promise<void> } }).$client;
  await client.close();
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE world_versions, world_pending_edits, worlds, user_assets, assets, asset_references, asset_folders, retained_user_asset_files`);
  await db.execute(sql`INSERT INTO asset_folders (id, user_id, name) VALUES ('folder', ${owner}, 'Art')`);
  await db.execute(sql`INSERT INTO user_assets (id, user_id, type, filename, url, folder_id) VALUES (${assetId}, ${owner}, 'image', 'a.png', ${url}, 'folder')`);
});

async function insertWorld(id: string, creator: string, schema: object, status = "draft") {
  await db.execute(sql`INSERT INTO worlds (id, creator_id, name, status, schema, age_rating, updated_at)
    VALUES (${id}, ${creator}, ${id}, ${status}, ${JSON.stringify(schema)}::jsonb, 'all', now())`);
}

async function deleteIntoRetention() {
  await db.transaction(async (tx) => {
    await retainUserAsset(tx, assetId);
    await tx.execute(sql`DELETE FROM user_assets WHERE id = ${assetId}`);
  });
}

test("a card's current content, draft or pending edit counts as use; another creator's card does not", async () => {
  await insertWorld("draft", owner, card(`@asset:${assetId}`));
  assert.deepEqual((await worldsUsingAssetContent(db, owner, assetId, url)).map((w) => w.id), ["draft"]);

  await db.execute(sql`TRUNCATE worlds CASCADE`);
  await insertWorld("live", owner, card(), "published");
  await db.execute(sql`INSERT INTO world_pending_edits (id, world_id, created_by, group_key, schema)
    VALUES ('p', 'live', ${owner}, 'g', ${JSON.stringify(card(`url(/api/files/${url})`))}::jsonb)`);
  assert.deepEqual((await worldsUsingAssetContent(db, owner, assetId, url)).map((w) => w.id), ["live"]);

  await db.execute(sql`TRUNCATE worlds CASCADE`);
  await insertWorld("theirs", "someone", card(`@asset:${assetId}`));
  assert.equal((await worldsUsingAssetContent(db, owner, assetId, url)).length, 0);
  await db.execute(sql`INSERT INTO asset_references (id, world_id, asset_id) VALUES ('r', 'theirs', ${assetId})`);
  assert.equal((await worldsUsingAssetContent(db, owner, assetId, url)).length, 1);
});

test("shared bytes are detected so deleting one row never removes another row's file", async () => {
  assert.equal(await urlServedElsewhere(db, url, assetId), false);
  await db.execute(sql`INSERT INTO assets (id, world_id, url) VALUES ('w', 'x', ${url})`);
  assert.equal(await urlServedElsewhere(db, url, assetId), true);
});

test("sweep keeps files saved versions still hold, purges released ones, and returns reused ones to the library", async () => {
  // Held by a saved version, gone from the current content.
  await insertWorld("card", owner, card(`@asset:${assetId}`));
  await db.transaction((tx) => checkpointWorld(tx, "card", "save"));
  await db.execute(sql`UPDATE worlds SET schema = ${JSON.stringify(card())}::jsonb WHERE id = 'card'`);
  await deleteIntoRetention();
  assert.deepEqual(await sweepRetainedUserAssets(), { purged: 0, restored: 0 });
  assert.equal((await db.execute(sql`SELECT 1 FROM retained_user_asset_files`)).rows.length, 1);

  // A restored version puts it back in the card: it returns, minus a deleted folder.
  await db.execute(sql`DELETE FROM world_versions`);
  await db.execute(sql`DELETE FROM asset_folders`);
  await db.execute(sql`UPDATE worlds SET schema = ${JSON.stringify(card(`@asset:${assetId}`))}::jsonb WHERE id = 'card'`);
  assert.deepEqual(await sweepRetainedUserAssets(), { purged: 0, restored: 1 });
  const back = (await db.execute(sql`SELECT filename, folder_id FROM user_assets WHERE id = ${assetId}`)).rows[0] as { filename: string; folder_id: string | null };
  assert.deepEqual({ ...back }, { filename: "a.png", folder_id: null });

  // Released by every version and unused: the retained record goes.
  await db.execute(sql`UPDATE worlds SET schema = ${JSON.stringify(card())}::jsonb WHERE id = 'card'`);
  await deleteIntoRetention();
  assert.deepEqual(await sweepRetainedUserAssets(), { purged: 1, restored: 0 });
  assert.equal((await db.execute(sql`SELECT 1 FROM retained_user_asset_files`)).rows.length, 0);
});
