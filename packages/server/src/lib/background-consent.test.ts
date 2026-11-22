// Asking before the first background mushie charge (2026-11-08). A player on
// Yumina Free was billed every turn by the recap; now every background AI that
// would charge waits for the player's answer, and the server enforces it.
// No network requests or production database access.
import '../test/database-fixture.js';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { pendingBackgroundConsents, readBackgroundChargePrefs, SESSION_MEMORY_EXTENSION_KEY, type BackgroundChargePrefs } from '@yumina/shared';
import { db } from '../db/index.js';
import { apiKeys, creditTransactions, creditWallets, messages, modelPrices, playSessions, usageLogs, user, userExtensions, worlds } from '../db/schema.js';
import { encryptApiKey } from './crypto.js';
import { env } from './env.js';
import { OpenRouterProvider } from './llm/openrouter.js';
import { FREE_ROUTER_FALLBACK_MODEL, FREE_ROUTER_LAST_RESORT_MODEL } from './llm/fallback-models.js';
import type { GenerateParams, StreamChunk } from './llm/types.js';
import { invalidateModelPriceCache } from './model-price-cache.js';
import { consentNeededForDone, FREE_BACKGROUND_MODEL, gateBackgroundCharge } from './background-consent.js';
import { compactSummaryceptionForSession, gateAutomaticRecap } from './summaryception.js';
import { regenerateSessionMemoryForSession, scheduleSessionMemoryIncrementalUpdate } from './session-memory.js';
import { DEFAULT_STORY_SUMMARY_MODEL, generateStorySummaryText } from './session-compaction.js';
import { registerExtensionHooks } from './extension-hooks.js';
import { TurnOutputAttempt } from './turn-output-validation.js';
import { edition } from '../edition/index.js';
import type { WorldDefinition } from '@yumina/engine';

const paid = DEFAULT_STORY_SUMMARY_MODEL;
const memoryText = 'Core facts:\n- Ari keeps the blue compass.\nImportant decisions and promises:\n- Mira agreed to deliver the sealed letter.\nCurrent risks and constraints:\n- The north gate closes at dawn.';
after(async () => { await (db as unknown as { $client: { close(): Promise<void> } }).$client.close(); });

async function fixture(charges?: BackgroundChargePrefs) {
  const uid = randomUUID();
  await db.insert(user).values({ id: uid, name: 'Consent', email: `${uid}@example.test`, preferences: charges ? { backgroundCharges: charges } : {} });
  const [wallet] = await db.insert(creditWallets).values({ userId: uid, plan: 'free', balance: 100, addonBalance: 100, periodStart: new Date(), periodEnd: new Date(Date.now() + 30 * 86400000) }).returning();
  const [world] = await db.insert(worlds).values({ creatorId: uid, name: 'Tea room', schema: { id: randomUUID(), name: 'Tea room', entries: [], variables: [], rules: [], components: [], settings: {} } }).returning();
  const [session] = await db.insert(playSessions).values({ userId: uid, worldId: world!.id, state: { variables: {}, metadata: {} }, summaryLanguage: 'en', sessionMemoryIncluded: true, sessionMemory: { text: 'Core facts:\n- Ari keeps the blue compass.' } }).returning();
  const rows = Array.from({ length: 10 }, (_, i) => ({
    id: randomUUID(), sessionId: session!.id, role: i % 2 ? 'user' as const : 'assistant' as const,
    content: `Scene ${i}. The visitor waits for tea while Mira reads the letter.`,
    stateSnapshot: { variables: {}, metadata: {} }, createdAt: new Date(Date.UTC(2026, 10, 1, 0, 0, i)),
  }));
  await db.insert(messages).values(rows);
  return {
    uid, sid: session!.id, rows, worldId: world!.id,
    recapArgs: { sessionId: session!.id, userId: uid, fallbackModel: paid, force: true, foldThroughMessageId: rows[5]!.id },
    ledger: () => db.select().from(creditTransactions).where(eq(creditTransactions.walletId, wallet!.id)),
    prefs: async () => (await db.select({ p: user.preferences }).from(user).where(eq(user.id, uid)))[0]!.p,
    cleanup: () => db.delete(user).where(eq(user.id, uid)),
  };
}

function provider(st: { mock: { method: (...args: never[]) => unknown } }, text = 'The visitor waited for tea.') {
  const calls: GenerateParams[] = [];
  (st.mock.method as unknown as (o: object, k: string, f: unknown) => void)(OpenRouterProvider.prototype, 'generateStream', async function* (p: GenerateParams): AsyncIterable<StreamChunk> {
    calls.push(p);
    yield { type: 'text', content: text };
    yield { type: 'done', content: '', stopReason: 'stop', usage: { promptTokens: 2000, completionTokens: 200, totalTokens: 2200 } };
  });
  return calls;
}
const charged = async (f: { ledger: () => Promise<Array<{ amount: number }>> }) => (await f.ledger()).filter((row) => row.amount < 0).length;

test('background charges wait for the player', async (t) => {
  await db.insert(modelPrices).values([
    { modelId: paid, inputPricePerM: 1, outputPricePerM: 2, minPlan: 'free' },
    { modelId: FREE_BACKGROUND_MODEL, inputPricePerM: 0, outputPricePerM: 0, minPlan: 'free' },
    { modelId: 'deepseek/deepseek-v3.2', inputPricePerM: 1, outputPricePerM: 2, minPlan: 'free' },
  ]).onConflictDoNothing();
  await invalidateModelPriceCache();
  const oldKey = env.YUMINA_OPENROUTER_KEY;
  env.YUMINA_OPENROUTER_KEY = 'test-only-never-sent-key';
  try {
    await t.test('recap, undecided: nothing runs, nothing is charged, and the next reply asks', async (st) => {
      const f = await fixture();
      try {
        const calls = provider(st);
        assert.equal(await gateAutomaticRecap(f.recapArgs), null, 'the paid recap does not start');
        assert.equal(calls.length, 0);
        assert.equal(await charged(f), 0);
        const done = await consentNeededForDone(f.uid);
        assert.equal(done.consentNeeded?.length, 1);
        const [ask] = done.consentNeeded!;
        assert.equal(ask!.feature, 'recap');
        assert.equal(ask!.model, paid);
        assert.equal(ask!.hasFreeOption, true);
        assert.ok(ask!.estCredits && ask!.estCredits > 0, 'the dialog quotes a price');
        // Asked again: the note is written once and the dialog shows it once.
        assert.equal(await gateAutomaticRecap(f.recapArgs), null);
        assert.equal(pendingBackgroundConsents(await f.prefs()).length, 1);
        const unfolded = (await db.select().from(messages).where(eq(messages.sessionId, f.sid))).filter((m) => !m.summaryceptionCompacted);
        assert.equal(unfolded.length, f.rows.length, 'nothing is lost: the messages wait for the next run');
      } finally { await f.cleanup(); }
    });

    await t.test('recap, allowed: runs on the chosen model and is charged', async (st) => {
      const f = await fixture({ features: { recap: 'allow' } });
      try {
        const calls = provider(st);
        const args = await gateAutomaticRecap(f.recapArgs);
        assert.ok(args);
        await compactSummaryceptionForSession(args);
        assert.ok(calls.length > 0);
        assert.ok(calls.every((c) => c.model === paid));
        assert.ok(await charged(f) > 0, 'mushies were taken');
        assert.deepEqual(await consentNeededForDone(f.uid), {});
      } finally { await f.cleanup(); }
    });

    await t.test('recap, free model: runs on Yumina Free with room to think and charges nothing', async (st) => {
      const f = await fixture({ features: { recap: 'free' } });
      try {
        const calls = provider(st);
        const args = await gateAutomaticRecap(f.recapArgs);
        assert.equal(args?.runModel, FREE_BACKGROUND_MODEL);
        await compactSummaryceptionForSession(args!);
        assert.ok(calls.length > 0);
        assert.ok(calls.every((c) => c.model === FREE_BACKGROUND_MODEL), 'never the priced model');
        // When the free pool is out for the day it goes on on the near-free
        // model, at our cost: still nothing charged (below).
        assert.ok(calls.every((c) => JSON.stringify(c.fallbackModels) === JSON.stringify([FREE_ROUTER_FALLBACK_MODEL, FREE_ROUTER_LAST_RESORT_MODEL])), 'free pool fallback');
        assert.equal(calls[0]!.maxTokens, 4_000);
        assert.equal(await charged(f), 0);
        const folded = (await db.select().from(messages).where(eq(messages.sessionId, f.sid))).filter((m) => m.summaryceptionCompacted);
        assert.ok(folded.length > 0, 'the recap was written');
      } finally { await f.cleanup(); }
    });

    await t.test('recap, declined: nothing runs and nobody asks again', async (st) => {
      const f = await fixture({ features: { recap: 'skip' } });
      try {
        const calls = provider(st);
        assert.equal(await gateAutomaticRecap(f.recapArgs), null);
        assert.equal(calls.length, 0);
        assert.equal(await charged(f), 0);
        assert.deepEqual(await consentNeededForDone(f.uid), {});
      } finally { await f.cleanup(); }
    });

    await t.test('"don\'t ask again" lets every AI charge without asking', async () => {
      const f = await fixture({ allowAll: true, features: { recap: 'skip' } });
      try {
        for (const feature of ['recap', 'memory', 'guard', 'cardAi', 'runSummary'] as const) {
          const gate = await gateBackgroundCharge({ userId: f.uid, feature, model: paid });
          assert.deepEqual(gate, { run: true, model: paid, charged: true, viaFree: false }, feature);
        }
        assert.deepEqual(await consentNeededForDone(f.uid), {});
      } finally { await f.cleanup(); }
    });

    await t.test('a call that costs nothing never asks: free model, own key', async () => {
      const f = await fixture();
      try {
        assert.deepEqual(await gateBackgroundCharge({ userId: f.uid, feature: 'recap', model: FREE_BACKGROUND_MODEL }), { run: true, model: FREE_BACKGROUND_MODEL, charged: false, viaFree: false });
        assert.deepEqual(await gateBackgroundCharge({ userId: f.uid, feature: 'cardAi', model: paid, isByok: true }), { run: true, model: paid, charged: false, viaFree: false });
        assert.deepEqual(await consentNeededForDone(f.uid), {});
      } finally { await f.cleanup(); }
    });

    // 2026-11-08: the recap made 64 calls on one player's relay in 43 minutes.
    await t.test('recap on the player\'s own API asks once, with no price, and runs once allowed', async (st) => {
      const f = await fixture();
      try {
        const keyId = randomUUID();
        const encrypted = encryptApiKey('test-only-never-sent-private-key');
        await db.insert(apiKeys).values({ id: keyId, userId: f.uid, provider: 'custom', baseUrl: 'https://consent-own-api.example/v1', encryptedKey: encrypted.encrypted, keyIv: encrypted.iv, keyTag: encrypted.tag });
        await db.update(user).set({ preferences: { preferredProvider: 'private', activeApiKeyId: keyId } }).where(eq(user.id, f.uid));
        await db.insert(userExtensions).values({ userId: f.uid, extensionKey: SESSION_MEMORY_EXTENSION_KEY, status: 'installed' });
        await db.update(playSessions).set({ summaryceptionModel: 'custom/own', summaryModel: 'custom/own' }).where(eq(playSessions.id, f.sid));
        provider(st);
        assert.equal(await gateAutomaticRecap(f.recapArgs), null, 'no answer yet: does not run');
        assert.deepEqual(await consentNeededForDone(f.uid), {
          consentNeeded: [{ feature: 'recap', model: 'custom/own', estCredits: null, hasFreeOption: true, ownKey: true }],
        });
        await db.update(user).set({ preferences: { preferredProvider: 'private', activeApiKeyId: keyId, backgroundCharges: { features: { recap: 'allow' } } } }).where(eq(user.id, f.uid));
        assert.deepEqual(await gateAutomaticRecap(f.recapArgs), f.recapArgs);
        // The card AIs make one call at a time and still never ask on the player's key.
        assert.deepEqual(await gateBackgroundCharge({ userId: f.uid, feature: 'cardAi', model: 'custom/own', isByok: true }), { run: true, model: 'custom/own', charged: false, viaFree: false });
      } finally { await f.cleanup(); }
    });

    // 2026-11-09: a player on their own API chose the free model in the
    // dialog; it found no key in private mode and every recap failed.
    await t.test('recap on the player\'s own API, free model chosen: runs on Yumina Free, charges nothing', async (st) => {
      const f = await fixture();
      try {
        const keyId = randomUUID();
        const encrypted = encryptApiKey('test-only-never-sent-private-key');
        await db.insert(apiKeys).values({ id: keyId, userId: f.uid, provider: 'custom', baseUrl: 'https://consent-own-api.example/v1', encryptedKey: encrypted.encrypted, keyIv: encrypted.iv, keyTag: encrypted.tag });
        await db.update(user).set({ preferences: { preferredProvider: 'private', activeApiKeyId: keyId, backgroundCharges: { features: { recap: 'free' } } } }).where(eq(user.id, f.uid));
        const calls = provider(st);
        const args = await gateAutomaticRecap({ ...f.recapArgs, fallbackModel: 'custom/own' });
        assert.equal(args?.runModel, FREE_BACKGROUND_MODEL);
        await compactSummaryceptionForSession(args!);
        assert.ok(calls.length > 0);
        assert.ok(calls.every((c) => c.model === FREE_BACKGROUND_MODEL));
        assert.equal(await charged(f), 0);
        const [session] = await db.select().from(playSessions).where(eq(playSessions.id, f.sid));
        assert.notEqual(session!.summaryceptionStatus, 'failed', session!.summaryceptionError ?? '');
        const folded = (await db.select().from(messages).where(eq(messages.sessionId, f.sid))).filter((m) => m.summaryceptionCompacted);
        assert.ok(folded.length > 0, 'the recap was written');
      } finally { await f.cleanup(); }
    });

    await t.test('automatic memory rebuild follows the same answers', async (st) => {
      for (const [answer, expectRun, expectModel, expectCharge] of [
        [undefined, false, null, false],
        ['allow', true, paid, true],
        ['free', true, FREE_BACKGROUND_MODEL, false],
        ['skip', false, null, false],
      ] as const) {
        const f = await fixture(answer ? { features: { memory: answer } } : undefined);
        try {
          const calls = provider(st, memoryText);
          await regenerateSessionMemoryForSession({ sessionId: f.sid, userId: f.uid, automatic: true });
          assert.equal(calls.length > 0, expectRun, `${answer}: runs`);
          if (expectModel) assert.ok(calls.every((c) => c.model === expectModel), `${answer}: model`);
          assert.equal(await charged(f) > 0, expectCharge, `${answer}: charged`);
          const [session] = await db.select().from(playSessions).where(eq(playSessions.id, f.sid));
          if (!expectRun) assert.notEqual(session!.sessionMemoryStatus, 'failed', `${answer}: waiting is not a failure`);
          const asked = (await consentNeededForDone(f.uid)).consentNeeded?.map((c) => c.feature) ?? [];
          assert.deepEqual(asked, answer ? [] : ['memory'], `${answer}: asks`);
        } finally { await f.cleanup(); st.mock.restoreAll(); }
      }
    });

    await t.test('the per-turn memory update waits too, and catches up on the free model', async (st) => {
      const until = async (check: () => Promise<boolean>) => {
        for (let i = 0; i < 100; i++) { if (await check()) return; await new Promise((r) => setTimeout(r, 50)); }
        throw new Error('timed out');
      };
      const session = async (sid: string) => (await db.select().from(playSessions).where(eq(playSessions.id, sid)))[0]!;
      for (const answer of [undefined, 'free'] as const) {
        const f = await fixture(answer ? { features: { memory: answer } } : undefined);
        try {
          await db.update(playSessions).set({ sessionMemory: null }).where(eq(playSessions.id, f.sid));
          await db.insert(userExtensions).values({ userId: f.uid, extensionKey: SESSION_MEMORY_EXTENSION_KEY, status: 'installed' });
          const calls = provider(st, memoryText);
          scheduleSessionMemoryIncrementalUpdate({ sessionId: f.sid, userId: f.uid, userMessage: '', assistantMessage: '', state: {}, fallbackModel: paid });
          if (!answer) {
            await until(async () => pendingBackgroundConsents(await f.prefs()).some((c) => c.feature === 'memory'));
            await new Promise((r) => setTimeout(r, 100));
            assert.equal(calls.length, 0, 'no paid memory call');
            assert.equal((await session(f.sid)).sessionMemoryProcessedMessageId, null, 'the cursor waits where it was');
          } else {
            await until(async () => (await session(f.sid)).sessionMemoryProcessedMessageId != null);
            assert.ok(calls.length > 0 && calls.every((c) => c.model === FREE_BACKGROUND_MODEL));
            assert.equal(await charged(f), 0);
            assert.notEqual((await session(f.sid)).sessionMemoryModel, FREE_BACKGROUND_MODEL, 'the chat keeps its own model choice');
          }
        } finally { await f.cleanup(); st.mock.restoreAll(); }
      }
    });

    await t.test('a card AI waits for an answer and has no free stand-in', async (st) => {
      const call = (f: { uid: string; sid: string }) => generateStorySummaryText({ userId: f.uid, sessionId: f.sid, model: paid, endpoint: 'module-worker', maxTokens: 100, prompt: [{ role: 'system', content: 'Station instructions' }] });
      for (const answer of [undefined, 'skip', 'free', 'allow'] as const) {
        const f = await fixture(answer ? { features: { cardAi: answer } } : undefined);
        try {
          const calls = provider(st, 'A usable answer.');
          if (answer === 'allow') {
            assert.equal(await call(f), 'A usable answer.');
            assert.ok(await charged(f) > 0);
          } else {
            await assert.rejects(call(f), /CONSENT_NEEDED/, `${answer}`);
            assert.equal(calls.length, 0);
            assert.equal(await charged(f), 0);
          }
          const asked = (await consentNeededForDone(f.uid)).consentNeeded ?? [];
          assert.deepEqual(asked.map((c) => [c.feature, c.hasFreeOption]), answer ? [] : [['cardAi', false]]);
        } finally { await f.cleanup(); st.mock.restoreAll(); }
      }
    });

    // The open-source edition has no official models: a correction on one is
    // unavailable before anything could be charged (state-update-guard/model.ts).
    await t.test('a paid state guard correction waits; the free model runs uncharged', { skip: !edition.info().features.officialModels }, async () => {
      // The validator's own contract: a correction that cannot be resolved
      // leaves the reply unverified (extensions/state-update-guard/validate.ts).
      registerExtensionHooks('state-update-guard', {
        validateTurnOutput: async (ctx) => {
          try {
            const correction = await ctx.resolveCorrection!();
            ctx.audit.correctionApiKeyTier = correction.apiKeyTier;
            await ctx.recordUsage({ promptTokens: 2000, completionTokens: 200, totalTokens: 2200 }, correction.model);
            ctx.audit.outcome = 'valid-updates';
          } catch (error) {
            ctx.audit.outcome = 'unverified';
            ctx.audit.diagnostics.push((error as { code?: string }).code ?? 'error');
          }
          return { parsed: ctx.parsed, audit: ctx.audit };
        },
      });
      const world = { id: 'guard', name: 'Guard', variables: [], entries: [], rules: [], components: [], settings: {} } as unknown as WorldDefinition;
      for (const [answer, expected] of [
        [undefined, { model: undefined, cost: false, asks: true }],
        ['allow', { model: paid, cost: true, asks: false }],
        ['free', { model: FREE_BACKGROUND_MODEL, cost: false, asks: false }],
      ] as const) {
        const f = await fixture(answer ? { features: { guard: answer } } : undefined);
        try {
          const attempt = new TurnOutputAttempt({
            dispatch: { activeExtensions: new Map([['state-update-guard', new Set<string>()]]), outputModels: new Map([['state-update-guard', `official::${paid}`]]) } as never,
            userId: f.uid, sessionId: f.sid, targetId: f.rows.at(-1)!.id, path: 'send', world, baseline: { variables: {} } as never,
            model: 'story/model', apiKeyTier: 'free', startedAt: Date.now(), worldVersion: null, pendingVersion: null,
            worldId: f.worldId, checkPending: false, signal: new AbortController().signal,
          });
          const result = await attempt.validate({ raw: 'Reply', model: 'story/model', parsed: { cleanText: 'Reply', effects: [], audioEffects: [] } } as never, async () => {});
          assert.equal(result.parsed.cleanText, 'Reply', 'the reply is delivered either way');
          const used = (await db.select({ model: usageLogs.model }).from(usageLogs).where(eq(usageLogs.sessionId, f.sid))).map((row) => row.model);
          assert.deepEqual(used, expected.model ? [expected.model] : [], `${answer}: correction model`);
          const cost = (attempt as unknown as { correctionCost: number }).correctionCost;
          assert.equal(cost > 0, expected.cost, `${answer}: charged`);
          assert.equal(attempt.consentNeeded?.feature, expected.asks ? 'guard' : undefined, `${answer}: asks`);
          if (expected.asks) assert.equal(attempt.audit.outcome, 'unverified', 'delivered unverified, not failed');
          const asked = (await consentNeededForDone(f.uid, [attempt.consentNeeded])).consentNeeded?.map((c) => c.feature) ?? [];
          assert.deepEqual(asked, expected.asks ? ['guard'] : []);
        } finally { await f.cleanup(); }
      }
    });

    await t.test('answering clears the waiting notes; a saved "free" for a card AI means skip', () => {
      assert.deepEqual(readBackgroundChargePrefs({ backgroundCharges: { features: { cardAi: 'free', recap: 'free', bogus: 'allow', memory: 'maybe' } } }), { features: { cardAi: 'skip', recap: 'free' } });
      const pending = { backgroundChargePending: { recap: { model: paid, estCredits: 0.4 }, memory: { model: paid } } };
      assert.deepEqual(pendingBackgroundConsents({ ...pending, backgroundCharges: { features: { recap: 'allow' } } }).map((c) => c.feature), ['memory']);
      const route = readFileSync(new URL('../routes/users.ts', import.meta.url), 'utf8');
      assert.match(route, /clientPreferences\[BACKGROUND_CHARGE_PENDING_PREF_KEY\] = \{\}/, 'saving an answer clears the notes');
      assert.match(route, /\[BACKGROUND_CHARGE_PENDING_PREF_KEY\]: _ownedPending/, 'clients cannot write the notes');
    });

    await t.test('every automatic path goes through the gate', () => {
      const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
      assert.match(read('./summaryception.ts'), /gateAutomaticRecap\(args\)\s*\.then\(\(gated\) => gated \? compactSummaryceptionForSession\(\{ \.\.\.gated, automatic: true \}\)/);
      const memory = read('./session-memory.ts');
      assert.match(memory, /if \(!args\.force\) \{\s*const gated = await gateAutomaticMemory/);
      assert.match(memory, /planAutomaticRebuild\([^)]*\)\);\s*const gated = await gateAutomaticMemory/);
      assert.match(read('./turn-output-validation.ts'), /feature: "guard"/);
      assert.match(read('./module-generation-access.ts'), /feature: "cardAi"/);
      assert.match(read('./run-summary.ts'), /feature: "runSummary"/);
      const messages = read('../routes/messages.ts');
      assert.equal(messages.match(/consentNeededForDone\(currentUser\.id, \[outputAttempt\.consentNeeded\]\)/g)?.length, 3, 'send, regenerate and continue all carry the question');
    });
  } finally {
    env.YUMINA_OPENROUTER_KEY = oldKey;
  }
});
