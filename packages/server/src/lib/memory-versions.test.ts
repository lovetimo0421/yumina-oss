import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import { db } from "../db/index.js";
import { creditTransactions, creditWallets, messages, modelPrices, playSessions, sessionMemoryVersions, user, userExtensions, worlds } from "../db/schema.js";
import { env } from "./env.js";
import { invalidateModelPriceCache } from "./model-price-cache.js";
import { OpenRouterProvider } from "./llm/openrouter.js";
import type { GenerateParams, StreamChunk } from "./llm/types.js";
import { regenerateSessionMemoryForSession, retrySessionMemoryForSession } from "./session-memory.js";
import { latestValidMemoryVersion } from "./session-memory-versions.js";
import { runExtensionInvalidation } from "./extension-hooks.js";
import { registerSessionMemoryExtension } from "../extensions/session-memory/hooks.js";

// Memory is saved as a version at every committed fold, so a changed turn or
// a stopped rebuild continues from the newest version before it instead of
// re-reading the chat from its first message.

const model = "google/gemini-3.1-flash-lite";
// ~2,000 tokens a message: twenty messages fold in three ~60k-character batches.
const filler = "The visitor waits quietly while the barista warms the tea. ".repeat(136);
after(async () => { await (db as unknown as { $client: { close(): Promise<void> } }).$client.close(); });

async function fixture() {
  const uid = randomUUID();
  await db.insert(user).values({ id: uid, name: "Versions", email: `${uid}@example.test` });
  const [wallet] = await db.insert(creditWallets).values({ userId: uid, balance: 100000, addonBalance: 0 }).returning();
  await db.insert(userExtensions).values({ userId: uid, extensionKey: SESSION_MEMORY_EXTENSION_KEY, status: "installed" });
  const [world] = await db.insert(worlds).values({ creatorId: uid, name: "Cafe", schema: { name: "Cafe", entries: [], variables: [] } }).returning();
  const [session] = await db.insert(playSessions).values({ userId: uid, worldId: world!.id, state: {}, sessionMemoryModel: model, sessionMemoryIncluded: true }).returning();
  const ids = Array.from({ length: 20 }, () => randomUUID());
  await db.insert(messages).values(ids.map((id, i) => ({
    id, sessionId: session!.id, role: i % 2 ? "user" as const : "assistant" as const,
    content: `<<m${String(i).padStart(2, "0")}>> ${filler}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
  })));
  const charges = async () => (await db.select().from(creditTransactions)
    .where(and(eq(creditTransactions.walletId, wallet!.id), eq(creditTransactions.type, "usage")))).length;
  const versions = () => db.select().from(sessionMemoryVersions).where(eq(sessionMemoryVersions.sessionId, session!.id)).orderBy(asc(sessionMemoryVersions.processedAt));
  return { uid, sid: session!.id, ids, charges, versions };
}

function provider(t: TestContext, failFrom = Infinity) {
  const prompts: string[] = [];
  t.mock.method(OpenRouterProvider.prototype, "generateStream", async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
    prompts.push(JSON.stringify(p.messages));
    if (prompts.length >= failFrom) throw new Error("provider down");
    yield { type: "text", content: `Core facts:\n- Fact ${prompts.length}.` };
    yield { type: "done", content: "", stopReason: "stop", usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 } };
  });
  return prompts;
}

async function settled(sid: string) {
  for (let i = 0; i < 200; i++) {
    const [row] = await db.select().from(playSessions).where(eq(playSessions.id, sid));
    if (row!.sessionMemoryStatus !== "updating" && !row!.sessionMemoryStaleAt && !row!.sessionMemorySourceHash?.startsWith("repair:")) return row!;
    if (row!.sessionMemoryStatus === "failed") return row!;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("memory never settled");
}

test("session memory versions", async t => {
  assert.equal(env.DATABASE_URL, undefined);
  const oldKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = "test-only-key-never-sent";
  // Cheap enough that a rebuild of this chat from the start stays under the automatic cap.
  await db.insert(modelPrices).values({ modelId: model, inputPricePerM: 0.4, outputPricePerM: 0.4 }).onConflictDoNothing();
  await invalidateModelPriceCache();
  registerSessionMemoryExtension();
  try {
    await t.test("a rebuild keeps a version per batch, billed once each", async st => {
      const f = await fixture();
      const prompts = provider(st);
      await regenerateSessionMemoryForSession({ sessionId: f.sid, userId: f.uid });
      assert.equal(prompts.length, 3);
      const kept = await f.versions();
      assert.equal(kept.length, 3);
      assert.equal(kept.at(-1)!.processedMessageId, f.ids[16], "the last version stops before the newest reply (m18)");
      assert.equal(await f.charges(), 3);
    });

    await t.test("an ordinary update keeps a version too", async st => {
      const f = await fixture();
      provider(st);
      await regenerateSessionMemoryForSession({ sessionId: f.sid, userId: f.uid });
      const more = [randomUUID(), randomUUID(), randomUUID()];
      await db.insert(messages).values(more.map((id, i) => ({ id, sessionId: f.sid, role: i % 2 ? "user" as const : "assistant" as const,
        content: `<<n${i}>> ${filler}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 1, i)) })));
      await retrySessionMemoryForSession({ sessionId: f.sid, userId: f.uid });
      const kept = await f.versions();
      assert.equal(kept.at(-1)!.processedMessageId, more[0], "the update folded through the reply before the newest");
      const [row] = await db.select().from(playSessions).where(eq(playSessions.id, f.sid));
      assert.deepEqual(kept.at(-1)!.memory, row!.sessionMemory);
    });

    await t.test("an edit near the end refolds only from the version before it", async st => {
      const f = await fixture();
      provider(st);
      await regenerateSessionMemoryForSession({ sessionId: f.sid, userId: f.uid });
      const prompts = provider(st);
      const edited = f.ids[15]!;
      await runExtensionInvalidation({ reason: "message-edited", sessionId: f.sid }, undefined, db, async (tx) => {
        const [before] = await tx.select().from(messages).where(eq(messages.id, edited));
        await tx.update(messages).set({ content: `<<m15>> edited. ${filler}` }).where(eq(messages.id, edited));
        return { messageFlags: { id: before!.id, createdAt: before!.createdAt, compacted: false, summaryceptionCompacted: false } };
      });
      const row = await settled(f.sid);
      assert.equal(row.sessionMemoryStatus, "idle");
      assert.equal(row.sessionMemoryProcessedMessageId, f.ids[16]);
      assert.equal(prompts.length, 1, "one call, not a rebuild from message one");
      assert.ok(prompts[0]!.includes("<<m15>> edited"));
      assert.ok(!prompts[0]!.includes("<<m00>>"), "earlier turns come from the saved version");
      assert.equal(await f.charges(), 4);
    });

    await t.test("a stopped rebuild continues from its last kept batch", async st => {
      const f = await fixture();
      provider(st, 3);
      await assert.rejects(regenerateSessionMemoryForSession({ sessionId: f.sid, userId: f.uid }));
      assert.equal((await f.versions()).length, 2);
      assert.equal(await f.charges(), 2, "the two finished batches are paid, the failed one is not");
      const prompts = provider(st);
      await regenerateSessionMemoryForSession({ sessionId: f.sid, userId: f.uid, automatic: true });
      assert.equal(prompts.length, 1, "only the batch that never finished");
      assert.equal(await f.charges(), 3, "nothing is paid twice");
      const [row] = await db.select().from(playSessions).where(eq(playSessions.id, f.sid));
      assert.equal(row!.sessionMemoryProcessedMessageId, f.ids[16]);
    });

    await t.test("a version whose turns changed underneath it is not used", async st => {
      const f = await fixture();
      provider(st);
      await regenerateSessionMemoryForSession({ sessionId: f.sid, userId: f.uid });
      // Changed without going through invalidation: the fingerprint still catches it.
      await db.update(messages).set({ content: "<<m02>> shorter" }).where(eq(messages.id, f.ids[2]!));
      assert.equal(await latestValidMemoryVersion(f.sid, f.ids[16]!), null);
      assert.equal((await f.versions()).length, 0, "invalid versions are dropped");
    });

    await t.test("deleting a turn drops the versions that end on it", async st => {
      const f = await fixture();
      provider(st);
      await regenerateSessionMemoryForSession({ sessionId: f.sid, userId: f.uid });
      const before = (await f.versions()).map(v => v.processedMessageId);
      await db.delete(messages).where(eq(messages.id, before.at(-1)!));
      const after = (await f.versions()).map(v => v.processedMessageId);
      assert.deepEqual(after, before.slice(0, -1));
    });

    await t.test("restarting the story drops every version", async st => {
      const f = await fixture();
      provider(st);
      await regenerateSessionMemoryForSession({ sessionId: f.sid, userId: f.uid });
      assert.ok((await f.versions()).length > 0);
      await runExtensionInvalidation({ reason: "session-restart", sessionId: f.sid }, undefined, db, async () => ({}));
      assert.equal((await f.versions()).length, 0);
    });
  } finally {
    env.YUMINA_OPENROUTER_KEY = oldKey;
  }
});
