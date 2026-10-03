import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { before, test } from "node:test";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { auth } from "../lib/auth.js";
import {
  user,
  worlds,
  worldVersions,
  directConversations,
  directConversationParticipants,
  directMessages,
} from "../db/schema.js";
import { worldChangeRoutes } from "./world-changes.js";

const app = new Hono().route("/api/world-changes", worldChangeRoutes);
const day = (n: number) => new Date(Date.UTC(2026, 8, n));

before(async () => {
  await db.insert(user).values([
    { id: "author", name: "Author", email: "author@test.invalid", birthYear: 1990 },
    { id: "helper", name: "Helper", email: "helper@test.invalid", birthYear: 1990 },
    { id: "stranger", name: "Stranger", email: "stranger@test.invalid", birthYear: 1990 },
  ]);
  await db.insert(worlds).values([
    // The author's card, its language variant, an old copy, a withdrawn one.
    { id: "card", creatorId: "author", name: "Card", status: "published", isPublished: true, schema: { id: "lineage", entries: [] }, updatedAt: day(10) },
    { id: "card-ja", creatorId: "author", name: "Card JA", status: "draft", schema: { id: "lineage", entries: [] }, updatedAt: day(12) },
    { id: "card-old", creatorId: "author", name: "Card (1)", status: "draft", schema: { id: "lineage", entries: [] }, updatedAt: day(5) },
    // The author's own copy of their card, touched most recently of all.
    { id: "card-self-copy", creatorId: "author", name: "Card (2)", status: "draft", sourceWorldId: "card", schema: { id: "lineage", entries: [] }, updatedAt: day(25) },
    { id: "card-gone", creatorId: "author", name: "Gone", status: "unpublished", schema: { id: "lineage", entries: [] }, updatedAt: day(20) },
    { id: "unrelated", creatorId: "author", name: "Unrelated", status: "draft", schema: { id: "other", entries: [] } },
    // Copies other people made of the author's card.
    { id: "helper-copy", creatorId: "helper", name: "Card (1)", status: "draft", sourceWorldId: "card",
      schema: { id: "lineage", entries: [{ id: "e1", name: "Fixed", content: "x" }] }, createdAt: day(8), updatedAt: day(9) },
    { id: "stranger-copy", creatorId: "stranger", name: "Card (1)", status: "draft", sourceWorldId: "card",
      schema: { id: "lineage", entries: [] }, createdAt: day(11) },
    { id: "public-copy", creatorId: "stranger", name: "Remix", status: "published", isPublished: true, sourceWorldId: "card",
      schema: { id: "lineage", entries: [] }, createdAt: day(15) },
  ]);
  // The helper sent their copy back to the author over DM.
  await db.insert(directConversations).values({ id: "conv", createdById: "author" });
  await db.insert(directConversationParticipants).values([
    { conversationId: "conv", userId: "author" },
    { conversationId: "conv", userId: "helper" },
  ]);
  await db.insert(directMessages).values({
    conversationId: "conv", senderId: "helper", content: "Card (1)", contentType: "world-share", metadata: { worldId: "helper-copy" },
  });
});

function setup(t: { mock: { method: (...args: any[]) => unknown } }) {
  t.mock.method(auth.api, "getSession", async ({ headers }: { headers: Headers }) => {
    const id = headers.get("x-test-user");
    return id ? { user: { id }, session: { id: id + "-session", userId: id, expiresAt: new Date(Date.now() + 60000), token: "fixture" } } : null;
  });
  return (path: string, actor: string | null, method = "GET", body?: unknown) => app.request(path, {
    method,
    headers: { ...(actor ? { "x-test-user": actor } : {}), "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test("import matches only the caller's own cards, exact origin first, then published, then recent", async (t) => {
  const request = setup(t);
  const ids = async (query: string, actor = "author") => {
    const res = await request(`/api/world-changes/import-matches${query}`, actor);
    assert.equal(res.status, 200, await res.clone().text());
    return ((await res.json()) as { data: { id: string; exact: boolean }[] }).data.map((w) => w.id + (w.exact ? "!" : ""));
  };
  assert.equal((await request("/api/world-changes/import-matches?schemaId=lineage", null)).status, 401);
  assert.deepEqual(await ids(""), []);
  // Same lineage: published card first, then non-copies by recency, then copies;
  // withdrawn cards and other people's copies never.
  assert.deepEqual(await ids("?schemaId=lineage"), ["card", "card-ja", "card-old", "card-self-copy"]);
  // A stamped origin wins outright.
  assert.deepEqual(await ids("?schemaId=lineage&origin=card-old"), ["card-old!", "card", "card-ja", "card-self-copy"]);
  assert.deepEqual(await ids("?origin=unrelated"), ["unrelated!"]);
  // A file stamped with the author's card can't target it for anyone else:
  // the stranger only ever sees their own copies of the lineage.
  assert.deepEqual(await ids("?origin=card", "stranger"), []);
  assert.deepEqual(await ids("?origin=card&schemaId=lineage", "stranger"), ["public-copy", "stranger-copy"]);
});

test("the original author can read a helper's copy only when it was sent to them", async (t) => {
  const request = setup(t);
  const res = await request("/api/world-changes/proposals/helper-copy", "author");
  assert.equal(res.status, 200, await res.clone().text());
  const { data } = (await res.json()) as { data: any };
  assert.equal(data.target.id, "card");
  assert.equal(data.fork.creatorName, "Helper");
  assert.equal(data.schema.entries[0].name, "Fixed");
  // The card was touched (day 10) after the copy was taken (day 8).
  assert.equal(data.targetChangedSinceCopy, true);

  // A draft copy nobody sent to the author stays private.
  assert.equal((await request("/api/world-changes/proposals/stranger-copy", "author")).status, 404);
  // A published copy is public anyway.
  const pub = await request("/api/world-changes/proposals/public-copy", "author");
  assert.equal(pub.status, 200);
  assert.equal(((await pub.json()) as { data: any }).data.targetChangedSinceCopy, false);
  // Only the author of the original gets it — not the copy's owner, not a bystander.
  assert.equal((await request("/api/world-changes/proposals/helper-copy", "helper")).status, 404);
  assert.equal((await request("/api/world-changes/proposals/helper-copy", "stranger")).status, 404);
  // A card that isn't a copy of anything has no proposal.
  assert.equal((await request("/api/world-changes/proposals/card", "author")).status, 404);
});

test("the pre-apply backup is creator-only, automatic, and carries the note", async (t) => {
  const request = setup(t);
  assert.equal((await request("/api/world-changes/backups/card", "helper", "POST", { note: "x" })).status, 404);
  const res = await request("/api/world-changes/backups/card-ja", "author", "POST", { note: "Before applying Helper's changes" });
  assert.equal(res.status, 201, await res.clone().text());
  const rows = await db.select().from(worldVersions).where(and(eq(worldVersions.worldId, "card-ja")));
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "incoming");
  assert.equal(rows[0]!.note, "Before applying Helper's changes");
  assert.deepEqual(rows[0]!.schema, { id: "lineage", entries: [], name: "Card JA" });
  // Two applies in a row keep two backups (no de-duplication like publish snapshots).
  assert.equal((await request("/api/world-changes/backups/card-ja", "author", "POST", {})).status, 201);
  assert.equal((await db.select().from(worldVersions).where(eq(worldVersions.worldId, "card-ja"))).length, 2);
});
