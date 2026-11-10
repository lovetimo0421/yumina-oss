import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Hono } from "hono";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, worldReviewSubmissions, worldVersions } from "../db/schema.js";
import { auth } from "../lib/auth.js";
import { worldRoutes } from "./worlds.js";

const app = new Hono().route("/api/worlds", worldRoutes);
const crop = { x: 0, y: 0, zoom: 1, fit: "cover" };
async function fixture(t: TestContext, options: { trusted?: boolean; discover?: boolean; banned?: boolean } = {}) {
  const creatorId = crypto.randomUUID();
  await db.insert(user).values({ id: creatorId, name: "Creator", email: `${creatorId}@test.invalid`, skipReview: !!options.trusted, isBanned: !!options.banned });
  t.mock.method(auth.api, "getSession", async ({ headers }: { headers: Headers }) => {
    const id = headers.get("x-test-user");
    return id ? { user: { id }, session: { id: `${id}-session`, userId: id, token: "fixture", expiresAt: new Date(Date.now() + 60000) } } : null;
  });
  const previous = process.env.DISCOVER_PUBLIC_ENABLED;
  process.env.DISCOVER_PUBLIC_ENABLED = options.discover === false ? "false" : "true";
  t.after(() => { if (previous === undefined) delete process.env.DISCOVER_PUBLIC_ENABLED; else process.env.DISCOVER_PUBLIC_ENABLED = previous; });
  const group = crypto.randomUUID();
  const seed = async (patch: Partial<typeof worlds.$inferInsert> = {}) => {
    const id = crypto.randomUUID();
    const [row] = await db.insert(worlds).values({ id, creatorId, languageGroupId: group, language: "en", name: "Paths of Ascension", status: "draft", thumbnailUrl: "portrait.webp",
      schema: { version: "21.0.0", name: "Paths of Ascension", entries: [], variables: [], rules: [], components: [], coverCrop: crop, landscapeCover: "wide.webp", landscapeCoverCrop: crop }, ...patch }).returning();
    return row!;
  };
  const submit = (id: string, actor = creatorId) => app.request(`/api/worlds/${id}/status`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-test-user": actor },
    body: JSON.stringify({ status: "pending_review", ageRating: "all", targetAudience: "all" }),
  });
  return { creatorId, seed, submit };
}

for (const trusted of [false, true]) {
  test(`only the selected version enters review/publication (trusted=${trusted})`, async t => {
    const f = await fixture(t, { trusted });
    const selected = await f.seed();
    const siblings = await Promise.all([
      f.seed({ name: "问道", language: "zh", schema: { coverCrop: crop } }),
      f.seed({ name: "Another finished draft", language: "ja" }),
      f.seed({ name: "Already queued", status: "pending_review" }),
      f.seed({ name: "Already live", status: "published", isPublished: true }),
    ]);
    const response = await f.submit(selected.id);
    assert.equal(response.status, 200, await response.clone().text());
    const { data } = await response.json() as { data: { status: string } };
    assert.equal(data.status, trusted ? "published" : "pending_review");
    const ids = siblings.map(s => s.id);
    const after = await db.select().from(worlds).where(inArray(worlds.id, ids));
    for (const sibling of siblings) assert.deepEqual(after.find(row => row.id === sibling.id), sibling, "unselected versions stay byte-for-byte unchanged");
    assert.equal((await db.select().from(worldReviewSubmissions).where(inArray(worldReviewSubmissions.worldId, ids))).length, 0);
    assert.equal((await db.select().from(worldVersions).where(inArray(worldVersions.worldId, ids))).length, 0);
    assert.equal((await db.select().from(worldReviewSubmissions).where(eq(worldReviewSubmissions.worldId, selected.id))).length, 1);
  });
}

for (const [patch, code, missing] of [
  [{ thumbnailUrl: null }, "COVER_REQUIRED", ["portraitImage"]],
  [{ schema: { coverCrop: crop } }, "COVER_ART_REQUIRED", ["landscapeImage"]],
  [{ schema: { coverCrop: crop, landscapeCover: "wide.webp" } }, "COVER_ART_REQUIRED", ["landscapeCrop"]],
] as const) {
  test(`invalid selected artwork reports ${missing[0]} without submitting any sibling`, async t => {
    const f = await fixture(t);
    const selected = await f.seed(patch);
    const sibling = await f.seed({ language: "zh" });
    const response = await f.submit(selected.id);
    assert.equal(response.status, 400);
    const body = await response.json() as { code: string; artworkFailures: unknown };
    assert.equal(body.code, code);
    assert.deepEqual(body.artworkFailures, [{ worldId: selected.id, name: selected.name, language: "en", missing }]);
    for (const row of [selected, sibling]) assert.deepEqual((await db.select().from(worlds).where(eq(worlds.id, row.id)))[0], row);
  });
}

test("legacy Discover access keeps the portrait-only rule", async t => {
  const f = await fixture(t, { discover: false });
  const selected = await f.seed({ schema: {} });
  assert.equal((await f.submit(selected.id)).status, 200);
});

test("submission still enforces ownership and status", async t => {
  const f = await fixture(t);
  const otherCreator = crypto.randomUUID();
  await db.insert(user).values({ id: otherCreator, name: "Other creator", email: `${otherCreator}@test.invalid` });
  const foreign = await f.seed({ creatorId: otherCreator });
  assert.equal((await f.submit(foreign.id)).status, 404);
  const live = await f.seed({ status: "published", isPublished: true });
  assert.equal((await f.submit(live.id)).status, 400);
  assert.deepEqual((await db.select().from(worlds).where(eq(worlds.id, live.id)))[0], live);
});

test("trusted creators remain blocked when banned", async t => {
  const f = await fixture(t, { trusted: true, banned: true });
  const selected = await f.seed();
  assert.equal((await f.submit(selected.id)).status, 403);
  assert.deepEqual((await db.select().from(worlds).where(eq(worlds.id, selected.id)))[0], selected);
});

for (const action of ["withdraw-review", "status", "refresh-review"] as const) {
  test(`${action} affects only the selected version after separate sibling submissions`, async t => {
    const f = await fixture(t);
    const selected = await f.seed();
    const sibling = await f.seed({ language: "ja" });
    for (const row of [selected, sibling]) assert.equal((await f.submit(row.id)).status, 200);
    const siblingBefore = (await db.select().from(worlds).where(eq(worlds.id, sibling.id)))[0];
    const submissionsBefore = await db.select().from(worldReviewSubmissions).where(eq(worldReviewSubmissions.worldId, sibling.id));
    const versionsBefore = await db.select().from(worldVersions).where(eq(worldVersions.worldId, sibling.id));
    const response = await app.request(`/api/worlds/${selected.id}/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-test-user": f.creatorId },
      ...(action === "status" ? { body: JSON.stringify({ status: "draft" }) } : {}),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const [selectedAfter] = await db.select().from(worlds).where(eq(worlds.id, selected.id));
    assert.equal(selectedAfter?.status, action === "refresh-review" ? "pending_review" : "draft");
    assert.deepEqual((await db.select().from(worlds).where(eq(worlds.id, sibling.id)))[0], siblingBefore);
    assert.deepEqual(await db.select().from(worldReviewSubmissions).where(eq(worldReviewSubmissions.worldId, sibling.id)), submissionsBefore);
    assert.deepEqual(await db.select().from(worldVersions).where(eq(worldVersions.worldId, sibling.id)), versionsBefore);
    const [decision] = await db.select().from(worldReviewSubmissions).where(eq(worldReviewSubmissions.worldId, selected.id));
    assert.equal(decision?.decision, action === "refresh-review" ? "pending" : "withdrawn");
  });
}
