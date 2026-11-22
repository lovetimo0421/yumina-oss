import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds } from "../db/schema.js";
import { shareArtworkWithLanguageSiblings } from "./language-group-artwork.js";

const crop = { x: 4, y: -2, zoom: 0.9, fit: "cover" };
const base = { version: "21.0.0", name: "Card", entries: [], variables: [], rules: [], components: [] };

async function group() {
  const creatorId = crypto.randomUUID();
  await db.insert(user).values({ id: creatorId, name: "Creator", email: `${creatorId}@test.invalid` });
  const languageGroupId = crypto.randomUUID();
  const seed = async (patch: Partial<typeof worlds.$inferInsert> = {}) => {
    const [row] = await db.insert(worlds).values({ id: crypto.randomUUID(), creatorId, languageGroupId, language: "en", name: "Card",
      status: "draft", thumbnailUrl: null, schema: base, ...patch }).returning();
    return row!;
  };
  const read = async (id: string) => (await db.select().from(worlds).where(eq(worlds.id, id)))[0]!;
  return { creatorId, seed, read };
}

test("a translation without covers takes the card's covers and crops", async () => {
  const g = await group();
  const source = await g.seed({ thumbnailUrl: "tall.webp", schema: { ...base, coverCrop: crop, landscapeCover: "wide.webp", landscapeCoverCrop: crop } });
  const ja = await g.seed({ language: "ja" });
  assert.deepEqual(await shareArtworkWithLanguageSiblings(source.id, g.creatorId), [ja.id]);
  const after = await g.read(ja.id);
  assert.equal(after.thumbnailUrl, "tall.webp");
  assert.equal(after.landscapeCoverUrl, "wide.webp");
  assert.deepEqual(after.coverCrop, crop);
  assert.deepEqual(after.landscapeCoverCrop, crop);
  assert.deepEqual((after.schema as Record<string, unknown>).entries, [], "the rest of the card is untouched");
});

test("artwork a translation already has is never replaced, and a crop only travels with its image", async () => {
  const g = await group();
  const source = await g.seed({ thumbnailUrl: "tall.webp", schema: { ...base, coverCrop: crop, landscapeCover: "wide.webp", landscapeCoverCrop: crop } });
  const own = { x: 0, y: 10, zoom: 1, fit: "cover" };
  const es = await g.seed({ language: "es", thumbnailUrl: "own-tall.webp", schema: { ...base, coverCrop: own } });
  await shareArtworkWithLanguageSiblings(source.id, g.creatorId);
  const after = await g.read(es.id);
  assert.equal(after.thumbnailUrl, "own-tall.webp");
  assert.deepEqual(after.coverCrop, own, "its own portrait crop stays");
  assert.equal(after.landscapeCoverUrl, "wide.webp", "the empty landscape slot is filled");
  assert.deepEqual(after.landscapeCoverCrop, crop);
});

test("live cards, other creators' cards and other groups are left alone", async () => {
  const g = await group();
  const source = await g.seed({ thumbnailUrl: "tall.webp", schema: { ...base, landscapeCover: "wide.webp" } });
  const live = await g.seed({ language: "ja", status: "published", isPublished: true });
  const queued = await g.seed({ language: "es", status: "pending_review" });
  const other = await group();
  const stranger = await other.seed({ language: "zh", languageGroupId: source.languageGroupId! });
  const elsewhere = await g.seed({ language: "zh", languageGroupId: crypto.randomUUID() });
  assert.deepEqual(await shareArtworkWithLanguageSiblings(source.id, g.creatorId), []);
  for (const row of [live, queued, stranger, elsewhere]) {
    const after = await g.read(row.id);
    assert.equal(after.thumbnailUrl, null);
    assert.equal(after.landscapeCoverUrl, null);
  }
});

test("someone else cannot push their card's covers into a group", async () => {
  const g = await group();
  const source = await g.seed({ thumbnailUrl: "tall.webp", schema: { ...base, landscapeCover: "wide.webp" } });
  const ja = await g.seed({ language: "ja" });
  assert.deepEqual(await shareArtworkWithLanguageSiblings(source.id, crypto.randomUUID()), []);
  assert.equal((await g.read(ja.id)).thumbnailUrl, null);
});
