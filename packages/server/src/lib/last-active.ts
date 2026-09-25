import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";

/**
 * "Last active" for the admin Users lookup: the latest play or AI request.
 *
 * Two write paths keep it current without touching the hot path per message:
 *   - the batched lifetime-playtime flush stamps every account it credits
 *     (lifetime-playtime-sql.ts), so play is covered at ~30s lag for free;
 *   - recordUsageLog calls touchLastActive after each AI request, which covers
 *     Studio and BYOK. The SQL only writes when the stored value is older than
 *     five minutes, and an in-process throttle skips even that round trip for
 *     an account seen recently, so a busy player costs one row update per five
 *     minutes instead of one per message on the most-read table in the database.
 */
export const LAST_ACTIVE_MIN_GAP_MS = 5 * 60_000;

export function lastActiveTouchStatement(userId: string): SQL {
  return sql`UPDATE "user" SET last_active_at = now()
    WHERE id = ${userId} AND (last_active_at IS NULL OR last_active_at < now() - interval '5 minutes')`;
}

type Execute = (statement: SQL) => Promise<unknown>;

export function createLastActiveToucher(execute: Execute, gapMs = LAST_ACTIVE_MIN_GAP_MS) {
  const recent = new Map<string, number>();
  return {
    touch(userId: string, now = Date.now()): boolean {
      if (!userId) return false;
      const last = recent.get(userId);
      if (last !== undefined && now - last < gapMs) return false;
      recent.set(userId, now);
      // Bound memory on a long-lived process: sweep entries older than the gap.
      if (recent.size > 20_000)
        for (const [id, at] of recent) if (now - at >= gapMs) recent.delete(id);
      execute(lastActiveTouchStatement(userId)).catch(() => recent.delete(userId));
      return true;
    },
    reset() { recent.clear(); },
  };
}

const toucher = createLastActiveToucher((statement) => db.execute(statement));

/** Fire-and-forget; never throws, never awaited by callers. */
export function touchLastActive(userId: string): void {
  toucher.touch(userId);
}
