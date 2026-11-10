import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiKeys, creditTransactions, creditWallets, messages, modelPrices, playSessions, user, worlds } from "../db/schema.js";
import { env } from "./env.js";
import { encryptApiKey } from "./crypto.js";
import { deductCredits } from "./credit-service.js";
import { invalidateModelPriceCache } from "./model-price-cache.js";
import { OpenRouterProvider } from "./llm/openrouter.js";
import { CustomProvider } from "./llm/custom.js";
import type { GenerateParams, StreamChunk } from "./llm/types.js";
import { compactStorySummaryForSession, compactStorySummaryForSessionManually } from "./session-compaction.js";

const officialModel = "google/gemini-3.1-flash-lite";
const privateModel = "custom/deepseek-chat";
const paths = ["automatic", "manual", "regenerate-small", "regenerate-window"] as const;
type Path = typeof paths[number];
const episode = JSON.stringify({ title: "Cafe", summary: "The visitor waited for tea.", endingOneLine: "The visitor remains in the cafe.", majorEvents: ["The visitor waited."], relationshipChanges: [], decisionsAndPromises: [], goalsAndOpenThreads: ["Have tea."], worldStateAndInventory: [], risksAndConstraints: [], keywords: ["cafe"] });
const story = "## Story So Far\nThe visitor waited for tea.\n\n## Major Open Threads\n- Have tea.\n\n## Important Past Events\n- The visitor arrived at the cafe.";
after(async () => { await (db as unknown as { $client: { close(): Promise<void> } }).$client.close(); });

async function fixture(path: Path, balance: number, byok = false) {
  const uid = randomUUID();
  await db.insert(user).values({ id: uid, name: "Main promotion", email: `${uid}@example.test`, ...(byok ? { preferences: { preferredProvider: "private" } } : {}) });
  const [wallet] = await db.insert(creditWallets).values({ userId: uid, balance, addonBalance: 0 }).returning();
  const [world] = await db.insert(worlds).values({ creatorId: uid, name: "Cafe", schema: { id: randomUUID(), name: "Cafe", entries: [], variables: [], rules: [], components: [], settings: {} } }).returning();
  const model = byok ? privateModel : officialModel;
  const [session] = await db.insert(playSessions).values({ userId: uid, worldId: world!.id, state: { variables: { future: "LIVE_STATE_MUST_NOT_LEAK" }, metadata: {} }, summaryModel: model, summaryLanguage: "en", summaryRecentTailTokens: 5000 }).returning();
  const small = path === "regenerate-small";
  const rows = Array.from({ length: small ? 1 : 9 }, (_, i) => ({ id: randomUUID(), sessionId: session!.id, role: i % 2 ? "user" as const : "assistant" as const, content: `Scene ${i}. The visitor waits for tea. ` + (small ? "" : "The visitor waits quietly while the barista prepares warm tea and opens the cafe. ".repeat(120)), stateSnapshot: { variables: { boundary: "HISTORICAL_STATE" }, metadata: {} }, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)) }));
  await db.insert(messages).values(rows);
  if (byok) {
    const encrypted = encryptApiKey("test-only-key-never-sent");
    await db.insert(apiKeys).values({ userId: uid, provider: "custom", baseUrl: "https://api.deepseek.com", encryptedKey: encrypted.encrypted, keyIv: encrypted.iv, keyTag: encrypted.tag });
  }
  return { uid, sid: session!.id, model, walletId: wallet!.id };
}

async function run(path: Path, f: Awaited<ReturnType<typeof fixture>>) {
  if (path === "manual") return compactStorySummaryForSessionManually({ sessionId: f.sid, userId: f.uid, contextTokenLimit: 8192, force: true });
  return compactStorySummaryForSession({ sessionId: f.sid, userId: f.uid, fallbackModel: f.model, contextTokenLimit: 8192,
    ...(path === "automatic" ? { finalPromptRawTokenLimit: 5000 } : { force: true }) });
}

async function assertNothingCommitted(f: Awaited<ReturnType<typeof fixture>>) {
  const [saved] = await db.select().from(playSessions).where(eq(playSessions.id, f.sid));
  assert.equal(saved!.summary, null);
  assert.equal(saved!.summaryCoversUntilMessageId, null);
  assert.ok((await db.select().from(messages).where(eq(messages.sessionId, f.sid))).every(row => !row.compacted));
  assert.equal((await db.select().from(creditTransactions).where(and(eq(creditTransactions.walletId, f.walletId), ne(creditTransactions.referenceId, "concurrent-spend")))).length, 0);
}

test("main story admission and atomic settlement remain compatible", async t => {
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.PGLITE_DATA_DIR, "memory://");
  const oldKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = "test-only-key-never-sent";
  // Deliberately costly prices prove the whole-run estimate, not only the
  // five-mushie flat minimum, prevents starting an unaffordable run.
  await db.insert(modelPrices).values({ modelId: officialModel, inputPricePerM: 100, outputPricePerM: 100 });
  await invalidateModelPriceCache();
  try {
    for (const path of paths) await t.test(`${path}: insufficient whole-run budget never calls the provider`, async st => {
      const f = await fixture(path, 5);
      try {
        const provider = st.mock.method(OpenRouterProvider.prototype, "generateStream", async function* (): AsyncIterable<StreamChunk> { throw new Error("unaffordable provider call"); });
        if (path === "automatic") assert.equal(await run(path, f), null);
        else await assert.rejects(run(path, f), /Not enough mushies/);
        assert.equal(provider.mock.callCount(), 0);
        await assertNothingCommitted(f);
        const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.userId, f.uid));
        assert.equal(Number(wallet!.balance), 5);
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    for (const path of paths) await t.test(`${path}: zero-wallet BYOK bypasses admission and saves historical evidence`, async st => {
      const f = await fixture(path, 0, true);
      try {
        const official = st.mock.method(OpenRouterProvider.prototype, "generateStream", async function* (): AsyncIterable<StreamChunk> { throw new Error("BYOK must not fall back to platform"); });
        const requests: string[] = [];
        st.mock.method(CustomProvider.prototype, "generateStream", async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
          const prompt = JSON.stringify(p.messages); requests.push(prompt);
          yield { type: "text", content: prompt.includes("canonical compressed story summary") ? story : episode };
          yield { type: "done", content: "", stopReason: "stop", usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 } };
        });
        await run(path, f);
        assert.ok(requests.length >= 2, "episode and merge must run");
        assert.ok(requests.some(prompt => prompt.includes("HISTORICAL_STATE")));
        assert.ok(requests.every(prompt => !prompt.includes("LIVE_STATE_MUST_NOT_LEAK")));
        assert.equal(official.mock.callCount(), 0);
        const [saved] = await db.select().from(playSessions).where(eq(playSessions.id, f.sid));
        assert.equal(saved!.summary, story);
        assert.ok(saved!.summaryCoversUntilMessageId);
        const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.userId, f.uid));
        assert.equal(Number(wallet!.balance) + Number(wallet!.addonBalance), 0);
        assert.equal((await db.select().from(creditTransactions).where(eq(creditTransactions.walletId, f.walletId))).length, 0);
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    for (const path of paths) await t.test(`${path}: wallet drained after admission rolls back summary, source flags and ledger`, async st => {
      const f = await fixture(path, 10000);
      try {
        let calls = 0;
        st.mock.method(OpenRouterProvider.prototype, "generateStream", async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
          calls++;
          const merge = JSON.stringify(p.messages).includes("canonical compressed story summary");
          if (merge) await deductCredits(f.uid, 10000, "concurrent-spend", "Concurrent unrelated generation");
          yield { type: "text", content: merge ? story : episode };
          yield { type: "done", content: "", stopReason: "stop", usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 } };
        });
        await assert.rejects(run(path, f), /Not enough mushies/);
        assert.ok(calls >= 2, "admission must succeed and reach settlement");
        await assertNothingCommitted(f);
        const [wallet] = await db.select().from(creditWallets).where(eq(creditWallets.userId, f.uid));
        assert.equal(Number(wallet!.balance) + Number(wallet!.addonBalance), 0);
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    await t.test("successful retry settles cached episode once and each accepted merge once", async st => {
      const f = await fixture("regenerate-small", 10000);
      try {
        let episodeCalls = 0, mergeCalls = 0;
        st.mock.method(OpenRouterProvider.prototype, "generateStream", async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
          const merge = JSON.stringify(p.messages).includes("canonical compressed story summary");
          if (merge && ++mergeCalls === 1) throw new Error("fixture merge failure");
          if (!merge) episodeCalls++;
          yield { type: "text", content: merge ? story : episode };
          yield { type: "done", content: "", stopReason: "stop", usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 } };
        });
        await assert.rejects(run("regenerate-small", f), /fixture merge failure/);
        await assertNothingCommitted(f);
        await run("regenerate-small", f);
        assert.equal(episodeCalls, 1, "retry must reuse the accepted episode checkpoint");
        const afterRetry = await db.select().from(creditTransactions).where(eq(creditTransactions.walletId, f.walletId));
        assert.equal(afterRetry.length, 2, "accepted cached episode and successful merge both settle");
        assert.ok(afterRetry.every(row => row.amount < 0));
        await run("regenerate-small", f);
        assert.equal(episodeCalls, 1, "subsequent regeneration still reuses the same episode");
        const afterAgain = await db.select().from(creditTransactions).where(eq(creditTransactions.walletId, f.walletId));
        assert.equal(afterAgain.length, 3, "only the newly accepted merge adds a charge");
        assert.equal(new Set(afterAgain.map(row => row.referenceId)).size, 3);
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    for (const split of [false, true]) await t.test(`retry admission includes pending usage from cached episodes, split=${split}`, async st => {
      const f = await fixture("regenerate-small", 10000);
      try {
        let calls = 0;
        st.mock.method(OpenRouterProvider.prototype, "generateStream", async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
          calls++;
          if (JSON.stringify(p.messages).includes("canonical compressed story summary")) throw new Error("fixture merge failure");
          yield { type: "text", content: episode };
          if (split && calls === 1) {
            yield { type: "done", content: "", stopReason: "max_tokens" };
            return;
          }
          // Actual accepted usage can exceed the up-front estimate. The retry
          // must budget this unpaid checkpoint rather than considering it free.
          yield { type: "done", content: "", stopReason: "stop", usage: { promptTokens: 100000, completionTokens: 100, totalTokens: 100100 } };
        });
        await assert.rejects(run("regenerate-small", f), /fixture merge failure/);
        assert.equal(calls, split ? 4 : 2);
        await assertNothingCommitted(f);
        await assert.rejects(run("regenerate-small", f), /Not enough mushies/);
        assert.equal(calls, split ? 4 : 2, "unaffordable retry must not call the provider again");
        await assertNothingCommitted(f);
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });
  } finally { env.YUMINA_OPENROUTER_KEY = oldKey; }
});
