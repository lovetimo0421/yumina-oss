import "../test/database-fixture.js";
import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { db } from "../db/index.js";
import { playSessions, messages, worlds, user, userPersonas, userWorldPersonas, worldMemories, summaryceptionSnippets } from "../db/schema.js";
import { eq, asc } from "drizzle-orm";
import { branchSession } from "./sessions.js";

// Tests call `branchSession()` directly as a plain async function, bypassing
// Hono and the auth middleware. Task 3 factors the branch handler this way so
// the Hono route becomes a thin wrapper and all behavioral tests stay at the
// function level (no synthetic HTTP + no auth shim gymnastics).
//
// Expected signature (what Task 3 must export from ./sessions.ts):
//   export async function branchSession(args: {
//     userId: string;
//     sessionId: string;
//     messageId: string;
//   }): Promise<{
//     status: number;
//     body: { data?: { sessionId: string }; error?: string };
//   }>

// Session memory is a single text block; the helper keeps call sites terse.
const memory = (facts: string[]) => ({
  text: facts.map((fact) => `- ${fact}`).join("\n"),
});

describe("branchSession", () => {
  let testUserId: string;
  let testWorldId: string;
  let testSessionId: string;
  let messageIds: string[];
  let extraUserIds: string[];

  beforeEach(async () => {
    extraUserIds = [];

    // Create user
    const [u] = await db.insert(user).values({
      id: `test-user-${crypto.randomUUID()}`,
      name: "Branch Test User",
      email: `${crypto.randomUUID()}@test.local`,
      emailVerified: true,
    }).returning();
    testUserId = u!.id;

    // Create world (declares hp so normalizeGameState in branchSession
    // preserves the pivot snapshot's hp value rather than stripping it)
    const [w] = await db.insert(worlds).values({
      creatorId: testUserId,
      name: "Branch Test World",
      schema: {
        name: "Branch Test World",
        entries: [],
        variables: [
          { id: "hp", name: "HP", type: "number", defaultValue: 10 },
        ],
      },
      status: "draft",
    }).returning();
    testWorldId = w!.id;

    // Create session (state hp: 10, summary "parent summary", name "main")
    const [s] = await db.insert(playSessions).values({
      userId: testUserId,
      worldId: testWorldId,
      state: { variables: { hp: 10 } },
      summary: "parent summary",
      stateGuardEnabled: false,
      stateGuardModel: "custom/repair",
      name: "main",
    }).returning();
    testSessionId = s!.id;

    // Insert 5 messages ONE AT A TIME. A single bulk insert would give every
    // row the same `createdAt` (Postgres now() is statement-scoped), which
    // breaks the ORDER BY createdAt ASC contract the branching logic depends
    // on. We insert sequentially so each row has a distinct timestamp.
    const fixtures = [
      { role: "assistant" as const, content: "greeting", stateSnapshot: { variables: { hp: 10 } } },
      { role: "user" as const, content: "hi", stateSnapshot: { variables: { hp: 10 } } },
      { role: "assistant" as const, content: "reply 1", stateSnapshot: { variables: { hp: 9 } } },
      { role: "user" as const, content: "go", stateSnapshot: { variables: { hp: 9 } } },
      { role: "assistant" as const, content: "reply 2", stateSnapshot: { variables: { hp: 8 } } },
    ];
    messageIds = [];
    for (const f of fixtures) {
      const [row] = await db.insert(messages).values({ sessionId: testSessionId, ...f }).returning();
      messageIds.push(row!.id);
    }
  });

  afterEach(async () => {
    // Cascade: deleting the user cleans up worlds, sessions, messages,
    // and session-scoped worldMemories via onDelete: "cascade" FKs.
    await db.delete(user).where(eq(user.id, testUserId));
    for (const id of extraUserIds) {
      await db.delete(user).where(eq(user.id, id));
    }
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
    const result = await branchSession({ userId: testUserId, sessionId: testSessionId, messageId: messageIds[2]! });
    assert.equal(result.status, 201);
    const id = result.body.data!.sessionId as string;
    const [saved] = await db.select().from(playSessions).where(eq(playSessions.id, id));
    assert.equal(saved!.sessionPersona?.persona?.id, active!.id);
    assert.equal(saved!.personaLocked, false);
    assert.equal((saved!.state.metadata as Record<string, unknown>).personaName, "Current profile");
    assert.equal((saved!.state.metadata as Record<string, unknown>).personaBackstory, "Current story");
    assert.equal((saved!.state.variables as Record<string, unknown>).hp, 9);
    const [parent] = await db.select().from(playSessions).where(eq(playSessions.id, testSessionId));
    assert.deepEqual(parent!.sessionPersona, binding);
  });

  it("inherits an explicit persona lock from the parent session", async () => {
    const [locked] = await db.insert(userPersonas).values({ userId: testUserId, name: "Locked profile", backstory: "Locked story", isActive: false }).returning();
    await db.insert(userPersonas).values({ userId: testUserId, name: "Current profile", backstory: "Current story", isActive: true });
    await db.update(playSessions).set({
      personaLocked: true,
      sessionPersona: { persona: { id: locked!.id, name: locked!.name, backstory: locked!.backstory } },
    }).where(eq(playSessions.id, testSessionId));
    const result = await branchSession({ userId: testUserId, sessionId: testSessionId, messageId: messageIds[2]! });
    assert.equal(result.status, 201);
    const [saved] = await db.select().from(playSessions).where(eq(playSessions.id, result.body.data!.sessionId));
    assert.equal(saved!.personaLocked, true);
    assert.equal(saved!.sessionPersona?.persona?.id, locked!.id);
    assert.equal((saved!.state.metadata as Record<string, unknown>).personaName, "Locked profile");
  });

  it("clones messages up to branch point, copies state snapshot, and links parent", async () => {
    // Pivot is messageIds[2] ("reply 1"), whose stateSnapshot has hp: 9.
    // The branched session must adopt that snapshot, not the parent's
    // current state (which is still at hp: 10 because the state field on
    // playSessions is only updated by message effects — see the plan).
    const result = await branchSession({
      userId: testUserId,
      sessionId: testSessionId,
      messageId: messageIds[2]!,
    });
    assert.strictEqual(result.status, 201);
    assert.notStrictEqual(result.body.data?.sessionId, undefined);

    const newSessionId = result.body.data!.sessionId as string;
    const [newSession] = await db.select().from(playSessions).where(eq(playSessions.id, newSessionId));
    assert.notStrictEqual(newSession, undefined);
    assert.strictEqual(newSession!.parentSessionId, testSessionId);
    assert.strictEqual(newSession!.branchedFromMessageId, messageIds[2]);
    assert.strictEqual((newSession!.state as any).variables.hp, 9);
    assert.strictEqual(newSession!.summary, "parent summary");
    assert.strictEqual(newSession!.name, "main · 分支 1");

    const clonedMessages = await db.select().from(messages).where(eq(messages.sessionId, newSessionId)).orderBy(asc(messages.createdAt));
    assert.strictEqual(clonedMessages.length, 3);
    assert.deepStrictEqual(clonedMessages.map((m) => m.content), ["greeting", "hi", "reply 1"]);
    // Cloned messages must have fresh IDs, not reuse the parent's IDs.
    const parentIds = new Set(messageIds);
    for (const m of clonedMessages) {
      assert.ok(!parentIds.has(m.id), `cloned message "${m.content}" reused parent id ${m.id}`);
    }
  });

  it("does not mutate the parent session", async () => {
    await branchSession({
      userId: testUserId,
      sessionId: testSessionId,
      messageId: messageIds[2]!,
    });
    const parentMessages = await db.select().from(messages).where(eq(messages.sessionId, testSessionId)).orderBy(asc(messages.createdAt));
    assert.strictEqual(parentMessages.length, 5);
    assert.deepStrictEqual(parentMessages.map((m) => m.content), ["greeting", "hi", "reply 1", "go", "reply 2"]);
  });

  it("copies session-scoped memories to the new session", async () => {
    await db.insert(worldMemories).values([
      { worldId: testWorldId, userId: testUserId, sessionId: testSessionId, content: "meeting the stranger", category: "event", importance: 5 },
    ]);
    const result = await branchSession({
      userId: testUserId,
      sessionId: testSessionId,
      messageId: messageIds[2]!,
    });
    assert.strictEqual(result.status, 201);
    const newSessionId = result.body.data!.sessionId as string;
    const branchMemories = await db.select().from(worldMemories).where(eq(worldMemories.sessionId, newSessionId));
    assert.strictEqual(branchMemories.length, 1);
    assert.strictEqual(branchMemories[0]!.content, "meeting the stranger");
  });

  it("rejects branching a session owned by a different user", async () => {
    const otherUserId = `test-user-${crypto.randomUUID()}`;
    extraUserIds.push(otherUserId);
    await db.insert(user).values({ id: otherUserId, name: "Other", email: `${otherUserId}@test.local`, emailVerified: true });
    const result = await branchSession({
      userId: otherUserId,
      sessionId: testSessionId,
      messageId: messageIds[2]!,
    });
    assert.strictEqual(result.status, 404);
  });

  it("inherits the parent's guard toggle and correction model", async () => {
    const result = await branchSession({ userId: testUserId, sessionId: testSessionId, messageId: messageIds[2]! });
    assert.equal(result.status, 201);
    const [branch] = await db.select().from(playSessions).where(eq(playSessions.id, result.body.data!.sessionId));
    assert.equal(branch!.stateGuardEnabled, false);
    assert.equal(branch!.stateGuardModel, "custom/repair");
  });

  it("rejects branching with an unknown messageId", async () => {
    const result = await branchSession({
      userId: testUserId,
      sessionId: testSessionId,
      messageId: "nonexistent-message-id",
    });
    assert.strictEqual(result.status, 404);
  });

  it("auto-increments branch numbering under the same parent", async () => {
    await branchSession({
      userId: testUserId,
      sessionId: testSessionId,
      messageId: messageIds[2]!,
    });
    const result2 = await branchSession({
      userId: testUserId,
      sessionId: testSessionId,
      messageId: messageIds[2]!,
    });
    assert.strictEqual(result2.status, 201);
    const secondId = result2.body.data!.sessionId as string;
    const [second] = await db.select().from(playSessions).where(eq(playSessions.id, secondId));
    assert.strictEqual(second!.name, "main · 分支 2");
  });

  it("keeps session memory when the fork copies a reply newer than the processed turn, remapping the pointer", async () => {
    // Memory was last computed at "reply 1" (messageIds[2]); fork at "reply 2"
    // copies that turn AND a newer reply, so the facts are valid for the branch
    // and the lag-one invariant holds (memory doesn't cover the branch tip).
    await db.update(playSessions).set({
      sessionMemory: memory(["the hero met the stranger"]),
      sessionMemoryProcessedMessageId: messageIds[2]!,
      sessionMemoryStatus: "idle",
    }).where(eq(playSessions.id, testSessionId));

    const result = await branchSession({ userId: testUserId, sessionId: testSessionId, messageId: messageIds[4]! });
    assert.strictEqual(result.status, 201);
    const newSessionId = result.body.data!.sessionId as string;
    const [newSession] = await db.select().from(playSessions).where(eq(playSessions.id, newSessionId));

    assert.deepStrictEqual(newSession!.sessionMemory, memory(["the hero met the stranger"]));
    // The stored pointer must reference the BRANCH's cloned "reply 1", not the
    // parent id (which doesn't exist in the branch).
    const clonedMessages = await db.select().from(messages).where(eq(messages.sessionId, newSessionId)).orderBy(asc(messages.createdAt));
    const clonedReply1 = clonedMessages.find((m) => m.content === "reply 1")!;
    assert.strictEqual(newSession!.sessionMemoryProcessedMessageId, clonedReply1.id);
    assert.notStrictEqual(newSession!.sessionMemoryProcessedMessageId, messageIds[2], "pointer must not dangle on a parent id");
  });

  it("keeps session memory when the fork's own tip is the processed turn, remapping the pointer", async () => {
    // Memory was last computed at "reply 1"; forking AT "reply 1" makes that
    // turn the branch's newest visible reply. The memory holds no facts from
    // turns the branch never had, so it is kept (wiping destroyed the whole
    // accumulated memory for a one-exchange lag-one bend — same tradeoff as
    // the revert path; a swipe of the covered tip stamps the stale-confession).
    await db.update(playSessions).set({
      sessionMemory: memory(["the hero met the stranger"]),
      sessionMemoryProcessedMessageId: messageIds[2]!,
      sessionMemoryStatus: "idle",
    }).where(eq(playSessions.id, testSessionId));

    const result = await branchSession({ userId: testUserId, sessionId: testSessionId, messageId: messageIds[2]! });
    assert.strictEqual(result.status, 201);
    const newSessionId = result.body.data!.sessionId as string;
    const [newSession] = await db.select().from(playSessions).where(eq(playSessions.id, newSessionId));

    assert.deepStrictEqual(newSession!.sessionMemory, memory(["the hero met the stranger"]));
    const clonedMessages = await db.select().from(messages).where(eq(messages.sessionId, newSessionId)).orderBy(asc(messages.createdAt));
    const clonedReply1 = clonedMessages.find((m) => m.content === "reply 1")!;
    assert.strictEqual(newSession!.sessionMemoryProcessedMessageId, clonedReply1.id);
  });

  it("wipes session memory when the fork excludes its processed turn", async () => {
    // Memory processed the tip ("reply 2", messageIds[4]); forking earlier at
    // "reply 1" would leak facts from turns the branch never had → drop.
    await db.update(playSessions).set({
      sessionMemory: memory(["spoilers from a later turn"]),
      sessionMemoryProcessedMessageId: messageIds[4]!,
      sessionMemoryStatus: "idle",
    }).where(eq(playSessions.id, testSessionId));

    const result = await branchSession({ userId: testUserId, sessionId: testSessionId, messageId: messageIds[2]! });
    const newSessionId = result.body.data!.sessionId as string;
    const [newSession] = await db.select().from(playSessions).where(eq(playSessions.id, newSessionId));
    assert.strictEqual(newSession!.sessionMemory, null);
    assert.strictEqual(newSession!.sessionMemoryProcessedMessageId, null);
  });

  it("keeps session memory when an update is mid-flight at fork time but its pointer is copied", async () => {
    // The in-flight job moved the pointer to the turn it is folding when it
    // started; that turn being copied proves the stored (older) memory holds
    // only copied-turn facts. Same rule as invalidateForRevert.
    await db.update(playSessions).set({
      sessionMemory: memory(["x"]),
      sessionMemoryProcessedMessageId: messageIds[2]!,
      sessionMemoryStatus: "updating",
    }).where(eq(playSessions.id, testSessionId));
    const result = await branchSession({ userId: testUserId, sessionId: testSessionId, messageId: messageIds[2]! });
    const newSessionId = result.body.data!.sessionId as string;
    const [newSession] = await db.select().from(playSessions).where(eq(playSessions.id, newSessionId));
    assert.deepStrictEqual(newSession!.sessionMemory, memory(["x"]));
    const clonedMessages = await db.select().from(messages).where(eq(messages.sessionId, newSessionId));
    const clonedReply1 = clonedMessages.find((m) => m.content === "reply 1")!;
    assert.strictEqual(newSession!.sessionMemoryProcessedMessageId, clonedReply1.id);
  });

  it("remaps cloned layered-summary snippet source ids onto the branch's messages", async () => {
    // A snippet covering greeting..reply1; forking at reply1 keeps it (nothing
    // layer-compacted beyond the pivot), and its source ids must point at the
    // branch's cloned rows, not the parent's.
    await db.insert(summaryceptionSnippets).values({
      sessionId: testSessionId,
      layerIndex: 0,
      snippetOrder: 0,
      text: "the hero greeted the stranger",
      sourceStartMessageId: messageIds[0]!,
      sourceEndMessageId: messageIds[2]!,
    });

    const result = await branchSession({ userId: testUserId, sessionId: testSessionId, messageId: messageIds[2]! });
    assert.strictEqual(result.status, 201);
    const newSessionId = result.body.data!.sessionId as string;
    const clonedMessages = await db.select().from(messages).where(eq(messages.sessionId, newSessionId)).orderBy(asc(messages.createdAt));
    const clonedGreeting = clonedMessages.find((m) => m.content === "greeting")!;
    const clonedReply1 = clonedMessages.find((m) => m.content === "reply 1")!;

    const branchSnippets = await db.select().from(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId, newSessionId));
    assert.strictEqual(branchSnippets.length, 1);
    assert.strictEqual(branchSnippets[0]!.sourceStartMessageId, clonedGreeting.id);
    assert.strictEqual(branchSnippets[0]!.sourceEndMessageId, clonedReply1.id);
    assert.notStrictEqual(branchSnippets[0]!.sourceStartMessageId, messageIds[0], "must not dangle on a parent id");
  });
});

after(async () => { await (db as unknown as { $client: { close(): Promise<void> } }).$client.close(); });
