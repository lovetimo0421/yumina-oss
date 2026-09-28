import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadSessionImage } from './session-media';

test('an expired upload restarts once without changing the gallery entry', async () => {
  const original = globalThis.fetch;
  const reservations: Array<{ id: string; entryId: string }> = [];
  let puts = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/session-media/uploads')) {
      reservations.push(JSON.parse(String(init?.body)));
      return reservations.length === 1
        ? Response.json({ code: 'MEDIA_UPLOAD_EXPIRED' }, { status: 409 })
        : Response.json({ data: { complete: false, uploadUrl: 'https://storage.test/upload' } });
    }
    if (url === 'https://storage.test/upload') { puts++; return new Response(null, { status: 200 }); }
    assert.ok(url.endsWith(`/uploads/${reservations[1]!.id}/complete`));
    return Response.json({ data: { mediaId: 'media', entryId: 'entry' } });
  };
  try {
    await uploadSessionImage('session', new Blob(['image'], { type: 'image/png' }), { uploadId: 'original', entryId: 'entry', filename: 'map.png' });
    assert.equal(reservations.length, 2);
    assert.notEqual(reservations[0]!.id, reservations[1]!.id);
    assert.deepEqual(reservations.map(x => x.entryId), ['entry', 'entry']);
    assert.equal(puts, 1);
  } finally { globalThis.fetch = original; }
});

test('quota failures never retry or send image bytes', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ code: 'MEDIA_QUOTA_EXCEEDED' }, { status: 413 }); };
  try {
    await assert.rejects(uploadSessionImage('session', new Blob(['image'], { type: 'image/png' })), /MEDIA_QUOTA_EXCEEDED/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
