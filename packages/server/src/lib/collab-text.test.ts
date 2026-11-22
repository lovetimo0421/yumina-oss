import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import * as Y from "yjs";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worldPendingEdits, worlds } from "../db/schema.js";
import { applyChangeSetSave } from "./collab-save.js";
import {
  appendTextUpdate, injectServerTextWrite, openTextDoc, readStoredText, TEXT_NAME, TextFieldGone, textOf, useMemoryTextStoreForTests,
} from "./collab-text.js";
import { subscribeWorldEvents, type WorldEvent } from "./world-events.js";

before(async () => { await import(new URL("../../scripts/test-local-schema.mjs", import.meta.url).href); });

// Run only through scripts/test-local.mjs (isolated in-memory database).
async function card(schema: Record<string, unknown>, extra: Partial<typeof worlds.$inferInsert> = {}) {
  const creatorId = crypto.randomUUID();
  await db.insert(user).values({ id: creatorId, name: "Creator", email: `${creatorId}@test.local` });
  const [w] = await db.insert(worlds).values({ creatorId, name: "Card", status: "draft", schema, ...extra }).returning();
  return { worldId: w!.id, creatorId };
}

/** A client copy of a field: the document as the editor holds it. */
function client(update: Uint8Array) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  const sent: Uint8Array[] = [];
  doc.on("update", (u: Uint8Array, origin: unknown) => { if (origin !== "remote") sent.push(u); });
  return { doc, text: doc.getText(TEXT_NAME), sent };
}

const field = "r:entries:e1:content";

describe("live text relay", { concurrency: false }, () => {
  before(() => useMemoryTextStoreForTests());

  it("reads a field's stored text from the working copy, held edit first", async () => {
    const { worldId } = await card({ description: "", entries: [{ id: "e1", content: "live text" }], rootComponent: { files: { "a/b.tsx": "code" } } },
      { description: "row blurb" });
    assert.equal(await readStoredText(worldId, { kind: "row", key: "entries", id: "e1", field: "content" }), "live text");
    assert.equal(await readStoredText(worldId, { kind: "row", key: "entries", id: "nope", field: "content" }), undefined);
    assert.equal(await readStoredText(worldId, { kind: "row", key: "entries", id: "e1", field: "name" }), "");
    assert.equal(await readStoredText(worldId, { kind: "file", name: "a/b.tsx" }), "code");
    assert.equal(await readStoredText(worldId, { kind: "top", field: "description" }), "row blurb");
    await db.update(worlds).set({ status: "published" }).where(eq(worlds.id, worldId));
    await db.insert(worldPendingEdits).values({
      worldId, createdBy: (await db.select({ c: worlds.creatorId }).from(worlds).where(eq(worlds.id, worldId)))[0]!.c,
      schema: { entries: [{ id: "e1", content: "held text" }] }, groupKey: worldId,
    } as typeof worldPendingEdits.$inferInsert);
    assert.equal(await readStoredText(worldId, { kind: "row", key: "entries", id: "e1", field: "content" }), "held text");
  });

  it("makes a field's document once, from the stored text, however many open it", async () => {
    const { worldId } = await card({ entries: [{ id: "e1", content: "Hello" }] });
    const [a, b] = await Promise.all([openTextDoc(worldId, field), openTextDoc(worldId, field)]);
    assert.equal(a.gen, b.gen);
    assert.equal(textOf(a.update), "Hello");
    assert.equal(textOf(b.update), "Hello", "the starting text is in it once, not twice");
    await assert.rejects(openTextDoc(worldId, "r:entries:gone:content"), TextFieldGone);
  });

  it("merges two people's typing character by character", async () => {
    const { worldId } = await card({ entries: [{ id: "e1", content: "ab" }] });
    const opened = await openTextDoc(worldId, field);
    const alice = client(opened.update);
    const bob = client(opened.update);
    alice.text.insert(1, "X");
    bob.text.insert(1, "Y");
    for (const u of alice.sent) assert.equal(await appendTextUpdate(worldId, field, opened.gen, u), true);
    for (const u of bob.sent) assert.equal(await appendTextUpdate(worldId, field, opened.gen, u), true);
    for (const u of bob.sent) Y.applyUpdate(alice.doc, u, "remote");
    for (const u of alice.sent) Y.applyUpdate(bob.doc, u, "remote");
    assert.equal(alice.text.toString(), bob.text.toString());
    assert.equal(alice.text.toString().length, 4);
    const reopened = await openTextDoc(worldId, field);
    assert.equal(textOf(reopened.update), alice.text.toString(), "a late opener gets everyone's typing");
    // Catching up from a state vector sends only what is missing.
    const behind = client(opened.update);
    const since = await openTextDoc(worldId, field, { gen: opened.gen, sv: Y.encodeStateVector(behind.doc) });
    assert.equal(since.fresh, false);
    Y.applyUpdate(behind.doc, since.update, "remote");
    assert.equal(behind.text.toString(), alice.text.toString());
  });

  it("refuses updates for a document generation that no longer exists", async () => {
    const { worldId } = await card({ entries: [{ id: "e1", content: "x" }] });
    const opened = await openTextDoc(worldId, field);
    const c = client(opened.update);
    c.text.insert(0, "y");
    assert.equal(await appendTextUpdate(worldId, field, "some-other-gen", c.sent[0]!), false);
    assert.equal(await appendTextUpdate(worldId, field, opened.gen, c.sent[0]!), true);
  });

  it("folds a write made outside the document (the assistant) into it, keeping the typing", async () => {
    const { worldId, creatorId } = await card({ entries: [{ id: "e1", content: "The cat sat." }] });
    const opened = await openTextDoc(worldId, field);
    const typist = client(opened.update);
    typist.text.insert(typist.text.length, " On the mat.");
    for (const u of typist.sent) await appendTextUpdate(worldId, field, opened.gen, u);
    const events: WorldEvent[] = [];
    const stop = subscribeWorldEvents(worldId, (e) => events.push(e));
    const changed = await injectServerTextWrite(
      worldId,
      { entries: [{ id: "e1", content: "The cat sat." }] },
      { entries: [{ id: "e1", content: "The black cat sat." }] },
      { actorUserId: creatorId },
    );
    stop();
    assert.deepEqual(changed, [field]);
    const text = events.find((e) => e.kind === "text");
    assert.ok(text && text.kind === "text");
    Y.applyUpdate(typist.doc, new Uint8Array(Buffer.from(text.update, "base64")), "remote");
    assert.equal(typist.text.toString(), "The black cat sat. On the mat.");
    // A field the saving editor has open itself is left alone.
    assert.deepEqual(await injectServerTextWrite(worldId,
      { entries: [{ id: "e1", content: "The black cat sat. On the mat." }] },
      { entries: [{ id: "e1", content: "stale" }] },
      { actorUserId: creatorId, skip: new Set([field]) }), []);
  });
});

describe("change-set saves", () => {
  it("refuse an edit to a deleted row and keep the compiled bundle beside the changes", () => {
    const refused = applyChangeSetSave({ entries: [] }, [{ op: "rowFields", key: "entries", id: "a", set: { content: "x" } }], {});
    assert.equal(refused.ok, false);
    const saved = applyChangeSetSave({ rootComponent: { files: { "a.tsx": "1" } } }, [{ op: "file", name: "a.tsx", content: "2" }],
      { rootCompiled: { code: "compiled", filesHash: "h", compilerVersion: 3 } });
    assert.ok(saved.ok);
    assert.deepEqual((saved.schema.rootComponent as Record<string, unknown>).compiled, { code: "compiled", filesHash: "h", compilerVersion: 3 });
  });
});
