import '../test/database-fixture.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { creditWallets, messages, modelPrices, playSessions, user, worlds } from '../db/schema.js';
import { env } from './env.js';
import { OpenRouterProvider } from './llm/openrouter.js';
import type { GenerateParams, StreamChunk } from './llm/types.js';
import { regenerateSessionMemoryForSession } from './session-memory.js';
import { compactStorySummaryForSessionManually } from './session-compaction.js';
import { compactSummaryceptionForSession } from './summaryception.js';
import { invalidateModelPriceCache } from './model-price-cache.js';

after(async () => { await (db as unknown as { $client: { close(): Promise<void> } }).$client.close(); });

const model = 'google/gemini-3.1-flash-lite';
const failedMarker = 'FAILED_SOURCE_CANARY';
const episode = JSON.stringify({ title: 'Cafe', summary: 'The visitor waited for tea.', endingOneLine: 'The visitor remains in the cafe.', majorEvents: ['The visitor waited.'], relationshipChanges: [], decisionsAndPromises: [], goalsAndOpenThreads: ['Have tea.'], worldStateAndInventory: [], risksAndConstraints: [], keywords: ['cafe'] });
const story = '## Story So Far\nThe visitor waits for tea.\n\n## Major Open Threads\n- Have tea.\n\n## Important Past Events\n- The visitor arrived at the cafe.';

test('session-memory completion policy does not block other summary systems when memory is off', async t => {
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.PGLITE_DATA_DIR, 'memory://');
  await db.insert(modelPrices).values({ modelId: model, inputPricePerM: 1, outputPricePerM: 2 }).onConflictDoNothing();
  await invalidateModelPriceCache();
  const oldKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = 'test-only-never-sent';
  try {
    for (const tier of ['story', 'layered', 'memory'] as const) await t.test(tier, async st => {
      const uid = randomUUID();
      await db.insert(user).values({ id: uid, name: 'Summary policy', email: `${uid}@example.test` });
      try {
        await db.insert(creditWallets).values({ userId: uid, balance: 200 });
        const [world] = await db.insert(worlds).values({ creatorId: uid, name: 'Cafe', schema: { id: randomUUID(), name: 'Cafe', entries: [], variables: [], rules: [], components: [], settings: {} } }).returning();
        const [session] = await db.insert(playSessions).values({
          userId: uid, worldId: world!.id, state: { variables: {}, metadata: {} },
          sessionMemoryIncluded: tier === 'memory', sessionMemoryModel: model,
          summaryModel: model, summaryceptionModel: model, summaryLanguage: 'en', summaryRecentTailTokens: 5000,
        }).returning();
        const rows = Array.from({ length: 9 }, (_, i) => ({
          id: randomUUID(), sessionId: session!.id, role: i % 2 ? 'user' as const : 'assistant' as const,
          content: i === 0 ? failedMarker : `Scene ${i}. The visitor waits while the barista prepares warm tea. `.repeat(120),
          status: i === 0 ? 'failed' as const : 'complete' as const,
          stateSnapshot: { variables: {}, metadata: {} }, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
        }));
        await db.insert(messages).values(rows);
        let calls = 0;
        let sourceIncludedFailed = false;
        st.mock.method(OpenRouterProvider.prototype, 'generateStream', async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
          calls++;
          const request = JSON.stringify(p.messages);
          sourceIncludedFailed ||= request.includes(failedMarker);
          yield { type: 'text', content: tier === 'memory' ? 'Core facts:\n- The visitor waits for tea.' : tier === 'layered' ? 'The visitor waits for tea.' : request.includes('canonical compressed story summary') ? story : episode };
          yield { type: 'done', content: '', stopReason: 'stop' };
        });
        if (tier === 'memory') {
          await regenerateSessionMemoryForSession({ sessionId: session!.id, userId: uid });
          assert.equal(sourceIncludedFailed, false, 'session memory must exclude the failed assistant');
          const [saved] = await db.select().from(playSessions).where(eq(playSessions.id, session!.id));
          assert.equal(saved!.sessionMemoryStatus, 'idle');
          assert.ok(saved!.sessionMemorySourceHash?.includes(':eligible-v1'));
          assert.equal(saved!.sessionMemoryProcessedMessageId, rows[6]!.id);
        } else {
          const args = { sessionId: session!.id, userId: uid, fallbackModel: model, contextTokenLimit: 8192, force: true };
          const result = tier === 'story' ? await compactStorySummaryForSessionManually(args) : await compactSummaryceptionForSession(args);
          assert.ok(result.compactedCount > 0, 'a retained failed row must not make the unrelated summary guard reject every attempt');
          assert.equal(sourceIncludedFailed, true, 'retain the existing story/layered source policy');
        }
        assert.ok(calls > 0);
      } finally { await db.delete(user).where(eq(user.id, uid)); }
    });
  } finally { env.YUMINA_OPENROUTER_KEY = oldKey; }
});
