import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenRouterProvider, providerRoutingFor } from './openrouter.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { GoogleProvider } from './google.js';
import { OllamaProvider } from './ollama.js';
import { CustomProvider } from './custom.js';
import { LocalBridgeProvider } from './local-bridge.js';
import type { GenerateParams } from './types.js';

const format = { type: 'json_schema', json_schema: { name: 'decision_v1', strict: true, schema: {
  type: 'object', properties: { action: { type: 'string', enum: ['wait'] } }, required: ['action'], additionalProperties: false,
} } } as const;
const base = { model: 'google/gemini-3.5-flash', messages: [{ role: 'user', content: 'Choose an action' }], singleAttempt: true } as GenerateParams;
async function collect(provider: { generateStream: (params: GenerateParams) => AsyncIterable<unknown> }, params: GenerateParams) {
  const chunks = []; for await (const chunk of provider.generateStream(params)) chunks.push(chunk); return chunks;
}

for (const stream of [true, false]) for (const byok of [false, true]) {
  test(`OpenRouter preserves full schema and routing (stream=${stream}, BYOK=${byok})`, async t => {
    const requests: Record<string, any>[] = [];
    t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const body = JSON.parse(String(init?.body)); requests.push(body);
      return stream
        ? new Response('data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
        : Response.json({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] });
    });
    const provider = new OpenRouterProvider('synthetic-key', { preserveAccountRouting: byok });
    for (const responseFormat of [undefined, { type: 'json_object' } as const, format]) {
      await collect(provider, { ...base, stream, responseFormat: responseFormat as GenerateParams['responseFormat'], cacheBreakpoints: [0] });
      const sent = requests.at(-1)!;
      assert.deepEqual(sent.response_format, responseFormat);
      const routing = providerRoutingFor(base.model, true, undefined, byok);
      assert.deepEqual(sent.provider, responseFormat?.type === 'json_schema' ? { ...routing, require_parameters: true } : routing);
    }
    assert.equal(requests.length, 3);
  });
}

test('OpenRouter rejection never retries with a stripped schema', async t => {
  const requests: Record<string, any>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ error: { message: 'Schema unsupported', code: 400 } }, { status: 400 });
  });
  const chunks = await collect(new OpenRouterProvider('synthetic-key'), { ...base, responseFormat: format as unknown as GenerateParams['responseFormat'] });
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]!.response_format, format);
  assert.equal((chunks.at(-1) as any).type, 'error');
});

test('unsupported adapters reject JSON Schema before any fetch or local dispatch, in both modes', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new Error('network must not run'); });
  const providers = [new AnthropicProvider('synthetic'), new OpenAIProvider('synthetic'), new GoogleProvider('synthetic'),
    new OllamaProvider(), new CustomProvider('synthetic', 'https://synthetic.invalid'), new LocalBridgeProvider('synthetic-user')];
  for (const provider of providers) for (const stream of [true, false]) {
    await assert.rejects(collect(provider, { ...base, stream, responseFormat: format as unknown as GenerateParams['responseFormat'] }), /does not support JSON Schema/);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('other adapters retain their existing omitted/json_object request behavior in both modes', async t => {
  const requests: any[] = [];
  // Return a normal HTTP rejection after capturing the real serialized request.
  // Every adapter must reach its existing network path rather than the schema guard.
  t.mock.method(globalThis, 'fetch', async (_url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    requests.push(JSON.parse(String(init?.body)));
    return Response.json({ error: { message: 'synthetic rejection' } }, { status: 400 });
  });
  const providers = [new AnthropicProvider('synthetic'), new OpenAIProvider('synthetic'), new GoogleProvider('synthetic'),
    new OllamaProvider(), new CustomProvider('synthetic', 'https://synthetic.invalid')];
  for (const provider of providers) for (const stream of [true, false]) for (const responseFormat of [undefined, { type: 'json_object' } as const]) {
    const before = requests.length;
    try { await collect(provider, { ...base, stream, responseFormat }); } catch (error) {
      assert.doesNotMatch(String(error), /does not support JSON Schema/);
    }
    assert.equal(requests.length, before + 1);
    const sent = requests.at(-1);
    if (provider instanceof OpenAIProvider || provider instanceof CustomProvider) assert.deepEqual(sent.response_format, responseFormat);
    if (provider instanceof OllamaProvider) assert.equal(sent.format, responseFormat ? 'json' : undefined);
    if (provider instanceof GoogleProvider) assert.equal(sent.generationConfig.responseMimeType, responseFormat ? 'application/json' : undefined);
    if (provider instanceof AnthropicProvider) assert.equal(sent.response_format, undefined);
  }
  for (const responseFormat of [undefined, { type: 'json_object' } as const]) {
    const chunks = await collect(new LocalBridgeProvider('no-synthetic-connection'), { ...base, responseFormat });
    assert.match((chunks.at(-1) as any).content, /No local model is connected/);
  }
});
