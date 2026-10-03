import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";

export interface PoolQueryTiming {
  duration_ms: number;
  /** Pool wait + connection establishment/verification, not SQL execution. */
  connection_acquire_ms?: number;
  /** Driver/database/network time after acquisition, not pure SQL time. */
  database_roundtrip_ms?: number;
}

/** Passive observers: preserve pg's promise identity, callback overloads,
 * release ownership, errors, and deadline wrappers. Never replay a query. */
export function observePoolQueryTimings(
  pool: pg.Pool,
  onComplete: (args: unknown[], timing: PoolQueryTiming) => void,
  now: () => number = () => performance.now(),
): void {
  const scope = new AsyncLocalStorage<{ startedAt: number; acquiredAt?: number }>();
  const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  (pool as unknown as { connect: (...args: unknown[]) => unknown }).connect = (...args) => {
    const timing = scope.getStore();
    const callback = args[0];
    if (!timing || typeof callback !== "function") return connect(...args);
    // Capture at connect submission. pg-pool can deliver a queued callback
    // inside a DIFFERENT request's async context when its client is released.
    return connect(function (this: unknown, ...values: unknown[]) {
      timing.acquiredAt = now();
      return callback.apply(this, values);
    });
  };
  (pool as unknown as { query: (...args: unknown[]) => unknown }).query = (...args) => {
    if (typeof args[args.length - 1] === "function") return query(...args);
    const timing: { startedAt: number; acquiredAt?: number } = { startedAt: now() };
    const result = scope.run(timing, () => query(...args));
    if (result && typeof (result as Promise<unknown>).then === "function") {
      void (result as Promise<unknown>).then(() => {
        const endedAt = now();
        const duration_ms = Math.max(0, endedAt - timing.startedAt);
        try {
          onComplete(args, {
            duration_ms,
            ...(timing.acquiredAt === undefined ? {} : {
              connection_acquire_ms: Math.max(0, timing.acquiredAt - timing.startedAt),
              database_roundtrip_ms: Math.max(0, endedAt - timing.acquiredAt),
            }),
          });
        } catch { /* Diagnostics must never affect a database operation. */ }
      }, () => { /* Original errors remain owned by the caller. */ });
    }
    return result;
  };
}
