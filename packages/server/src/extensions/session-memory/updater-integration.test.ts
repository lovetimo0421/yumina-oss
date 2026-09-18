import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { eq } from "drizzle-orm";
import { SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import { db } from "../../db/index.js";
import * as schema from "../../db/schema.js";
import { apiKeys, messages, playSessions, usageLogs, user, userExtensions, worlds } from "../../db/schema.js";
import { encryptApiKey } from "../../lib/crypto.js";
import { CustomProvider } from "../../lib/llm/custom.js";
import type { GenerateParams, StreamChunk } from "../../lib/llm/types.js";
import { retrySessionMemoryForSession, regenerateSessionMemoryForSession, sessionMemoryProgress } from "../../lib/session-memory.js";

// Exercises the real updater, provider resolution, database claims and commits.
// Only the provider stream is scripted; no real API key or network is used.
test("manual retry preserves an empty failure, accepts partial memory, and rebuilds it completely", async (t) => {
  assert.equal(process.env.DATABASE_URL, "");
  assert.equal(process.env.PGLITE_DATA_DIR, "memory://");
  assert.ok(db.$client instanceof PGlite);
  const migration = await generateMigration(generateDrizzleJson({}), generateDrizzleJson(schema));
  for (const statement of migration) await db.$client.exec(statement);
  const testUserId = `memory-updater-${randomUUID()}`;
  const testKeyId = randomUUID();
  const testSessionId = randomUUID();
  const model = "custom/memory-updater-test";
  const oldMemory = { text: "Core facts:\n- Ari keeps a blue compass." };
  const healthyText = "Core facts:\n- Ari keeps a blue compass.\nImportant decisions and promises:\n- Mira agreed to carry the sealed letter.\nCurrent risks and constraints:\n- The north gate closes at dawn.";
  const prompts: GenerateParams[] = [];
  let phase: "empty" | "partial" | "healthy" = "empty";

  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("The memory updater integration test must never access the network");
  });
  t.mock.method(CustomProvider.prototype, "generateStream", async function* (params: GenerateParams): AsyncIterable<StreamChunk> {
    prompts.push(structuredClone(params));
    const truncated = phase !== "healthy";
    yield { type: "text", content: phase === "empty" ? "" : truncated ? "Core facts:\n- Mira accepted the sealed letter." : healthyText };
    yield {
      type: "done", content: "", stopReason: truncated ? "max_tokens" : "stop",
      usage: { promptTokens: 200, completionTokens: truncated ? 8192 : 100, totalTokens: truncated ? 8392 : 300 },
    };
  });

  try {
    await db.insert(user).values({
      id: testUserId, name: "Memory updater integration", email: `${testUserId}@test.local`, emailVerified: true,
      preferences: { preferredProvider: "private", activeApiKeyId: testKeyId },
    });
    const encrypted = encryptApiKey("test-only-never-sent-api-key");
    await db.insert(apiKeys).values({
      id: testKeyId, userId: testUserId, provider: "custom", baseUrl: "https://memory-updater-test.example/v1",
      encryptedKey: encrypted.encrypted, keyIv: encrypted.iv, keyTag: encrypted.tag,
    });
    await db.insert(userExtensions).values({ userId: testUserId, extensionKey: SESSION_MEMORY_EXTENSION_KEY, status: "installed" });
    const [world] = await db.insert(worlds).values({
      creatorId: testUserId, name: "Memory updater fixture", status: "draft",
      schema: { name: "Memory updater fixture", entries: [], variables: [] },
    }).returning();
    await db.insert(playSessions).values({
      id: testSessionId, userId: testUserId, worldId: world!.id, state: {},
      sessionMemory: oldMemory, sessionMemoryModel: model, sessionMemoryIncluded: true,
      sessionMemoryStatus: "idle", sessionMemorySourceHash: "v2:previous-success",
      sessionMemoryUpdatedAt: new Date("2026-09-01T00:00:00Z"),
    });
    const fixtures = [
      { role: "assistant" as const, content: "COVERED_REPLY_ZERO" },
      { role: "user" as const, content: "PENDING_USER_ONE asks Mira to carry the letter." },
      { role: "assistant" as const, content: "PENDING_REPLY_ONE Mira promises to carry the sealed letter." },
      { role: "user" as const, content: "PENDING_USER_TWO asks when the north gate closes." },
      { role: "assistant" as const, content: "PENDING_REPLY_TWO The north gate closes at dawn." },
      { role: "user" as const, content: "NEWEST_USER_EXCLUDED asks for another route." },
      { role: "assistant" as const, content: "NEWEST_REPLY_EXCLUDED reveals a secret tunnel." },
    ];
    const ids: string[] = [];
    for (const [index, fixture] of fixtures.entries()) {
      const id = randomUUID();
      ids.push(id);
      await db.insert(messages).values({
        id, sessionId: testSessionId, ...fixture,
        stateSnapshot: index === 4 ? { marker: "ELIGIBLE_STATE" } : { marker: `EXCLUDED_STATE_${index}`, historicalPayload: "unused".repeat(20_000) },
        createdAt: new Date(Date.UTC(2026, 8, 1, 1, 0, index)),
      });
    }
    await db.update(playSessions).set({ sessionMemoryProcessedMessageId: ids[0]! }).where(eq(playSessions.id, testSessionId));
    const readSession = async () => {
      const [session] = await db.select().from(playSessions).where(eq(playSessions.id, testSessionId));
      assert.ok(session);
      return session;
    };
    assert.equal((await sessionMemoryProgress(await readSession())).pendingTurns, 2);

    await retrySessionMemoryForSession({ sessionId: testSessionId, userId: testUserId });
    const failed = await readSession();
    assert.equal(prompts.length, 1, "empty private output cannot escape the private provider boundary");
    assert.equal(failed.sessionMemoryStatus, "failed");
    assert.deepEqual(failed.sessionMemory, oldMemory, "empty output cannot replace existing memory");
    assert.equal(failed.sessionMemoryProcessedMessageId, ids[0]);
    assert.equal(failed.sessionMemoryUpdatedAt?.toISOString(), "2026-09-01T00:00:00.000Z");
    assert.equal(failed.sessionMemoryClaimedAt, null);
    assert.equal(failed.sessionMemoryRetryCount, 1);
    assert.equal((await sessionMemoryProgress(failed)).pendingTurns, 2, "failed replies remain eligible for the next retry");

    phase = "partial";
    await retrySessionMemoryForSession({ sessionId: testSessionId, userId: testUserId });
    const partial = await readSession();
    assert.equal(prompts.length, 3, "partial recovery uses exactly two generation attempts");
    assert.equal(partial.sessionMemoryStatus, "idle");
    assert.deepEqual(partial.sessionMemory, {text: "Core facts:\n- Mira accepted the sealed letter.", warning: "truncated"});
    assert.equal(partial.sessionMemoryProcessedMessageId, ids[4]);
    assert.equal(partial.sessionMemoryRetryCount, 0);
    assert.equal((await sessionMemoryProgress(partial)).pendingTurns, 0);
    phase = "healthy";
    await regenerateSessionMemoryForSession({ sessionId: testSessionId, userId: testUserId });
    const recovered = await readSession();
    assert.equal(prompts.length, 4, "a healthy rebuild needs only one generation");
    assert.equal(recovered.sessionMemoryStatus, "idle");
    assert.deepEqual(recovered.sessionMemory, { text: healthyText });
    assert.equal(recovered.sessionMemoryProcessedMessageId, ids[4], "coverage stops at the second-newest assistant reply");
    assert.equal(recovered.sessionMemoryClaimedAt, null);
    assert.equal(recovered.sessionMemoryRetryCount, 0);
    assert.equal(recovered.sessionMemoryError, null);
    assert.equal((await sessionMemoryProgress(recovered)).pendingTurns, 0);
    for (const params of prompts.slice(0, 3)) {
      const prompt = JSON.stringify(params.messages);
      assert.equal(params.model, model);
      for (const marker of ["PENDING_USER_ONE", "PENDING_REPLY_ONE", "PENDING_USER_TWO", "PENDING_REPLY_TWO"]) {
        assert.ok(prompt.includes(marker), `every attempt must include ${marker}`);
      }
      for (const marker of ["COVERED_REPLY_ZERO", "NEWEST_USER_EXCLUDED", "NEWEST_REPLY_EXCLUDED"]) {
        assert.ok(!prompt.includes(marker), `the prompt must exclude ${marker}`);
      }
      assert.ok(prompt.includes("Ari keeps a blue compass"), "all retries start from the last complete memory");
    }
    assert.match(JSON.stringify(prompts[2]!.messages), /1500 characters/);
    await t.test("legacy repair uses the eligible endpoint state without leaking later or earlier snapshots", async () => {
      await db.update(playSessions).set({
        sessionMemoryStatus: "failed", sessionMemorySourceHash: "legacy-attempt",
        sessionMemoryRetryCount: 1,
      }).where(eq(playSessions.id, testSessionId));
      await retrySessionMemoryForSession({ sessionId: testSessionId, userId: testUserId });
      const repaired = await readSession();
      assert.equal(repaired.sessionMemoryStatus, "idle");
      assert.equal(repaired.sessionMemoryProcessedMessageId, ids[4]);
      assert.equal(repaired.sessionMemoryRetryCount, 0);
      assert.equal(prompts.length, 5);
      const repairPrompt = JSON.stringify(prompts[4]!.messages);
      assert.ok(repairPrompt.includes("ELIGIBLE_STATE"));
      assert.ok(!repairPrompt.includes("EXCLUDED_STATE"));
      assert.ok(!repairPrompt.includes("NEWEST_REPLY_EXCLUDED"));
      assert.ok(repairPrompt.includes("PENDING_REPLY_ONE"));
      assert.ok(repairPrompt.includes("PENDING_REPLY_TWO"));
    });
    assert.equal(network.mock.callCount(), 0);
  } finally {
    await db.delete(usageLogs).where(eq(usageLogs.userId, testUserId));
    await db.delete(user).where(eq(user.id, testUserId));
    await db.$client.close();
  }
});
