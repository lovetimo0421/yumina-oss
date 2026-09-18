import type pg from "pg";
import { captureServerError } from "../lib/posthog.js";

/**
 * Pool guards against read-only-poisoned connections (2026-08-18 incident).
 *
 * When Neon migrates/restarts the primary compute, connections that live
 * through the transition can end up pinned to a READ-ONLY backend. Every
 * write on such a connection fails with SQLSTATE 25006 ("cannot execute
 * UPDATE in a read-only transaction"). pg-pool destroys a client only when
 * it is released WITH an error — which `pool.query` does on failure, but the
 * drizzle `db.transaction` path does not: it ROLLBACKs and releases cleanly,
 * so the poisoned client goes straight back into the pool and the next
 * checkout fails again, forever. That turned a transient Neon blip into a
 * 90-minute partial write outage on the highest-frequency transaction path
 * (session playtime ticks).
 *
 * Two layers, both cheap:
 *  - `armReadOnlyEviction`: watch every query on every pooled client; on a
 *    25006 error, mark the client not-queryable so pg-pool's release check
 *    (`err || !client._queryable || …`) destroys it no matter how it is
 *    released. One poisoned connection fails at most one request.
 *  - `makeReadOnlyVerify`: pg-pool `verify` hook for NEW connections on the
 *    primary pool — one `SHOW transaction_read_only` round-trip; a read-only
 *    connection is rejected before it can serve a single query.
 */

const READ_ONLY_SQLSTATE = "25006";

type GuardedClient = pg.PoolClient & {
  _queryable?: boolean;
  __roGuardInstalled?: boolean;
  __connectionGuardInstalled?: boolean;
};

/** pg-pool removes its idle error listener while a client is checked out.
 * A connection failure between transaction queries therefore needs a client
 * listener too. pg still rejects pending/future queries; never retry writes or
 * release a transaction's client here. Its owner releases it in finally, and
 * _queryable=false makes the pool destroy it instead of recycling it. */
export function armConnectionErrorHandling(pool: pg.Pool, label: string): void {
  pool.on("connect", (client: GuardedClient) => {
    if (client.__connectionGuardInstalled) return;
    client.__connectionGuardInstalled = true;
    client.on("error", (err: Error) => {
      client._queryable = false;
      captureServerError("pg-client-connection", err, { pool: label });
      console.error(`[DB] Connection error (${label} client); discarding connection:`, err.message);
    });
  });
}

function markPoisoned(client: GuardedClient, label: string, err: unknown): void {
  if (client._queryable === false) return; // already condemned
  client._queryable = false;
  captureServerError("pg-pool-readonly-evict", err, { pool: label });
  console.error(
    `[DB] ${label} pool connection hit read-only backend (25006) — evicting it on release`,
  );
}

/** Install the 25006 eviction watcher on every client the pool creates. */
export function armReadOnlyEviction(pool: pg.Pool, label: string): void {
  pool.on("connect", (client: GuardedClient) => {
    if (client.__roGuardInstalled) return;
    client.__roGuardInstalled = true;
    const orig = client.query.bind(client) as (...args: unknown[]) => unknown;
    (client as { query: unknown }).query = (...args: unknown[]) => {
      const last = args[args.length - 1];
      if (typeof last === "function") {
        const cb = last as (err: unknown, res: unknown) => void;
        args[args.length - 1] = (err: unknown, res: unknown) => {
          if ((err as { code?: string } | null)?.code === READ_ONLY_SQLSTATE) {
            markPoisoned(client, label, err);
          }
          return cb(err, res);
        };
        return orig(...args);
      }
      const out = orig(...args);
      if (out && typeof (out as Promise<unknown>).catch === "function") {
        (out as Promise<unknown>).catch((err: { code?: string }) => {
          if (err?.code === READ_ONLY_SQLSTATE) markPoisoned(client, label, err);
        });
      }
      return out;
    };
  });
}

/**
 * pg-pool `verify` for the PRIMARY pool: reject any new connection whose
 * session is read-only. (Never install on the replica pool — read-only is its
 * normal state.)
 */
export function makeReadOnlyVerify(label: string) {
  return (client: pg.PoolClient, done: (err?: Error) => void): void => {
    client.query("SHOW transaction_read_only", (err: Error | null, res?: { rows: Array<{ transaction_read_only?: string }> }) => {
      if (err) return done(err);
      if (res?.rows?.[0]?.transaction_read_only === "on") {
        const roErr = new Error(
          `${label} pool connected to a read-only backend — rejecting connection`,
        );
        captureServerError("pg-pool-readonly-verify", roErr, { pool: label });
        console.error(`[DB] ${roErr.message}`);
        return done(roErr);
      }
      done();
    });
  };
}
