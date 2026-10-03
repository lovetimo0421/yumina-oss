import test from 'node:test';
import assert from 'node:assert/strict';
import { readSessionStorage, writeSessionStorage, removeSessionStorage } from './session-storage';

test('cloud JSON client escapes scoped keys and preserves explicit CAS on write/delete', async () => {
  const original = globalThis.fetch;
  const calls: {url: string; init?: RequestInit}[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({url: String(input), init});
    return Response.json({data: {value: {entryId: 'image'}, version: 7, exists: true}});
  };
  try {
    assert.equal((await readSessionStorage('save', 'gallery:active')).version, 7);
    assert.ok(calls[0]!.url.endsWith('/session-media/session/save/storage/gallery%3Aactive'));
    await writeSessionStorage('save', 'gallery:active', {entryId: 'image'}, {expectedVersion: 7});
    assert.deepEqual(JSON.parse(String(calls[1]!.init!.body)), {value: {entryId: 'image'}, expectedVersion: 7});
    await removeSessionStorage('save', 'gallery:active', {expectedVersion: 8});
    assert.equal(calls[2]!.init!.method, 'DELETE');
    assert.deepEqual(JSON.parse(String(calls[2]!.init!.body)), {expectedVersion: 8});
    await assert.rejects(readSessionStorage('', 'gallery'), /No active session/);
    assert.equal(calls.length, 3);
  } finally { globalThis.fetch = original; }
});

test('a cloud JSON conflict is surfaced without an overwrite retry', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({code: 'SESSION_STORAGE_CONFLICT'}, {status: 409}); };
  try {
    await assert.rejects(writeSessionStorage('save', 'gallery', {}, {expectedVersion: 4}), /SESSION_STORAGE_CONFLICT/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
