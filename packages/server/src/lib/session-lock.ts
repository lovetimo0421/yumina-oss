import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

/**
 * Session mutation lock. Ordinary calls wait in Node rather than pinning a
 * backend. Explicit acknowledged state-only saves may queue one bounded lock.
 *
 * Every writer of session state (message persist, state patch, execute-action,
 * context inject, playtime tick) serialises on `SELECT … FOR UPDATE`. The
 * classic form WAITS inside Postgres, and a waiting statement holds one of the
 * few pooled backend connections while doing nothing. In prod (2026-09-07,
 * pg_stat_statements since 07-28) that single statement averaged 1.1s over
 * 1.88M calls — 576 hours of connections pinned idle — and every other request
 * on the primary queued behind those pins.
 *
 * `NOWAIT` fails instantly when the row is held (SQLSTATE 55P03). We then wait
 * in Node — where waiting is free — and retry with a fresh short transaction,
 * so no connection is ever held while blocked. Ordering is preserved: the patch
 * still applies AFTER the holder commits, exactly as the blocking form did. If
 * the row stays busy for the whole window (a long generation), the caller gets
 * SessionBusyError and answers 409 so the client re-queues.
 *
 * Recurring voice SHARE gates can defeat every NOWAIT retry. Acknowledged
 * state saves first try NO KEY UPDATE NOWAIT, then queue only on contention
 * within that same window. At most two contended operations per process (one
 * per owner/session) may wait; all other writers retain the ordinary policy.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const RETRY_DELAYS_MS = [120, 240, 480, 800, 1200, 1600, 1600] as const; // ≈6s total
const ACKNOWLEDGED_CONTENTION_MS = 6040; // Same total as the ordinary retry window.
const MAX_ACKNOWLEDGED_WAITERS = 2;
const acknowledgedWaiters = new Set<string>();

export const SESSION_NOT_FOUND = Symbol("session-not-found");

export class SessionBusyError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs = 1500) {
    super("session_busy");
    this.name = "SessionBusyError";
    this.retryAfterMs = retryAfterMs;
  }
}

export interface LockedSessionRow {
  state: Record<string, unknown>;
  userId: string;
}

function isLockNotAvailable(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "55P03";
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn` inside a transaction that holds the session row lock. Resolves to
 * SESSION_NOT_FOUND when the row does not exist. Throws SessionBusyError when
 * the row stayed locked for the whole retry window.
 */
export async function withSessionRowLock<T>(
  sessionId: string,
  fn: (tx: Tx, row: LockedSessionRow) => Promise<T>,
  options?: { acknowledged?: { userId: string; signal?: AbortSignal } },
): Promise<T | typeof SESSION_NOT_FOUND> {
  if (options?.acknowledged) {
    // Healthy independent state saves do not consume waiter capacity. Only a
    // contended acquisition queues for its turn between voice SHARE gates.
    const userId = options.acknowledged.userId;
    const signal = options.acknowledged.signal;
    signal?.throwIfAborted();
    const expires = performance.now() + ACKNOWLEDGED_CONTENTION_MS;
    let acquisitionBusy = false;
    const mutate = async (tx: Tx, waiting: boolean) => {
      signal?.throwIfAborted();
      const remaining = Math.floor(expires - performance.now());
      if (remaining <= 0) throw new SessionBusyError();
      // Transaction-local: commit/rollback restores the pooled connection.
      // Only this state-only callback uses NO KEY UPDATE; generic mutations
      // keep the existing stronger NOWAIT lock below.
      if (waiting) {
        await tx.execute(sql.raw(`SET LOCAL lock_timeout='${remaining}ms'`));
        signal?.throwIfAborted();
      }
      let locked;
      try {
        locked = await tx.execute(waiting
          ? sql`SELECT state, user_id FROM play_sessions WHERE id = ${sessionId} FOR NO KEY UPDATE`
          : sql`SELECT state, user_id FROM play_sessions WHERE id = ${sessionId} FOR NO KEY UPDATE NOWAIT`);
      } catch (err) {
        if (!waiting && isLockNotAvailable(err)) acquisitionBusy = true;
        throw err;
      }
      signal?.throwIfAborted();
      if (performance.now() >= expires) throw new SessionBusyError();
      const row = locked.rows[0] as { state: Record<string, unknown> | null; user_id: string } | undefined;
      if (!row || row.user_id !== userId) return SESSION_NOT_FOUND;
      const result = await fn(tx, { state: row.state ?? {}, userId: row.user_id });
      signal?.throwIfAborted();
      return result;
    };
    try { return await db.transaction(tx => mutate(tx, false)); }
    catch (err) { if (!acquisitionBusy || !isLockNotAvailable(err)) throw err; }
    signal?.throwIfAborted();
    if (performance.now() >= expires) throw new SessionBusyError();
    const key = JSON.stringify([userId, sessionId]);
    if (acknowledgedWaiters.has(key) || acknowledgedWaiters.size >= MAX_ACKNOWLEDGED_WAITERS) throw new SessionBusyError();
    acknowledgedWaiters.add(key);
    try {
      return await db.transaction(tx => mutate(tx, true));
    } catch (err) {
      if (isLockNotAvailable(err)) throw new SessionBusyError();
      throw err;
    } finally {
      // Do not free a slot merely because an HTTP caller stopped waiting: the
      // actual database transaction must have committed or rolled back first.
      acknowledgedWaiters.delete(key);
    }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const locked = await tx.execute(
          sql`SELECT state, user_id FROM play_sessions WHERE id = ${sessionId} FOR UPDATE NOWAIT`,
        );
        const row = locked.rows[0] as { state: Record<string, unknown> | null; user_id: string } | undefined;
        if (!row) return SESSION_NOT_FOUND;
        return fn(tx, { state: row.state ?? {}, userId: row.user_id });
      });
    } catch (err) {
      if (!isLockNotAvailable(err)) throw err;
      if (attempt >= RETRY_DELAYS_MS.length) throw new SessionBusyError();
      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }
}
