import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.js";
import { assetFolders, user, userAssets, worldCollaborators, worldFolderBindings, worlds } from "../../db/schema.js";
import { loadAssetCatalog } from "./asset-catalog.js";
import { generatedImageFolder } from "../../routes/agent.js";
import { captureStudioCreditWorldRevision } from "../studio-credit-checkpoint.js";

before(async () => { await import(new URL("../../../scripts/test-local-schema.mjs", import.meta.url).href); });

// Run only through scripts/test-local.mjs (isolated in-memory database).
// An editor collaborator works on someone else's card in Studio: they reach the
// card's bound assets, never the rest of the creator's library, and what they
// generate lands in their own library.
async function fixture() {
  const creatorId = crypto.randomUUID();
  const editorId = crypto.randomUUID();
  await db.insert(user).values([
    { id: creatorId, name: "Creator", email: `${creatorId}@test.local` },
    { id: editorId, name: "Editor", email: `${editorId}@test.local` },
  ]);
  const [world] = await db.insert(worlds).values({ creatorId, name: "Card", status: "draft", schema: {} }).returning();
  const [bound] = await db.insert(assetFolders).values({ userId: creatorId, name: "Card art" }).returning();
  const [nested] = await db.insert(assetFolders).values({ userId: creatorId, name: "Portraits", parentFolderId: bound!.id }).returning();
  const [privateFolder] = await db.insert(assetFolders).values({ userId: creatorId, name: "Private" }).returning();
  const [editorFolder] = await db.insert(assetFolders).values({ userId: editorId, name: "Mine" }).returning();
  await db.insert(worldFolderBindings).values({ worldId: world!.id, folderId: bound!.id });
  const asset = (userId: string, filename: string, folderId: string | null) => ({ userId, type: "image" as const, filename, url: `test/${filename}`, folderId });
  await db.insert(userAssets).values([
    asset(creatorId, "bound.png", bound!.id),
    asset(creatorId, "nested.png", nested!.id),
    asset(creatorId, "private.png", privateFolder!.id),
    asset(creatorId, "root.png", null),
    asset(editorId, "editor.png", editorFolder!.id),
    asset(editorId, "editor-root.png", null),
  ]);
  return { creatorId, editorId, worldId: world!.id, bound: bound!.id, privateFolder: privateFolder!.id, editorFolder: editorFolder!.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const grant = (f: Fixture, role: "editor" | "viewer", status = "accepted") =>
  db.insert(worldCollaborators).values({ worldId: f.worldId, userId: f.editorId, role, status });
const names = (catalog: Awaited<ReturnType<typeof loadAssetCatalog>>) => catalog.assets.map(a => a.filename).sort();

describe("Studio access for an editor collaborator", { concurrency: false }, () => {
  it("refuses strangers, pending invitations and viewers", async () => {
    const f = await fixture();
    await assert.rejects(loadAssetCatalog(f.editorId, f.worldId));
    await assert.rejects(captureStudioCreditWorldRevision({ worldId: f.worldId, userId: f.editorId }));
    await grant(f, "editor", "pending");
    await assert.rejects(loadAssetCatalog(f.editorId, f.worldId));
    await db.update(worldCollaborators).set({ role: "viewer", status: "accepted" }).where(eq(worldCollaborators.userId, f.editorId));
    await assert.rejects(loadAssetCatalog(f.editorId, f.worldId));
    await assert.rejects(captureStudioCreditWorldRevision({ worldId: f.worldId, userId: f.editorId }));
  });

  it("shows the card's bound folders and the editor's own library, not the creator's private files", async () => {
    const f = await fixture();
    await grant(f, "editor");
    assert.deepEqual(names(await loadAssetCatalog(f.editorId, f.worldId)), ["bound.png", "nested.png"]);
    const all = await loadAssetCatalog(f.editorId, f.worldId, { scope: "all" });
    assert.deepEqual(names(all), ["bound.png", "editor-root.png", "editor.png", "nested.png"]);
    assert.deepEqual(all.folders.map(folder => folder.path).sort(), ["Card art", "Card art/Portraits", "Mine"]);
    assert.deepEqual(names(await loadAssetCatalog(f.editorId, f.worldId, { folderId: f.editorFolder })), ["editor.png"]);
    assert.equal((await loadAssetCatalog(f.editorId, f.worldId, { scope: "all", query: "private" })).total, 0);
    await assert.rejects(loadAssetCatalog(f.editorId, f.worldId, { folderId: f.privateFolder }));
    // The creator's own view is unchanged: their whole library.
    assert.deepEqual(names(await loadAssetCatalog(f.creatorId, f.worldId, { scope: "all" })), ["bound.png", "nested.png", "private.png", "root.png"]);
  });

  it("files generated pictures in the requester's own library", async () => {
    const f = await fixture();
    await grant(f, "editor");
    assert.equal(await generatedImageFolder(f.creatorId, f.worldId), f.bound);
    assert.equal(await generatedImageFolder(f.editorId, f.worldId), null);
    await db.insert(worldFolderBindings).values({ worldId: f.worldId, folderId: f.editorFolder });
    assert.equal(await generatedImageFolder(f.editorId, f.worldId), f.editorFolder);
    assert.equal(await generatedImageFolder(f.creatorId, f.worldId), f.bound);
  });

  it("lets the editor's agent run take the world's credit lock", async () => {
    const f = await fixture();
    await grant(f, "editor");
    const mine = await captureStudioCreditWorldRevision({ worldId: f.worldId, userId: f.creatorId });
    const theirs = await captureStudioCreditWorldRevision({ worldId: f.worldId, userId: f.editorId });
    assert.equal(theirs.revision, mine.revision);
  });
});
