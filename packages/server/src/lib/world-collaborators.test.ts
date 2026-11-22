import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, userAssets, worldCollaborators, worlds } from "../db/schema.js";
import { assetsUsedInSharedCards, copySharedCardAssets, getWorldAccess, handOverSharedCardAssets } from "./world-collaborators.js";

before(async () => { await import(new URL("../../scripts/test-local-schema.mjs", import.meta.url).href); });

// Run only through scripts/test-local.mjs (isolated in-memory database).
async function fixture() {
  const creatorId = crypto.randomUUID();
  const peerId = crypto.randomUUID();
  await db.insert(user).values([
    { id: creatorId, name: "Creator", email: `${creatorId}@test.local` },
    { id: peerId, name: "Peer", email: `${peerId}@test.local` },
  ]);
  const group = crypto.randomUUID();
  const [zh] = await db.insert(worlds).values({ creatorId, name: "卡", status: "draft", schema: {}, languageGroupId: group, language: "zh" }).returning();
  const [en] = await db.insert(worlds).values({ creatorId, name: "Card", status: "draft", schema: {}, languageGroupId: group, language: "en" }).returning();
  const [other] = await db.insert(worlds).values({ creatorId, name: "Other", status: "draft", schema: {} }).returning();
  return { creatorId, peerId, zh: zh!.id, en: en!.id, other: other!.id };
}

describe("world collaborators", { concurrency: false }, () => {
  it("grants by role once accepted, across the card's language variants only", async () => {
    const f = await fixture();
    assert.equal((await getWorldAccess(f.creatorId, f.zh))?.role, "owner");
    assert.equal(await getWorldAccess(f.peerId, f.zh), null);
    await db.insert(worldCollaborators).values({ worldId: f.zh, userId: f.peerId, role: "editor", status: "pending" });
    assert.equal(await getWorldAccess(f.peerId, f.zh), null, "a pending invite grants nothing");
    await db.update(worldCollaborators).set({ status: "accepted", canPublish: true }).where(eq(worldCollaborators.userId, f.peerId));
    assert.deepEqual(
      { role: (await getWorldAccess(f.peerId, f.en))?.role, canPublish: (await getWorldAccess(f.peerId, f.en))?.canPublish },
      { role: "editor", canPublish: true },
      "the grant covers the other language of the same card",
    );
    assert.equal(await getWorldAccess(f.peerId, f.other), null, "but not the creator's other cards");
    await db.update(worldCollaborators).set({ role: "viewer" }).where(eq(worldCollaborators.userId, f.peerId));
    assert.deepEqual(await getWorldAccess(f.peerId, f.zh).then((a) => [a?.role, a?.canPublish]), ["viewer", false]);
  });

  it("hands a leaving collaborator's images in the card over to its creator", async () => {
    const f = await fixture();
    await db.insert(worldCollaborators).values({ worldId: f.zh, userId: f.peerId, role: "editor", status: "accepted" });
    const [used] = await db.insert(userAssets).values({ userId: f.peerId, type: "image", filename: "used.png", url: `users/${f.peerId}/used.png` }).returning();
    const [unused] = await db.insert(userAssets).values({ userId: f.peerId, type: "image", filename: "mine.png", url: `users/${f.peerId}/mine.png` }).returning();
    // Used in the English variant, which the grant on the Chinese one covers.
    await db.update(worlds).set({ schema: { entries: [{ id: "e", portrait: `@asset:${used!.id}` }] } }).where(eq(worlds.id, f.en));

    assert.deepEqual((await assetsUsedInSharedCards(f.peerId)).map((r) => r.id), [used!.id]);
    assert.equal((await assetsUsedInSharedCards(f.peerId, unused!.id)).length, 0);

    const copies: Array<[string, string]> = [];
    assert.equal(await handOverSharedCardAssets(f.peerId, { enabled: true, copy: async (a, b) => { copies.push([a, b]); } }), 1);
    const [moved] = await db.select().from(userAssets).where(eq(userAssets.id, used!.id));
    assert.equal(moved!.userId, f.creatorId);
    assert.equal(moved!.url, `worlds/${f.en}/handed-over/${used!.id}-used.png`);
    assert.deepEqual(copies, [[`users/${f.peerId}/used.png`, moved!.url]]);
    const [kept] = await db.select().from(userAssets).where(eq(userAssets.id, unused!.id));
    assert.equal(kept!.userId, f.peerId, "their other files stay theirs");
  });

  it("an invite never accepted can't claim someone's files", async () => {
    const f = await fixture();
    const [art] = await db.insert(userAssets).values({ userId: f.peerId, type: "image", filename: "art.png", url: `users/${f.peerId}/art.png` }).returning();
    // The creator pastes the peer's (public) asset id into their own card.
    await db.update(worlds).set({ schema: { avatar: `@asset:${art!.id}` } }).where(eq(worlds.id, f.zh));
    await db.insert(worldCollaborators).values({ worldId: f.zh, userId: f.peerId, role: "editor", status: "pending" });
    assert.equal((await assetsUsedInSharedCards(f.peerId)).length, 0);
    assert.equal(await handOverSharedCardAssets(f.peerId, { enabled: false, copy: async () => {} }), 0);
    const [kept] = await db.select().from(userAssets).where(eq(userAssets.id, art!.id));
    assert.equal(kept!.userId, f.peerId);
  });

  it("keeps protecting someone's images after they leave, are removed, or are made a viewer", async () => {
    const f = await fixture();
    const [art] = await db.insert(userAssets).values({ userId: f.peerId, type: "image", filename: "art.png", url: `users/${f.peerId}/art.png` }).returning();
    await db.update(worlds).set({ schema: { avatar: `@asset:${art!.id}` } }).where(eq(worlds.id, f.zh));
    for (const [role, status] of [["editor", "left"], ["editor", "removed"], ["viewer", "accepted"], ["viewer", "pending"]] as const) {
      await db.delete(worldCollaborators).where(eq(worldCollaborators.userId, f.peerId));
      // pending here = invited back after having been on the card
      await db.insert(worldCollaborators).values({ worldId: f.zh, userId: f.peerId, role, status, acceptedAt: new Date(Date.now() - 60_000) });
      assert.deepEqual((await assetsUsedInSharedCards(f.peerId)).map((r) => r.id), [art!.id], `${role}/${status}`);
    }
  });

  it("hands over inside a transaction: a rolled-back deletion leaves owners unchanged", async () => {
    const f = await fixture();
    await db.insert(worldCollaborators).values({ worldId: f.zh, userId: f.peerId, role: "editor", status: "accepted", acceptedAt: new Date() });
    const [art] = await db.insert(userAssets).values({ userId: f.peerId, type: "image", filename: "a.png", url: `users/${f.peerId}/a.png` }).returning();
    await db.update(worlds).set({ schema: { avatar: `@asset:${art!.id}` } }).where(eq(worlds.id, f.zh));
    const copies: string[] = [];
    const storage = { enabled: true, copy: async (_from: string, to: string) => { copies.push(to); } };
    const copied = await copySharedCardAssets(f.peerId, storage);
    await assert.rejects(db.transaction(async (tx) => {
      await handOverSharedCardAssets(f.peerId, storage, tx as unknown as Parameters<typeof handOverSharedCardAssets>[2], copied);
      throw new Error("deletion failed");
    }));
    const [still] = await db.select().from(userAssets).where(eq(userAssets.id, art!.id));
    assert.equal(still!.userId, f.peerId);
    assert.equal(still!.url, `users/${f.peerId}/a.png`);
    assert.deepEqual(copies, [`worlds/${f.zh}/handed-over/${art!.id}-a.png`], "copied once, ahead of the transaction");
  });

  it("names the creator joined first when cards of two creators use the same file", async () => {
    const f = await fixture();
    const second = crypto.randomUUID();
    await db.insert(user).values({ id: second, name: "Second", email: `${second}@test.local` });
    const [theirs] = await db.insert(worlds).values({ creatorId: second, name: "Theirs", status: "draft", schema: {} }).returning();
    await db.insert(worldCollaborators).values([
      { worldId: theirs!.id, userId: f.peerId, role: "editor", status: "accepted", acceptedAt: new Date(Date.now() - 60_000) },
      { worldId: f.zh, userId: f.peerId, role: "editor", status: "accepted", acceptedAt: new Date() },
    ]);
    const [art] = await db.insert(userAssets).values({ userId: f.peerId, type: "image", filename: "s.png", url: `users/${f.peerId}/s.png` }).returning();
    for (const id of [theirs!.id, f.zh]) await db.update(worlds).set({ schema: { avatar: `@asset:${art!.id}` } }).where(eq(worlds.id, id));
    const [row] = await assetsUsedInSharedCards(f.peerId);
    assert.equal(row!.creator_id, second);
  });

  it("leaves the creator's own uploads alone", async () => {
    const f = await fixture();
    const [own] = await db.insert(userAssets).values({ userId: f.creatorId, type: "image", filename: "c.png", url: "users/c.png" }).returning();
    await db.update(worlds).set({ schema: { avatar: `@asset:${own!.id}` } }).where(eq(worlds.id, f.zh));
    assert.equal((await assetsUsedInSharedCards(f.creatorId)).length, 0);
  });
});
