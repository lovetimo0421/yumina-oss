import assert from "node:assert/strict";
import test from "node:test";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { user, worlds, playSessions, messages } from "../db/schema.js";
import { messageContentUpdate } from "./message-edit.js";

test("editing persists in the active swipe without changing raw output, state, or other variants", async () => {
  const uid = crypto.randomUUID();
  await db.insert(user).values({ id: uid, name: "Test", email: `${uid}@test.local` });
  try {
    const [world] = await db.insert(worlds).values({ creatorId: uid, name: "Test" }).returning();
    const [session] = await db.insert(playSessions).values({ userId: uid, worldId: world!.id }).returning();
    const original = { content: "Original", rawContent: "Original [var: hp=7]", stateSnapshot: { variables: { hp: 7 } }, createdAt: new Date().toISOString(), model: "test" };
    const other = { ...original, content: "Other" };
    const [msg] = await db.insert(messages).values({ sessionId: session!.id, role: "assistant", content: "Original", swipes: [original, other], activeSwipeIndex: 0 }).returning();
    const [edited] = await db.update(messages).set(messageContentUpdate('Edited "text"')).where(eq(messages.id, msg!.id)).returning();
    assert.equal(edited!.content, 'Edited "text"');
    assert.deepEqual(edited!.swipes, [{ ...original, content: 'Edited "text"' }, other]);
    // A regeneration appends a version. Restoring the previously edited version reads its saved text.
    const [fresh] = await db.select().from(messages).where(eq(messages.id, msg!.id));
    await db.update(messages).set({ swipes: [...fresh!.swipes!, { ...other, content: "Regenerated" }], content: "Regenerated", activeSwipeIndex: 2 }).where(eq(messages.id, msg!.id));
    const [reloaded] = await db.select().from(messages).where(eq(messages.id, msg!.id));
    assert.equal(reloaded!.swipes![0]!.content, 'Edited "text"');
    // SQL must update the active index at WRITE time, not the index from an earlier read.
    const [secondEdit] = await db.update(messages).set(messageContentUpdate("Newest edit")).where(eq(messages.id, msg!.id)).returning();
    assert.equal(secondEdit!.swipes![2]!.content, "Newest edit");
    assert.equal(secondEdit!.swipes![0]!.content, 'Edited "text"');
    const [plain] = await db.insert(messages).values({ sessionId: session!.id, role: "user", content: "User text", swipes: [] }).returning();
    const [plainEdit] = await db.update(messages).set(messageContentUpdate("Edited user")).where(eq(messages.id, plain!.id)).returning();
    assert.equal(plainEdit!.content, "Edited user"); assert.deepEqual(plainEdit!.swipes, []);
    const [oldMessage] = await db.insert(messages).values({ sessionId: session!.id, role: "assistant", content: "Old", swipes: null, activeSwipeIndex: null }).returning();
    const [oldEdit] = await db.update(messages).set(messageContentUpdate("Edited old reply")).where(eq(messages.id, oldMessage!.id)).returning();
    assert.equal(oldEdit!.content, "Edited old reply"); assert.equal(oldEdit!.swipes, null);
    await db.update(messages).set({ swipes: [original] }).where(eq(messages.id, oldMessage!.id));
    const [defaultIndexEdit] = await db.update(messages).set(messageContentUpdate("Edited first version")).where(eq(messages.id, oldMessage!.id)).returning();
    assert.equal(defaultIndexEdit!.swipes![0]!.content, "Edited first version");
  } finally { await db.delete(user).where(eq(user.id, uid)); }
});
