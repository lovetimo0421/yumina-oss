// Ledger verifier: the second half of the "every mushie is recorded" rule.
//
// The database guard (scripts/install-ledger-guard.sql) refuses any transaction
// that moves a wallet balance without a matching credit_transactions row. This
// module re-checks the chain from the outside on a schedule, so a bypass that
// slips past the guard (a superuser script, a trigger disabled for a migration,
// a bug in the guard itself) is caught within hours instead of never:
//
//   1. Tail check   — for every wallet touched in the window, the newest ledger
//                     row's balance_after must equal the wallet's balance.
//   2. Chain check  — for every ledger row in the window, balance_after must equal
//                     the previous row's balance_after plus this row's amount.
//
// Findings go to PostHog as a server error and to the log; nothing is repaired
// automatically — a drift is a bug to read, not a number to paper over.
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { env } from "./env.js";
import { runExclusive } from "./leader.js";
import { captureServerError } from "./posthog.js";

// Same rule as db/index.ts: no DATABASE_URL means the in-memory PGlite used by
// local runs and tests, where scheduled jobs never start.
const IS_PGLITE = !env.DATABASE_URL;

export interface LedgerChainGap {
  type: string;
  gaps: number;
  /** Sum of (prev + amount − balance_after): positive = mushies removed without a row. */
  unrecordedDelta: number;
}

export interface LedgerVerification {
  windowHours: number;
  walletsChecked: number;
  tailMismatches: number;
  chainGaps: LedgerChainGap[];
  clean: boolean;
}

export async function verifyLedger(windowHours = 26): Promise<LedgerVerification> {
  const window = sql.raw(`interval '${Math.max(1, Math.min(24 * 30, Math.floor(windowHours)))} hours'`);

  const tail = (await db.execute(sql`
    WITH active AS (
      SELECT id, balance FROM credit_wallets WHERE updated_at > now() - ${window}
    ), last AS (
      SELECT a.balance, t.balance_after
      FROM active a
      CROSS JOIN LATERAL (
        SELECT balance_after FROM credit_transactions
        WHERE wallet_id = a.id ORDER BY created_at DESC, id DESC LIMIT 1
      ) t
    )
    SELECT count(*)::int AS wallets,
           count(*) FILTER (WHERE abs(balance - balance_after) > (0.05 + abs(balance) * 0.000002))::int AS mismatches
    FROM last`)).rows[0] as { wallets: number; mismatches: number } | undefined;

  const gaps = (await db.execute(sql`
    WITH active AS (
      SELECT id FROM credit_wallets WHERE updated_at > now() - ${window}
    ), tx AS (
      SELECT t.type, t.amount, t.balance_after,
             lag(t.balance_after) OVER (PARTITION BY t.wallet_id ORDER BY t.created_at, t.id) AS prev_after
      FROM credit_transactions t JOIN active a ON a.id = t.wallet_id
      WHERE t.created_at > now() - ${window}
    )
    SELECT type, count(*)::int AS gaps,
           round(sum(prev_after + amount - balance_after)::numeric, 1)::float AS unrecorded_delta
    FROM tx
    WHERE prev_after IS NOT NULL AND abs(balance_after - (prev_after + amount)) > (0.05 + abs(balance_after) * 0.000002)
    GROUP BY type ORDER BY gaps DESC`)).rows as Array<{ type: string; gaps: number; unrecorded_delta: number }>;

  const chainGaps = gaps.map((g) => ({ type: g.type, gaps: Number(g.gaps), unrecordedDelta: Number(g.unrecorded_delta) }));
  const tailMismatches = Number(tail?.mismatches ?? 0);
  return {
    windowHours,
    walletsChecked: Number(tail?.wallets ?? 0),
    tailMismatches,
    chainGaps,
    clean: tailMismatches === 0 && chainGaps.length === 0,
  };
}

async function runVerifierQuiet(): Promise<void> {
  try {
    const result = await verifyLedger();
    if (result.clean) {
      console.log(`[LedgerVerifier] clean — ${result.walletsChecked} wallets, ${result.windowHours}h window`);
      return;
    }
    console.error("[LedgerVerifier] DRIFT", JSON.stringify(result));
    captureServerError("ledger-drift", new Error("credit ledger drift detected"), {
      tailMismatches: result.tailMismatches,
      chainGaps: JSON.stringify(result.chainGaps),
      walletsChecked: result.walletsChecked,
    });
  } catch (err) {
    console.error("[LedgerVerifier] failed:", err instanceof Error ? err.message : err);
  }
}

const VERIFIER_INTERVAL_MS = 6 * 60 * 60_000;
let handle: ReturnType<typeof setInterval> | null = null;

/** Leader-locked (one run per ~6h across the fleet), like the daily-recovery interval. */
export function startLedgerVerifierInterval(): void {
  if (IS_PGLITE) return;
  if (handle) return;
  void runExclusive("ledger-verifier", 5 * 60 * 60, runVerifierQuiet);
  handle = setInterval(() => {
    void runExclusive("ledger-verifier", 5 * 60 * 60, runVerifierQuiet);
  }, VERIFIER_INTERVAL_MS);
}

export function stopLedgerVerifierInterval(): void {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}
