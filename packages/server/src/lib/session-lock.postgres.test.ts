import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { withSessionRowLock, SessionBusyError, SESSION_NOT_FOUND } from './session-lock.js';

const url = process.env.SESSION_STATE_TEST_DATABASE_URL;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function latch() {
  let release!: () => void;
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<void>((resolve, reject) => {
    timer = setTimeout(() => reject(Error('FIXTURE_BARRIER_TIMEOUT')), 60000);
    release = () => { clearTimeout(timer); resolve(); };
  });
  void promise.catch(() => {});
  return { promise, release };
}

test('PostgreSQL: acknowledged state save progresses between voice gate transactions with original guards and bounded waits',
  { skip: !url, timeout: 180000 }, async () => {
  const name = `session_state_test_${randomUUID().replaceAll('-', '')}`;
  assert.match(name, /^session_state_test_[a-f0-9]{32}$/);
  const labels = ['admin', 'save', 'voice-first', 'voice-later', 'observer'];
  const pools = labels.map(label => new pg.Pool({ connectionString: url, max: 1,
    application_name: `${name}_${label}`, connectionTimeoutMillis: 10000,
    statement_timeout: 15000, query_timeout: 20000, idleTimeoutMillis: 1000 }));
  const [admin, save, first, later, observer] = pools as [pg.Pool, pg.Pool, pg.Pool, pg.Pool, pg.Pool];
  const releases = new Set<() => void>(), tasks = new Set<Promise<unknown>>();
  const hold = () => { const b = latch(); releases.add(b.release); return b; };
  function track<T>(task: Promise<T>): Promise<T> { tasks.add(task); void task.then(() => tasks.delete(task), () => tasks.delete(task)); return task; }
  async function scoped<T>(pool: pg.Pool, fn: (tx: any) => Promise<T>): Promise<T> {
    return drizzle(pool).transaction(async tx => {
      await tx.execute(sql.raw(`SET LOCAL search_path TO "${name}",pg_catalog`));
      await tx.execute(sql`SET LOCAL lock_timeout='12s'`);
      await tx.execute(sql`SET LOCAL idle_in_transaction_session_timeout='60s'`);
      return fn(tx);
    });
  }
  async function fixture() {
    const owner = randomUUID(), session = randomUUID();
    await scoped(admin, async tx => {
      await tx.execute(sql`INSERT INTO "user" (id,banned) VALUES (${owner},false)`);
      await tx.execute(sql`INSERT INTO play_sessions (id,user_id,state) VALUES (${session},${owner},${JSON.stringify({ attempt: 'current', saved: 0 })}::jsonb)`);
      await tx.execute(sql`INSERT INTO wallet (id,user_id,hold) VALUES (${owner},${owner},800)`);
      await tx.execute(sql`INSERT INTO voice_call (id,user_id,session_id,attempt,samples) VALUES (${owner},${owner},${session},'current',0)`);
    });
    return { owner, session };
  }
  async function gate(pool: pg.Pool, f: { owner: string; session: string }, after: (state: any) => Promise<void>) {
    return scoped(pool, async tx => {
      // The production user -> session KEY SHARE -> current-attempt SHARE ->
      // wallet -> call graph. No simplified SHARE-only ordering claim.
      const user = (await tx.execute(sql`SELECT id,banned FROM "user" WHERE id=${f.owner} FOR NO KEY UPDATE`)).rows[0];
      assert.equal(user.banned, false);
      await tx.execute(sql`SELECT id FROM play_sessions WHERE id=${f.session} AND user_id=${f.owner} FOR KEY SHARE`);
      const state = (await tx.execute(sql`SELECT state FROM play_sessions WHERE id=${f.session} AND user_id=${f.owner} FOR SHARE`)).rows[0]?.state;
      if (!state || state.attempt !== 'current') throw Error('VOICE_SCOPE_MISMATCH');
      const wallet = (await tx.execute(sql`SELECT hold FROM wallet WHERE id=${f.owner} FOR UPDATE`)).rows[0];
      assert.equal(wallet.hold, 800);
      const call = (await tx.execute(sql`SELECT attempt,samples FROM voice_call WHERE id=${f.owner} FOR UPDATE`)).rows[0];
      assert.equal(call.attempt, 'current'); assert.equal(call.samples, 0);
      await after(state);
    });
  }
  async function blocked(label: string, queryPart?: RegExp) {
    const until = performance.now() + 15000;
    while (performance.now() < until) {
      const result = await observer.query('SELECT wait_event_type,query FROM pg_stat_activity WHERE application_name=$1', [`${name}_${label}`]);
      if (result.rows.some(row => row.wait_event_type === 'Lock' && (!queryPart || queryPart.test(row.query)))) return;
      await delay(25);
    }
    throw Error('FIXTURE_EXPECTED_LOCK_WAITER');
  }
  try {
    await admin.query(`CREATE SCHEMA "${name}"`);
    await admin.query(`CREATE TABLE "${name}"."user" (id text PRIMARY KEY,banned boolean NOT NULL);
      CREATE TABLE "${name}".play_sessions (id text PRIMARY KEY,user_id text NOT NULL REFERENCES "${name}"."user",state jsonb NOT NULL);
      CREATE TABLE "${name}".wallet (id text PRIMARY KEY,user_id text NOT NULL REFERENCES "${name}"."user",hold integer NOT NULL);
      CREATE TABLE "${name}".voice_call (id text PRIMARY KEY,user_id text NOT NULL,session_id text NOT NULL,attempt text NOT NULL,samples integer NOT NULL)`);
    let helperTransactions = 0, healthyPoolOrdinal: number | null = null, duplicatePool: pg.Pool | null = null;
    const healthyPools = [save, first, later, observer];
    mock.method(db, 'transaction', (fn: any) => {
      helperTransactions++;
      const pool = duplicatePool ?? (healthyPoolOrdinal === null ? save : healthyPools[healthyPoolOrdinal++ % healthyPools.length]!);
      return scoped(pool, fn);
    });

    // Existing/default path is the production failure mechanism: busy gates
    // never register a writer in the database's lock wait queue.
    const red = await fixture(), redHeld = hold(), redAcquired = latch();
    let redHolderState = 'pending';
    const redGate = track(gate(first, red, async () => { redAcquired.release(); await redHeld.promise; }));
    void redGate.then(() => { redHolderState = 'committed'; }, () => { redHolderState = 'rejected'; });
    await redAcquired.promise;
    let redSaves = 0;
    const redStarted = performance.now();
    await assert.rejects(withSessionRowLock(red.session, async () => { redSaves++; }), SessionBusyError);
    assert.equal(redSaves, 0); assert.equal(helperTransactions, 8); assert.equal(redHolderState, 'pending');
    console.log(`SESSION_STATE_DEFAULT_RED_TIMING=${JSON.stringify({ milliseconds: Math.round(performance.now() - redStarted), attempts: helperTransactions, holderState: redHolderState })}`);
    redHeld.release(); await redGate;
    console.log('SESSION_STATE_DEFAULT_RED_SESSION_BUSY=true');

    const healthy = await Promise.all(Array.from({ length: 4 }, () => fixture()));
    const allHealthyEntered = latch(), releaseHealthy = hold();
    let healthyEntered = 0;
    healthyPoolOrdinal = 0;
    const healthyWrites = track(Promise.all(healthy.map(f => withSessionRowLock(f.session, async tx => {
      if (++healthyEntered === 4) allHealthyEntered.release();
      await releaseHealthy.promise;
      await tx.execute(sql`UPDATE play_sessions SET state='{"attempt":"current","saved":1}'::jsonb WHERE id=${f.session}`);
      return 'saved';
    }, { acknowledged: { userId: f.owner } }))));
    await allHealthyEntered.promise;
    assert.equal(healthyEntered, 4, 'uncontended writers are not globally capped');
    releaseHealthy.release(); assert.deepEqual(await healthyWrites, ['saved', 'saved', 'saved', 'saved']);
    healthyPoolOrdinal = null;
    console.log('SESSION_STATE_FOUR_INDEPENDENT_HEALTHY_SAVES=true');

    const compatible = await fixture(), keyHeld = hold(), keyAcquired = latch();
    const keyReader = track(scoped(first, async tx => {
      await tx.execute(sql`SELECT id FROM play_sessions WHERE id=${compatible.session} FOR KEY SHARE`);
      keyAcquired.release(); await keyHeld.promise;
    }));
    await keyAcquired.promise;
    assert.equal(await withSessionRowLock(compatible.session, async tx => {
      await tx.execute(sql`UPDATE play_sessions SET state='{"attempt":"current","saved":1}'::jsonb WHERE id=${compatible.session}`);
      return 'saved while key reader held';
    }, { acknowledged: { userId: compatible.owner } }), 'saved while key reader held');
    keyHeld.release(); await keyReader;
    console.log('SESSION_STATE_KEY_SHARE_READER_COMPATIBLE=true');

    for (const changedAttempt of [false, true]) {
      const f = await fixture(), acquired = latch(), releaseFirst = hold(), writerAcquired = latch(), releaseWriter = hold();
      const order: string[] = [];
      const firstGate = track(gate(first, f, async () => { acquired.release(); await releaseFirst.promise; }));
      await acquired.promise;
      const writing = track(withSessionRowLock(f.session, async (tx, row) => {
        assert.equal(row.userId, f.owner); order.push('writer'); writerAcquired.release();
        await tx.execute(sql`UPDATE play_sessions SET state=${JSON.stringify({ attempt: changedAttempt ? 'next' : 'current', saved: 1 })}::jsonb WHERE id=${f.session}`);
        await releaseWriter.promise;
        return 'acknowledged';
      }, { acknowledged: { userId: f.owner } }));
      await blocked('save');
      const laterGate = track(gate(later, f, async state => { order.push('later-voice'); assert.equal(state.saved, 1); }));
      // Attach rejection handling before releasing the prior guard.
      const result = Promise.allSettled([writing, laterGate]);
      await blocked('voice-later');
      await delay(2300); releaseFirst.release(); await firstGate;
      await writerAcquired.promise;
      await blocked('voice-later', /play_sessions.*FOR SHARE/);
      assert.deepEqual(order, ['writer']);
      releaseWriter.release();
      const outcomes = await result;
      assert.equal(outcomes[0]!.status, 'fulfilled');
      if (changedAttempt) {
        assert.equal(outcomes[1]!.status, 'rejected');
        assert.match(String((outcomes[1] as PromiseRejectedResult).reason), /VOICE_SCOPE_MISMATCH/);
      } else {
        assert.equal(outcomes[1]!.status, 'fulfilled'); assert.deepEqual(order, ['writer', 'later-voice']);
      }
      const audit = await scoped<{ rows: { hold: number; samples: number }[] }>(admin, tx => tx.execute(sql`SELECT hold,samples FROM wallet JOIN voice_call USING(id) WHERE id=${f.owner}`));
      assert.equal(audit.rows[0]!.hold, 800); assert.equal(audit.rows[0]!.samples, 0);
      console.log(`SESSION_STATE_QUEUED_WRITER_${changedAttempt ? 'STALE_SCOPE_REJECTED' : 'VOICE_RENEWAL_SEES_SAVE'}=true`);
    }

    const exhausted = await fixture(), held = hold(), acquired = latch();
    const slowGate = track(gate(first, exhausted, async () => { acquired.release(); await held.promise; }));
    await acquired.promise;
    let timeoutWrites = 0;
    const start = performance.now();
    await assert.rejects(withSessionRowLock(exhausted.session, async () => { timeoutWrites++; }, { acknowledged: { userId: exhausted.owner } }), SessionBusyError);
    assert.equal(timeoutWrites, 0);
    assert.ok(performance.now() - start < 14000, 'one bounded wait, not repeated six-second waits');
    held.release(); await slowGate;
    assert.equal((await save.query('SHOW lock_timeout')).rows[0].lock_timeout, '0', 'SET LOCAL rolled back with the timed-out transaction');
    assert.equal(await withSessionRowLock(exhausted.session, async () => 'retry', { acknowledged: { userId: exhausted.owner } }), 'retry');
    console.log('SESSION_STATE_TIMEOUT_ROLLBACK_CAPACITY_RELEASED=true');

    const cancelled = await fixture(), cancellationHeld = hold(), cancellationAcquired = latch(), abort = new AbortController();
    const cancellationGate = track(gate(first, cancelled, async () => { cancellationAcquired.release(); await cancellationHeld.promise; }));
    await cancellationAcquired.promise;
    let cancelledWrites = 0;
    const cancelledSave = track(withSessionRowLock(cancelled.session, async () => { cancelledWrites++; }, { acknowledged: { userId: cancelled.owner, signal: abort.signal } }));
    const cancelledResult = assert.rejects(cancelledSave, /synthetic request cancelled/);
    void cancelledResult.catch(() => {});
    await blocked('save'); abort.abort(Error('synthetic request cancelled'));
    // The duplicate's fast miss needs its own connection while the original
    // queued transaction still owns save's sole connection and waiter slot.
    duplicatePool = observer;
    try {
      await assert.rejects(withSessionRowLock(cancelled.session, async () => { cancelledWrites++; }, { acknowledged: { userId: cancelled.owner } }), SessionBusyError);
    } finally { duplicatePool = null; }
    cancellationHeld.release(); await cancellationGate; await cancelledResult;
    assert.equal(cancelledWrites, 0);
    assert.equal(await withSessionRowLock(cancelled.session, async () => 'retry', { acknowledged: { userId: cancelled.owner } }), 'retry');
    assert.equal((await save.query('SHOW lock_timeout')).rows[0].lock_timeout, '0');
    console.log('SESSION_STATE_CANCELLED_WAITER_ROLLED_BACK_BEFORE_CAPACITY_RELEASE=true');

    const rollback = await fixture();
    await assert.rejects(withSessionRowLock(rollback.session, async tx => {
      await tx.execute(sql`UPDATE play_sessions SET state='{"attempt":"next","saved":1}'::jsonb WHERE id=${rollback.session}`);
      throw Error('synthetic save rejected');
    }, { acknowledged: { userId: rollback.owner } }), /synthetic save rejected/);
    await gate(first, rollback, async state => assert.equal(state.saved, 0));
    assert.equal(await withSessionRowLock(rollback.session, async () => 'retry', { acknowledged: { userId: rollback.owner } }), 'retry');
    console.log('SESSION_STATE_SAVE_ERROR_ROLLED_BACK=true');

    const deleted = await fixture(), deleteWriterAcquired = latch(), releaseDeleteWriter = hold();
    const beforeDeletion = track(withSessionRowLock(deleted.session, async () => {
      deleteWriterAcquired.release(); await releaseDeleteWriter.promise; return 'saved';
    }, { acknowledged: { userId: deleted.owner } }));
    await deleteWriterAcquired.promise;
    let deleteCompleted = false;
    const deleting = track(scoped(later, tx => tx.execute(sql`DELETE FROM play_sessions WHERE id=${deleted.session}`)).then(() => { deleteCompleted = true; }));
    await blocked('voice-later', /DELETE FROM play_sessions/);
    assert.equal(deleteCompleted, false, 'deletion cannot invalidate a locked save before it commits');
    releaseDeleteWriter.release(); assert.equal(await beforeDeletion, 'saved'); await deleting;
    let deletedWrites = 0;
    assert.equal(await withSessionRowLock(deleted.session, async () => { deletedWrites++; }, { acknowledged: { userId: deleted.owner } }), SESSION_NOT_FOUND);
    assert.equal(deletedWrites, 0);
    console.log('SESSION_STATE_DELETED_SESSION_NOT_SAVED=true');
  } finally {
    for (const release of releases) release();
    await Promise.allSettled([...tasks]);
    mock.restoreAll();
    try {
      await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
      const retained = await admin.query('SELECT count(*) AS count FROM pg_namespace WHERE nspname=$1', [name]);
      assert.equal(Number(retained.rows[0].count), 0);
      console.log('SESSION_STATE_OWNED_SCHEMA_REMOVED=true');
    } finally { await Promise.all(pools.map(pool => pool.end())); }
  }
});
