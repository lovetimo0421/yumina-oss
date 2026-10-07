import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { eq, sql } from "drizzle-orm";
import { worlds, worldVersions, worldPendingEdits, worldReviewSubmissions, worldSnapshots } from "../db/schema.js";

// This regression suite must never use a developer's or deployed database.
// Imports that initialize the database happen only after these overrides.
process.env.DATABASE_URL = " ";
process.env.DATABASE_READ_URL = "";
process.env.PGLITE_DATA_DIR = "memory://";
process.env.BETTER_AUTH_SECRET = "isolated-world-version-regression";
process.env.REDIS_URL = "";
process.env.NODE_ENV = "test";
const { db, ensureWorldsSchemaDerived } = await import("../db/index.js");
const { lockWorldForVersioning, restoreStudioSnapshot, BEFORE_ROLLBACK_LABEL } = await import("./world-versioning.js");
const { applyWorldCover, writeStudioWorldSchema, getPendingEdit, commitPendingEditsForGroup } = await import("./pending-edit.js");
const { checkpointWorld, readVersionState, assetIsVersioned } = await import("./world-version-store.js");
const { WORLD_VERSION_SCHEMA_SQL, WORLDS_TABLE_SQL } = await import("../db/world-version-schema.js");
const { lockWorldForSave } = await import("./world-save-transaction.js");

const schema = (content: string, name = "Card") => ({
  id: "card", name, version: "1.0.0",
  entries: [{ id: "setting", name: "Setting", content, role: "system", position: "before_char", enabled: true, constant: true }],
  variables: [], rules: [], components: [],
});
const creatorId = "creator";
const worldId = "world";
const oldDate = new Date("2026-01-01T00:00:00Z");

before(async () => {
  // Only the tables used by these production transactions. All data is in RAM.
  for (const ddl of [
    WORLDS_TABLE_SQL,
    `CREATE TABLE world_versions (id text PRIMARY KEY, world_id text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      created_by text NOT NULL, name text NOT NULL, note text, schema jsonb NOT NULL, created_at timestamp NOT NULL DEFAULT now())`,
    `CREATE TABLE world_snapshots (id text PRIMARY KEY, world_id text NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
      user_id text NOT NULL, agent_run_id text, schema_data jsonb NOT NULL, label text NOT NULL DEFAULT 'Auto-save', created_at timestamp DEFAULT now())`,
    `CREATE TABLE world_pending_edits (id text PRIMARY KEY, world_id text NOT NULL UNIQUE REFERENCES worlds(id) ON DELETE CASCADE,
      created_by text NOT NULL, group_key text NOT NULL, schema jsonb NOT NULL, thumbnail_url text, age_rating text, is_nsfw boolean,
      reasons jsonb NOT NULL DEFAULT '[]', update_title text, update_content text, update_is_major boolean NOT NULL DEFAULT false,
      status text NOT NULL DEFAULT 'draft', submitted_at timestamp, reviewed_by text, reviewed_at timestamp, rejection_reason text,
      rejection_detail text, base_updated_at timestamp, created_at timestamp DEFAULT now(), updated_at timestamp DEFAULT now())`,
    `CREATE TABLE world_review_submissions (id text PRIMARY KEY, world_id text REFERENCES worlds(id) ON DELETE CASCADE,
      group_key text NOT NULL, submitted_by text NOT NULL, submitted_at timestamp NOT NULL DEFAULT now(), decision text NOT NULL DEFAULT 'pending',
      decided_by text, decided_at timestamp, rejection_reason text, rejection_detail text, ignored_at timestamp, ignored_by text,
      submission_type text NOT NULL DEFAULT 'initial', snapshot_age_rating text, snapshot_is_nsfw boolean, snapshot_target_audience text,
      snapshot_visibility text, snapshot_allow_edit boolean, snapshot_allow_reviews boolean)`,
  ].flatMap(ddl => ddl.split(";").map(part => part.trim()).filter(Boolean))) await db.execute(sql.raw(ddl));
  for (const statement of WORLD_VERSION_SCHEMA_SQL.split(";").filter(s => s.trim())) await db.execute(sql.raw(statement));
  await ensureWorldsSchemaDerived();
  await db.execute(sql`CREATE TABLE IF NOT EXISTS "user" (id text PRIMARY KEY, is_banned boolean DEFAULT false, is_muted boolean DEFAULT false, muted_until timestamp)`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS admin_actions (id text PRIMARY KEY, admin_id text, action_type text NOT NULL, target_type text NOT NULL, target_id text NOT NULL, metadata jsonb, created_at timestamp DEFAULT now())`);
  await db.execute(sql`INSERT INTO "user" (id) VALUES (${creatorId}) ON CONFLICT DO NOTHING`);
});
beforeEach(async () => {
  await db.execute(sql`TRUNCATE world_versions, world_snapshots, world_pending_edits, world_review_submissions, worlds`);
  await db.execute(sql`INSERT INTO worlds (id,creator_id,name,status,schema,age_rating,updated_at)
    VALUES (${worldId},${creatorId},'Card','published',${JSON.stringify(schema("LIVE"))}::jsonb,'all',${oldDate.toISOString()})`);
});
after(async () => {
  const client = (db as unknown as { $client: { close: () => Promise<void> } }).$client;
  await client.close();
});
async function addVersion(content: string, name = "Card") {
  const [version] = await db.insert(worldVersions).values({ worldId, createdBy: creatorId, name: content, schema: schema(content, name) }).returning();
  return version!.id;
}
async function readLive() {
  const [row] = await db.select({ schema: worlds.schema, name: worlds.name, status: worlds.status, updatedAt: worlds.updatedAt }).from(worlds).where(eq(worlds.id, worldId));
  return row!;
}
async function setWorkingCopy(content: string, status: "draft" | "pending" = "draft") {
  await db.insert(worldPendingEdits).values({ worldId, createdBy: creatorId, groupKey: worldId,
    schema: schema(content), status, updateTitle: "Upcoming", updateContent: "Creator's note", updateIsMajor: true });
}

test("saving a named snapshot selects the held copy and canonical display title", async () => {
  await setWorkingCopy("DRAFT");
  await db.update(worlds).set({ name: "Renamed" }).where(eq(worlds.id, worldId));
  const snapshot = await db.transaction(tx => lockWorldForVersioning(tx, worldId, creatorId));
  assert.deepEqual(snapshot!.schema, schema("DRAFT", "Renamed"));
});

test("a current published working copy can save; a changed pending copy is rejected even with the same live timestamp", async () => {
  const live = await readLive();
  const baseline = { worldId, creatorId, clientBaseUpdatedAt: live.updatedAt!.toISOString(),
    observedStatus: live.status, observedUpdatedAt: live.updatedAt, observedPendingUpdatedAt: null };
  assert.equal((await db.transaction(tx => lockWorldForSave(tx, baseline))).kind, "ready");
  await setWorkingCopy("NEW WORK");
  assert.equal((await db.transaction(tx => lockWorldForSave(tx, baseline))).kind, "stale");
  const pending = await getPendingEdit(worldId);
  assert.equal((await db.transaction(tx => lockWorldForSave(tx, { ...baseline, observedPendingUpdatedAt: pending!.updatedAt }))).kind, "ready");
});

test("AI snapshot restore backs up the working copy even when held, and its backup can itself be restored", async () => {
  await setWorkingCopy("MY UNSUBMITTED WORK");
  const [target] = await db.insert(worldSnapshots).values({ worldId, userId: creatorId, schemaData: schema("AI TARGET") }).returning();
  const result = await restoreStudioSnapshot({ worldId, creatorId, snapshotId: target!.id });
  assert.equal(result.kind === "ok" && result.held, true);
  assert.deepEqual((await readLive()).schema, schema("LIVE"));
  const backups = await db.select().from(worldSnapshots).where(eq(worldSnapshots.label, BEFORE_ROLLBACK_LABEL));
  assert.equal(backups.length, 1);
  assert.deepEqual(backups[0]!.schemaData, schema("MY UNSUBMITTED WORK"));
  await restoreStudioSnapshot({ worldId, creatorId, snapshotId: backups[0]!.id });
  assert.deepEqual((await getPendingEdit(worldId))!.schema, schema("MY UNSUBMITTED WORK"));
  const newBackups = await db.select().from(worldSnapshots).where(eq(worldSnapshots.label, BEFORE_ROLLBACK_LABEL));
  assert.equal(newBackups.length, 1);
  assert.deepEqual(newBackups[0]!.schemaData, schema("AI TARGET"));
});

test("failed AI snapshot restore preserves the earlier backup and the working copy", async () => {
  await setWorkingCopy("DRAFT");
  const [target] = await db.insert(worldSnapshots).values({ worldId, userId: creatorId, schemaData: schema("FAIL") }).returning();
  await db.insert(worldSnapshots).values({ worldId, userId: creatorId, schemaData: schema("EARLIER BACKUP"), label: BEFORE_ROLLBACK_LABEL });
  const beforeSnapshots = await db.select().from(worldSnapshots);
  await db.execute(sql`ALTER TABLE worlds ADD CONSTRAINT reject_test_write CHECK (updated_at = '2026-01-01T00:00:00'::timestamp)`);
  try {
    await assert.rejects(restoreStudioSnapshot({ worldId, creatorId, snapshotId: target!.id }));
    assert.deepEqual(await db.select().from(worldSnapshots), beforeSnapshots);
    assert.deepEqual((await getPendingEdit(worldId))!.schema, schema("DRAFT"));
  } finally {
    await db.execute(sql`ALTER TABLE worlds DROP CONSTRAINT reject_test_write`);
  }
});


test("automatic saves deduplicate content, retain metadata, and ignore compilation timestamps", async () => {
  const first = await db.transaction(tx => checkpointWorld(tx, worldId, "publish", "live"));
  const again = await db.transaction(tx => checkpointWorld(tx, worldId, "save", "live"));
  assert.equal(first, again);
  const [saved] = await db.select().from(worldVersions);
  assert.ok(saved!.publishedAt);
  assert.equal(saved!.metadata!.name, "Card");
  await db.update(worlds).set({ description: "New description" }).where(eq(worlds.id, worldId));
  const changed = await db.transaction(tx => checkpointWorld(tx, worldId, "save", "live"));
  assert.notEqual(first, changed);
});

test("an Update on a published card records only the saved draft, never an extra live backup", async () => {
  await writeStudioWorldSchema({ worldId, creatorId, schema: schema("EDITED") });
  assert.equal((await db.select().from(worldVersions)).length, 0, "background edits do not create history");
  const saved = await db.transaction(tx => checkpointWorld(tx, worldId, "save"));
  assert.equal(await db.transaction(tx => checkpointWorld(tx, worldId, "save")), saved);
  const versions = await db.select().from(worldVersions);
  assert.equal(versions.length, 1);
  assert.deepEqual(versions[0]!.schema, schema("EDITED"));
  assert.equal(versions[0]!.publishedAt, null);
  assert.deepEqual((await readLive()).schema, schema("LIVE"));
});

test("autosaving a draft does not create versions; explicit saves retain distinct saved content", async () => {
  await db.update(worlds).set({ status: "draft" }).where(eq(worlds.id, worldId));
  for (const content of ["A", "B", "C"]) await writeStudioWorldSchema({ worldId, creatorId, schema: schema(content) });
  assert.equal((await db.select().from(worldVersions)).length, 0);
  await db.transaction(tx => checkpointWorld(tx, worldId, "save"));
  await writeStudioWorldSchema({ worldId, creatorId, schema: schema("D") });
  await db.transaction(tx => checkpointWorld(tx, worldId, "save"));
  const contents = (await db.select().from(worldVersions)).map(v => (v.schema.entries as any[])[0].content);
  assert.deepEqual(contents.sort(), ["C", "D"]);
});

test("checkpoint failure rolls back the paired content save", async () => {
  await db.execute(sql`ALTER TABLE world_versions ADD CONSTRAINT reject_checkpoint CHECK (source = 'manual')`);
  try {
    await assert.rejects(db.transaction(async tx => {
      await tx.update(worlds).set({ schema: schema("BROKEN") }).where(eq(worlds.id, worldId));
      await checkpointWorld(tx, worldId, "save");
    }));
    assert.deepEqual((await readLive()).schema, schema("LIVE"));
    assert.equal((await db.select().from(worldVersions)).length, 0);
  } finally { await db.execute(sql`ALTER TABLE world_versions DROP CONSTRAINT reject_checkpoint`); }
});

test("version asset retention includes schema references and gallery metadata", async () => {
  await db.update(worlds).set({ galleryImages: ["gallery/old.png"], schema: { ...schema("LIVE"), image: "@asset:asset-123" } }).where(eq(worlds.id, worldId));
  await db.transaction(tx => checkpointWorld(tx, worldId, "save"));
  assert.equal(await assetIsVersioned(db, "asset-123", "unused.png"), true);
  assert.equal(await assetIsVersioned(db, "other", "gallery/old.png"), true);
  assert.equal(await assetIsVersioned(db, "unused", "missing.png"), false);
});


test("automatic publish refuses a superseded submission even if a newer material edit was submitted", async () => {
  await setWorkingCopy("NEW MATERIAL", "pending");
  const [old] = await db.insert(worldReviewSubmissions).values({ worldId, groupKey: worldId, submittedBy: creatorId, submissionType: "edit", decision: "withdrawn" }).returning();
  await db.insert(worldReviewSubmissions).values({ worldId, groupKey: worldId, submittedBy: creatorId, submissionType: "edit", decision: "pending" });
  const result = await commitPendingEditsForGroup(worldId, creatorId, [worldId], old!.id);
  assert.equal(result.handled, false);
  assert.deepEqual((await readLive()).schema, schema("LIVE"));
  assert.equal((await getPendingEdit(worldId))!.status, "pending");
});


test("approval marks the submitted version live without creating another version or old live backup", async () => {
  const targetSchema = schema("APPROVED", "Approved name");
  await db.insert(worldPendingEdits).values({ worldId, createdBy: creatorId, groupKey: worldId, status: "pending",
    schema: targetSchema, ageRating: "all", reasons: ["entries"], metadata: { name: "Approved name", description: "Approved description", tags: ["approved"], announcement: "Approved announcement" } });
  const [submission] = await db.insert(worldReviewSubmissions).values({ worldId, groupKey: worldId, submittedBy: creatorId, submissionType: "edit" }).returning();
  const submittedVersion = await db.transaction(tx => checkpointWorld(tx, worldId, "publish"));
  assert.equal((await db.select().from(worldVersions)).length, 1);
  assert.equal((await commitPendingEditsForGroup(worldId, creatorId, [worldId], submission!.id)).handled, true);
  const state = (await db.transaction(tx => readVersionState(tx, worldId)))!;
  assert.deepEqual(state.live.schema, targetSchema);
  assert.equal(state.live.metadata.description, "Approved description");
  assert.deepEqual(state.live.metadata.tags, ["approved"]);
  assert.equal(await getPendingEdit(worldId), null);
  const releases = (await db.select().from(worldVersions)).filter(v => v.publishedAt);
  assert.equal((await db.select().from(worldVersions)).length, 1);
  assert.equal(releases.length, 1);
  assert.equal(releases[0]!.id, submittedVersion);
  assert.ok(releases.some(v => isDeepStrictEqual(v.schema, targetSchema) && v.metadata?.announcement === "Approved announcement"));
});


test("a landscape cover replacement keeps the live portrait and held story intact", async () => {
  await setWorkingCopy("MY STORY");
  await db.update(worlds).set({ thumbnailUrl: "portrait.jpg" }).where(eq(worlds.id, worldId));
  await db.update(worldPendingEdits).set({ thumbnailUrl: "portrait.jpg" }).where(eq(worldPendingEdits.worldId, worldId));
  const result = await applyWorldCover({ worldId, creatorId, newKey: "wide.jpg", target: "landscape" } as Parameters<typeof applyWorldCover>[0]);
  assert.equal(result.ok, true);
  const [live] = await db.select().from(worlds).where(eq(worlds.id, worldId));
  assert.equal(live!.thumbnailUrl, "portrait.jpg");
  assert.equal((live!.schema as Record<string, unknown>).landscapeCover, undefined);
  const pending = await getPendingEdit(worldId);
  assert.equal(pending!.thumbnailUrl, "portrait.jpg");
  assert.equal(pending!.schema.landscapeCover, "wide.jpg");
  assert.deepEqual(pending!.schema.entries, schema("MY STORY").entries);
});


test("replacing portrait artwork preserves the dedicated landscape and its crop", async () => {
  const wideCrop = { x: 12, y: 4, zoom: .8, fit: "cover" };
  await db.update(worlds).set({ status: "draft", schema: { ...schema("STORY"), landscapeCover: "wide.jpg", landscapeCoverCrop: wideCrop,
    coverCrop: { x: 1, y: 2, zoom: .6 }, galleryCoverCrop: { x: 0, y: 20, zoom: .7 } } }).where(eq(worlds.id, worldId));
  // Production gates the per-image crop reset behind Discover preview access; a plain
  // thumbnail replacement keeps legacy crop semantics (discover-preview.test.ts).
  const result = await applyWorldCover({ worldId, creatorId, newKey: "new-portrait.jpg", target: "portrait", discoverPreview: true });
  assert.equal(result.ok, true);
  const [row] = await db.select().from(worlds).where(eq(worlds.id, worldId));
  assert.equal(row!.thumbnailUrl, "new-portrait.jpg");
  assert.equal(row!.landscapeCoverUrl, "wide.jpg");
  assert.deepEqual(row!.landscapeCoverCrop, wideCrop);
  assert.equal(row!.coverCrop, null);
  assert.equal(row!.galleryCoverCrop, null);
});
