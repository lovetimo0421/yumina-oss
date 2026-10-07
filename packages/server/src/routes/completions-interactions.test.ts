import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { migrateWorldDefinition, type WorldDefinition } from '@yumina/engine';
import { db } from '../db/index.js';
import { apiKeys, messages, playSessions, usageLogs, user, worlds } from '../db/schema.js';
import { encryptApiKey } from '../lib/crypto.js';
import { OpenRouterProvider } from '../lib/llm/openrouter.js';
import type { GenerateParams, StreamChunk } from '../lib/llm/types.js';
import type { AppEnv } from '../lib/types.js';
import { USAGE_ENDPOINT_BILLING_POLICY } from '../lib/usage-log.js';
import { completionRoutes } from './completions.js';

before(async () => { await import(new URL('../../scripts/test-local-schema.mjs', import.meta.url).href); });

async function fixture(options: { ephemeral?: boolean; copy?: boolean } = {}) {
  const userId = crypto.randomUUID(), worldId = crypto.randomUUID();
  const account = { id: userId, name: 'Interaction test', email: `${userId}@test.local`, preferences: { preferredProvider: 'private' } };
  await db.insert(user).values(account);
  const key = encryptApiKey('synthetic-interaction-test-key');
  await db.insert(apiKeys).values({ userId, provider: 'openrouter', encryptedKey: key.encrypted, keyIv: key.iv, keyTag: key.tag });
  const schema = migrateWorldDefinition({ id: worldId, version: '1.0.0', name: 'Stage', description: '', author: 'test', entries: [], variables: [], rules: [], reactions: [], components: [], audioTracks: [], customUI: [], settings: { maxTokens: 2000, temperature: 1 } } as unknown as WorldDefinition);
  const sourceId = options.copy ? crypto.randomUUID() : null;
  if (sourceId) await db.insert(worlds).values({ id: sourceId, creatorId: userId, name: 'Original', schema: {}, status: 'published' });
  await db.insert(worlds).values({ id: worldId, creatorId: userId, name: schema.name, status: 'draft', schema: schema as unknown as Record<string, unknown>, sourceWorldId: sourceId });
  const state = { variables: { scene: 'unchanged' }, turnCount: 2 };
  const [session] = await db.insert(playSessions).values({ userId, worldId, state, ephemeral: options.ephemeral ?? false }).returning();
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => { c.set('user', account as unknown as AppEnv['Variables']['user']); await next(); });
  const route = '/sessions/:sessionId/completions';
  for (const { handler } of completionRoutes.routes.filter(item => item.method === 'POST' && item.path === route)) app.post(route, handler);
  const request = (context?: 'session', signal?: AbortSignal) => app.request(`/sessions/${session!.id}/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
    body: JSON.stringify({ messages: [{ role: 'user', content: 'The player is tapping the cup. Respond to the scene.' }], model: 'anthropic/claude-sonnet-4.6', context }),
  });
  return { userId, worldId, sourceId, session: session!, state, request };
}

async function count(worldId: string) {
  const [row] = await db.select({ value: worlds.messageCount }).from(worlds).where(eq(worlds.id, worldId));
  return row!.value;
}

test('side completions record background interactions without inventing chat turns', async t => {
  let chunks = ['{"line":', '"I can hear you."}'];
  let fail = false;
  let errorChunk = false, missingDone = false;
  let duringGeneration: (() => Promise<void> | void) | undefined;
  t.mock.method(OpenRouterProvider.prototype, 'generateStream', async function* (_params: GenerateParams): AsyncGenerator<StreamChunk> {
    for (const content of chunks) yield { type: 'text', content };
    await duringGeneration?.();
    if (fail) throw new Error('Synthetic interrupted generation');
    if (errorChunk) { yield { type: 'error', content: 'Synthetic provider error chunk' }; return; }
    if (missingDone) return;
    yield { type: 'done', content: '', usage: { promptTokens: 20, completionTokens: 10, totalTokens: 30 } };
  });

  await t.test('one completed response counts once, including session-context autonomy and copies', async () => {
    const f = await fixture({ copy: true });
    for (const context of ['session', undefined] as const) {
      const res = await f.request(context); assert.equal(res.status, 200); assert.match(await res.text(), /event: done/);
    }
    assert.equal(await count(f.worldId), 2, 'two completions, not four chunks or fictitious player messages');
    assert.equal(await count(f.sourceId!), 2, 'use the existing copy-to-source aggregation');
    const logs = await db.select().from(usageLogs).where(eq(usageLogs.sessionId, f.session.id));
    assert.equal(logs.length, 2);
    assert.ok(logs.every(log => log.analyticsWorldId === f.worldId && log.endpoint === 'side-completion'));
    assert.equal((await db.select().from(messages).where(eq(messages.sessionId, f.session.id))).length, 0);
    const [saved] = await db.select().from(playSessions).where(eq(playSessions.id, f.session.id));
    assert.deepEqual(saved!.state, f.state);
  });

  await t.test('empty generations retain usage but are not successful play interactions', async () => {
    const f = await fixture(); chunks = [' ', '\n'];
    await (await f.request()).text();
    assert.equal(await count(f.worldId), 0);
    const [log] = await db.select().from(usageLogs).where(eq(usageLogs.sessionId, f.session.id));
    assert.equal(log?.endpoint, 'side-completion_empty');
    assert.equal(log?.analyticsWorldId, f.worldId);
    assert.equal(log?.totalTokens, 30);
    assert.equal(USAGE_ENDPOINT_BILLING_POLICY['side-completion_empty'], 'billed', 'classification must not silently change the existing side-call billing policy');
    chunks = ['A reply.'];
  });

  await t.test('partial failure and cancellation do not count as replies', async () => {
    const f = await fixture(); fail = true;
    const failed = await f.request(); assert.match(await failed.text(), /event: error/);
    fail = false;
    const controller = new AbortController();
    duringGeneration = () => controller.abort();
    await (await f.request(undefined, controller.signal)).text();
    duringGeneration = undefined;
    assert.equal(await count(f.worldId), 0);
  });

  await t.test('ephemeral playtests retain usage without inflating popularity', async () => {
    const f = await fixture({ ephemeral: true });
    await (await f.request('session')).text();
    assert.equal(await count(f.worldId), 0);
    const [log] = await db.select().from(usageLogs).where(eq(usageLogs.sessionId, f.session.id));
    assert.equal(log?.analyticsWorldId, f.worldId);
    assert.equal(log?.totalTokens, 30);
  });

  await t.test('provider error chunks and unterminated partial streams are not completed replies', async () => {
    const f = await fixture();
    errorChunk = true;
    assert.match(await (await f.request()).text(), /event: error/);
    errorChunk = false; missingDone = true;
    assert.match(await (await f.request()).text(), /event: error/);
    missingDone = false;
    assert.equal(await count(f.worldId), 0);
  });

  await t.test('world attribution survives a session deleted while generation is in flight', async () => {
    const f = await fixture();
    duringGeneration = async () => { await db.delete(playSessions).where(eq(playSessions.id, f.session.id)); };
    await (await f.request()).text();
    duringGeneration = undefined;
    const [log] = await db.select().from(usageLogs).where(eq(usageLogs.userId, f.userId));
    assert.equal(log?.sessionId, null);
    assert.equal(log?.analyticsWorldId, f.worldId);
    assert.equal(await count(f.worldId), 1);
  });
});
