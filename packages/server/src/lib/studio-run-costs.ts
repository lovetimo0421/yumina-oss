import { and, eq, inArray, sql } from "drizzle-orm";
import { db, readPublic } from "../db/index.js";
import { studioCreditReservations } from "../db/schema.js";

/**
 * What Studio runs actually cost, from the settled credit reservations (one per
 * model call, keyed by run). Creators saw a one-call floor before sending and a
 * run's cost only until the page reloaded; the median run cost 2.6× the floor
 * and the 90th percentile 9.9×, and "I didn't know it used this much" came up
 * on Discord.
 */

/** Settled mushies per run, for the runs of one conversation being displayed. */
export async function loadRunCosts(runIds: string[]): Promise<Record<string, number>> {
  const ids = [...new Set(runIds.filter(Boolean))].slice(0, 500);
  if (ids.length === 0) return {};
  const rows = await db
    .select({ runId: studioCreditReservations.runId, credits: sql<number>`sum(${studioCreditReservations.settledCredits})` })
    .from(studioCreditReservations)
    .where(and(inArray(studioCreditReservations.runId, ids), eq(studioCreditReservations.status, "settled")))
    .groupBy(studioCreditReservations.runId);
  const out: Record<string, number> = {};
  for (const row of rows) {
    const credits = Number(row.credits);
    if (Number.isFinite(credits) && credits > 0) out[row.runId] = Math.round(credits * 10) / 10;
  }
  return out;
}

/** Fewer runs than this and the spread is noise: show the floor instead. */
const MIN_RUNS = 20;
const TTL_MS = 60 * 60 * 1000;
let typical: { at: number; byModel: Map<string, [number, number]> } | null = null;
let refreshing: Promise<void> | null = null;

async function refreshTypical(): Promise<void> {
  // One aggregate over two weeks of runs (~3s on prod), shared by every model
  // and recomputed at most hourly per instance. Aggregate browse: replica.
  const result = await readPublic().execute(sql`
    select l.model, count(*)::int n,
      percentile_cont(0.5) within group (order by x.c) p50,
      percentile_cont(0.9) within group (order by x.c) p90
    from (select r.run_id, min(r.reference_id) ref, sum(r.settled_credits) c
          from studio_credit_reservations r
          where r.status = 'settled' and r.created_at > now() - interval '14 days'
          group by r.run_id) x
    join usage_logs l on l.id = x.ref
    group by l.model`);
  const byModel = new Map<string, [number, number]>();
  for (const row of result.rows as Array<{ model: string; n: number; p50: number; p90: number }>) {
    if (Number(row.n) < MIN_RUNS) continue;
    const low = roundMushies(Number(row.p50));
    const high = roundMushies(Number(row.p90));
    if (low > 0 && high >= low) byModel.set(row.model, [low, high]);
  }
  typical = { at: Date.now(), byModel };
}

function roundMushies(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value < 20 ? Math.ceil(value) : Math.ceil(value / 10) * 10;
}

/** A recent run on this model: half cost at most [0], nine in ten at most [1].
 *  Null when unknown; never waits on a cold refresh longer than the request. */
export async function typicalRunCredits(model: string): Promise<[number, number] | null> {
  if (!typical || Date.now() - typical.at > TTL_MS) {
    refreshing ??= refreshTypical().catch((error) => {
      console.warn("[StudioRunCosts] typical-run refresh failed:", error instanceof Error ? error.message : error);
      // Retry in five minutes rather than on every estimate request.
      typical ??= { at: Date.now() - TTL_MS + 5 * 60_000, byModel: new Map() };
    }).finally(() => { refreshing = null; });
    // The first request after boot waits; later ones serve the stale value.
    if (!typical) await refreshing;
  }
  return typical?.byModel.get(model) ?? null;
}
