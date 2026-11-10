import '../test/database-fixture.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { user, worlds, playSessions, creditWallets, apiKeys, modelPrices, usageLogs } from '../db/schema.js';
import { completionRoutes } from './completions.js';
import { OpenRouterProvider } from '../lib/llm/openrouter.js';
import { encryptApiKey } from '../lib/crypto.js';
import { env } from '../lib/env.js';
import { acquireConcurrency, releaseConcurrency, SIDE_CALL_MAX_CONCURRENT } from '../middleware/rate-limit.js';
import type { AppEnv } from '../lib/types.js';
import type { GenerateParams } from '../lib/llm/types.js';

const format = { type: 'json_schema', json_schema: { name: 'decision_v1', strict: true, schema: {
  type: 'object', properties: { action: { type: 'string', enum: ['wait'] } }, required: ['action'], additionalProperties: false,
} } } as const;

test('actual side-completion route bounds, forwards, prices and fails closed on schema errors', async t => {
  const id = crypto.randomUUID(), worldId = crypto.randomUUID(), model = 'deepseek/deepseek-v3.2';
  const oldKey = env.YUMINA_OPENROUTER_KEY; env.YUMINA_OPENROUTER_KEY = 'synthetic-official';
  t.after(() => { env.YUMINA_OPENROUTER_KEY = oldKey; });
  await db.insert(user).values({ id, name: 'Completion test', email: `${id}@test.local`, preferences: { preferredProvider: 'official' } });
  await db.insert(creditWallets).values({ userId: id, plan: 'plus', balance: 100, periodStart: new Date(), periodEnd: new Date(Date.now() + 86400000) });
  await db.insert(modelPrices).values({ modelId: model, inputPricePerM: 1, outputPricePerM: 1 });
  await db.insert(worlds).values({ id: worldId, creatorId: id, name: 'Completion test', schema: {} });
  const [session] = await db.insert(playSessions).values({ userId: id, worldId }).returning();
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('user', { id } as AppEnv['Variables']['user']); await next(); });
  const path = '/sessions/:sessionId/completions';
  for (const route of completionRoutes.routes.filter(r => r.method === 'POST' && r.path === path)) app.post(path, route.handler);
  const send = (extra = {}, text = 'Choose') => app.request(`/sessions/${session!.id}/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: text }], ...extra }) });
  let fail = false;
  const calls: GenerateParams[] = [];
  t.mock.method(OpenRouterProvider.prototype, 'generateStream', async function* (params: GenerateParams) {
    calls.push(params);
    if (fail) { yield { type: 'error' as const, content: 'Schema rejected upstream' }; return; }
    yield { type: 'text' as const, content: '{}' };
    yield { type: 'done' as const, content: '', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } };
  });
  await t.test('provider error chunks become SSE errors without successful done', async () => {
    fail = true;
    const failure = await send({ responseFormat: format }); const events = await failure.text();
    assert.match(events, /event: error\ndata: .*Schema rejected upstream/);
    assert.doesNotMatch(events, /event: done/);
  });
  fail = false; calls.length = 0;
  const malformed = await send({ responseFormat: { ...format, extra: true }, messages: [{ role: 'user', content: [], attachments: [{ type: 'image', data: 'invalid' }] }] });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json() as any).error, /responseFormat/, 'reject format before image normalization');
  const deepSchema: Record<string, unknown> = { type: 'object' }; let nested = deepSchema;
  for (let i = 0; i < 20; i++) nested = nested.child = {};
  for (const raw of [null, { type: 'json_schema' }, { type: 'json_schema', json_schema: { ...format.json_schema, schema: deepSchema } }, { type: 'json_schema', json_schema: { ...format.json_schema, schema: { type: 'object', description: 'é'.repeat(9000) } } }]) {
    const rejected = await send({ responseFormat: raw }); assert.equal(rejected.status, 400); assert.match((await rejected.json() as any).error, /responseFormat/);
  }
  const tooLong = await send({ responseFormat: format }, 'x'.repeat(50_000 - JSON.stringify(format).length + 1));
  assert.equal(tooLong.status, 400, 'schema characters count toward the prompt-size limit');
  assert.equal(calls.length, 0);
  for (const responseFormat of [undefined, { type: 'json_object' }, format]) {
    const response = await send({ responseFormat }); assert.equal(response.status, 200, await response.clone().text());
    assert.match(await response.text(), /event: done/); assert.deepEqual(calls.at(-1)!.responseFormat, responseFormat);
  }
  fail = true;
  const failure = await send({ responseFormat: format }); const events = await failure.text();
  assert.match(events, /event: error\ndata: .*Schema rejected upstream/);
  assert.doesNotMatch(events, /event: done/);
  assert.equal((await db.select().from(usageLogs).where(eq(usageLogs.userId, id))).length, 3, 'failed stream does not log or bill success');
  // A tiny balance admits text alone, but not a large schema; use a fresh wallet to keep ledger guards intact.
  const pricedId = crypto.randomUUID();
  await db.insert(user).values({ id: pricedId, name: 'Priced', email: `${pricedId}@test.local`, preferences: { preferredProvider: 'official' } });
  await db.insert(creditWallets).values({ userId: pricedId, plan: 'plus', balance: 0.2, periodStart: new Date(), periodEnd: new Date(Date.now() + 86400000) });
  const [pricedSession] = await db.insert(playSessions).values({ userId: pricedId, worldId }).returning();
  const pricedApp = new Hono<AppEnv>(); pricedApp.use('*', async (c, next) => { c.set('user', { id: pricedId } as AppEnv['Variables']['user']); await next(); });
  for (const route of completionRoutes.routes.filter(r => r.method === 'POST' && r.path === path)) pricedApp.post(path, route.handler);
  const priced = await pricedApp.request(`/sessions/${pricedSession!.id}/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Choose' }], responseFormat: { ...format, json_schema: { ...format.json_schema, schema: { ...format.json_schema.schema, description: 'x'.repeat(2000) } } } }) });
  assert.equal(priced.status, 402); assert.equal((await priced.json() as any).code, 'NO_CREDITS');
  // OpenAI BYOK must fail before generation concurrency, even when its pool is full.
  const key = encryptApiKey('synthetic-byok');
  await db.insert(apiKeys).values({ userId: id, provider: 'openai', encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag });
  await db.update(user).set({ preferences: { preferredProvider: 'private' } }).where(eq(user.id, id));
  for (let i = 0; i < SIDE_CALL_MAX_CONCURRENT; i++) assert.equal(await acquireConcurrency(`side:${id}`, SIDE_CALL_MAX_CONCURRENT), true);
  try {
    const unsupported = await send({ model: 'openai/gpt-4o', responseFormat: format });
    assert.equal(unsupported.status, 400);
    assert.deepEqual(await unsupported.json(), { error: 'This provider does not support JSON Schema side completions.', code: 'UNSUPPORTED_RESPONSE_FORMAT' });
  } finally { for (let i = 0; i < SIDE_CALL_MAX_CONCURRENT; i++) await releaseConcurrency(`side:${id}`); }
  fail = false;
  await db.insert(apiKeys).values({ userId: id, provider: 'openrouter', encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag });
  const balanceBefore = (await db.select().from(creditWallets).where(eq(creditWallets.userId, id)))[0]!.balance;
  const byok = await send({ responseFormat: format }); assert.match(await byok.text(), /event: done/);
  assert.deepEqual(calls.at(-1)!.responseFormat, format); assert.equal(calls.at(-1)!.model, model);
  assert.equal((await db.select().from(creditWallets).where(eq(creditWallets.userId, id)))[0]!.balance, balanceBefore, 'BYOK is not charged platform credits');
  // Protected-world resolution (completions-ordinary-account.test.ts): a noncreator in private
  // mode is rejected outright rather than silently moved onto official billing.
  await db.update(worlds).set({ creatorId: pricedId, allowCustomApi: false }).where(eq(worlds.id, worldId));
  const protectedCall = await send({ responseFormat: format });
  assert.equal(protectedCall.status, 403);
  assert.equal((await protectedCall.json() as any).code, 'PROTECTED_WORLD');
  const logged = await db.select().from(usageLogs).where(eq(usageLogs.userId, id));
  assert.equal(logged.filter(row => row.apiKeyTier === 'byok').length, 1);
  assert.equal(logged.length, 4, 'protected-world call neither ran nor billed under the private key');
  await db.update(worlds).set({ allowCustomApi: true }).where(eq(worlds.id, worldId));
  await t.test('request cancellation after upstream done suppresses final success and billing', async () => {
    const abort = new AbortController();
    t.mock.method(OpenRouterProvider.prototype, 'generateStream', async function* () {
      yield { type: 'done' as const, content: '', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } };
      abort.abort();
    });
    const response = await app.request(`/sessions/${session!.id}/completions`, { method: 'POST', signal: abort.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Choose' }], responseFormat: format }) });
    assert.doesNotMatch(await response.text(), /event: done/);
    assert.equal((await db.select().from(usageLogs).where(eq(usageLogs.userId, id))).length, 4);
    assert.equal(await acquireConcurrency(`side:${id}`, 1), true, 'cancelled call releases concurrency');
    await releaseConcurrency(`side:${id}`);
  });
  await t.test('request abort during actual usage persistence suppresses terminal success after listener cleanup', async lateTest => {
    const abort = new AbortController();
    let generationSignal: AbortSignal | undefined;
    let abortAtUsage = false;
    lateTest.mock.method(OpenRouterProvider.prototype, 'generateStream', async function* (params: GenerateParams) {
      generationSignal = params.signal;
      yield { type: 'text' as const, content: '{}' };
      yield { type: 'done' as const, content: '', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } };
    });
    const client = db.$client;
    assert.ok(client instanceof PGlite);
    const originalQuery = client.query.bind(client);
    lateTest.mock.method(client, 'query', async (...args: Parameters<typeof client.query>) => {
      const result = await originalQuery(...args);
      if (/insert into "usage_logs"/i.test(args[0])) {
        abortAtUsage = true;
        abort.abort();
        assert.equal(generationSignal?.aborted, false, 'request listener was removed before accounting');
      }
      return result;
    });
    const response = await app.request(`/sessions/${session!.id}/completions`, { method: 'POST', signal: abort.signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Choose' }], responseFormat: format }) });
    const events = await response.text();
    assert.equal(abortAtUsage, true, 'abort occurred on a real usage insert');
    assert.equal(abort.signal.aborted, true);
    assert.match(events, /event: text/);
    assert.doesNotMatch(events, /event: done/);
  });
});
