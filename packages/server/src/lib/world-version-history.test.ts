import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { MAX_AUTO_VERSIONS_PER_WORLD, MAX_VERSIONS_PER_WORLD } from "@yumina/shared";
import { user, worlds, worldPendingEdits, worldReviewSubmissions, worldVersions } from "../db/schema.js";
import {
  captureAutomaticVersion,
  capturePublishVersion,
  lockVersionWorld,
  makeVersionLive,
  restoreVersionDraft,
  sameVersionMaterial,
  VersionActionError,
  type VersionExecutor,
} from "./world-version-history.js";

// Real PostgreSQL execution checks JSONB comparison, retention, ON CONFLICT and
// transaction atomicity. Unrelated production FKs/defaults are intentionally
// omitted; every fixture value used by the version flow is supplied explicitly.
const pg = new PGlite();
const database = drizzle(pg);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const schema = (content: string) => ({
  id: "story", version: "20.0.0", name: "Historical title",
  entries: [{ id: "intro", name: "Introduction", content, enabled: true }],
  variables: [], firstMessage: content,
});
const action = { worldId: "world", creatorId: "owner", versionId: "target" };
const transact = <T>(run: (tx: VersionExecutor) => Promise<T>) =>
  database.transaction((tx) => run(tx as unknown as VersionExecutor));

async function worldRow() {
  const [world] = await database.select().from(worlds).where(eq(worlds.id, "world"));
  assert.ok(world);
  return world;
}

async function version(id = "target", source: "manual" | "publish" | "live" | "backup" = "live", worldId = "world") {
  await database.insert(worldVersions).values({
    id, worldId, createdBy: "owner", name: id, source,
    schema: schema(id), thumbnailUrl: `${id}.webp`, ageRating: "adult",
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });
}

async function pending(status = "draft") {
  await database.insert(worldPendingEdits).values({
    id: "held", worldId: "world", createdBy: "owner", groupKey: "world",
    schema: schema("unfinished"), thumbnailUrl: "draft.webp", ageRating: "all",
    isNsfw: false, preserveDraft: false, reasons: ["entries"], status,
    updateTitle: "Next chapter", updateContent: "Still writing", updateIsMajor: true,
    baseUpdatedAt: new Date("2026-01-01T00:00:00Z"),
    createdAt: new Date("2026-01-02T00:00:00Z"), updatedAt: new Date("2026-01-02T00:00:00Z"),
  });
}

async function rejectsCode(run: () => Promise<unknown>, code: string) {
  await assert.rejects(run, (error: unknown) => error instanceof VersionActionError && error.code === code);
}

describe("world version history with PostgreSQL", { concurrency: false }, () => {
  before(async () => {
    for (const table of [user, worlds, worldPendingEdits, worldReviewSubmissions, worldVersions]) {
      const config = getTableConfig(table);
      const columns = config.columns.map((column) => {
        const type = column.getSQLType().replace(/^vector\(\d+\)$/, "text");
        return `${quote(column.name)} ${type}${column.name === "id" ? " PRIMARY KEY" : ""}`;
      });
      if (table === worldPendingEdits) columns.push('UNIQUE ("world_id")');
      await pg.exec(`CREATE TABLE ${quote(config.name)} (${columns.join(", ")})`);
    }
  });
  beforeEach(async () => {
    await pg.exec('TRUNCATE "world_versions", "world_pending_edits", "world_review_submissions", "worlds", "user"');
    await database.insert(user).values({ id: "owner", name: "Owner", email: "owner@example.test", isBanned: false });
    await database.insert(worlds).values({
      id: "world", creatorId: "owner", name: "Current listing title", description: "Story",
      schema: schema("current"), status: "published", isPublished: true,
      thumbnailUrl: "current.webp", ageRating: "all", isNsfw: false, totalTokens: 100,
      updatedAt: new Date("2026-02-01T00:00:00Z"), createdAt: new Date("2026-01-01T00:00:00Z"),
    });
  });
  after(async () => { await pg.close(); });

  it("accepts only immutable live-source versions belonging to this world and owner", async () => {
    await version();
    await rejectsCode(() => transact((tx) => makeVersionLive(tx, { ...action, creatorId: "stranger" })), "NOT_FOUND");
    await version("elsewhere", "live", "different-world");
    await rejectsCode(() => transact((tx) => makeVersionLive(tx, { ...action, versionId: "elsewhere" })), "VERSION_NOT_FOUND");
    for (const source of ["manual", "publish", "backup"] as const) {
      await version(source, source);
      await rejectsCode(() => transact((tx) => makeVersionLive(tx, { ...action, versionId: source })), "VERSION_NOT_APPROVED");
    }
    await database.update(worldVersions).set({ ageRating: null }).where(eq(worldVersions.id, "target"));
    await rejectsCode(() => transact((tx) => makeVersionLive(tx, action)), "VERSION_NOT_APPROVED");
    assert.equal((await worldRow()).schema.firstMessage, "current");
    assert.equal((await database.select().from(worldPendingEdits)).length, 0);
  });

  it("refuses publication for banned creators, nonpublished worlds and a queued draft", async () => {
    await version();
    await database.update(user).set({ isBanned: true }).where(eq(user.id, "owner"));
    await rejectsCode(() => transact((tx) => makeVersionLive(tx, action)), "BANNED");
    await database.update(user).set({ isBanned: false }).where(eq(user.id, "owner"));
    for (const status of ["draft", "pending_review", "rejected", "unpublished"]) {
      await database.update(worlds).set({ status }).where(eq(worlds.id, "world"));
      await rejectsCode(() => transact((tx) => makeVersionLive(tx, action)), "NOT_PUBLISHED");
    }
    await database.update(worlds).set({ status: "published", isPublished: false }).where(eq(worlds.id, "world"));
    await rejectsCode(() => transact((tx) => makeVersionLive(tx, action)), "NOT_PUBLISHED");
    await database.update(worlds).set({ isPublished: true }).where(eq(worlds.id, "world"));
    await pending("pending");
    await rejectsCode(() => transact((tx) => makeVersionLive(tx, action)), "VERSION_IN_REVIEW");
    assert.equal((await worldRow()).schema.firstMessage, "current");
    assert.equal((await database.select().from(worldVersions)).length, 1);
  });

  it("requires fresh review for a live snapshot from before a takedown and reapproval", async () => {
    // Target was live in January. The currently published, corrected world was
    // reapproved in March after a moderation takedown; its older approval must
    // not authorize putting the removed content back in front of players.
    await version();
    await database.update(worlds).set({ reviewedAt: new Date("2026-03-01T00:00:00Z") }).where(eq(worlds.id, "world"));
    await rejectsCode(() => transact((tx) => makeVersionLive(tx, action)), "VERSION_NOT_APPROVED");
    assert.equal((await worldRow()).schema.firstMessage, "current");
    // It remains recoverable as an editable draft through the normal review path.
    await transact((tx) => restoreVersionDraft(tx, action));
    assert.equal((await database.select().from(worldPendingEdits))[0]?.schema.firstMessage, "target");
    assert.equal((await worldRow()).schema.firstMessage, "current");
  });

  it("switches frozen content and material while preserving an existing draft and update note", async () => {
    await version();
    await pending();
    const result = await transact((tx) => makeVersionLive(tx, action));
    assert.equal(result.changed, true);
    const live = await worldRow();
    assert.equal(live.schema.firstMessage, "target");
    assert.equal(live.name, "Current listing title");
    assert.equal(live.schema.name, live.name);
    assert.equal(live.thumbnailUrl, "target.webp");
    assert.equal(live.ageRating, "adult");
    assert.equal(live.isNsfw, true);
    assert.notEqual(live.totalTokens, 100);
    const [draft] = await database.select().from(worldPendingEdits);
    assert.equal(draft?.schema.firstMessage, "unfinished");
    assert.equal(draft?.thumbnailUrl, "draft.webp");
    assert.equal(draft?.ageRating, "all");
    assert.equal(draft?.preserveDraft, true);
    assert.equal(draft?.status, "draft");
    assert.equal(draft?.updateTitle, "Next chapter");
    assert.equal(draft?.updateContent, "Still writing");
    assert.equal(draft?.updateIsMajor, true);
    assert.equal(draft?.baseUpdatedAt?.getTime(), live.updatedAt?.getTime());
    const history = await database.select().from(worldVersions);
    assert.equal(history.length, 1, "switching live must not create an outgoing-live backup");
  });

  it("retains the previous working content even with no existing hold or material difference", async () => {
    const current = await worldRow();
    await version();
    await database.update(worldVersions).set({
      schema: { ...current.schema, firstMessage: "older opening" },
      thumbnailUrl: current.thumbnailUrl, ageRating: current.ageRating,
    }).where(eq(worldVersions.id, "target"));
    await transact((tx) => makeVersionLive(tx, action));
    const [draft] = await database.select().from(worldPendingEdits);
    assert.equal((await worldRow()).schema.firstMessage, "older opening");
    assert.equal(draft?.schema.firstMessage, "current");
    assert.equal(draft?.preserveDraft, true);
    assert.deepEqual(draft?.reasons, []);
  });

  it("does not disturb a draft or create history when the selected content is already live", async () => {
    await version();
    const current = await worldRow();
    await database.update(worldVersions).set({ schema: { ...current.schema, name: "Old title" }, thumbnailUrl: current.thumbnailUrl, ageRating: current.ageRating }).where(eq(worldVersions.id, "target"));
    await pending("rejected");
    const beforeDraft = await database.select().from(worldPendingEdits);
    const result = await transact((tx) => makeVersionLive(tx, action));
    assert.equal(result.changed, false);
    assert.deepEqual(await database.select().from(worldPendingEdits), beforeDraft);
    assert.equal((await database.select().from(worldVersions)).length, 1);
  });

  it("keeps manual slots and the old selected target when automatic retention is full", async () => {
    await version();
    for (let i = 0; i < MAX_VERSIONS_PER_WORLD; i++) await version(`manual-${i}`, "manual");
    for (let i = 0; i < MAX_AUTO_VERSIONS_PER_WORLD - 1; i++) await version(`auto-${i}`, "publish");
    await database.update(worldVersions).set({ createdAt: new Date("2020-01-01T00:00:00Z") }).where(eq(worldVersions.id, "target"));
    await transact((tx) => makeVersionLive(tx, action));
    const history = await database.select().from(worldVersions);
    assert.equal(history.filter((v) => v.source === "manual").length, MAX_VERSIONS_PER_WORLD);
    assert.equal(history.filter((v) => v.source !== "manual").length, MAX_AUTO_VERSIONS_PER_WORLD);
    assert.ok(history.some((v) => v.id === "target"));
    assert.ok(!history.some((v) => v.schema.firstMessage === "current"));
  });

  it("captures only the held working draft on Publish, without a live baseline", async () => {
    await pending();
    await transact(async (tx) => {
      const world = await lockVersionWorld(tx, "world", "owner");
      assert.ok(world);
      const [draft] = await tx.select().from(worldPendingEdits);
      await capturePublishVersion(tx, world, draft!);
    });
    const history = await database.select().from(worldVersions);
    assert.equal(history.find((v) => v.source === "publish")?.schema.firstMessage, "unfinished");
    assert.equal(history.find((v) => v.source === "publish")?.thumbnailUrl, "draft.webp");
    assert.equal(history.length, 1);
    assert.equal(history.find((v) => v.source === "live"), undefined);
  });

  it("reuses one saved row for repeated submissions and approval, preserving its save time", async () => {
    await pending();
    const world = await worldRow();
    const [draft] = await database.select().from(worldPendingEdits);
    assert.ok(draft);
    const savedId = await transact((tx) => capturePublishVersion(tx, world, draft));
    const saved = (await database.select().from(worldVersions))[0]!;
    const repeatedId = await transact((tx) => capturePublishVersion(tx, world, draft));
    assert.equal(repeatedId, savedId);
    assert.equal(saved.source, "publish");
    assert.equal(saved.publishedAt, null);
    await rejectsCode(() => transact((tx) => makeVersionLive(tx, { ...action, versionId: savedId })), "VERSION_NOT_APPROVED");

    // Approval publishes the exact submitted material; it marks the existing
    // record instead of adding a second, identical 'published' card.
    const [published] = await database.update(worlds).set({
      schema: draft.schema, thumbnailUrl: draft.thumbnailUrl, ageRating: draft.ageRating ?? "all",
      reviewedAt: new Date(),
    }).where(eq(worlds.id, "world")).returning();
    assert.ok(published);
    const approvedId = await transact((tx) => captureAutomaticVersion(tx, published, "live", published));
    assert.equal(approvedId, savedId);
    const history = await database.select().from(worldVersions);
    assert.equal(history.length, 1);
    assert.equal(history[0]!.source, "live");
    assert.equal(history[0]!.createdAt.getTime(), saved.createdAt.getTime());
    assert.ok(history[0]!.publishedAt! >= published.reviewedAt!);
    await transact((tx) => capturePublishVersion(tx, published, null));
    assert.equal((await database.select().from(worldVersions)).length, 1);

    await database.update(worlds).set({ schema: schema("a newer live revision") }).where(eq(worlds.id, "world"));
    const switched = await transact((tx) => makeVersionLive(tx, { ...action, versionId: savedId }));
    assert.equal(switched.changed, true);
  });

  it("retains a distinct row when submitted content changes", async () => {
    const world = await worldRow();
    const first = await transact((tx) => capturePublishVersion(tx, world, null));
    const second = await transact((tx) => captureAutomaticVersion(tx, world, "publish", { ...world, schema: schema("changed") }));
    assert.notEqual(first, second);
    assert.equal((await database.select().from(worldVersions)).length, 2);
  });

  it("deduplicates true live records without promoting matching manual saves", async () => {
    const world = await worldRow();
    await version("manual", "manual");
    await database.update(worldVersions).set({ schema: world.schema, thumbnailUrl: world.thumbnailUrl, ageRating: world.ageRating }).where(eq(worldVersions.id, "manual"));
    const first = await transact((tx) => captureAutomaticVersion(tx, world, "live", world));
    const second = await transact((tx) => captureAutomaticVersion(tx, world, "live", { ...world, schema: { ...world.schema, name: "Renamed" } }));
    assert.equal(first, second);
    assert.notEqual(first, "manual");
    assert.deepEqual((await database.select().from(worldVersions)).map((v) => v.source).sort(), ["live", "manual"]);
    assert.equal(sameVersionMaterial(world, { ...world, schema: { ...world.schema, name: "Renamed" } }), true);
  });

  it("records a fresh approval on the same row when old content is reapproved", async () => {
    await version();
    await database.update(worlds).set({ reviewedAt: new Date("2026-03-01T00:00:00Z") }).where(eq(worlds.id, "world"));
    const world = await worldRow();
    await database.update(worldVersions).set({ schema: world.schema, thumbnailUrl: world.thumbnailUrl, ageRating: world.ageRating }).where(eq(worldVersions.id, "target"));
    const freshId = await transact((tx) => captureAutomaticVersion(tx, world, "live", world));
    assert.equal(freshId, "target");
    const reusedId = await transact((tx) => captureAutomaticVersion(tx, world, "live", world));
    assert.equal(reusedId, freshId);
    const fresh = (await database.select().from(worldVersions)).find((v) => v.id === freshId);
    assert.ok(fresh?.publishedAt && fresh.publishedAt >= world.reviewedAt!);
    assert.equal(fresh.createdAt.toISOString(), "2026-01-01T00:00:00.000Z");
    await database.update(worlds).set({ schema: schema("newer edit") }).where(eq(worlds.id, "world"));
    const switched = await transact((tx) => makeVersionLive(tx, { ...action, versionId: freshId }));
    assert.equal(switched.changed, true);
    assert.equal((await worldRow()).schema.firstMessage, "current");
  });

  it("restores published content into a held draft, backs up working content and withdraws queued review", async () => {
    await version("target", "manual");
    await pending("pending");
    await database.insert(worldReviewSubmissions).values({ id: "review", worldId: "world", groupKey: "world", submittedBy: "owner", decision: "pending", submissionType: "edit" });
    const beforeLive = await worldRow();
    await transact((tx) => restoreVersionDraft(tx, action));
    const afterLive = await worldRow();
    assert.deepEqual(afterLive.schema, beforeLive.schema);
    assert.equal(afterLive.thumbnailUrl, beforeLive.thumbnailUrl);
    assert.equal(afterLive.ageRating, beforeLive.ageRating);
    const [draft] = await database.select().from(worldPendingEdits);
    assert.equal(draft?.schema.firstMessage, "target");
    assert.equal(draft?.preserveDraft, true);
    assert.equal(draft?.status, "draft");
    const [review] = await database.select().from(worldReviewSubmissions);
    assert.equal(review?.decision, "withdrawn");
    assert.equal(review?.decidedBy, "owner");
    const backups = (await database.select().from(worldVersions)).filter((v) => v.source === "backup");
    assert.equal(backups.length, 1);
    assert.equal(backups[0]?.schema.firstMessage, "unfinished");
  });

  it("restores legacy schema-only saves without erasing the effective working cover or rating", async () => {
    await version("target", "manual");
    await database.update(worldVersions).set({ ageRating: null, thumbnailUrl: null }).where(eq(worldVersions.id, "target"));
    await pending();
    await database.update(worldPendingEdits).set({ ageRating: "adult" }).where(eq(worldPendingEdits.worldId, "world"));
    await transact((tx) => restoreVersionDraft(tx, { ...action, skipSafetySnapshot: true }));
    const [draft] = await database.select().from(worldPendingEdits);
    assert.equal(draft?.schema.firstMessage, "target");
    assert.equal(draft?.thumbnailUrl, "draft.webp");
    assert.equal(draft?.ageRating, "adult");
    assert.equal((await database.select().from(worldVersions)).length, 1);
    assert.equal((await worldRow()).schema.firstMessage, "current");
  });

  it("restores an unpublished draft directly and respects intentional cover removal", async () => {
    await version("target", "manual");
    await database.update(worldVersions).set({ thumbnailUrl: null }).where(eq(worldVersions.id, "target"));
    await database.update(worlds).set({ status: "draft", isPublished: false }).where(eq(worlds.id, "world"));
    await transact((tx) => restoreVersionDraft(tx, action));
    const world = await worldRow();
    assert.equal(world.schema.firstMessage, "target");
    assert.equal(world.thumbnailUrl, null);
    assert.equal(world.ageRating, "adult");
    assert.equal(world.isNsfw, true);
    assert.equal((await database.select().from(worldPendingEdits)).length, 0);
  });

  it("does not leave history behind when the submitted version cannot be persisted", async () => {
    await pg.exec("ALTER TABLE world_versions ADD CONSTRAINT fail_publish CHECK (source <> 'publish')");
    try {
      const world = await worldRow();
      await assert.rejects(() => transact((tx) => capturePublishVersion(tx, world, null)));
      assert.equal((await database.select().from(worldVersions)).length, 0);
      assert.equal((await worldRow()).schema.firstMessage, "current");
    } finally { await pg.exec("ALTER TABLE world_versions DROP CONSTRAINT fail_publish"); }
  });

  it("does not restore or withdraw review when its safety snapshot fails", async () => {
    await version("target", "manual");
    await pending("pending");
    await database.insert(worldReviewSubmissions).values({ id: "review", worldId: "world", groupKey: "world", submittedBy: "owner", decision: "pending", submissionType: "edit" });
    await pg.exec("ALTER TABLE world_versions ADD CONSTRAINT fail_backup CHECK (source <> 'backup')");
    try {
      await assert.rejects(() => transact((tx) => restoreVersionDraft(tx, action)));
      const [draft] = await database.select().from(worldPendingEdits);
      assert.equal(draft?.schema.firstMessage, "unfinished");
      assert.equal(draft?.status, "pending");
      assert.equal((await database.select().from(worldReviewSubmissions))[0]?.decision, "pending");
      assert.equal((await worldRow()).schema.firstMessage, "current");
      assert.equal((await database.select().from(worldVersions)).length, 1);
    } finally { await pg.exec("ALTER TABLE world_versions DROP CONSTRAINT fail_backup"); }
  });

  it("rolls back both public content and its archive if preserving the draft fails", async () => {
    await version();
    await pg.exec("ALTER TABLE world_pending_edits ADD CONSTRAINT fail_preserve CHECK (preserve_draft = false)");
    try {
      await assert.rejects(() => transact((tx) => makeVersionLive(tx, action)));
      assert.equal((await worldRow()).schema.firstMessage, "current");
      assert.equal((await worldRow()).thumbnailUrl, "current.webp");
      assert.equal((await database.select().from(worldPendingEdits)).length, 0);
      assert.equal((await database.select().from(worldVersions)).length, 1);
    } finally { await pg.exec("ALTER TABLE world_pending_edits DROP CONSTRAINT fail_preserve"); }
  });
});
