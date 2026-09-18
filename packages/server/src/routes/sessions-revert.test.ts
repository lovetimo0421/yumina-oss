import "../test/database-fixture.js";
import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db/index.js";
import { playSessions, messages, worlds, user, userPersonas, userWorldPersonas } from "../db/schema.js";
import { eq, asc } from "drizzle-orm";
import { revertSession } from "./sessions.js";
import { pruneSessionSnapshots } from "../lib/snapshot.js";

// Mirrors sessions-branch.test.ts: call revertSession() directly as a plain
// async function, bypassing Hono + auth. The fixtures model REAL play data —
// user messages have NO stateSnapshot (only assistant messages do), which is
// exactly the condition that made revert silently reset variables to defaults
// when reverting onto a user message.

describe("revertSession", () => {
  let testUserId: string;
  let testWorldId: string;
  let testSessionId: string;
  let messageIds: string[];

  beforeEach(async () => {
    const [u] = await db.insert(user).values({
      id: `test-user-${crypto.randomUUID()}`,
      name: "Revert Test User",
      email: `${crypto.randomUUID()}@test.local`,
      emailVerified: true,
    }).returning();
    testUserId = u!.id;

    const [w] = await db.insert(worlds).values({
      creatorId: testUserId,
      name: "Revert Test World",
      schema: {
        name: "Revert Test World",
        entries: [],
        variables: [
          { id: "hp", name: "HP", type: "number", defaultValue: 10 },
        ],
      },
      status: "draft",
    }).returning();
    testWorldId = w!.id;

    // Session's live state is at hp: 8 (latest turn).
    const [s] = await db.insert(playSessions).values({
      userId: testUserId,
      worldId: testWorldId,
      state: { variables: { hp: 8 } },
      summary: "running summary",
      name: "main",
    }).returning();
    testSessionId = s!.id;

    // Insert sequentially so each row gets a distinct createdAt. Crucially,
    // USER messages carry no stateSnapshot — matching production, where only
    // assistant turns persist a snapshot.
    const fixtures = [
      { role: "assistant" as const, content: "greeting", stateSnapshot: { variables: { hp: 10 } } },
      { role: "user" as const, content: "i attack" },
      { role: "assistant" as const, content: "reply 1", stateSnapshot: { variables: { hp: 9 } } },
      { role: "user" as const, content: "again" },
      { role: "assistant" as const, content: "reply 2", stateSnapshot: { variables: { hp: 8 } } },
    ];
    messageIds = [];
    for (const f of fixtures) {
      const [row] = await db.insert(messages).values({ sessionId: testSessionId, ...f }).returning();
      messageIds.push(row!.id);
    }
  });

  afterEach(async () => {
    await db.delete(user).where(eq(user.id, testUserId));
  });

  it("uses current profile identity despite world and turn snapshots", { timeout: 30_000 }, async () => {
    const [selected] = await db.insert(userPersonas).values({
      userId: testUserId, name: "Updated A", backstory: "Updated A story", isActive: false,
    }).returning();
    const binding = { persona: { id: selected!.id, name: "Stale A", backstory: "Old A story" } };
    const [active] = await db.insert(userPersonas).values({
      userId: testUserId, name: "Current profile", backstory: "Current story", isActive: true,
    }).returning();
    await db.insert(userWorldPersonas).values({ userId: testUserId, worldId: testWorldId, personaId: selected!.id });
    await db.update(playSessions).set({ sessionPersona: binding }).where(eq(playSessions.id, testSessionId));
    await db.update(messages).set({ stateSnapshot: {
      variables: { hp: 9 }, metadata: { personaActive: true, personaName: "Persona B", personaBackstory: "B story" },
    } }).where(eq(messages.id, messageIds[2]!));
    const result = await revertSession({ userId: testUserId, sessionId: testSessionId, messageId: messageIds[2]! });
    assert.equal(result.status, 200);
    const id = testSessionId;
    const [saved] = await db.select().from(playSessions).where(eq(playSessions.id, id));
    assert.deepEqual(saved!.sessionPersona, binding);
    assert.equal((saved!.state.metadata as Record<string, unknown>).personaName, "Current profile");
    assert.equal((saved!.state.metadata as Record<string, unknown>).personaBackstory, "Current story");
    assert.equal((saved!.state.variables as Record<string, unknown>).hp, 9);
  });

  it("restores the preceding assistant snapshot when reverting onto a user message", async () => {
    // Revert to messageIds[3] ("again", a USER message with no snapshot).
    // The bug: revert read only that message's (null) snapshot and fell back
    // to world defaults (hp: 10). Correct: walk back to "reply 1" (hp: 9).
    const result = await revertSession({
      userId: testUserId,
      sessionId: testSessionId,
      messageId: messageIds[3]!,
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual((result.body.data!.state as any).variables.hp, 9);

    // Persisted session state must also be hp: 9, not the default 10.
    const [s] = await db.select().from(playSessions).where(eq(playSessions.id, testSessionId));
    assert.strictEqual((s!.state as any).variables.hp, 9);

    // Messages after the target are deleted; target is kept.
    const remaining = await db.select().from(messages).where(eq(messages.sessionId, testSessionId)).orderBy(asc(messages.createdAt));
    assert.deepStrictEqual(remaining.map((m) => m.content), ["greeting", "i attack", "reply 1", "again"]);
  });

  it("uses the exact snapshot when reverting onto an assistant message", async () => {
    const result = await revertSession({
      userId: testUserId,
      sessionId: testSessionId,
      messageId: messageIds[2]!, // "reply 1", hp: 9
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual((result.body.data!.state as any).variables.hp, 9);
  });

  it("reverting onto the very first user turn restores the greeting snapshot, not defaults", async () => {
    // messageIds[1] = "i attack" (user, no snapshot). Walk back finds the
    // greeting snapshot (hp: 10), which happens to equal the default here, but
    // the path that produces it is the backward walk, not the default fallback.
    const result = await revertSession({
      userId: testUserId,
      sessionId: testSessionId,
      messageId: messageIds[1]!,
    });
    assert.strictEqual(result.status, 200);
    assert.strictEqual((result.body.data!.state as any).variables.hp, 10);
    const remaining = await db.select().from(messages).where(eq(messages.sessionId, testSessionId)).orderBy(asc(messages.createdAt));
    assert.deepStrictEqual(remaining.map((m) => m.content), ["greeting", "i attack"]);
  });

  it("rejects reverting a session owned by a different user", async () => {
    const otherUserId = `test-user-${crypto.randomUUID()}`;
    await db.insert(user).values({ id: otherUserId, name: "Other", email: `${otherUserId}@test.local`, emailVerified: true });
    try {
      const result = await revertSession({
        userId: otherUserId,
        sessionId: testSessionId,
        messageId: messageIds[2]!,
      });
      assert.strictEqual(result.status, 404);
    } finally {
      await db.delete(user).where(eq(user.id, otherUserId));
    }
  });

  it("rejects reverting with an unknown messageId", async () => {
    const result = await revertSession({
      userId: testUserId,
      sessionId: testSessionId,
      messageId: "nonexistent-message-id",
    });
    assert.strictEqual(result.status, 404);
  });

  it("pruneSessionSnapshots keeps only the most recent N snapshots, nulling older ones + their swipe snapshots", async () => {
    // Give the oldest snapshot-bearing message (greeting) a swipe carrying its
    // own stateSnapshot, so we can prove pruning strips swipe state too while
    // keeping swipe content.
    await db.update(messages)
      .set({ swipes: [{ content: "greeting", stateSnapshot: { variables: { hp: 10 } }, generationState: { variables: { hp: 11 } }, createdAt: new Date().toISOString() }] })
      .where(eq(messages.id, messageIds[0]!));

    // Fixture has 3 assistant snapshots (greeting, reply 1, reply 2); user
    // messages carry none. Keep the 2 newest snapshots → greeting's is nulled.
    await pruneSessionSnapshots(testSessionId, 2);

    const rows = await db.select().from(messages).where(eq(messages.sessionId, testSessionId)).orderBy(asc(messages.createdAt));
    const row = (content: string) => rows.find((r) => r.content === content)!;
    assert.strictEqual(row("greeting").stateSnapshot, null, "oldest snapshot should be pruned");
    assert.notStrictEqual(row("reply 1").stateSnapshot, null, "recent snapshot should survive");
    assert.notStrictEqual(row("reply 2").stateSnapshot, null, "recent snapshot should survive");
    // Pruned message keeps its swipe CONTENT but loses the swipe's stateSnapshot.
    const greetingSwipes = (row("greeting").swipes ?? []) as Array<Record<string, unknown>>;
    const firstSwipe = greetingSwipes[0] ?? {};
    assert.strictEqual(firstSwipe.content, "greeting", "swipe content kept");
    assert.ok(!("stateSnapshot" in firstSwipe), "swipe stateSnapshot stripped on pruned message");
    assert.ok(!("generationState" in firstSwipe), "generation baseline stripped on pruned message");
    // Message rows themselves are untouched — only the snapshot is dropped.
    assert.strictEqual(rows.length, 5);
  });

  it("preserves setup-scoped variables on revert (player's pre-game choice not reset to default)", async () => {
    // A self-contained world with a setup-scoped variable (e.g. the cast the
    // player picked before play). Snapshots carry its DEFAULT, mimicking the
    // bug where reverting/opening-switch reset the choice. The fix keeps the
    // live choice (["A","B"]) instead of the snapshot's default ([]).
    const [u2] = await db.insert(user).values({
      id: `test-user-${crypto.randomUUID()}`,
      name: "Setup Scope User",
      email: `${crypto.randomUUID()}@test.local`,
      emailVerified: true,
    }).returning();
    const [w2] = await db.insert(worlds).values({
      creatorId: u2!.id,
      name: "Setup Scope World",
      schema: {
        name: "Setup Scope World",
        entries: [],
        variables: [
          { id: "hp", name: "HP", type: "number", defaultValue: 10 },
          { id: "selected", name: "Cast", type: "json", defaultValue: [], scope: "setup" },
        ],
      },
      status: "draft",
    }).returning();
    const [s2] = await db.insert(playSessions).values({
      userId: u2!.id,
      worldId: w2!.id,
      state: { variables: { hp: 8, selected: ["A", "B"] } },
      name: "main",
    }).returning();
    const fixtures = [
      { role: "assistant" as const, content: "greeting", stateSnapshot: { variables: { hp: 10, selected: [] } } },
      { role: "user" as const, content: "i attack" },
      { role: "assistant" as const, content: "reply 1", stateSnapshot: { variables: { hp: 9, selected: [] } } },
      { role: "user" as const, content: "again" },
      { role: "assistant" as const, content: "reply 2", stateSnapshot: { variables: { hp: 8, selected: [] } } },
    ];
    const ids: string[] = [];
    for (const f of fixtures) {
      const [row] = await db.insert(messages).values({ sessionId: s2!.id, ...f }).returning();
      ids.push(row!.id);
    }

    // Revert onto the user message "again" (deletes reply 2) → walks back to
    // reply 1's snapshot (hp: 9), whose `selected` is the default [].
    const result = await revertSession({ userId: u2!.id, sessionId: s2!.id, messageId: ids[3]! });
    assert.strictEqual(result.status, 200);
    const state = result.body.data!.state as any;
    assert.strictEqual(state.variables.hp, 9); // narrative var follows the snapshot
    assert.deepStrictEqual(state.variables.selected, ["A", "B"]); // setup choice survives

    // And it was actually persisted to the session, not just returned.
    const [persisted] = await db.select().from(playSessions).where(eq(playSessions.id, s2!.id));
    assert.deepStrictEqual((persisted!.state as any).variables.selected, ["A", "B"]);

    await db.delete(user).where(eq(user.id, u2!.id));
  });

  it("reverting to a target whose snapshot was pruned falls back to live session state, not defaults", async () => {
    // Simulate the cap having pruned everything: set session.state to a
    // distinctive value and null ALL message snapshots.
    await db.update(playSessions).set({ state: { variables: { hp: 42 } } }).where(eq(playSessions.id, testSessionId));
    await db.update(messages).set({ stateSnapshot: null }).where(eq(messages.sessionId, testSessionId));

    // Revert to greeting (assistant) — its snapshot and all older are gone.
    const result = await revertSession({
      userId: testUserId,
      sessionId: testSessionId,
      messageId: messageIds[0]!,
    });
    assert.strictEqual(result.status, 200);
    // Must be the live session value (42), NOT the world default (10).
    assert.strictEqual((result.body.data!.state as any).variables.hp, 42);

    const [s] = await db.select().from(playSessions).where(eq(playSessions.id, testSessionId));
    assert.strictEqual((s!.state as any).variables.hp, 42);
  });
});

after(async () => { await (db as unknown as { $client: { close(): Promise<void> } }).$client.close(); });
