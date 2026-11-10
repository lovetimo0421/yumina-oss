import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { creditWallets, messages, modelPrices, playSessions, summaryceptionSnippets, user, worlds } from "../db/schema.js";
import { env } from "./env.js";
import { OpenRouterProvider } from "./llm/openrouter.js";
import type { GenerateParams, StreamChunk } from "./llm/types.js";
import { invalidateModelPriceCache } from "./model-price-cache.js";
import { clearSummaryceptionData, compactSummaryceptionForSession, SummaryceptionInvalidatedError } from "./summaryception.js";

after(async () => { await (db as unknown as { $client: { close(): Promise<void> } }).$client.close(); });

test("a restart during layer promotion cannot resurrect snippets or compacted flags", async t => {
  const userId = randomUUID();
  const model = "google/gemini-3.1-flash-lite";
  const previousKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = "test-only-never-sent-key";
  await db.insert(user).values({ id: userId, name: "Promotion", email: `${userId}@example.test` });
  try {
    await db.insert(modelPrices).values({ modelId: model, inputPricePerM: 1, outputPricePerM: 2 });
    await invalidateModelPriceCache();
    await db.insert(creditWallets).values({ userId, balance: 100, addonBalance: 100 });
    const [world] = await db.insert(worlds).values({ creatorId: userId, name: "Promotion", schema: { name: "Promotion", entries: [], variables: [] } }).returning();
    const [session] = await db.insert(playSessions).values({ userId, worldId: world!.id, state: { variables: {} },
      summaryceptionModel: model, summaryLanguage: "en", summaryRecentTailTokens: 1000 }).returning();
    await db.insert(messages).values(Array.from({ length: 8 }, (_, index) => ({ sessionId: session!.id,
      role: index % 2 ? "user" as const : "assistant" as const,
      content: `Transcript ${index}. ` + "The visitor waits while the barista prepares warm tea. ".repeat(120),
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)),
    })));
    const older = await db.insert(messages).values(Array.from({length:11},(_,i)=>({sessionId:session!.id,role:"assistant" as const,content:`Earlier scene ${i}.`,summaryceptionCompacted:true,createdAt:new Date(Date.UTC(2026,8,30,0,0,i))}))).returning();
    await db.insert(summaryceptionSnippets).values([
      ...Array.from({ length: 10 }, (_, index) => ({ sessionId: session!.id, layerIndex: 0, snippetOrder: index, sourceStartMessageId:older[index+1]!.id,sourceEndMessageId:older[index+1]!.id,text: `Old lower fact ${index}.` })),
      { sessionId: session!.id, layerIndex: 1, snippetOrder: 0, sourceStartMessageId:older[0]!.id,sourceEndMessageId:older[0]!.id,text: "Old upper fact." },
    ]);
    let callCount = 0;
    t.mock.method(OpenRouterProvider.prototype, "generateStream", async function* (params: GenerateParams): AsyncIterable<StreamChunk> {
      callCount++;
      if (callCount === 2) {
        assert.ok(JSON.stringify(params.messages).includes("Old lower fact"), "second request must be the promotion merge");
        await clearSummaryceptionData(session!.id);
      }
      yield { type: "text", content: "The visitor met the barista and ordered tea. They intend to return tomorrow." };
      yield { type: "done", content: "", stopReason: "stop", usage: { promptTokens: 100, completionTokens: 30, totalTokens: 130 } };
    });
    await assert.rejects(compactSummaryceptionForSession({ sessionId: session!.id, userId, fallbackModel: model,
      contextTokenLimit: 4096, force: true }), SummaryceptionInvalidatedError);
    assert.equal(callCount, 2);
    assert.equal((await db.select().from(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId, session!.id))).length, 0);
    const remaining = await db.select().from(messages).where(eq(messages.sessionId, session!.id));
    assert.ok(remaining.every(message => !message.summaryceptionCompacted));
    const [saved] = await db.select().from(playSessions).where(eq(playSessions.id, session!.id));
    assert.equal(saved!.summaryceptionStatus, "idle", "late failure must not overwrite reset status");
    assert.equal(saved!.summaryceptionSourceHash, null);
  } finally {
    env.YUMINA_OPENROUTER_KEY = previousKey;
    await db.delete(user).where(eq(user.id, userId));
  }
});
