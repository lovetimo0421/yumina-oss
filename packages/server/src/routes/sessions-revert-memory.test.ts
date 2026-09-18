import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db/index.js";
import { playSessions, messages, worlds, user } from "../db/schema.js";
import { eq, asc } from "drizzle-orm";
import { revertSession } from "./sessions.js";
import { registerSessionMemoryExtension } from "../extensions/session-memory/hooks.js";

// End-to-end coverage for the coverage-aware revert: with the real session-memory
// extension registered, revertSession must KEEP the story summary (and leave its
// compacted messages flagged) when the rewind deletes only uncompacted turns, and
// DROP it (un-flagging the survivors) when the rewind cuts into compacted ones.
// The decision matrix itself is unit-tested in
// extensions/session-memory/invalidate-revert.test.ts; this proves the route
// wiring + the runAfter flag handling against a real database.

describe("revertSession + session-memory keep-when-valid", () => {
  let testUserId: string;
  let testWorldId: string;
  let testSessionId: string;
  let messageIds: string[];

  before(() => {
    // Runs in its own process (node --test isolation), so registering the real
    // extension here lets collectExtensionInvalidation dispatch to it.
    registerSessionMemoryExtension();
  });

  beforeEach(async () => {
    const [u] = await db.insert(user).values({
      id: `test-user-${crypto.randomUUID()}`,
      name: "Revert Memory Test User",
      email: `${crypto.randomUUID()}@test.local`,
      emailVerified: true,
    }).returning();
    testUserId = u!.id;

    const [w] = await db.insert(worlds).values({
      creatorId: testUserId,
      name: "Revert Memory World",
      schema: { name: "Revert Memory World", entries: [], variables: [{ id: "hp", name: "HP", type: "number", defaultValue: 10 }] },
      status: "draft",
    }).returning();
    testWorldId = w!.id;

    const [s] = await db.insert(playSessions).values({
      userId: testUserId,
      worldId: testWorldId,
      state: { variables: { hp: 7 } },
      summary: "kept summary",
      summaryStatus: "idle",
      name: "main",
    }).returning();
    testSessionId = s!.id;

    // m0..m2 are the compacted early block the summary stands in for; m3..m6 are
    // the uncompacted recent tail. Inserted one at a time for distinct createdAt.
    const fixtures = [
      { role: "assistant" as const, content: "greeting", stateSnapshot: { variables: { hp: 10 } }, compacted: true },
      { role: "user" as const, content: "a" },
      { role: "assistant" as const, content: "r1", stateSnapshot: { variables: { hp: 9 } }, compacted: true },
      { role: "user" as const, content: "b" },
      { role: "assistant" as const, content: "r2", stateSnapshot: { variables: { hp: 8 } } },
      { role: "user" as const, content: "c" },
      { role: "assistant" as const, content: "r3", stateSnapshot: { variables: { hp: 7 } } },
    ];
    messageIds = [];
    for (const f of fixtures) {
      const [row] = await db.insert(messages).values({ sessionId: testSessionId, ...f }).returning();
      messageIds.push(row!.id);
    }
    // Record that the summary covers up to r1 (the last compacted message).
    await db.update(playSessions).set({ summaryCoversUntilMessageId: messageIds[2]! }).where(eq(playSessions.id, testSessionId));
  });

  afterEach(async () => {
    await db.delete(user).where(eq(user.id, testUserId));
  });

  it("keeps the summary and its compacted flags when the rewind deletes only uncompacted turns", async () => {
    // Reverting to r2 (messageIds[4]) deletes c/r3 — both uncompacted, both
    // after the summary's covers-until pointer (r1). The summary describes
    // nothing that was deleted, so it stays, and m0/r1 stay compacted. Only
    // the job bookkeeping is reset (any compaction that claimed the row while
    // the revert was in flight must not be able to persist).
    const result = await revertSession({ userId: testUserId, sessionId: testSessionId, messageId: messageIds[4]! });
    assert.strictEqual(result.status, 200);

    const [s] = await db.select().from(playSessions).where(eq(playSessions.id, testSessionId));
    assert.strictEqual(s!.summary, "kept summary", "summary covers only surviving turns → kept");
    assert.strictEqual(s!.summaryCoversUntilMessageId, messageIds[2]!);
    assert.strictEqual(s!.summaryStatus, "idle");
    assert.strictEqual(s!.summarySourceHash, null, "in-flight compaction guard invalidated");

    const rows = await db.select().from(messages).where(eq(messages.sessionId, testSessionId)).orderBy(asc(messages.createdAt));
    assert.deepStrictEqual(
      rows.map((r) => r.compacted),
      [true, false, true, false, false],
      "compacted block stays compacted; the summary still stands in for it",
    );
  });

  it("drops the summary when its covers-until pointer is missing (coverage cannot be verified)", async () => {
    await db.update(playSessions).set({ summaryCoversUntilMessageId: null }).where(eq(playSessions.id, testSessionId));
    const result = await revertSession({ userId: testUserId, sessionId: testSessionId, messageId: messageIds[4]! });
    assert.strictEqual(result.status, 200);

    const [s] = await db.select().from(playSessions).where(eq(playSessions.id, testSessionId));
    assert.strictEqual(s!.summary, null, "unverifiable summary → dropped");
    const rows = await db.select().from(messages).where(eq(messages.sessionId, testSessionId)).orderBy(asc(messages.createdAt));
    assert.ok(rows.every((r) => r.compacted === false), "every surviving message un-compacted");
  });

  it("drops the summary and un-flags survivors when the rewind cuts into the compacted block", async () => {
    // Revert to "a" (messageIds[1]) — deletes r1 (compacted) and everything after.
    const result = await revertSession({ userId: testUserId, sessionId: testSessionId, messageId: messageIds[1]! });
    assert.strictEqual(result.status, 200);

    const [s] = await db.select().from(playSessions).where(eq(playSessions.id, testSessionId));
    assert.strictEqual(s!.summary, null, "summary described a deleted compacted turn → dropped");
    assert.strictEqual(s!.summaryCoversUntilMessageId, null);

    const rows = await db.select().from(messages).where(eq(messages.sessionId, testSessionId)).orderBy(asc(messages.createdAt));
    assert.ok(rows.every((r) => r.compacted === false), "surviving compacted messages re-exposed as raw history");
  });
});
