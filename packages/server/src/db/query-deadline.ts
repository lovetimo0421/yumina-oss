import type pg from "pg";
import { AsyncLocalStorage } from "node:async_hooks";

const deadlineScope = new AsyncLocalStorage<number>();
const capturedDeadline = Symbol("yumina.queryDeadline");

/** Reserved for explicitly bounded maintenance and shorter health probes.
 * This is a client deadline, not a SET on a pooled Postgres session. */
export function withDatabaseQueryTimeout<T>(timeoutMs: number, run: () => T): T {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600_000) {
    throw new RangeError("Database query deadline must be between 1 and 600000 milliseconds");
  }
  return deadlineScope.run(timeoutMs, run);
}

export class DatabaseQueryTimeoutError extends Error {
  readonly code = "DB_QUERY_TIMEOUT";
  // Even a failed COMMIT response does not prove that the write rolled back.
  readonly outcome = "unknown";
  constructor(readonly pool: string, readonly timeoutMs: number, cause: Error) {
    super(`Database query exceeded ${timeoutMs}ms; its outcome is unconfirmed`, { cause });
    this.name = "DatabaseQueryTimeoutError";
  }
}

/** Drizzle wraps failed statements in a query error with the driver error as
 * its cause. Keep timeout semantics when that wrapper reaches an HTTP route. */
export function findDatabaseQueryTimeout(error: unknown): DatabaseQueryTimeoutError | undefined {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof DatabaseQueryTimeoutError) return error;
    seen.add(error);
    error = error.cause;
  }
  return undefined;
}

type Callback = (error: Error | null, result?: unknown) => void;
type GuardedClient = pg.PoolClient & { _queryable?: boolean; __queryDeadlineInstalled?: boolean; end: pg.Client["end"] };

/** pg's query_timeout rejects the caller but leaves an active query running.
 * Intercept its callback BEFORE pg-pool releases the client or Drizzle starts
 * rollback. Destroy the socket, reject later commands with the original error,
 * and leave release ownership with the caller. Never replay any query. */
export function armQueryDeadlines(
  pool: pg.Pool,
  label: string,
  timeoutMs: number,
  onTimeout?: (error: DatabaseQueryTimeoutError) => void,
): void {
  (pool.options as pg.PoolConfig).query_timeout = timeoutMs;
  const poolQuery = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  (pool as { query: unknown }).query = (config: unknown, ...args: unknown[]) => {
    // pg-pool can service its waiting queue inside the RELEASING request's
    // async context. Capture the deadline at submission, before that handoff.
    if (typeof config === "string" || (config && typeof config === "object")) {
      config = { ...(typeof config === "string" ? { text: config } : config),
        [capturedDeadline]: deadlineScope.getStore() ?? timeoutMs };
    }
    return poolQuery(config, ...args);
  };
  pool.on("connect", (pooledClient) => {
    const client = pooledClient as GuardedClient;
    if (client.__queryDeadlineInstalled) return;
    client.__queryDeadlineInstalled = true;
    const query = client.query.bind(client) as (...args: unknown[]) => unknown;
    let failure: DatabaseQueryTimeoutError | undefined;
    (client as { query: unknown }).query = (config: string | Record<string, unknown>, values?: unknown, callback?: Callback) => {
      if (config == null) throw new TypeError("Client was passed a null or undefined query");
      // Drizzle and Better Auth use SQL/config overloads. Cursor/Submittable
      // lifecycles require a separate guard; do not silently leave them unsafe.
      if (typeof config === "object" && typeof config.submit === "function") {
        throw new TypeError("Deadline-protected pools require SQL text or a query config, not a Submittable");
      }
      const options: Record<string, unknown> = typeof config === "string" ? { text: config } : { ...config };
      const cb = typeof values === "function" ? values as Callback
        : callback ?? (typeof options.callback === "function" ? options.callback as Callback : undefined);
      const args = typeof values === "function" ? undefined : values;
      const limit = (typeof config === "object" ? (config as { [capturedDeadline]?: number })[capturedDeadline] : undefined)
        ?? deadlineScope.getStore() ?? timeoutMs;
      delete options.callback;
      const execute = (done: Callback) => {
        if (failure) { process.nextTick(() => done(failure!)); return; }
        return query({ ...options, query_timeout: limit }, args, (error: Error | null, result: unknown) => {
          if (error?.message === "Query read timeout" && !(error as { code?: string }).code) {
            if (!failure) {
              failure = new DatabaseQueryTimeoutError(label, limit, error);
              client._queryable = false;
              // pg.end() force-destroys the local socket when !queryable, so no
              // more commands can use it. This does not prove server-side rollback;
              // the role's statement timeout still bounds backend execution.
              void client.end().catch(() => {});
              try { onTimeout?.(failure); } catch { /* diagnostics cannot break cleanup */ }
            }
            error = failure;
          }
          done(error, result);
        });
      };
      if (cb) return execute(cb);
      return new Promise((resolve, reject) => execute((error, result) => error ? reject(error) : resolve(result)));
    };
  });
}
