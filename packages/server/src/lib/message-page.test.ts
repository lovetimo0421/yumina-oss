import "../test/database-fixture.js";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { messages, playSessions, user, worlds } from "../db/schema.js";
import { loadMessagePage, messagePageCursor } from "./message-page.js";

let sessionId: string;
before(async () => {
  const owner = "message-page-test";
  await db.insert(user).values({ id: owner, name: "Page Test", email: "pages@test.local", emailVerified: true });
  const [world] = await db.insert(worlds).values({ creatorId: owner, name: "Pages", schema: {} }).returning();
  const [session] = await db.insert(playSessions).values({ userId: owner, worldId: world!.id, state: {} }).returning();
  sessionId = session!.id;
  const snapshot = { variables: { journal: "世界\\\"\n".repeat(1000) } };
  await db.insert(messages).values(Array.from({ length: 9 }, (_, index) => ({
    id: `page-${index}`, sessionId, role: "assistant" as const,
    content: `reply ${index}`, createdAt: new Date("2026-01-01T00:00:00Z"),
    stateSnapshot: snapshot,
    swipes: [{ content: `reply ${index}`, rawContent: `raw ${index}`, createdAt: "now",
      stateSnapshot: snapshot, generationState: snapshot }],
  })));
});
after(async () => { await (db as unknown as { $client: { close(): Promise<void> } }).$client.close(); });

test("byte-limited pages retain historical state and every display swipe, without gaps at equal timestamps", async () => {
  const seen: string[] = [];
  let cursor;
  for (;;) {
    const page = await loadMessagePage(db, sessionId, 8, cursor, 40_000);
    assert.ok(page.messages.length > 0 && page.messages.length < 8);
    assert.ok(Buffer.byteLength(JSON.stringify(page.messages)) <= 40_000);
    for (const row of page.messages) {
      assert.ok(row.stateSnapshot?.variables);
      assert.deepEqual(row.swipes, [{ content: row.content, rawContent: row.content.replace("reply", "raw"), createdAt: "now" }]);
    }
    seen.unshift(...page.messages.map((row) => row.id));
    if (!page.hasMore) break;
    const oldest = page.messages[0]!;
    cursor = messagePageCursor(sessionId, new Date(oldest.createdAt!), oldest.id);
  }
  assert.deepEqual(seen, Array.from({ length: 9 }, (_, index) => `page-${index}`));
  const [stored] = await db.select().from(messages).where(eq(messages.id, "page-8"));
  assert.ok(stored!.swipes![0]!.stateSnapshot);
  assert.ok(stored!.swipes![0]!.generationState);
});

test("row limit probes hasMore and an oversized individual row still makes cursor progress", async () => {
  const capped = await loadMessagePage(db, sessionId, 2);
  assert.equal(capped.messages.length, 2);
  assert.equal(capped.hasMore, true);
  const oversized = await loadMessagePage(db, sessionId, 8, undefined, 1);
  assert.deepEqual(oversized.messages.map((row) => row.id), ["page-8"]);
  assert.equal(oversized.hasMore, true);
  const empty = await loadMessagePage(db, "no-such-session", 8);
  assert.deepEqual(empty, { messages: [], hasMore: false });
});

test("cursor keeps PostgreSQL microsecond precision when transport dates have milliseconds", async () => {
  await db.execute(sql`UPDATE messages SET created_at = '2026-01-02 00:00:00.123456'::timestamp
    WHERE session_id = ${sessionId}`);
  const latest = await loadMessagePage(db, sessionId, 1);
  const row = latest.messages[0]!;
  assert.equal(row.createdAt, "2026-01-02T00:00:00.123456Z");
  const older = await loadMessagePage(db, sessionId, 8, messagePageCursor(sessionId, new Date(row.createdAt!), row.id));
  assert.deepEqual(older.messages.map((message) => message.id), Array.from({ length: 8 }, (_, index) => `page-${index}`));
  assert.equal(older.hasMore, false);
  const timeOnly = await loadMessagePage(db, sessionId, 8, messagePageCursor(sessionId, new Date("2026-01-03")));
  assert.equal(timeOnly.messages.length, 8);
  const missingAnchor = await loadMessagePage(db, sessionId, 8, messagePageCursor(sessionId, new Date("2026-01-03"), "deleted"));
  assert.equal(missingAnchor.messages.length, 8);
  const preciseFallback = await loadMessagePage(db, sessionId, 9,
    messagePageCursor(sessionId, "2026-01-02T00:00:00.123457Z", "deleted"));
  assert.equal(preciseFallback.messages.length, 9);
  const preciseTimeOnly = await loadMessagePage(db, sessionId, 9,
    messagePageCursor(sessionId, "2026-01-02T00:00:00.123457Z"));
  assert.equal(preciseTimeOnly.messages.length, 9);
  const offsetTime = await loadMessagePage(db, sessionId, 9,
    messagePageCursor(sessionId, "2026-01-01T16:00:00.123457-08:00"));
  assert.equal(offsetTime.messages.length, 9);
});
