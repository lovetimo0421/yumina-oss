/**
 * Invite Race board extras: the prize-over-time chart, what moved it, the
 * friend funnel and activity feed, and the paged friends list.
 *
 * History is one row per inviter per hour (invite_race_user_history). The
 * rollup writes the live point every hour; `backfillInviteRaceHistory`
 * rebuilds any past hour from the ledger, because tickets can be recomputed
 * "as of" any moment.
 */
import { sql } from "drizzle-orm";
import { resolveImageCdn } from "./cdn-url.js";
import {
  inviteRaceBandProgress,
  inviteRaceRoundAt,
  inviteRaceUsageTickets,
  settleInviteRaceRound,
  type InviteRaceStanding,
  type InviteRaceView,
} from "@yumina/shared";
import { db } from "../db/index.js";
import { roundStandings, type InviteRaceEvent } from "./invite-race.js";

type Rows<T> = { rows: T[] };
const WEEK_MS = 7 * 86_400_000;
const HOUR_MS = 3_600_000;

/** Per-inviter tickets for one round as they stood at `asOf`, rebuilt from the ledger. */
export async function standingsAsOf(event: InviteRaceEvent, roundNo: number, asOf: Date): Promise<InviteRaceStanding[]> {
  const rules = event.rules;
  const roundStart = new Date(event.startsAt.getTime() + (roundNo - 1) * WEEK_MS);
  const roundEnd = new Date(roundStart.getTime() + WEEK_MS);
  const cut = asOf < roundEnd ? asOf : roundEnd;
  const r = await db.execute(sql`
    SELECT f.inviter_id,
      (f.signup_round = ${roundNo} AND f.joined_at <= ${cut}) signup,
      (f.active_round = ${roundNo} AND f.active_at <= ${cut}) active,
      COALESCE((SELECT -SUM(t.amount) FROM credit_wallets w JOIN credit_transactions t ON t.wallet_id = w.id
        WHERE w.user_id = f.invitee_id AND (t.type IN ('usage','usage_refund') OR (t.type = 'refund' AND EXISTS (SELECT 1 FROM credit_transactions u WHERE u.wallet_id = t.wallet_id AND u.type = 'usage' AND u.reference_id = t.reference_id)))
          AND t.created_at >= f.joined_at AND t.created_at < LEAST(f.window_ends_at, ${roundStart}::timestamptz)), 0)::float8 before,
      COALESCE((SELECT -SUM(t.amount) FROM credit_wallets w JOIN credit_transactions t ON t.wallet_id = w.id
        WHERE w.user_id = f.invitee_id AND (t.type IN ('usage','usage_refund') OR (t.type = 'refund' AND EXISTS (SELECT 1 FROM credit_transactions u WHERE u.wallet_id = t.wallet_id AND u.type = 'usage' AND u.reference_id = t.reference_id)))
          AND t.created_at >= f.joined_at AND t.created_at < LEAST(f.window_ends_at, ${cut}::timestamptz)), 0)::float8 upto
    FROM invite_race_friends f
    WHERE f.event_id = ${event.id} AND f.joined_at <= ${cut}
      AND EXISTS (SELECT 1 FROM "user" u WHERE u.id = f.invitee_id) AND EXISTS (SELECT 1 FROM "user" u WHERE u.id = f.inviter_id)
      AND NOT EXISTS (SELECT 1 FROM invite_race_exclusions x WHERE x.event_id = f.event_id AND x.kind = 'friend' AND x.user_id = f.invitee_id)
      AND NOT EXISTS (SELECT 1 FROM invite_race_exclusions x WHERE x.event_id = f.event_id AND x.kind = 'inviter' AND x.user_id = f.inviter_id)`) as Rows<{
      inviter_id: string; signup: boolean; active: boolean; before: number; upto: number;
    }>;
  const by = new Map<string, number>();
  for (const f of r.rows) {
    const t = (f.signup ? rules.signupTickets : 0) + (f.active ? rules.activeTickets : 0)
      + inviteRaceUsageTickets(Number(f.upto), rules.bands) - inviteRaceUsageTickets(Number(f.before), rules.bands);
    if (t > 0) by.set(f.inviter_id, (by.get(f.inviter_id) ?? 0) + t);
  }
  return [...by].map(([userId, tickets]) => ({ userId, tickets, reachedAt: null }));
}

async function writeHistoryPoint(event: InviteRaceEvent, roundNo: number, at: Date, standings: InviteRaceStanding[]) {
  const settlement = settleInviteRaceRound(standings, event.rules);
  const payout = new Map(settlement.payouts.map((p) => [p.userId, p.totalUsd]));
  const withTickets = standings.filter((s) => s.tickets > 0);
  await db.execute(sql`INSERT INTO invite_race_round_history (event_id, round_no, at, total_tickets, participants, usd_per_ticket)
    VALUES (${event.id}, ${roundNo}, ${at}, ${settlement.totalTickets}, ${withTickets.length}, ${settlement.usdPerTicket})
    ON CONFLICT (event_id, round_no, at) DO UPDATE SET total_tickets = excluded.total_tickets,
      participants = excluded.participants, usd_per_ticket = excluded.usd_per_ticket`);
  for (let i = 0; i < withTickets.length; i += 500) {
    const chunk = withTickets.slice(i, i + 500);
    await db.execute(sql`INSERT INTO invite_race_user_history (event_id, round_no, user_id, at, tickets, estimate_usd) VALUES
      ${sql.join(chunk.map((s) => sql`(${event.id}, ${roundNo}, ${s.userId}, ${at}, ${s.tickets}, ${payout.get(s.userId) ?? 0})`), sql`, `)}
      ON CONFLICT (event_id, round_no, user_id, at) DO UPDATE SET tickets = excluded.tickets, estimate_usd = excluded.estimate_usd`);
  }
}

/** The hourly point for the running round, from the live standings. Called after each rollup. */
export async function recordInviteRaceHistory(event: InviteRaceEvent, now = new Date()) {
  const roundNo = inviteRaceRoundAt(event.startsAt, event.roundCount, now);
  if (!roundNo) return;
  const hour = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS);
  await writeHistoryPoint(event, roundNo, hour, await roundStandings(event.id, roundNo));
}

/** Hourly point for every running event (skips paused ones, like the rollup). */
export async function recordActiveInviteRaceHistory(now = new Date()) {
  const r = await db.execute(sql`SELECT id FROM invite_race_events WHERE status IN ('preview', 'live')`) as Rows<{ id: string }>;
  const { inviteRaceEventById } = await import("./invite-race.js");
  for (const row of r.rows) {
    const event = await inviteRaceEventById(row.id);
    if (event) await recordInviteRaceHistory(event, now);
  }
}

/** Rebuild the hourly history of a round from the ledger (backfill, demo). */
export async function backfillInviteRaceHistory(event: InviteRaceEvent, roundNo: number, now = new Date()) {
  const start = event.startsAt.getTime() + (roundNo - 1) * WEEK_MS;
  const end = Math.min(start + WEEK_MS, now.getTime());
  let points = 0;
  for (let t = start + HOUR_MS; t <= end; t += HOUR_MS) {
    await writeHistoryPoint(event, roundNo, new Date(t), await standingsAsOf(event, roundNo, new Date(t)));
    points++;
  }
  return points;
}

// ─── Board extras ────────────────────────────────────────────────────

export interface InviteRaceBoardExtras {
  prizeHistory: { at: string; estimateUsd: number; tickets: number }[];
  /** What moved the estimate over ~24h: tickets your friends earned vs. the value of each ticket. */
  change: { hours: number; deltaUsd: number; ticketsGained: number; fromFriendsUsd: number; fromPoolUsd: number } | null;
  funnel: { signedUp: number; active: number; playing: number; maxed: number; waiting: number };
  activity: { at: string; kind: "joined" | "came_back"; name: string; tickets: number }[];
}

export async function inviteRaceBoardExtras(event: InviteRaceEvent, userId: string, view: InviteRaceView, now = new Date()): Promise<InviteRaceBoardExtras> {
  const roundNo = view.round?.roundNo ?? null;
  const hist = roundNo
    ? await db.execute(sql`SELECT at, tickets, estimate_usd::float8 usd FROM invite_race_user_history
        WHERE event_id = ${event.id} AND round_no = ${roundNo} AND user_id = ${userId} ORDER BY at`) as Rows<{ at: Date; tickets: number; usd: number }>
    : { rows: [] };
  const history = hist.rows.map((h) => ({ at: new Date(h.at).toISOString(), estimateUsd: Number(h.usd), tickets: Number(h.tickets) }));
  // The live point, so the line always ends at the number in the headline.
  if (roundNo && view.event.status !== "ended") history.push({ at: now.toISOString(), estimateUsd: view.me.estimateUsd, tickets: view.me.tickets });

  let change: InviteRaceBoardExtras["change"] = null;
  if (history.length >= 2) {
    const dayAgo = now.getTime() - 86_400_000;
    const base = [...history].reverse().find((h) => Date.parse(h.at) <= dayAgo) ?? history[0]!;
    const last = history[history.length - 1]!;
    const gained = last.tickets - base.tickets;
    const fromFriends = Math.round(gained * view.totals.usdPerTicket * 100) / 100;
    const delta = Math.round((last.estimateUsd - base.estimateUsd) * 100) / 100;
    change = {
      hours: Math.max(1, Math.round((Date.parse(last.at) - Date.parse(base.at)) / HOUR_MS)),
      deltaUsd: delta,
      ticketsGained: gained,
      fromFriendsUsd: fromFriends,
      fromPoolUsd: Math.round((delta - fromFriends) * 100) / 100,
    };
  }

  const firstPaying = (event.rules.bands[0]?.from ?? 1000) + (event.rules.bands[0]?.per ?? 100);
  const top = event.rules.bands.at(-1)?.to ?? 15000;
  const f = await db.execute(sql`SELECT
      COUNT(*)::int signed_up,
      COUNT(*) FILTER (WHERE active_round IS NOT NULL AND spent_total < ${firstPaying})::int active,
      COUNT(*) FILTER (WHERE spent_total >= ${firstPaying} AND spent_total < ${top})::int playing,
      COUNT(*) FILTER (WHERE spent_total >= ${top})::int maxed,
      COUNT(*) FILTER (WHERE active_round IS NULL AND spent_total < ${firstPaying})::int waiting
    FROM invite_race_friends WHERE event_id = ${event.id} AND inviter_id = ${userId}`) as Rows<{ signed_up: number; active: number; playing: number; maxed: number; waiting: number }>;
  const fr = f.rows[0]!;

  const act = await db.execute(sql`
    SELECT * FROM (
      SELECT f.joined_at at, 'joined' kind, COALESCE(NULLIF(u.display_username, ''), u.name) name, ${event.rules.signupTickets}::int tickets
        FROM invite_race_friends f JOIN "user" u ON u.id = f.invitee_id
        WHERE f.event_id = ${event.id} AND f.inviter_id = ${userId} AND f.signup_round IS NOT NULL
      UNION ALL
      SELECT f.active_at, 'came_back', COALESCE(NULLIF(u.display_username, ''), u.name), ${event.rules.activeTickets}::int
        FROM invite_race_friends f JOIN "user" u ON u.id = f.invitee_id
        WHERE f.event_id = ${event.id} AND f.inviter_id = ${userId} AND f.active_at IS NOT NULL
    ) x WHERE at <= ${now} ORDER BY at DESC LIMIT 30`) as Rows<{ at: Date; kind: "joined" | "came_back"; name: string; tickets: number }>;

  return {
    prizeHistory: history,
    change,
    funnel: { signedUp: Number(fr.signed_up), active: Number(fr.active), playing: Number(fr.playing), maxed: Number(fr.maxed), waiting: Number(fr.waiting) },
    activity: act.rows.map((a) => ({ at: new Date(a.at).toISOString(), kind: a.kind, name: a.name, tickets: Number(a.tickets) })),
  };
}

// ─── Friends list ────────────────────────────────────────────────────

export type InviteRaceFriendFilter = "all" | "waiting" | "active" | "playing" | "maxed";
export type InviteRaceFriendSort = "tickets" | "newest" | "closest";

/** One page of an inviter's friends, filtered, searched and sorted in SQL. */
export async function inviteRaceFriendsPage(
  event: InviteRaceEvent,
  userId: string,
  opts: { filter: InviteRaceFriendFilter; sort: InviteRaceFriendSort; q: string; offset: number; limit: number },
  now = new Date(),
) {
  const firstPaying = (event.rules.bands[0]?.from ?? 1000) + (event.rules.bands[0]?.per ?? 100);
  const top = event.rules.bands.at(-1)?.to ?? 15000;
  const filter = {
    all: sql``,
    waiting: sql`AND f.active_round IS NULL AND f.spent_total < ${firstPaying}`,
    active: sql`AND f.active_round IS NOT NULL AND f.spent_total < ${firstPaying}`,
    playing: sql`AND f.spent_total >= ${firstPaying} AND f.spent_total < ${top}`,
    maxed: sql`AND f.spent_total >= ${top}`,
  }[opts.filter];
  const like = `%${opts.q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  const search = opts.q ? sql`AND (u.name ILIKE ${like} OR u.display_username ILIKE ${like})` : sql``;
  const order = {
    tickets: sql`tickets DESC, f.joined_at DESC`,
    newest: sql`f.joined_at DESC`,
    closest: sql`(f.active_round IS NULL AND f.window_ends_at > ${now}) DESC, f.window_ends_at ASC`,
  }[opts.sort];
  const base = sql`FROM invite_race_friends f JOIN "user" u ON u.id = f.invitee_id
    LEFT JOIN referral_qualifications q ON q.invitee_id = f.invitee_id
    WHERE f.event_id = ${event.id} AND f.inviter_id = ${userId} ${filter} ${search}`;
  const total = await db.execute(sql`SELECT COUNT(*)::int n ${base}`) as Rows<{ n: number }>;
  const rows = await db.execute(sql`
    SELECT f.invitee_id, COALESCE(NULLIF(u.display_username, ''), u.name) AS name, u.image, f.joined_at, f.window_ends_at,
      f.signup_round, f.active_round, f.spent_total, q.returned,
      COALESCE((SELECT SUM(signup + active + usage) FROM invite_race_tickets t WHERE t.event_id = f.event_id AND t.invitee_id = f.invitee_id), 0)::int tickets,
      EXISTS (SELECT 1 FROM invite_race_exclusions x WHERE x.event_id = f.event_id AND x.kind = 'friend' AND x.user_id = f.invitee_id) excluded
    ${base} ORDER BY ${order} LIMIT ${opts.limit} OFFSET ${opts.offset}`) as Rows<{
      invitee_id: string; name: string; image: string | null; joined_at: Date; window_ends_at: Date; signup_round: number | null;
      active_round: number | null; spent_total: number; returned: boolean | null; tickets: number; excluded: boolean;
    }>;
  return {
    total: Number(total.rows[0]?.n ?? 0),
    rows: rows.rows.map((f) => ({
      inviteeId: f.invitee_id,
      name: f.name,
      image: resolveImageCdn(f.image),
      joinedAt: new Date(f.joined_at).toISOString(),
      windowEndsAt: new Date(f.window_ends_at).toISOString(),
      signupTicket: f.signup_round != null,
      active: f.active_round != null,
      activeHint: f.active_round != null ? null : f.returned ? ("play_more" as const) : ("return_tomorrow" as const),
      progress: inviteRaceBandProgress(Number(f.spent_total), event.rules.bands),
      tickets: Number(f.tickets),
      excluded: !!f.excluded,
    })),
  };
}
