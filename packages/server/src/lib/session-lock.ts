import { sql } from "drizzle-orm";
import { db } from "../db/index.js";

/**
 * Short, non-pinning row lock on a play_sessions row.
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
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const RETRY_DELAYS_MS = [120, 240, 480, 800, 1200, 1600, 1600] as const; // ≈6s total

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
): Promise<T | typeof SESSION_NOT_FOUND> {
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
