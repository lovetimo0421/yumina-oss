import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import pg from "pg";
import { armConnectionErrorHandling } from "./pool-guards.js";

type DriverClient = pg.Client & {
  _queryable: boolean;
  _handleErrorMessage(error: Error): void;
  _handleErrorEvent(error: Error): void;
};

function connectionFailure() {
  return Object.assign(new Error("server conn crashed?"), { code: "08P01", severity: "FATAL" });
}

for (const label of ["primary", "read"]) {
  test(`${label}: a fatal connection error between queries does not escape the client`, async () => {
    const pool = new EventEmitter();
    armConnectionErrorHandling(pool as pg.Pool, label);
    const client = new pg.Client() as DriverClient;
    pool.emit("connect", client);
    pool.emit("connect", client);
    assert.equal(client.listenerCount("error"), 1, "install once for the life of a connection");
    assert.doesNotThrow(() => client._handleErrorMessage(connectionFailure()));
    assert.equal(client._queryable, false);
    await assert.rejects(client.query("SELECT 1"), /not queryable/);
  });
}

test("pending queries still reject with the actual connection error", async () => {
  const pool = new EventEmitter();
  armConnectionErrorHandling(pool as pg.Pool, "primary");
  const client = new pg.Client() as DriverClient;
  pool.emit("connect", client);
  // Not connected to a server: pg queues this query until readyForQuery.
  const query = client.query("SELECT 1");
  const error = connectionFailure();
  assert.doesNotThrow(() => client._handleErrorEvent(error));
  await assert.rejects(query, (caught) => caught === error);
});

/** Real pg-pool lifecycle with only network establishment simulated. */
class LocalClient extends EventEmitter {
  _queryable = true;
  _ending = false;
  connect(done: (error?: Error) => void) { queueMicrotask(() => done()); }
  end(done?: () => void) {
    this._ending = true;
    queueMicrotask(() => { this.emit("end"); done?.(); });
  }
  ref() {}
  unref() {}
}

test("a checked-out failed connection is destroyed on release and a waiting request gets a new one", async () => {
  const pool = new pg.Pool({ Client: LocalClient, max: 1 } as unknown as pg.PoolConfig);
  armConnectionErrorHandling(pool, "primary");
  pool.on("error", () => {}); // existing idle-pool protection
  try {
    const first = await pool.connect();
    const waiting = pool.connect();
    assert.equal(pool.waitingCount, 1);
    assert.doesNotThrow(() => first.emit("error", connectionFailure()));
    // The guard does not steal release ownership from the transaction.
    first.release();
    const next = await waiting;
    assert.notEqual(next, first);
    assert.equal(pool.totalCount, 1);
    assert.equal(pool.waitingCount, 0);
    next.release();
    assert.equal(pool.idleCount, 1);
  } finally {
    await pool.end();
  }
});

test("idle connection errors still reach the pool listener and remove the failed client", async () => {
  const pool = new pg.Pool({ Client: LocalClient, max: 1 } as unknown as pg.PoolConfig);
  armConnectionErrorHandling(pool, "read");
  const errors: Error[] = [];
  pool.on("error", (error) => errors.push(error));
  try {
    const client = await pool.connect();
    client.release();
    const error = connectionFailure();
    assert.doesNotThrow(() => client.emit("error", error));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(errors, [error]);
    assert.equal(pool.totalCount, 0);
  } finally {
    await pool.end();
  }
});
