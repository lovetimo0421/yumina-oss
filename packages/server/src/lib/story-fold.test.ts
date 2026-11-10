import "../test/database-fixture.js";
import assert from "node:assert/strict";
import { after, test, type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import { SESSION_MEMORY_EXTENSION_KEY } from "@yumina/shared";
import { db } from "../db/index.js";
import { creditWallets, messages, modelPrices, playSessions, user, worlds } from "../db/schema.js";
import { env } from "./env.js";
import { invalidateModelPriceCache } from "./model-price-cache.js";
import { OpenRouterProvider } from "./llm/openrouter.js";
import type { GenerateParams, StreamChunk } from "./llm/types.js";
import { compactStorySummaryForSession } from "./session-compaction.js";
import { runTurnComplete } from "./extension-hooks.js";
import { registerSessionMemoryExtension } from "../extensions/session-memory/hooks.js";

// A default story summary folds against the story memory: ahead of the
// overflow, so the cut and the new summary land on one prompt, and a first
// summary over a long backlog recaps only what a prompt could still carry.

const model = "google/gemini-3.1-flash-lite";
const episode = JSON.stringify({ title: "Cafe", summary: "The visitor waited.", endingOneLine: "Still waiting.", majorEvents: [], relationshipChanges: [], decisionsAndPromises: [], goalsAndOpenThreads: [], worldStateAndInventory: [], risksAndConstraints: [], keywords: [] });
const story = "## Story So Far\nThe visitor waited for tea.";
// ~2,000 tokens a message by the character heuristic.
const filler = "The visitor waits quietly while the barista warms the tea. ".repeat(136);
after(async () => { await (db as unknown as { $client: { close(): Promise<void> } }).$client.close(); });

async function fixture(count: number) {
  const uid = randomUUID();
  await db.insert(user).values({ id: uid, name: "Fold", email: `${uid}@example.test` });
  await db.insert(creditWallets).values({ userId: uid, balance: 100000, addonBalance: 0 });
  const [world] = await db.insert(worlds).values({ creatorId: uid, name: "Cafe", schema: { id: randomUUID(), name: "Cafe", entries: [], variables: [], rules: [], components: [], settings: {} } }).returning();
  const [session] = await db.insert(playSessions).values({ userId: uid, worldId: world!.id, state: { variables: {}, metadata: {} }, summaryModel: model, summaryLanguage: "en" }).returning();
  await db.insert(messages).values(Array.from({ length: count }, (_, i) => ({
    id: randomUUID(), sessionId: session!.id, role: i % 2 ? "user" as const : "assistant" as const,
    content: `<<m${String(i).padStart(2, "0")}>> ${filler}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
  })));
  return { uid, sid: session!.id };
}

async function compactedMarks(sid: string): Promise<boolean[]> {
  const rows = await db.select({ compacted: messages.compacted }).from(messages).where(eq(messages.sessionId, sid)).orderBy(asc(messages.createdAt));
  return rows.map(row => row.compacted);
}

function mockProvider(t: TestContext) {
  const episodes: string[] = [];
  const provider = t.mock.method(OpenRouterProvider.prototype, "generateStream", async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
    const prompt = JSON.stringify(p.messages);
    const merge = prompt.includes("canonical compressed story summary");
    if (!merge) episodes.push(prompt);
    yield { type: "text", content: merge ? story : episode };
    yield { type: "done", content: "", stopReason: "stop", usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 } };
  });
  return { provider, episodes };
}

test("default story summary folds ahead of the overflow and recaps only the carried backlog", async t => {
  assert.equal(env.DATABASE_URL, undefined);
  const oldKey = env.YUMINA_OPENROUTER_KEY;
  const oldDefault = env.STORY_SUMMARY_DEFAULT_ON;
  env.YUMINA_OPENROUTER_KEY = "test-only-key-never-sent";
  await db.insert(modelPrices).values({ modelId: model, inputPricePerM: 0.1, outputPricePerM: 0.4 }).onConflictDoNothing();
  await invalidateModelPriceCache();
  try {
    await t.test("folds once the history passes the fold point, keeping the tail", async st => {
      const f = await fixture(10); // ~20k tokens
      const { episodes } = mockProvider(st);
      await compactStorySummaryForSession({ sessionId: f.sid, userId: f.uid, fallbackModel: model, contextTokenLimit: 64000, finalPromptRawTokenLimit: 9000, foldAtTokens: 16000 });
      const marks = await compactedMarks(f.sid);
      assert.deepEqual(marks, [true, true, true, true, true, false, false, false, false, false]);
      assert.ok(episodes.some(p => p.includes("<<m00>>")));
      const [saved] = await db.select().from(playSessions).where(eq(playSessions.id, f.sid));
      assert.equal(saved!.summary, story);
    });

    await t.test("does nothing below the fold point", async st => {
      const f = await fixture(10);
      const { provider } = mockProvider(st);
      await compactStorySummaryForSession({ sessionId: f.sid, userId: f.uid, fallbackModel: model, contextTokenLimit: 64000, finalPromptRawTokenLimit: 9000, foldAtTokens: 21000 });
      assert.equal(provider.mock.callCount(), 0);
      assert.ok((await compactedMarks(f.sid)).every(mark => !mark));
    });

    await t.test("a first summary recaps only the newest carried tokens; the older backlog folds unsummarised", async st => {
      const f = await fixture(20); // ~40k tokens
      const { episodes } = mockProvider(st);
      await compactStorySummaryForSession({ sessionId: f.sid, userId: f.uid, fallbackModel: model, contextTokenLimit: 64000, finalPromptRawTokenLimit: 6000, recapWithinTokens: 16500 });
      const marks = await compactedMarks(f.sid);
      assert.deepEqual(marks.slice(0, 17), Array(17).fill(true));
      assert.deepEqual(marks.slice(17), [false, false, false]);
      const sent = episodes.join("\n");
      for (const seen of ["<<m12>>", "<<m16>>"]) assert.ok(sent.includes(seen), `${seen} is recapped`);
      for (const unseen of ["<<m00>>", "<<m11>>"]) assert.ok(!sent.includes(unseen), `${unseen} is not recapped`);
    });

    await t.test("an existing summary is continued from where it left off, never skipped past", async st => {
      const f = await fixture(20);
      const [first] = await db.select({ id: messages.id }).from(messages).where(eq(messages.sessionId, f.sid)).orderBy(asc(messages.createdAt)).limit(1);
      await db.update(messages).set({ compacted: true }).where(eq(messages.id, first!.id));
      await db.update(playSessions).set({ summary: "## Story So Far\nEarlier.", summaryCoversUntilMessageId: first!.id }).where(eq(playSessions.id, f.sid));
      const { episodes } = mockProvider(st);
      await compactStorySummaryForSession({ sessionId: f.sid, userId: f.uid, fallbackModel: model, contextTokenLimit: 64000, finalPromptRawTokenLimit: 6000, recapWithinTokens: 16500 });
      assert.ok(episodes.some(p => p.includes("<<m01>>")), "the recap continues right after the old summary");
      assert.deepEqual((await compactedMarks(f.sid)).slice(17), [false, false, false]);
    });

    await t.test("turn completion folds a default summary only when the next turn would overflow", async st => {
      env.STORY_SUMMARY_DEFAULT_ON = true;
      registerSessionMemoryExtension();
      const { provider } = mockProvider(st);
      const dispatch = {
        activeExtensions: new Map([[SESSION_MEMORY_EXTENSION_KEY, new Set(["story-summary"]) as ReadonlySet<string>]]),
        defaultActivated: new Set([SESSION_MEMORY_EXTENSION_KEY]),
      };
      const complete = (sid: string, uid: string, tokens: number) => runTurnComplete(dispatch, {
        ownerUserId: uid, sessionId: sid, userId: uid, userMessage: "hi", assistantMessage: "Short reply.", state: {},
        fallbackModel: model, assistantMessageId: randomUUID(), contextTokenLimit: 64000, rawHistory: { budget: 18000, tokens },
      });

      const far = await fixture(10);
      complete(far.sid, far.uid, 12000);
      await new Promise(resolve => setTimeout(resolve, 300));
      assert.equal(provider.mock.callCount(), 0, "far from the budget: no fold");

      const near = await fixture(10);
      complete(near.sid, near.uid, 16500);
      for (let i = 0; i < 100 && !(await compactedMarks(near.sid)).some(Boolean); i++) await new Promise(resolve => setTimeout(resolve, 50));
      const marks = await compactedMarks(near.sid);
      assert.deepEqual(marks, [true, true, true, true, true, false, false, false, false, false], "folds down to half the budget");
    });
  } finally {
    env.YUMINA_OPENROUTER_KEY = oldKey;
    env.STORY_SUMMARY_DEFAULT_ON = oldDefault;
  }
});
