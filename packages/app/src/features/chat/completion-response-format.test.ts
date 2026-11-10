import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { buildAPI, receiveStreamChunk } from '../../../sandbox/sandbox-context';
import type { SandboxState } from '../../../sandbox/protocol';
import { createSideCallStreamReader } from './side-call-stream';
import { buildSideCompletionRequest } from './side-completion-request';

const format = { type: 'json_schema', json_schema: { name: 'decision_v1', strict: true, schema: {
  type: 'object', properties: { action: { type: 'string', enum: ['wait'] } }, required: ['action'], additionalProperties: false,
} } } as const;

test('real SDK streaming payload preserves the full optional format and selected-model default', async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let sent: any;
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { search: '' }, parent: { postMessage: (message: any) => { sent = structuredClone(message).payload; } },
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  // Do not leave the SDK's normal 120s cleanup timer alive in this focused test.
  t.mock.method(globalThis, 'setTimeout', (() => 0) as any);
  const api = buildAPI({ mode: 'session', sessionId: 'session-test', selectedModel: 'chosen-model', variables: {}, globalVariables: {}, messages: [] } as unknown as SandboxState);
  for (const responseFormat of [undefined, { type: 'json_object' } as const, format]) {
    const promise = api.ai.complete({ messages: [{ role: 'user', content: 'Choose' }], responseFormat } as Parameters<typeof api.ai.complete>[0]);
    assert.equal(sent.method, 'ai.complete');
    receiveStreamChunk(sent.callId, '', true, '{}');
    assert.equal(await promise, '{}');
    assert.deepEqual(sent.args[0].responseFormat, responseFormat);
    assert.equal(sent.args[0].model, 'chosen-model');
  }
});

test('execute the real host streaming callback: format survives the HTTP JSON body and SSE result', async t => {
  // Extract the actual callback's AST, isolating it from renderer stores, media and UI.
  // This executes the production allowlist and fetch/error/SSE code, not a copied implementation.
  const source = readFileSync(new URL('./world-renderer.tsx', import.meta.url), 'utf8');
  const file = ts.createSourceFile('world-renderer.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'handleStreamCall' && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(file); assert.ok(callback);
  const output = ts.transpileModule(`const callback = ${callback.getText(file)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  // The callback builds its body through the real allowlisted request builder, reading the player's settings at call time.
  const handle = new Function('mode', 'sessionIdRef', 'createSideCallStreamReader', 'buildSideCompletionRequest', 'useConfigStore', `${output}\nreturn callback;`)(
    'session', { current: 'session-test' }, createSideCallStreamReader, buildSideCompletionRequest, { getState: () => ({}) });
  const requests: any[] = [];
  t.mock.method(globalThis, 'fetch', async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    assert.equal(url, '/api/sessions/session-test/completions');
    assert.equal(init?.credentials, 'include');
    requests.push(JSON.parse(String(init?.body)));
    return new Response('event: done\ndata: {"content":"{}"}\n\n');
  });
  for (const responseFormat of [undefined, { type: 'json_object' } as const, format]) {
    const result = await new Promise((resolve, reject) => handle('ai.complete', [{ messages: [{ role: 'user', content: 'Choose' }], model: 'chosen-model', responseFormat }], { onDelta: () => {}, onDone: resolve, onError: reject }));
    assert.equal(result, '{}');
    assert.deepEqual(requests.at(-1).responseFormat, responseFormat);
    assert.equal(requests.at(-1).model, 'chosen-model');
  }
});
