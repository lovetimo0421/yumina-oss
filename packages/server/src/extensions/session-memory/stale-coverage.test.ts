import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { db } from "../../db/index.js";
import * as schema from "../../db/schema.js";
import { messages, playSessions, user, worlds } from "../../db/schema.js";
import { env } from "../../lib/env.js";
import { runExtensionInvalidation } from "../../lib/extension-hooks.js";
import { registerSessionMemoryExtension } from "./hooks.js";

// An edit/delete/swipe of an older message stamps session memory stale, and a
// stale memory is rebuilt from the whole transcript. Memory only holds turns up
// to its committed pointer, so a change after the pointer must not trigger
// that rebuild; anything at or before it, or any doubt, still must.

test("session memory goes stale only for changes it may cover", async (t) => {
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.PGLITE_DATA_DIR, "memory://");
  const client = (db as unknown as { $client: PGlite }).$client;
  for (const statement of await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema))) await client.exec(statement);
  registerSessionMemoryExtension();
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("no network in invalidation tests"); });

  async function fixture(session: Partial<typeof playSessions.$inferInsert> = {}) {
    const userId = `stale-${randomUUID()}`;
    const sessionId = randomUUID();
    await db.insert(user).values({ id: userId, name: "Stale", email: `${userId}@example.com` });
    const [world] = await db.insert(worlds).values({ creatorId: userId, name: "Stale", schema: {} }).returning();
    // a0 u1 a2 u3 a4 u5 a6 u7 a8 — the memory covers through a4.
    const ids = Array.from({ length: 9 }, () => randomUUID());
    await db.insert(playSessions).values({ id: sessionId, userId, worldId: world!.id, state: {} });
    await db.insert(messages).values(ids.map((id, i) => ({
      id, sessionId, role: i % 2 === 0 ? "assistant" as const : "user" as const,
      content: `turn ${i}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
    })));
    await db.update(playSessions).set({
      sessionMemory: { text: "Core facts:\n- turn facts" }, sessionMemoryIncluded: true, sessionMemoryStatus: "idle",
      sessionMemorySourceHash: `v2:${randomUUID()}:eligible-v1`, sessionMemoryProcessedMessageId: ids[4]!, ...session,
    }).where(eq(playSessions.id, sessionId));
    const change = async (index: number, kind: "message-edited" | "message-deleted" = "message-edited") => {
      await runExtensionInvalidation({ reason: kind, sessionId }, undefined, db, async (tx) => {
        const [before] = await tx.select().from(messages).where(eq(messages.id, ids[index]!));
        if (kind === "message-deleted") await tx.delete(messages).where(eq(messages.id, ids[index]!));
        else await tx.update(messages).set({ content: `edited ${index}` }).where(eq(messages.id, ids[index]!));
        return { messageFlags: { id: before!.id, createdAt: before!.createdAt, compacted: false, summaryceptionCompacted: false } };
      });
      const [row] = await db.select().from(playSessions).where(eq(playSessions.id, sessionId));
      return row!;
    };
    return { change, ids, cleanup: () => db.delete(user).where(eq(user.id, userId)) };
  }

  await t.test("a change after the memory pointer keeps the memory usable", async () => {
    const f = await fixture();
    try {
      for (const index of [5, 6, 7]) {
        const row = await f.change(index);
        assert.equal(row.sessionMemoryStaleAt, null, `message ${index} is not in the memory`);
        assert.equal(row.sessionMemoryProcessedMessageId, f.ids[4]);
      }
      assert.equal((await f.change(5, "message-deleted")).sessionMemoryStaleAt, null);
    } finally { await f.cleanup(); }
  });

  await t.test("a change at or before the pointer still marks it stale", async () => {
    for (const index of [4, 3, 0]) {
      const f = await fixture();
      try { assert.ok((await f.change(index)).sessionMemoryStaleAt, `message ${index} may be in the memory`); }
      finally { await f.cleanup(); }
    }
    const f = await fixture();
    try { assert.ok((await f.change(4, "message-deleted")).sessionMemoryStaleAt, "a deleted pointer proves nothing"); }
    finally { await f.cleanup(); }
  });

  await t.test("unproven coverage stays conservative", async () => {
    for (const session of [
      { sessionMemoryProcessedMessageId: null },
      { sessionMemorySourceHash: `repair:v2:${randomUUID()}:eligible-v1` },
      { sessionMemoryStatus: "failed" as const, sessionMemorySourceHash: "legacy-hash" },
    ]) {
      const f = await fixture(session);
      try { assert.ok((await f.change(6)).sessionMemoryStaleAt, JSON.stringify(session)); }
      finally { await f.cleanup(); }
    }
  });

  await t.test("an in-flight update over the changed turn is still aborted", async () => {
    const f = await fixture({ sessionMemoryStatus: "updating", sessionMemoryClaimedAt: new Date(), sessionMemorySourceHash: `v2:${randomUUID()}:eligible-v1` });
    try {
      const row = await f.change(6);
      assert.equal(row.sessionMemoryStaleAt, null);
      assert.equal(row.sessionMemoryStatus, "idle", "its persist guard can no longer match");
      assert.equal(row.sessionMemorySourceHash, null);
    } finally { await f.cleanup(); }
  });

  assert.equal(network.mock.callCount(), 0);
  await client.close();
});
