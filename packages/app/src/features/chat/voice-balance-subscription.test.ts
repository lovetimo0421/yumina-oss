import test from 'node:test';
import assert from 'node:assert/strict';
import { attempt, identity, fixture, connect } from './voice-balance-test-support';
import type { VoiceEvent } from '../../../sandbox/voice-types';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => resolve = done); return { promise, resolve }; }
function journal(last = 2, after = 0, size = 100) {
  return { ...identity, status: 'finished', providerState: 'close-confirmed', accountingState: 'complete', finalSeq: last,
    finals: Array.from({ length: Math.min(last - after, size) }, (_, index) => ({ finalSeq: after + index + 1, kind: 'transcription',
      finals: [{ itemId: `input-${after + index + 1}`, contentIndex: 0, role: 'user', text: `Accepted answer ${after + index + 1}` }] })) };
}
const after = (url: string) => Number(new URL(url, 'https://yumina.invalid').searchParams.get('afterFinalSeq') ?? 0);
const transcripts = (events: VoiceEvent[]) => events.filter((event): event is Extract<VoiceEvent, { type: 'transcript' }> => event.type === 'transcript');

test('same-client finish re-delivers complete groups after a card subscription gap without starting voice', async () => {
  const receipt = journal(); receipt.finals[0]!.kind = 'response'; receipt.finals[0]!.finals[0]!.role = 'assistant';
  receipt.finals[0]!.finals.push({ itemId: 'input-1', contentIndex: 1, role: 'assistant', text: 'Second accepted content part' });
  let listening = false; const received: VoiceEvent[] = [];
  const f = await fixture(() => receipt, event => { if (listening) received.push(event); });
  assert.equal((await f.client.finish()).status, 'finished'); assert.equal(transcripts(received).length, 0);
  const original = transcripts(f.events); listening = true;
  const result = await f.client.finish(); assert.equal(result.status, 'finished');
  if (result.status === 'finished') assert.equal(result.lastFinalSeq, 2);
  assert.deepEqual(transcripts(received), original, 'the remounted subscriber gets every stable group member');
  assert.equal(transcripts(received).length, 3);
  assert.equal(f.urls.some(url => url.endsWith('/start')), false); assert.equal(f.socket.sent.length, 0);
  f.client.dispose();
});

test('a second explicit finish has its own full drain while an earlier finish page is in flight', async () => {
  let posts = 0, listening = false, firstDone = false; const received: VoiceEvent[] = [], page = deferred<ReturnType<typeof journal>>();
  const f = await fixture(url => {
    if (url.endsWith('/finish')) return ++posts === 1 ? journal(2, 0, 1) : journal();
    return page.promise;
  }, event => { if (listening) received.push(event); });
  const first = f.client.finish().then(value => { firstDone = true; return value; }); await flush();
  assert.ok(f.urls.some(url => url.includes('afterFinalSeq=1')));
  listening = true; const second = f.client.finish();
  try {
    await flush(); assert.equal(posts, 2, 'each invocation obtains a fresh exact-call receipt');
    assert.deepEqual(transcripts(received).map(event => event.native?.finalSeq), [1, 2]);
    assert.equal(firstDone, false, 'the new drain does not reuse or wait for an older subscriber drain');
    const result = await second; assert.equal(result.status, 'finished');
    page.resolve(journal(2, 1)); await first;
    assert.deepEqual(transcripts(received).map(event => event.native?.finalSeq), [1, 2, 2]);
  } finally { page.resolve(journal(2, 1)); await Promise.allSettled([first, second]); f.client.dispose(); }
});

test('explicit finish cannot reuse an in-flight prefetch or background final replay', async t => {
  for (const background of ['prefetch', 'final'] as const) await t.test(background, async () => {
    const held = deferred<ReturnType<typeof journal>>(), received: VoiceEvent[] = []; let hold = true;
    const f = await fixture(url => {
      if (url.endsWith('/start') || url.endsWith('/stop')) return { ...identity, status: 'pending', finalSeq: 0, finals: [] };
      if (url.endsWith('/finish')) return journal(2, 0, 1);
      if (hold) { hold = false; return held.promise; }
      return journal(2, after(url));
    }, event => received.push(event));
    let prefetch: Promise<void> | undefined;
    if (background === 'prefetch') prefetch = f.client.recover();
    else { await connect(f); f.socket.event({ type: 'final', epoch: 1, finalSeq: 1, delivery: 'input', attempt }); }
    await flush(); const finish = f.client.finish();
    try {
      await flush(); assert.ok(f.urls.some(url => url.includes('/status?afterFinalSeq=1')), 'fresh finish pages bypass a retained replay promise');
      assert.deepEqual(transcripts(received).map(event => event.native?.finalSeq), [1, 2]);
      assert.equal((await finish).status, 'finished');
    } finally { held.resolve(journal()); await Promise.allSettled([finish, ...(prefetch ? [prefetch] : [])]); await flush(); f.client.dispose(); }
  });
});

test('every finish restarts bounded journal pagination at zero for a replacement subscriber', async () => {
  let listening = false; const received: VoiceEvent[] = [];
  const f = await fixture(url => journal(201, after(url)), event => { if (listening) received.push(event); });
  await f.client.finish(); listening = true;
  const result = await f.client.finish(); assert.equal(result.status, 'finished');
  if (result.status === 'finished') assert.equal(result.lastFinalSeq, 201);
  assert.deepEqual(transcripts(received).map(event => event.native?.finalSeq), Array.from({ length: 201 }, (_, index) => index + 1));
  assert.deepEqual(f.urls.filter(url => url.includes('/status?')).map(after), [100, 200, 100, 200]);
  f.client.dispose();
});

test('repeat drains retain exact group and member conflict history, epoch and attempt fences', async t => {
  for (const change of ['text', 'membership', 'kind', 'reused-member', 'regressed-cursor', 'epoch', 'attempt'] as const) await t.test(change, async () => {
    let changed = false;
    const f = await fixture(() => {
      const value = journal(); if (!changed) return value;
      if (change === 'text') value.finals[0]!.finals[0]!.text = 'Altered accepted answer';
      if (change === 'membership') value.finals[0]!.finals.push({ itemId: 'added', contentIndex: 0, role: 'user', text: 'Forged extra member' });
      if (change === 'kind') value.finals[0]!.kind = 'response';
      if (change === 'reused-member') value.finals[1]!.finals[0] = { ...value.finals[0]!.finals[0]! };
      if (change === 'regressed-cursor') { value.finalSeq = 1; value.finals.pop(); }
      if (change === 'epoch') value.epoch = 0;
      if (change === 'attempt') value.attempt = { ...attempt, cardAttemptId: 'foreign' };
      return value;
    });
    await f.client.finish(); changed = true;
    await assert.rejects(f.client.finish(), /identity|group|regress|call|scope|bound/i);
    assert.equal(transcripts(f.events).some(event => event.text.includes('Altered') || event.text.includes('Forged')), false);
    f.client.dispose();
  });
});

test('fresh drains fail closed on page exhaustion and scope replacement during a page', async t => {
  await t.test('bounded pages', async () => {
    const f = await fixture(url => journal(501, after(url)));
    await assert.rejects(f.client.finish(), /bound/i);
    assert.equal(f.urls.filter(url => url.includes('/status?')).length, 4); f.client.dispose();
  });
  await t.test('scope replacement', async () => {
    const page = deferred<ReturnType<typeof journal>>();
    const f = await fixture(url => url.endsWith('/finish') ? journal(2, 0, 1) : page.promise);
    const finish = f.client.finish(), rejected = assert.rejects(finish, /scope|unavailable/i); await flush();
    f.replace(); page.resolve(journal(2, 1)); await rejected;
    assert.deepEqual(transcripts(f.events).map(event => event.native?.finalSeq), [1]); f.client.dispose();
  });
});

test('a late full drain cannot restore journal contents after authoritative redaction', async () => {
  const page = deferred<ReturnType<typeof journal>>(); let posts = 0;
  const f = await fixture(url => {
    if (url.includes('/recover/finish')) return journal();
    if (url.endsWith('/finish') && ++posts === 1) return page.promise;
    return { ...identity, status: 'unavailable', providerState: 'unconfirmed', accountingState: 'incomplete', receiptAvailability: 'redacted' };
  });
  await f.client.finish(); f.events.length = 0;
  const late = f.client.finish(); await flush();
  assert.equal((await f.client.finish()).status, 'unavailable');
  const rejected = assert.rejects(late, /redact/i); page.resolve(journal()); await rejected;
  assert.equal(transcripts(f.events).length, 0); f.client.dispose();
});

test('a completed page cannot certify an older cursor after an interleaved drain observes a newer group', async () => {
  const olderPage = deferred<ReturnType<typeof journal>>(), newerPage = deferred<ReturnType<typeof journal>>(); let pages = 0;
  const f = await fixture(url => url.endsWith('/finish')
    ? { ...journal(1), status: 'pending', providerState: 'open', accountingState: 'pending' }
    : ++pages === 1 ? olderPage.promise : newerPage.promise);
  const older = f.client.finish(); await flush();
  const newer = f.client.finish(); await flush();
  const rejected = assert.rejects(older, /fully delivered|regress/i);
  olderPage.resolve({ ...journal(2, 1), status: 'incomplete', providerState: 'open', accountingState: 'incomplete' });
  newerPage.resolve({ ...journal(3, 1), status: 'incomplete', providerState: 'open', accountingState: 'incomplete' });
  try {
    await rejected; const result = await newer; assert.equal(result.status, 'incomplete');
    if (result.status === 'incomplete') assert.equal(result.lastFinalSeq, 3);
  } finally { await Promise.allSettled([older, newer]); f.client.dispose(); }
});

const openIncomplete = (last: number, cursor = 0) => ({ ...journal(last, cursor), status: 'incomplete', providerState: 'open', accountingState: 'incomplete' });

test('100-group concurrent pages retain reported high-water while the newer tail is still undelivered', async () => {
  const olderPage = deferred<ReturnType<typeof journal>>(), newerPage = deferred<ReturnType<typeof journal>>(), tail = deferred<ReturnType<typeof journal>>();
  let posts = 0, pages = 0, newerDone = false;
  const f = await fixture(url => url.endsWith('/finish') ? openIncomplete(++posts === 1 ? 200 : 201)
    : ++pages === 1 ? olderPage.promise : pages === 2 ? newerPage.promise : tail.promise);
  const older = f.client.finish(), rejected = assert.rejects(older, /fully delivered|regress/i); void rejected.catch(() => {}); await flush();
  const newer = f.client.finish().then(value => { newerDone = true; return value; }); await flush();
  olderPage.resolve(openIncomplete(200, 100)); newerPage.resolve(openIncomplete(201, 100));
  try {
    await rejected; await flush();
    assert.equal(newerDone, false); assert.equal(Math.max(...transcripts(f.events).map(event => event.native!.finalSeq)), 200);
    assert.ok(f.urls.some(url => url.endsWith('afterFinalSeq=200')));
    tail.resolve(openIncomplete(201, 200)); const result = await newer;
    assert.equal(result.status, 'incomplete'); if (result.status === 'incomplete') assert.equal(result.lastFinalSeq, 201);
    assert.equal(f.urls.some(url => url.endsWith('/start')), false); assert.equal(f.socket.sent.length, 0);
  } finally { tail.resolve(openIncomplete(201, 200)); await Promise.allSettled([older, newer]); f.client.dispose(); }
});

test('prefetched reported progress survives two older receipt assignments without requiring emission', async () => {
  const olderPages = [deferred<ReturnType<typeof journal>>(), deferred<ReturnType<typeof journal>>()]; let pages = 0, fresh = false;
  const f = await fixture(url => url.includes('/recover?') ? openIncomplete(201)
    : fresh ? openIncomplete(201, after(url)) : url.endsWith('/finish') ? openIncomplete(200) : olderPages[pages++]!.promise);
  const first = f.client.finish(), firstRejected = assert.rejects(first, /fully delivered|regress/i); void firstRejected.catch(() => {}); await flush();
  const second = f.client.finish(), secondRejected = assert.rejects(second, /fully delivered|regress/i); void secondRejected.catch(() => {}); await flush();
  const emitted = transcripts(f.events).length;
  await f.client.recover(); assert.equal(transcripts(f.events).length, emitted, 'prefetch observes progress without delivering records');
  try {
    olderPages[0]!.resolve(openIncomplete(200, 100)); await firstRejected;
    olderPages[1]!.resolve(openIncomplete(200, 100)); await secondRejected;
    assert.equal(transcripts(f.events).some(event => event.native?.finalSeq === 201), false);
    fresh = true; const result = await f.client.finish(); assert.equal(result.status, 'incomplete');
    if (result.status === 'incomplete') assert.equal(result.lastFinalSeq, 201);
    assert.ok(transcripts(f.events).some(event => event.native?.finalSeq === 201));
  } finally { for (const page of olderPages) page.resolve(openIncomplete(200, 100)); await Promise.allSettled([first, second]); f.client.dispose(); }
});

test('a foreign prefetch cannot advance the owned receipt high-water', async () => {
  let foreign = true;
  const f = await fixture(() => foreign ? { ...openIncomplete(201), attempt: { ...attempt, cardAttemptId: 'foreign' } } : journal(1));
  await assert.rejects(f.client.recover(), /scope/i); foreign = false;
  const result = await f.client.finish(); assert.equal(result.status, 'finished');
  if (result.status === 'finished') assert.equal(result.lastFinalSeq, 1); f.client.dispose();
});
