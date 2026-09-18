import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { armReadOnlyEviction, makeReadOnlyVerify } from "./pool-guards.js";

type FakeClient = {
  query: (...args: unknown[]) => unknown;
  _queryable?: boolean;
};

function fakePool() {
  return new EventEmitter();
}

test("evicts a client whose promise-style query fails with 25006 (drizzle transaction path)", async () => {
  const pool = fakePool();
  armReadOnlyEviction(pool as never, "primary");

  const client: FakeClient = {
    _queryable: true,
    query: () => Promise.reject(Object.assign(new Error("cannot execute UPDATE in a read-only transaction"), { code: "25006" })),
  };
  pool.emit("connect", client);

  await (client.query() as Promise<unknown>).catch(() => {});
  // allow the guard's .catch microtask to run
  await new Promise((r) => setImmediate(r));
  assert.equal(client._queryable, false);
});

test("evicts a client whose callback-style query fails with 25006 (pool.query path)", async () => {
  const pool = fakePool();
  armReadOnlyEviction(pool as never, "primary");

  const client: FakeClient = {
    _queryable: true,
    query: (...args: unknown[]) => {
      const cb = args[args.length - 1] as (err: unknown) => void;
      cb(Object.assign(new Error("cannot execute INSERT in a read-only transaction"), { code: "25006" }));
    },
  };
  pool.emit("connect", client);

  await new Promise<void>((resolve) => {
    client.query("INSERT ...", [], () => resolve());
  });
  assert.equal(client._queryable, false);
});

test("leaves healthy clients and non-25006 errors alone", async () => {
  const pool = fakePool();
  armReadOnlyEviction(pool as never, "primary");

  const ok: FakeClient = { _queryable: true, query: () => Promise.resolve({ rows: [] }) };
  const otherErr: FakeClient = {
    _queryable: true,
    query: () => Promise.reject(Object.assign(new Error("lock timeout"), { code: "55P03" })),
  };
  pool.emit("connect", ok);
  pool.emit("connect", otherErr);

  await (ok.query() as Promise<unknown>);
  await (otherErr.query() as Promise<unknown>).catch(() => {});
  await new Promise((r) => setImmediate(r));
  assert.equal(ok._queryable, true);
  assert.equal(otherErr._queryable, true);
});

test("query results pass through unchanged (promise and callback styles)", async () => {
  const pool = fakePool();
  armReadOnlyEviction(pool as never, "primary");

  const client: FakeClient = {
    _queryable: true,
    query: (...args: unknown[]) => {
      const cb = args[args.length - 1];
      if (typeof cb === "function") {
        (cb as (err: null, res: unknown) => void)(null, { rows: [{ ok: 1 }] });
        return undefined;
      }
      return Promise.resolve({ rows: [{ ok: 2 }] });
    },
  };
  pool.emit("connect", client);

  const viaPromise = (await (client.query("SELECT 1") as Promise<{ rows: Array<{ ok: number }> }>)).rows[0]!.ok;
  assert.equal(viaPromise, 2);
  const viaCb = await new Promise<number>((resolve) => {
    client.query("SELECT 1", [], (_e: unknown, res: { rows: Array<{ ok: number }> }) => resolve(res.rows[0]!.ok));
  });
  assert.equal(viaCb, 1);
});

test("makeReadOnlyVerify rejects read-only connections and accepts writable ones", async () => {
  const verify = makeReadOnlyVerify("primary");

  const roClient = {
    query: (_sql: string, cb: (err: null, res: { rows: Array<{ transaction_read_only: string }> }) => void) =>
      cb(null, { rows: [{ transaction_read_only: "on" }] }),
  };
  const rwClient = {
    query: (_sql: string, cb: (err: null, res: { rows: Array<{ transaction_read_only: string }> }) => void) =>
      cb(null, { rows: [{ transaction_read_only: "off" }] }),
  };

  const roResult = await new Promise<unknown>((resolve) => verify(roClient as never, resolve));
  assert.ok(roResult instanceof Error, "read-only connection must be rejected");

  const rwResult = await new Promise<unknown>((resolve) => verify(rwClient as never, resolve));
  assert.equal(rwResult, undefined);
});
