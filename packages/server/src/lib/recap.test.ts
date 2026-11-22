// The recap (layered summary) as the one recap every player can choose:
// carrying an old rolling summary over, revising only an edited chapter,
// trimming only rewound chapters, and asking before a long backfill.
// No network requests or production database access.
import '../test/database-fixture.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { RECAP_ALL_THINKING_ERROR, SESSION_MEMORY_EXTENSION_KEY } from '@yumina/shared';
import { db } from '../db/index.js';
import { apiKeys, creditWallets, messages, modelPrices, playSessions, summaryceptionSnippets, user, userExtensions, worlds } from '../db/schema.js';
import { encryptApiKey } from './crypto.js';
import { CustomProvider } from './llm/custom.js';
import { env } from './env.js';
import { OpenRouterProvider } from './llm/openrouter.js';
import type { GenerateParams, StreamChunk } from './llm/types.js';
import { invalidateModelPriceCache } from './model-price-cache.js';
import { estimateMessagesTokens } from './session-compaction-core.js';
import {
  autoBackfillLimitTokens,
  compactSummaryceptionForSession,
  deleteSummaryceptionSnippet,
  estimateRecapFold,
  getSummaryceptionStats,
  loadRecapPromptBlock,
  markRecapChangedMessage,
  countSetAsideMessages,
  fillSetAsideRecap,
  stopRecapRun,
  trimRecapAfterRewind,
} from './summaryception.js';
import { __setInstalledLookupForTests, __setUninstalledLookupForTests, resolveTurnHooks } from './extension-hooks.js';
import { registerSessionMemoryExtension } from '../extensions/session-memory/hooks.js';

const model = 'google/gemini-3.1-flash-lite';
after(async () => { await (db as unknown as { $client: { close(): Promise<void> } }).$client.close(); });

async function fixture(count: number, content = (i: number) => `Scene ${i}. The visitor waits for tea.`) {
  const uid = randomUUID();
  await db.insert(user).values({ id: uid, name: 'Recap', email: `${uid}@example.test` });
  await db.insert(creditWallets).values({ userId: uid, balance: 100, addonBalance: 100 });
  const [world] = await db.insert(worlds).values({ creatorId: uid, name: 'Recap room', schema: { id: randomUUID(), name: 'Recap room', entries: [], variables: [], rules: [], components: [], settings: {} } }).returning();
  const [session] = await db.insert(playSessions).values({ userId: uid, worldId: world!.id, state: { variables: {}, metadata: {} }, summaryModel: model, summaryceptionModel: model, summaryLanguage: 'en' }).returning();
  const rows = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(), sessionId: session!.id, role: i % 2 ? 'user' as const : 'assistant' as const,
    content: content(i), stateSnapshot: { variables: {}, metadata: {} }, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, i)),
  }));
  await db.insert(messages).values(rows);
  return { uid, sid: session!.id, rows };
}

async function chapters(sid: string) {
  return (await db.select().from(summaryceptionSnippets).where(eq(summaryceptionSnippets.sessionId, sid)))
    .sort((a, b) => a.layerIndex !== b.layerIndex ? b.layerIndex - a.layerIndex : a.snippetOrder - b.snippetOrder);
}

test('recap', async (t) => {
  assert.equal(env.DATABASE_URL, undefined);
  await db.insert(modelPrices).values({ modelId: model, inputPricePerM: 1, outputPricePerM: 2 }).onConflictDoNothing();
  await invalidateModelPriceCache();
  const oldKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = 'test-only-never-sent-key';
  try {
    await t.test('an old rolling summary becomes the first chapter, once', async () => {
      const f = await fixture(6);
      try {
        await db.update(playSessions).set({ summary: '## Story So Far\nThe visitor arrived at the cafe.', summaryCoversUntilMessageId: f.rows[3]!.id }).where(eq(playSessions.id, f.sid));
        const [session] = await db.select().from(playSessions).where(eq(playSessions.id, f.sid));
        const block = await loadRecapPromptBlock(f.sid, session!);
        assert.ok(block.content?.includes('The visitor arrived at the cafe.'));
        await loadRecapPromptBlock(f.sid, session!);
        const saved = await chapters(f.sid);
        assert.equal(saved.length, 1, 'carried over once');
        assert.equal(saved[0]!.layerIndex, 4);
        assert.equal(saved[0]!.sourceEndMessageId, f.rows[3]!.id);
        const folded = (await db.select().from(messages).where(eq(messages.sessionId, f.sid))).filter((m) => m.summaryceptionCompacted).map((m) => m.id);
        assert.deepEqual(new Set(folded), new Set(f.rows.slice(0, 4).map((r) => r.id)), 'the messages it covered count as folded');
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    await t.test('editing a folded message revises only the chapter that covers it', async (st) => {
      const f = await fixture(6);
      try {
        await db.update(messages).set({ summaryceptionCompacted: true }).where(eq(messages.sessionId, f.sid));
        await db.insert(summaryceptionSnippets).values([
          { sessionId: f.sid, layerIndex: 1, snippetOrder: 0, sourceStartMessageId: f.rows[0]!.id, sourceEndMessageId: f.rows[1]!.id, text: 'Chapter one.', mergedCount: 3 },
          { sessionId: f.sid, layerIndex: 0, snippetOrder: 0, sourceStartMessageId: f.rows[2]!.id, sourceEndMessageId: f.rows[3]!.id, text: 'Chapter two: the visitor ordered coffee.' },
          { sessionId: f.sid, layerIndex: 0, snippetOrder: 1, sourceStartMessageId: f.rows[4]!.id, sourceEndMessageId: f.rows[5]!.id, text: 'Chapter three.' },
        ]);
        await db.update(messages).set({ content: 'The visitor ordered green tea, not coffee.' }).where(eq(messages.id, f.rows[3]!.id));
        await markRecapChangedMessage(f.sid, { id: f.rows[3]!.id, createdAt: f.rows[3]!.createdAt, deleted: false });
        const marked = await chapters(f.sid);
        assert.deepEqual(marked.map((c) => c.sourceHash?.startsWith('stale:') ?? false), [false, true, false], 'only the covering chapter waits');

        const prompts: string[] = [];
        st.mock.method(OpenRouterProvider.prototype, 'generateStream', async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
          prompts.push(JSON.stringify(p.messages));
          yield { type: 'text', content: 'Chapter two: the visitor ordered green tea.' };
          yield { type: 'done', content: '', stopReason: 'stop' };
        });
        await compactSummaryceptionForSession({ sessionId: f.sid, userId: f.uid, fallbackModel: model, finalPromptRawTokenLimit: Number.MAX_SAFE_INTEGER });
        assert.equal(prompts.length, 1, 'one call');
        assert.ok(prompts[0]!.includes('green tea') && prompts[0]!.includes('Chapter one.'), 'redone from its messages, after the earlier chapters');
        const revised = await chapters(f.sid);
        assert.deepEqual(revised.map((c) => c.text), ['Chapter one.', 'Chapter two: the visitor ordered green tea.', 'Chapter three.']);
        assert.ok(revised.every((c) => !c.sourceHash?.startsWith('stale:')));
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    await t.test('a refused recap call retries once on the tolerant model', async (st) => {
      const f = await fixture(6);
      try {
        await db.insert(modelPrices).values({ modelId: 'deepseek/deepseek-v3.2', inputPricePerM: 1, outputPricePerM: 2 }).onConflictDoNothing();
        await invalidateModelPriceCache();
        await db.update(messages).set({ summaryceptionCompacted: true }).where(eq(messages.sessionId, f.sid));
        await db.insert(summaryceptionSnippets).values([
          { sessionId: f.sid, layerIndex: 0, snippetOrder: 0, sourceStartMessageId: f.rows[0]!.id, sourceEndMessageId: f.rows[5]!.id, text: 'Old chapter.', sourceHash: 'stale:edited' },
        ]);
        const calls: Array<{ model: string; ignore?: readonly string[] }> = [];
        st.mock.method(OpenRouterProvider.prototype, 'generateStream', async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
          calls.push({ model: p.model, ignore: p.ignoreProviders });
          if (p.model === model) {
            yield { type: 'error', content: 'OpenRouter error (403): Gemini blocked the request: PROHIBITED_CONTENT' };
            return;
          }
          yield { type: 'text', content: 'The visitor waits for tea, still.' };
          yield { type: 'done', content: '', stopReason: 'stop' };
        });
        await compactSummaryceptionForSession({ sessionId: f.sid, userId: f.uid, fallbackModel: model, finalPromptRawTokenLimit: Number.MAX_SAFE_INTEGER });
        assert.deepEqual(calls.map((c) => c.model), [model, 'deepseek/deepseek-v3.2']);
        assert.deepEqual(calls[1]!.ignore, ['gmicloud']);
        assert.deepEqual((await chapters(f.sid)).map((c) => c.text), ['The visitor waits for tea, still.']);
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    await t.test('deleting a chapter edge moves the edge; a chapter left empty goes', async () => {
      const f = await fixture(4);
      try {
        await db.insert(summaryceptionSnippets).values([
          { sessionId: f.sid, layerIndex: 0, snippetOrder: 0, sourceStartMessageId: f.rows[0]!.id, sourceEndMessageId: f.rows[0]!.id, text: 'Only the first message.' },
          { sessionId: f.sid, layerIndex: 0, snippetOrder: 1, sourceStartMessageId: f.rows[1]!.id, sourceEndMessageId: f.rows[3]!.id, text: 'Messages two to four.' },
        ]);
        await db.delete(messages).where(eq(messages.id, f.rows[3]!.id));
        await markRecapChangedMessage(f.sid, { id: f.rows[3]!.id, createdAt: f.rows[3]!.createdAt, deleted: true });
        await db.delete(messages).where(eq(messages.id, f.rows[0]!.id));
        await markRecapChangedMessage(f.sid, { id: f.rows[0]!.id, createdAt: f.rows[0]!.createdAt, deleted: true });
        const saved = await chapters(f.sid);
        assert.equal(saved.length, 1);
        assert.equal(saved[0]!.sourceStartMessageId, f.rows[1]!.id);
        assert.equal(saved[0]!.sourceEndMessageId, f.rows[2]!.id);
        assert.ok(saved[0]!.sourceHash?.startsWith('stale:'));
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    await t.test('a rewind drops only the chapters that covered deleted messages', async () => {
      const f = await fixture(6);
      try {
        await db.update(messages).set({ summaryceptionCompacted: true }).where(eq(messages.sessionId, f.sid));
        await db.insert(summaryceptionSnippets).values([
          { sessionId: f.sid, layerIndex: 0, snippetOrder: 0, sourceStartMessageId: f.rows[0]!.id, sourceEndMessageId: f.rows[2]!.id, text: 'Kept.' },
          { sessionId: f.sid, layerIndex: 0, snippetOrder: 1, sourceStartMessageId: f.rows[3]!.id, sourceEndMessageId: f.rows[5]!.id, text: 'Covers the rewound tail.' },
        ]);
        for (const row of f.rows.slice(4)) await db.delete(messages).where(eq(messages.id, row.id));
        await trimRecapAfterRewind(f.sid);
        const saved = await chapters(f.sid);
        assert.deepEqual(saved.map((c) => c.text), ['Kept.']);
        const left = await db.select().from(messages).where(eq(messages.sessionId, f.sid));
        assert.equal(left.find((m) => m.id === f.rows[3]!.id)!.summaryceptionCompacted, false, 'its surviving message returns to the raw history');
        assert.equal(left.find((m) => m.id === f.rows[2]!.id)!.summaryceptionCompacted, true);
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    await t.test('a long backlog starts the recap from its recent part for free; filling the set-aside part keeps the chapters and fits the budget', async (st) => {
      const f = await fixture(40, (i) => `Scene ${i}. ` + 'The visitor waits for tea while the rain goes on. '.repeat(60));
      try {
        let calls = 0;
        const passages: string[] = [];
        st.mock.method(OpenRouterProvider.prototype, 'generateStream', async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
          calls++;
          passages.push(JSON.stringify(p.messages));
          yield { type: 'text', content: `Chapter ${calls}: the visitor waited through the rain for tea.` };
          yield { type: 'done', content: '', stopReason: 'stop' };
        });
        const args = { sessionId: f.sid, userId: f.uid, fallbackModel: model, finalPromptRawTokenLimit: 2_000, foldAll: true, storyMemoryTokens: 2_048 };
        // Larger than the 24k tokens folded unasked: the oldest part is set aside.
        const auto = await compactSummaryceptionForSession(args);
        assert.ok(auto.compactedCount > 0, 'the recent part is folded');
        assert.ok(!passages.some((text) => text.includes('Scene 0.')), 'the oldest scenes are not paid for');
        const flagged = (await db.select().from(messages).where(eq(messages.sessionId, f.sid))).filter((m) => m.summaryceptionCompacted);
        const covered = new Set((await chapters(f.sid)).flatMap((c) => [c.sourceStartMessageId]));
        assert.ok(flagged.some((m) => m.id === f.rows[0]!.id), 'the first message is set aside');
        assert.ok(!covered.has(f.rows[0]!.id), 'with no chapter');
        const autoCalls = calls;

        // Filling the set-aside part keeps the chapters already written and
        // reads only what was set aside.
        const written = await chapters(f.sid);
        const autoScenes = f.rows.map((r, i) => auto.compactedMessageIds.includes(r.id) ? `Scene ${i}. ` : null).filter((s): s is string => !!s);
        calls = 0;
        passages.length = 0;
        await fillSetAsideRecap({ ...args, recapBudgetTokens: 100_000 });
        assert.ok(autoCalls > 0 && calls > 0, 'the set-aside part is folded');
        assert.ok(passages.some((text) => text.includes('Scene 0.')), 'from the first message');
        assert.ok(!passages.some((text) => autoScenes.some((scene) => text.includes(scene))), 'what was folded is not read again');
        let saved = await chapters(f.sid);
        assert.ok(written.every((w) => saved.some((c) => c.id === w.id)), 'the chapters already written stay');
        assert.equal(saved[0]!.sourceStartMessageId, f.rows[0]!.id, 'the new chapters come first, in story order');
        assert.equal(saved.at(-1)!.id, written.at(-1)!.id);
        assert.equal(await countSetAsideMessages(f.sid), 0, 'nothing is set aside any more');
        const notFolded = (await db.select().from(messages).where(eq(messages.sessionId, f.sid))).filter((m) => !m.summaryceptionCompacted);
        assert.ok(notFolded.length > 0 && notFolded.length < 40, 'the recent tail stays word for word');

        // A second click finds nothing set aside: no new calls, nothing changed.
        calls = 0;
        const chaptersBefore = (await chapters(f.sid)).map((c) => c.id);
        await fillSetAsideRecap({ ...args, recapBudgetTokens: 100_000 });
        assert.equal(calls, 0);
        assert.deepEqual((await chapters(f.sid)).map((c) => c.id), chaptersBefore);

        // A small budget merges them down.
        await fillSetAsideRecap({ ...args, recapBudgetTokens: 60 });
        saved = await chapters(f.sid);
        assert.ok(saved.length < chaptersBefore.length, 'merged to fit the budget');
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    await t.test('the stop button ends a fill after its current call and keeps what it wrote', async (st) => {
      const f = await fixture(40, (i) => `Scene ${i}. ` + 'The visitor waits for tea while the rain goes on. '.repeat(60));
      try {
        let calls = 0;
        let stopping = false;
        st.mock.method(OpenRouterProvider.prototype, 'generateStream', async function* (): AsyncIterable<StreamChunk> {
          calls++;
          // The player presses stop while the second fill call is out.
          if (stopping && calls === 2) await stopRecapRun(f.sid, f.uid);
          yield { type: 'text', content: `Chapter ${calls}: the visitor waited through the rain for tea.` };
          yield { type: 'done', content: '', stopReason: 'stop' };
        });
        const args = { sessionId: f.sid, userId: f.uid, fallbackModel: model, finalPromptRawTokenLimit: 2_000, foldAll: true, storyMemoryTokens: 2_048 };
        await compactSummaryceptionForSession(args);
        const setAside = await countSetAsideMessages(f.sid);
        assert.ok(setAside > 0, 'part of the story is set aside');
        calls = 0;
        stopping = true;
        await fillSetAsideRecap({ ...args, recapBudgetTokens: 100_000 }).catch(() => {});
        assert.equal(calls, 2, 'no call after the stop');
        const left = await countSetAsideMessages(f.sid);
        assert.ok(left > 0 && left < setAside, 'the first chapter stays, the rest is still set aside');
        const [row] = await db.select().from(playSessions).where(eq(playSessions.id, f.sid));
        assert.equal(row!.summaryceptionStatus, 'idle');

        // 补上 again later picks up where it stopped.
        stopping = false;
        calls = 0;
        await fillSetAsideRecap({ ...args, recapBudgetTokens: 100_000 });
        assert.ok(calls > 0);
        assert.equal(await countSetAsideMessages(f.sid), 0);
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    await t.test('chapters with set-aside history between them do not merge across it', async (st) => {
      const f = await fixture(12);
      try {
        st.mock.method(OpenRouterProvider.prototype, 'generateStream', async function* (): AsyncIterable<StreamChunk> {
          yield { type: 'text', content: 'Merged: the visitor waited for tea.' };
          yield { type: 'done', content: '', stopReason: 'stop' };
        });
        await db.update(messages).set({ summaryceptionCompacted: true }).where(eq(messages.sessionId, f.sid));
        // Chapters for 1-2 and 9-10 in the top layer, 11-12 below; 3-8 set aside.
        const r = f.rows;
        await db.insert(summaryceptionSnippets).values([
          { sessionId: f.sid, layerIndex: 4, snippetOrder: 0, sourceStartMessageId: r[0]!.id, sourceEndMessageId: r[1]!.id, text: 'Opening. '.repeat(40), sourceHash: 'a' },
          { sessionId: f.sid, layerIndex: 4, snippetOrder: 1, sourceStartMessageId: r[8]!.id, sourceEndMessageId: r[9]!.id, text: 'Later. '.repeat(40), sourceHash: 'b' },
          { sessionId: f.sid, layerIndex: 4, snippetOrder: 2, sourceStartMessageId: r[10]!.id, sourceEndMessageId: r[11]!.id, text: 'Latest. '.repeat(40), sourceHash: 'c' },
        ]);
        assert.equal(await countSetAsideMessages(f.sid), 6);
        await compactSummaryceptionForSession({ sessionId: f.sid, userId: f.uid, fallbackModel: model, recapBudgetTokens: 30 });
        assert.equal(await countSetAsideMessages(f.sid), 6, 'still set aside, still offered');
        const saved = await chapters(f.sid);
        assert.equal(saved[0]!.sourceEndMessageId, r[1]!.id, 'the chapter before the gap is untouched');
        assert.equal(saved.length, 2, 'the two after it merged');
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    await t.test('chapters are numbered by their place in the whole story', async () => {
      const f = await fixture(8);
      try {
        await db.update(messages).set({ summaryceptionCompacted: true }).where(eq(messages.sessionId, f.sid));
        // Written by the old numbering, which counted only unfolded messages.
        await db.insert(summaryceptionSnippets).values([
          { sessionId: f.sid, layerIndex: 0, snippetOrder: 0, sourceStartMessageId: f.rows[0]!.id, sourceEndMessageId: f.rows[2]!.id, sourceStartOrdinal: 1, sourceEndOrdinal: 3, text: 'One.' },
          { sessionId: f.sid, layerIndex: 0, snippetOrder: 1, sourceStartMessageId: f.rows[3]!.id, sourceEndMessageId: f.rows[4]!.id, sourceStartOrdinal: 1, sourceEndOrdinal: 2, text: 'Two.' },
        ]);
        const [session] = await db.select().from(playSessions).where(eq(playSessions.id, f.sid));
        const stats = await getSummaryceptionStats(session!);
        const shown = stats.layers.flatMap((layer) => layer.snippets).map((s) => [s.sourceStartOrdinal, s.sourceEndOrdinal]);
        assert.deepEqual(shown, [[1, 3], [4, 5]]);
        assert.equal(stats.coversUntilOrdinal, 5);
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    await t.test('folding the oldest N: ends on a reply, keeps the newest reply, every chapter ends on a reply; deleting the newest undoes it', async (st) => {
      // Row 0 is the AI, then player and AI take turns; two messages fill a chunk.
      const f = await fixture(10, (i) => `Scene ${i}. ` + 'The visitor waits for tea while the rain goes on. '.repeat(110));
      try {
        let calls = 0;
        st.mock.method(OpenRouterProvider.prototype, 'generateStream', async function* (): AsyncIterable<StreamChunk> {
          calls++;
          yield { type: 'text', content: `Chapter ${calls}.` };
          yield { type: 'done', content: '', stopReason: 'stop' };
        });
        const estimate = await estimateRecapFold({ sessionId: f.sid, userId: f.uid, count: 4 });
        assert.equal(estimate.available, 8, 'the newest reply and what follows it stay');
        assert.equal(estimate.messages, 5, 'four ends on a player message, so the reply after it comes too');
        assert.equal(estimate.throughMessageId, f.rows[4]!.id);
        assert.equal(estimate.throughOrdinal, 5);
        assert.ok(estimate.estimatedCredits != null && estimate.estimatedCredits > 0);

        await compactSummaryceptionForSession({ sessionId: f.sid, userId: f.uid, fallbackModel: model, force: true, foldThroughMessageId: estimate.throughMessageId });
        const saved = await chapters(f.sid);
        const roleOf = new Map<string, string>(f.rows.map((r) => [r.id, r.role]));
        assert.ok(saved.length >= 2, 'more than one chapter in one fold');
        assert.ok(saved.every((c) => roleOf.get(c.sourceEndMessageId!) === 'assistant'), 'each chapter ends on a reply');
        const folded = (await db.select().from(messages).where(eq(messages.sessionId, f.sid))).filter((m) => m.summaryceptionCompacted).map((m) => m.id);
        assert.deepEqual(new Set(folded), new Set(f.rows.slice(0, 5).map((r) => r.id)));

        // An older chapter is only forgotten: its messages stay out of the prompt.
        const forget = await deleteSummaryceptionSnippet({ sessionId: f.sid, userId: f.uid, snippetId: saved[0]!.id });
        assert.equal(forget.restoredMessages, 0, 'an older chapter is only forgotten');
        const [first] = await db.select().from(messages).where(eq(messages.id, f.rows[0]!.id));
        assert.equal(first!.summaryceptionCompacted, true);

        // The newest goes back to word for word, like undoing that fold.
        const newest = saved.at(-1)!;
        const undo = await deleteSummaryceptionSnippet({ sessionId: f.sid, userId: f.uid, snippetId: newest.id });
        assert.ok(undo.restoredMessages > 0);
        const back = (await db.select().from(messages).where(eq(messages.sessionId, f.sid))).filter((m) => !m.summaryceptionCompacted).map((m) => m.id);
        assert.ok(back.includes(newest.sourceStartMessageId!) && back.includes(f.rows[4]!.id), 'its messages are word for word again');
        assert.ok(!back.includes(f.rows[0]!.id));
        assert.equal((await chapters(f.sid)).length, saved.length - 2);
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    // The player's own API: thinking cannot be switched off there.
    async function ownApi(f: { uid: string; sid: string }) {
      const keyId = randomUUID();
      const encrypted = encryptApiKey('test-only-never-sent-private-key');
      await db.insert(apiKeys).values({ id: keyId, userId: f.uid, provider: 'custom', baseUrl: 'https://recap-own-api.example/v1', encryptedKey: encrypted.encrypted, keyIv: encrypted.iv, keyTag: encrypted.tag });
      await db.update(user).set({ preferences: { preferredProvider: 'private', activeApiKeyId: keyId } }).where(eq(user.id, f.uid));
      await db.insert(userExtensions).values({ userId: f.uid, extensionKey: SESSION_MEMORY_EXTENSION_KEY, status: 'installed' });
      await db.update(playSessions).set({ summaryceptionModel: 'custom/thinker', summaryModel: 'custom/thinker' }).where(eq(playSessions.id, f.sid));
    }
    const long = (i: number) => `Scene ${i}. ` + 'The visitor waits for tea while the rain goes on. '.repeat(40);

    await t.test('on the player\'s own API a thinking model gets room to think, one attempt, and a clear error when it writes nothing', async (st) => {
      const f = await fixture(12, long);
      try {
        await ownApi(f);
        const calls: GenerateParams[] = [];
        // The single request under the provider's retry wrapper, so its
        // empty-reply retries are exercised for real.
        st.mock.method(CustomProvider.prototype as any, 'streamOnce', async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
          calls.push(p);
          yield { type: 'reasoning', content: 'Let me think about the passage at length...' };
          yield { type: 'done', content: '', stopReason: 'max_tokens', usage: { promptTokens: 900, completionTokens: p.maxTokens ?? 0, totalTokens: 900 + (p.maxTokens ?? 0) } };
        });
        await assert.rejects(
          compactSummaryceptionForSession({ sessionId: f.sid, userId: f.uid, fallbackModel: model, force: true, foldThroughMessageId: f.rows[7]!.id }),
          (err: Error) => err.message === RECAP_ALL_THINKING_ERROR,
        );
        assert.equal(calls.length, 1, 'no empty-reply retries on the player\'s key');
        assert.equal(calls[0]!.model, 'custom/thinker');
        assert.equal(calls[0]!.maxTokens, 4_000, 'room to think before the chapter');
        const [session] = await db.select().from(playSessions).where(eq(playSessions.id, f.sid));
        assert.equal(session!.summaryceptionError, RECAP_ALL_THINKING_ERROR, 'the panel can say what to do');
        assert.equal((await chapters(f.sid)).length, 0);
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    await t.test('on the player\'s own API a model that thinks and then writes keeps its chapter', async (st) => {
      const f = await fixture(12, long);
      try {
        await ownApi(f);
        const calls: GenerateParams[] = [];
        st.mock.method(CustomProvider.prototype as any, 'streamOnce', async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
          calls.push(p);
          yield { type: 'reasoning', content: 'Thinking it over first.' };
          yield { type: 'text', content: 'The visitor waited out the rain for tea.' };
          yield { type: 'done', content: '', stopReason: 'stop', usage: { promptTokens: 900, completionTokens: 900, totalTokens: 1800 } };
        });
        const result = await compactSummaryceptionForSession({ sessionId: f.sid, userId: f.uid, fallbackModel: model, force: true, foldThroughMessageId: f.rows[7]!.id });
        assert.ok(result.compactedCount > 0);
        assert.ok(calls.length >= 1 && calls.every((c) => c.maxTokens === 4_000 && c.singleAttempt === true));
        const saved = await chapters(f.sid);
        assert.equal(saved.length, calls.length, 'one chapter per call, no retries');
        assert.ok(saved.every((c) => c.text === 'The visitor waited out the rain for tea.'));
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    await t.test('on our own key a call has room for its chapter and the usual retries', async (st) => {
      const f = await fixture(12, long);
      try {
        const calls: GenerateParams[] = [];
        st.mock.method(OpenRouterProvider.prototype, 'generateStream', async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
          calls.push(p);
          yield { type: 'text', content: 'The visitor waited out the rain for tea.' };
          yield { type: 'done', content: '', stopReason: 'stop' };
        });
        await compactSummaryceptionForSession({ sessionId: f.sid, userId: f.uid, fallbackModel: model, force: true, foldThroughMessageId: f.rows[7]!.id });
        assert.ok(calls.length >= 1);
        assert.ok(calls.every((c) => c.maxTokens === 700 && !c.singleAttempt));
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    // 2026-11-08: one player's own relay took 64 recap calls in 43 minutes,
    // 27 of them after a send that failed; another's backfill read the whole
    // recap on each of 631 calls.
    const automaticRun = (f: { uid: string; sid: string }) => compactSummaryceptionForSession({
      sessionId: f.sid, userId: f.uid, fallbackModel: model, finalPromptRawTokenLimit: 1_000, foldAll: true, backfillApproved: true, automatic: true,
    });

    await t.test('an automatic run makes at most 4 calls on our key; the next run goes on from there', async (st) => {
      const f = await fixture(60, long);
      try {
        const calls: GenerateParams[] = [];
        st.mock.method(OpenRouterProvider.prototype, 'generateStream', async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
          calls.push(p);
          yield { type: 'text', content: `Chapter ${calls.length}.` };
          yield { type: 'done', content: '', stopReason: 'stop' };
        });
        await automaticRun(f);
        assert.equal(calls.length, 4);
        assert.equal((await chapters(f.sid)).length, 4);
        await automaticRun(f);
        assert.equal(calls.length, 8);
        const saved = await chapters(f.sid);
        assert.deepEqual(saved.map((c) => c.text), ['Chapter 1.', 'Chapter 2.', 'Chapter 3.', 'Chapter 4.', 'Chapter 5.', 'Chapter 6.', 'Chapter 7.', 'Chapter 8.']);
        for (let i = 1; i < saved.length; i++) assert.equal(saved[i]!.sourceStartOrdinal, saved[i - 1]!.sourceEndOrdinal! + 1, 'in story order, nothing skipped');
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    await t.test('on the player\'s own API an automatic run makes at most 2 calls, on longer passages', async (st) => {
      const f = await fixture(40, long);
      try {
        await ownApi(f);
        const calls: GenerateParams[] = [];
        st.mock.method(CustomProvider.prototype as any, 'streamOnce', async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
          calls.push(p);
          yield { type: 'text', content: Array.from({ length: 120 }, (_, i) => `Fact ${i}: the visitor moved room ${i}.`).join(' ') };
          yield { type: 'done', content: '', stopReason: 'stop', usage: { promptTokens: 900, completionTokens: 900, totalTokens: 1800 } };
        });
        await automaticRun(f);
        assert.equal(calls.length, 2);
        const saved = await chapters(f.sid);
        assert.equal(saved.length, 2, 'a long chapter is kept, not redone on a shorter passage');
        const first = f.rows.slice(saved[0]!.sourceStartOrdinal! - 1, saved[0]!.sourceEndOrdinal!);
        assert.ok(estimateMessagesTokens(first, 'custom/thinker') > 4_000, 'a passage larger than our key\'s');
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    await t.test('a cut-off chapter is redone once on whole exchanges, then kept up to its last full sentence', async (st) => {
      const f = await fixture(12, long);
      try {
        const calls: GenerateParams[] = [];
        st.mock.method(OpenRouterProvider.prototype, 'generateStream', async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
          calls.push(p);
          yield { type: 'text', content: 'The visitor arrives; the rain starts. She asks for te' };
          yield { type: 'done', content: '', stopReason: 'length' };
        });
        await compactSummaryceptionForSession({ sessionId: f.sid, userId: f.uid, fallbackModel: model, force: true, foldThroughMessageId: f.rows[10]!.id });
        const saved = await chapters(f.sid);
        assert.ok(saved.length >= 1);
        assert.ok(saved.every((c) => c.text === 'The visitor arrives; the rain starts.'));
        assert.ok(calls.length <= saved.length * 2, 'at most one redo a chapter');
        for (const c of saved) {
          assert.ok(c.sourceEndOrdinal! > c.sourceStartOrdinal!, 'never a chapter of one message');
          assert.equal(f.rows[c.sourceEndOrdinal! - 1]!.role, 'assistant', 'ends on a reply');
        }
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    await t.test('a call reads the chapters just before its passage and the opening ones, not the whole recap', async (st) => {
      const f = await fixture(30);
      try {
        await db.update(messages).set({ summaryceptionCompacted: true }).where(eq(messages.sessionId, f.sid));
        for (const row of f.rows.slice(20)) await db.update(messages).set({ summaryceptionCompacted: false }).where(eq(messages.id, row.id));
        await db.insert(summaryceptionSnippets).values(Array.from({ length: 20 }, (_, i) => ({
          sessionId: f.sid, layerIndex: 1, snippetOrder: i, sourceStartMessageId: f.rows[i]!.id, sourceEndMessageId: f.rows[i]!.id,
          text: `Chapter ${i}: ` + 'The visitor waits for tea while the rain goes on. '.repeat(20), sourceHash: `seed-${i}`,
        })));
        const prompts: string[] = [];
        st.mock.method(OpenRouterProvider.prototype, 'generateStream', async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
          prompts.push(p.messages.map((m) => String(m.content)).join('\n'));
          yield { type: 'text', content: 'New chapter.' };
          yield { type: 'done', content: '', stopReason: 'stop' };
        });
        await compactSummaryceptionForSession({ sessionId: f.sid, userId: f.uid, fallbackModel: model, force: true, foldThroughMessageId: f.rows[24]!.id });
        assert.equal(prompts.length, 1);
        assert.ok(prompts[0]!.includes('Chapter 0:') && prompts[0]!.includes('Chapter 19:'));
        assert.ok(!prompts[0]!.includes('Chapter 5:'), 'the middle is left out');
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });

    await t.test('a model that refused once is not asked again in the same run', async (st) => {
      const f = await fixture(20, long);
      try {
        await db.insert(modelPrices).values({ modelId: 'deepseek/deepseek-v3.2', inputPricePerM: 1, outputPricePerM: 2 }).onConflictDoNothing();
        await invalidateModelPriceCache();
        const calls: string[] = [];
        st.mock.method(OpenRouterProvider.prototype, 'generateStream', async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
          calls.push(p.model);
          if (p.model === model) {
            yield { type: 'error', content: 'OpenRouter error (403): Gemini blocked the request: PROHIBITED_CONTENT' };
            return;
          }
          yield { type: 'text', content: 'A chapter.' };
          yield { type: 'done', content: '', stopReason: 'stop' };
        });
        await compactSummaryceptionForSession({ sessionId: f.sid, userId: f.uid, fallbackModel: model, force: true, foldThroughMessageId: f.rows[16]!.id });
        assert.ok(calls.length >= 3);
        assert.deepEqual(calls, [model, ...calls.slice(1).map(() => 'deepseek/deepseek-v3.2')]);
      } finally { await db.delete(user).where(eq(user.id, f.uid)); }
    });
  } finally { env.YUMINA_OPENROUTER_KEY = oldKey; }
});

test('who gets the recap', async () => {
  registerSessionMemoryExtension();
  let installed = false;
  let uninstalled = false;
  __setInstalledLookupForTests(async () => new Set(installed ? [SESSION_MEMORY_EXTENSION_KEY] : []));
  __setUninstalledLookupForTests(async () => new Set(uninstalled ? [SESSION_MEMORY_EXTENSION_KEY] : []));
  try {
    const caps = async (chosenShare: unknown, session: Record<string, unknown> = {}) => {
      const dispatch = await resolveTurnHooks({ ownerUserId: 'u1', sessionId: 's1', session, recap: { chosenShare, storyMemory: 16_000 } });
      return [...(dispatch.activeExtensions.get(SESSION_MEMORY_EXTENSION_KEY) ?? [])];
    };
    installed = true;
    assert.ok((await caps(undefined)).includes('summaryception'), 'memory feature, never chose: on');
    assert.ok(!(await caps(undefined)).includes('story-summary'), 'the rolling summary no longer runs');
    assert.ok(!(await caps('off')).includes('summaryception'), 'off is off');
    assert.ok(!(await caps(undefined, { summaryIncluded: false, summaryceptionIncluded: false })).includes('summaryception'), 'the session switch still applies');
    installed = false;
    assert.deepEqual(await caps(undefined), ['summaryception'], 'on for everyone by default');
    assert.deepEqual(await caps('off'), [], 'off in AI settings is off');
    assert.deepEqual(await caps('lean'), ['summaryception']);
    uninstalled = true;
    assert.deepEqual(await caps(undefined), [], 'an explicit uninstall still opts out of the default');
    assert.deepEqual(await caps('lean'), ['summaryception'], 'the explicit choice outranks an old uninstall');
  } finally {
    __setInstalledLookupForTests(null);
    __setUninstalledLookupForTests(null);
  }
});

test('the first catch-up of a recap is held to 24,000 tokens whatever the story memory', () => {
  assert.equal(autoBackfillLimitTokens(200_000, false), 24_000);
  assert.equal(autoBackfillLimitTokens(8_000, false), 24_000);
  assert.equal(autoBackfillLimitTokens(200_000, true), 200_000);
  assert.equal(autoBackfillLimitTokens(8_000, true), 24_000);
});

test("a turn's recap run starts after its reply is saved, never for a send that fails", () => {
  const hooks = readFileSync(new URL('../extensions/session-memory/hooks.ts', import.meta.url), 'utf8');
  const overflow = hooks.slice(hooks.indexOf('onPromptOverflow:'), hooks.indexOf('onTurnComplete:'));
  const blocks = hooks.slice(hooks.indexOf('contributePromptBlocks:'), hooks.indexOf('filterHistory:'));
  assert.ok(!overflow.includes('scheduleSummaryceptionCompaction('), 'the prompt build only holds the run');
  assert.ok(!blocks.includes('scheduleSummaryceptionCompaction('));
  assert.match(hooks.slice(hooks.indexOf('onTurnComplete:')), /takeRecapRun\(ctx\.sessionId\)/);
});
