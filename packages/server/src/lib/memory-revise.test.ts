import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import { db } from "../db/index.js";
import { creditWallets, messages, modelPrices, playSessions, user, userExtensions, worlds } from "../db/schema.js";
import { env } from "./env.js";
import { invalidateModelPriceCache } from "./model-price-cache.js";
import { OpenRouterProvider } from "./llm/openrouter.js";
import type { GenerateParams, StreamChunk } from "./llm/types.js";
import { runExtensionInvalidation } from "./extension-hooks.js";
import { registerSessionMemoryExtension } from "../extensions/session-memory/hooks.js";

// A long chat with no saved versions, whose full rebuild is over the automatic
// budget, used to keep its memory hidden after any edit until the player
// rebuilt it. When the stale stamp locates the edit, the memory is revised
// from that turn on instead; when it cannot, nothing changes from before.

const model = "google/gemini-3.1-flash-lite";
const oldMemory = "Core facts:\n- The party camps at the beach.";
// ~2,000 tokens a message: a full rebuild of twenty is over the automatic cap.
const filler = "The visitor waits quietly while the barista warms the tea. ".repeat(136);
after(async () => { await (db as unknown as { $client: { close(): Promise<void> } }).$client.close(); });

async function fixture(staleAt: Date | null = null) {
  const uid = randomUUID();
  await db.insert(user).values({ id: uid, name: "Revise", email: `${uid}@example.test` });
  await db.insert(creditWallets).values({ userId: uid, balance: 100000, addonBalance: 0 });
  await db.insert(userExtensions).values({ userId: uid, extensionKey: SESSION_MEMORY_EXTENSION_KEY, status: "installed" });
  const [world] = await db.insert(worlds).values({ creatorId: uid, name: "Cafe", schema: { name: "Cafe", entries: [], variables: [] } }).returning();
  const ids = Array.from({ length: 20 }, () => randomUUID());
  const [session] = await db.insert(playSessions).values({ userId: uid, worldId: world!.id, state: {}, sessionMemoryModel: model, sessionMemoryIncluded: true }).returning();
  await db.insert(messages).values(ids.map((id, i) => ({
    id, sessionId: session!.id, role: i % 2 ? "user" as const : "assistant" as const,
    content: `<<m${String(i).padStart(2, "0")}>> ${filler}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
  })));
  // The memory covers through m16 (lag one behind the newest reply, m18).
  await db.update(playSessions).set({
    sessionMemory: { text: oldMemory }, sessionMemoryStatus: "idle", sessionMemoryProcessedMessageId: ids[16]!,
    sessionMemorySourceHash: `v2:${randomUUID()}:eligible-v1`, sessionMemoryUpdatedAt: new Date(Date.UTC(2026, 9, 1, 1)), sessionMemoryStaleAt: staleAt,
  }).where(eq(playSessions.id, session!.id));
  const edit = (index: number) => runExtensionInvalidation({ reason: "message-edited", sessionId: session!.id }, undefined, db, async (tx) => {
    const [before] = await tx.select().from(messages).where(eq(messages.id, ids[index]!));
    await tx.update(messages).set({ content: `<<m${String(index).padStart(2, "0")}>> edited: the party moved to the forest. ${filler}` }).where(eq(messages.id, ids[index]!));
    return { messageFlags: { id: before!.id, createdAt: before!.createdAt, compacted: false, summaryceptionCompacted: false } };
  });
  const row = async () => (await db.select().from(playSessions).where(eq(playSessions.id, session!.id)))[0]!;
  return { sid: session!.id, ids, edit, row };
}

function provider(t: TestContext) {
  const prompts: string[] = [];
  t.mock.method(OpenRouterProvider.prototype, "generateStream", async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
    prompts.push(JSON.stringify(p.messages));
    yield { type: "text", content: "Core facts:\n- The party camps in the forest." };
    yield { type: "done", content: "", stopReason: "stop", usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 } };
  });
  return prompts;
}

async function settled(row: () => Promise<typeof playSessions.$inferSelect>) {
  for (let i = 0; i < 200; i++) {
    const current = await row();
    if (current.sessionMemoryStatus === "failed" || (current.sessionMemoryStatus === "idle" && !current.sessionMemoryStaleAt)) return current;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return row();
}

test("an over-budget memory repair revises from the edit instead of hiding the memory", async t => {
  assert.equal(env.DATABASE_URL, undefined);
  const oldKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = "test-only-key-never-sent";
  await db.insert(modelPrices).values({ modelId: model, inputPricePerM: 1, outputPricePerM: 1 }).onConflictDoNothing();
  await invalidateModelPriceCache();
  registerSessionMemoryExtension();
  try {
    await t.test("an edit near the end revises the memory from that turn, in one call", async st => {
      const f = await fixture();
      const prompts = provider(st);
      await f.edit(15);
      const after = await settled(f.row);
      assert.equal(after.sessionMemoryStatus, "idle", String(after.sessionMemoryError));
      assert.equal(after.sessionMemoryStaleAt, null, "the memory is usable again");
      assert.equal((after.sessionMemory as { text: string }).text, "Core facts:\n- The party camps in the forest.");
      assert.equal(after.sessionMemoryProcessedMessageId, f.ids[16]);
      assert.equal(prompts.length, 1);
      assert.match(prompts[0]!, /The player edited the story/);
      assert.ok(prompts[0]!.includes("The party camps at the beach"), "the old memory is the base to revise");
      assert.ok(prompts[0]!.includes("<<m15>> edited"));
      assert.ok(!prompts[0]!.includes("<<m14>>"), "nothing before the edit is re-read");
    });

    await t.test("two edits revise from the earlier one", async st => {
      const f = await fixture();
      const prompts = provider(st);
      // Hold the repair until both edits are in.
      await db.update(playSessions).set({ sessionMemoryIncluded: false }).where(eq(playSessions.id, f.sid));
      await f.edit(15);
      await f.edit(11);
      await db.update(playSessions).set({ sessionMemoryIncluded: true, sessionMemoryStatus: "idle" }).where(eq(playSessions.id, f.sid));
      await f.edit(13);
      const after = await settled(f.row);
      assert.equal(after.sessionMemoryStaleAt, null, String(after.sessionMemoryError));
      const sent = prompts.join("\n");
      assert.ok(sent.includes("<<m11>> edited"), "the revision starts at the earliest edit");
      assert.ok(!sent.includes("<<m10>>"));
    });

    await t.test("a stamp that does not locate the edit keeps the memory hidden, as before", async st => {
      // An older stamp records when the edit happened: after the memory's last turn.
      const f = await fixture(new Date(Date.UTC(2026, 9, 2)));
      const prompts = provider(st);
      await f.edit(15);
      const after = await settled(f.row);
      assert.equal(prompts.length, 0, "no paid call");
      assert.equal(after.sessionMemoryStatus, "failed");
      assert.match(after.sessionMemoryError ?? "", /would cost about \d+ mushies/);
      assert.ok(after.sessionMemoryStaleAt, "still hidden from the prompt");
      assert.equal(after.sessionMemoryStaleAt!.getTime(), Date.UTC(2026, 9, 2), "a nearer edit never replaces an unlocated one");
    });
  } finally {
    env.YUMINA_OPENROUTER_KEY = oldKey;
  }
});
