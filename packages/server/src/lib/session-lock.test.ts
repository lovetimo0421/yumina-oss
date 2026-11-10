import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { db } from '../db/index.js';
import { withSessionRowLock, SessionBusyError, SESSION_NOT_FOUND } from './session-lock.js';

const dialect = new PgDialect();
const lock = withSessionRowLock as (...args: any[]) => Promise<any>;
const acknowledged = (userId = 'owner') => ({ acknowledged: { userId } });
const busy = () => Object.assign(Error('lock unavailable'), { code: '55P03' });
function database(execute: (text: string) => Promise<any>, contended = false) {
  mock.method(db, 'transaction', async (fn: any) => fn({ execute: async (query: any) => {
    const text = dialect.sqlToQuery(query).sql;
    if (contended && /FOR NO KEY UPDATE NOWAIT$/.test(text)) throw busy();
    return execute(text);
  } }));
}

test('acknowledged state save queues a non-key writer instead of repeatedly racing a voice share holder', async () => {
  const queries: string[] = [];
  database(async text => {
    queries.push(text);
    if (text.startsWith('SET LOCAL')) return { rows: [] };
    assert.match(text, /FOR NO KEY UPDATE$/);
    assert.doesNotMatch(text, /NOWAIT/);
    return { rows: [{ state: { revision: 2 }, user_id: 'owner' }] };
  }, true);
  try {
    assert.equal(await lock('session', async (_tx: any, row: any) => row.state.revision, acknowledged()), 2);
    assert.match(queries[0]!, /^SET LOCAL lock_timeout='[1-6][0-9]{0,3}ms'$/);
    assert.equal(queries.length, 2);
  } finally { mock.restoreAll(); }
});

test('ordinary session mutation retains immediate FOR UPDATE NOWAIT', async () => {
  database(async text => { assert.match(text, /FOR UPDATE NOWAIT$/); return { rows: [{ state: {}, user_id: 'owner' }] }; });
  try { assert.equal(await withSessionRowLock('ordinary', async () => 'saved'), 'saved'); }
  finally { mock.restoreAll(); }
});

test('acknowledged lock timeout permits one queued attempt after the fast miss and releases waiter capacity', async () => {
  let transactions = 0, saves = 0;
  mock.method(db, 'transaction', async (fn: any) => {
    transactions++;
    return fn({ execute: async (query: any) => {
      if (dialect.sqlToQuery(query).sql.startsWith('SET LOCAL')) return { rows: [] };
      throw Object.assign(Error('lock timeout'), { code: '55P03' });
    } });
  });
  try {
    await assert.rejects(lock('timed-out', async () => { saves++; }, acknowledged()), SessionBusyError);
    assert.equal(transactions, 2); assert.equal(saves, 0);
    await assert.rejects(lock('timed-out', async () => { saves++; }, acknowledged()), SessionBusyError);
    assert.equal(transactions, 4, 'finally released the same scoped waiter');
  } finally { mock.restoreAll(); }
});

test('acknowledged waiters are bounded across tabs and sessions until transactions unwind', async () => {
  const releases: (() => void)[] = [];
  let queued = 0;
  mock.method(db, 'transaction', async (fn: any) => {
    return fn({ execute: async (query: any) => {
      const text = dialect.sqlToQuery(query).sql;
      if (/FOR NO KEY UPDATE NOWAIT$/.test(text)) throw busy();
      if (text.startsWith('SET LOCAL')) return { rows: [] };
      queued++;
      return new Promise(resolve => releases.push(() => resolve({ rows: [{ state: {}, user_id: 'owner' }] })));
    } });
  });
  try {
    const first = lock('one', async () => 'saved', acknowledged());
    for (let n = 0; n < 10; n++) await Promise.resolve();
    await assert.rejects(Promise.race([lock('one', async () => 'duplicate', acknowledged()),
      new Promise((_, reject) => setTimeout(() => reject(Error('Duplicate waiter entered database')), 40))]), SessionBusyError);
    const second = lock('two', async () => 'saved', acknowledged());
    for (let n = 0; n < 10; n++) await Promise.resolve();
    await assert.rejects(lock('three', async () => 'overflow', acknowledged('other')), SessionBusyError);
    assert.equal(queued, 2);
    releases.shift()!(); await first;
    const third = lock('three', async () => 'saved', acknowledged('other'));
    for (let n = 0; n < 10; n++) await Promise.resolve();
    assert.equal(queued, 3);
    releases.shift()!(); releases.shift()!(); await Promise.all([second, third]);
  } finally { for (const release of releases) release(); mock.restoreAll(); }
});

test('missing or wrong-owner acknowledged session does not invoke mutation and releases capacity', async () => {
  let wrongOwner = false, mutations = 0;
  database(async text => text.startsWith('SET LOCAL') ? { rows: [] } : { rows: wrongOwner ? [{ state: {}, user_id: 'foreign' }] : [] });
  try {
    assert.equal(await lock('missing', async () => { mutations++; }, acknowledged()), SESSION_NOT_FOUND);
    wrongOwner = true;
    assert.equal(await lock('missing', async () => { mutations++; }, acknowledged()), SESSION_NOT_FOUND);
    assert.equal(mutations, 0);
  } finally { mock.restoreAll(); }
});

test('save rejection leaves no retained acknowledged waiter', async () => {
  database(async text => text.startsWith('SET LOCAL') ? { rows: [] } : { rows: [{ state: {}, user_id: 'owner' }] });
  try {
    await assert.rejects(lock('rollback', async () => { throw Error('save rejected'); }, acknowledged()), /save rejected/);
    assert.equal(await lock('rollback', async () => 'retry saved', acknowledged()), 'retry saved');
  } finally { mock.restoreAll(); }
});

test('time spent waiting for a pooled transaction consumes the same contention deadline before mutation', async () => {
  let clock = 0, mutations = 0;
  mock.method(performance, 'now', () => clock);
  mock.method(db, 'transaction', async (fn: any) => {
    clock = 6041;
    return fn({ execute: async () => { throw Error('Expired operation entered SQL'); } });
  });
  try { await assert.rejects(lock('expired', async () => { mutations++; }, acknowledged()), SessionBusyError); assert.equal(mutations, 0); }
  finally { mock.restoreAll(); }
});

test('cancelled acknowledged request never enters SQL or mutation', async () => {
  const controller = new AbortController(); controller.abort(Error('request cancelled'));
  database(async () => { throw Error('Cancelled request entered SQL'); });
  try { await assert.rejects(lock('cancelled', async () => 'unsafe', { acknowledged: { userId: 'owner', signal: controller.signal } }), /request cancelled/); }
  finally { mock.restoreAll(); }
});

test('cancellation while queued retains capacity through lock completion and rollback, then permits retry', async () => {
  const controller = new AbortController();
  let release!: () => void, entered!: () => void, mutations = 0;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  database(async text => {
    if (text.startsWith('SET LOCAL')) return { rows: [] };
    entered(); await new Promise<void>(resolve => { release = resolve; });
    return { rows: [{ state: {}, user_id: 'owner' }] };
  }, true);
  try {
    const save = lock('cancelled-waiter', async () => { mutations++; }, { acknowledged: { userId: 'owner', signal: controller.signal } });
    const rejected = assert.rejects(save, /request cancelled/);
    await waiting; controller.abort(Error('request cancelled'));
    await assert.rejects(lock('cancelled-waiter', async () => 'duplicate', acknowledged()), SessionBusyError);
    release(); await rejected; assert.equal(mutations, 0);
    mock.restoreAll(); database(async text => text.startsWith('SET LOCAL') ? { rows: [] } : { rows: [{ state: {}, user_id: 'owner' }] });
    assert.equal(await lock('cancelled-waiter', async () => 'retry', acknowledged()), 'retry');
  } finally { release?.(); mock.restoreAll(); }
});

test('known cancellation during state-only callback rolls the transaction back before commit', async () => {
  const controller = new AbortController();
  database(async text => text.startsWith('SET LOCAL') ? { rows: [] } : { rows: [{ state: {}, user_id: 'owner' }] });
  try {
    await assert.rejects(lock('cancelled-callback', async () => { controller.abort(Error('request cancelled')); return 'unacknowledged'; },
      { acknowledged: { userId: 'owner', signal: controller.signal } }), /request cancelled/);
  } finally { mock.restoreAll(); }
});

test('four independent uncontended acknowledged saves all enter their state-only callbacks', async () => {
  let entered = 0, release!: () => void;
  const body = new Promise<void>(resolve => { release = resolve; });
  database(async () => ({ rows: [{ state: {}, user_id: 'owner' }] }));
  const saving = Array.from({ length: 4 }, (_, index) => lock(`healthy-${index}`, async () => { entered++; await body; return 'saved'; }, acknowledged()));
  const outcomes = Promise.allSettled(saving);
  try {
    for (let n = 0; n < 10; n++) await Promise.resolve();
    assert.equal(entered, 4, 'healthy independent saves must not consume queued-waiter capacity');
  } finally { release(); await outcomes; mock.restoreAll(); }
  assert.ok((await outcomes).every(result => result.status === 'fulfilled'));
});

test('fast lock miss consumes the original contention budget before the one queued attempt', async () => {
  let clock = 0, waiting = false;
  mock.method(performance, 'now', () => clock);
  database(async text => {
    if (/NOWAIT$/.test(text)) { clock = 5000; throw busy(); }
    if (text.startsWith('SET LOCAL')) { assert.equal(text, "SET LOCAL lock_timeout='1040ms'"); waiting = true; return { rows: [] }; }
    return { rows: [{ state: {}, user_id: 'owner' }] };
  });
  try { assert.equal(await lock('remaining-budget', async () => 'saved', acknowledged()), 'saved'); assert.equal(waiting, true); }
  finally { mock.restoreAll(); }
});

test('a state callback error with SQLSTATE55P03 is rolled back without replaying the callback', async () => {
  let mutations = 0;
  database(async text => { assert.match(text, /NOWAIT$/); return { rows: [{ state: {}, user_id: 'owner' }] }; });
  const error = busy();
  try {
    await assert.rejects(lock('callback-error', async () => { mutations++; throw error; }, acknowledged()), value => value === error);
    assert.equal(mutations, 1);
  } finally { mock.restoreAll(); }
});
