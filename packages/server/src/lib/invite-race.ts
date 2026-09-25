/**
 * Invite Race: rollup, live view, settlement and payouts.
 *
 * Every number here is recomputed from source tables ("user".referred_by,
 * referral_qualifications, credit_transactions), so running the rollup twice —
 * which happens whenever Redis is down and runExclusive fails open — gives the
 * same result. Rounds that an admin has approved are frozen and never rewritten.
 *
 * Design: docs/superpowers/specs/2026-09-23-invite-race-design.md
 */
import { sql } from "drizzle-orm";
import { resolveImageCdn } from "./cdn-url.js";
import {
  DEFAULT_INVITE_RACE_RULES,
  inviteRaceBandProgress,
  inviteRaceRank,
  inviteRaceRoundAt,
  inviteRaceRounds,
  inviteRaceUsageTickets,
  settleInviteRaceRound,
  type InviteRaceRules,
  type InviteRaceStanding,
  type InviteRaceView,
} from "@yumina/shared";
import { db } from "../db/index.js";
import { insertHashedTransaction, type LedgerDatabase } from "./transaction-hash.js";
import { ensureWallet } from "./credit-service.js";
import { giftCardsConfigured, sendGiftCard } from "./gift-cards.js";

type Rows<T> = { rows: T[] };
const WEEK_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;

export interface InviteRaceEvent {
  id: string;
  startsAt: Date;
  roundCount: number;
  status: "draft" | "preview" | "live" | "paused" | "ended";
  rules: InviteRaceRules;
}

const toEvent = (r: { id: string; starts_at: Date | string; round_count: number; status: InviteRaceEvent["status"]; rules: Partial<InviteRaceRules>; ended_at?: Date | string | null }): InviteRaceEvent => {
  const startsAt = new Date(r.starts_at);
  const planned = Number(r.round_count);
  // Ending an event keeps the period it was ended in (so nobody's week is cut
  // short) and drops every later one. Before the start, nothing is left.
  let roundCount = planned;
  if (r.ended_at) {
    const endedAt = new Date(r.ended_at);
    roundCount = endedAt < startsAt ? 0 : Math.min(planned, inviteRaceRoundAt(startsAt, planned, endedAt) ?? planned);
  }
  return { id: r.id, startsAt, roundCount, status: r.status, rules: { ...DEFAULT_INVITE_RACE_RULES, ...r.rules } };
};

export const eventEndsAt = (e: InviteRaceEvent) => new Date(e.startsAt.getTime() + e.roundCount * WEEK_MS);

/** The event players see: the newest non-draft one. Preview events only for admins. */
export async function currentInviteRaceEvent(opts: { includePreview: boolean }, database: LedgerDatabase = db): Promise<InviteRaceEvent | null> {
  const statuses = opts.includePreview ? ["preview", "live", "paused", "ended"] : ["live", "paused", "ended"];
  const r = await database.execute(sql`SELECT id, starts_at, round_count, status, rules, ended_at FROM invite_race_events
    WHERE status IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)}) ORDER BY starts_at DESC LIMIT 1`) as unknown as Rows<Parameters<typeof toEvent>[0]>;
  return r.rows[0] ? toEvent(r.rows[0]) : null;
}

export async function inviteRaceEventById(id: string, database: LedgerDatabase = db): Promise<InviteRaceEvent | null> {
  const r = await database.execute(sql`SELECT id, starts_at, round_count, status, rules, ended_at FROM invite_race_events WHERE id = ${id}`) as unknown as Rows<Parameters<typeof toEvent>[0]>;
  return r.rows[0] ? toEvent(r.rows[0]) : null;
}

/** Create or replace an event and its round rows. Refuses once rules are locked. */
export async function upsertInviteRaceEvent(input: { id: string; startsAt: Date; roundCount: number; status: InviteRaceEvent["status"]; rules?: Partial<InviteRaceRules> }) {
  const rules = { ...DEFAULT_INVITE_RACE_RULES, ...input.rules };
  return db.transaction(async (tx) => {
    const existing = await inviteRaceEventById(input.id, tx);
    const locked = await tx.execute(sql`SELECT rules_locked_at FROM invite_race_events WHERE id = ${input.id}`) as Rows<{ rules_locked_at: Date | null }>;
    const isLocked = !!locked.rows[0]?.rules_locked_at;
    if (existing && isLocked && input.status !== "ended" && (existing.startsAt.getTime() !== input.startsAt.getTime() || input.rules)) {
      throw new Error("RULES_LOCKED");
    }
    // Going live from a preview starts the real event this minute, clean: the
    // preview's counts (made while nobody could see it) are thrown away.
    if (existing && !isLocked && existing.status === "preview" && input.status === "live") {
      input = { ...input, startsAt: new Date(Math.floor(Date.now() / 60_000) * 60_000) };
      for (const t of ["invite_race_tickets", "invite_race_standings", "invite_race_round_history", "invite_race_user_history", "invite_race_friends"]) {
        await tx.execute(sql`DELETE FROM ${sql.raw(t)} WHERE event_id = ${input.id}`);
      }
      await tx.execute(sql`DELETE FROM invite_race_rounds WHERE event_id = ${input.id} AND status = 'open'`);
    }
    await tx.execute(sql`INSERT INTO invite_race_events (id, starts_at, round_count, status, rules, rules_locked_at)
      VALUES (${input.id}, ${input.startsAt}, ${input.roundCount}, ${input.status}, ${JSON.stringify(rules)}::jsonb,
        ${input.status === "live" ? new Date() : null})
      ON CONFLICT (id) DO UPDATE SET status = excluded.status,
        starts_at = CASE WHEN invite_race_events.rules_locked_at IS NULL THEN excluded.starts_at ELSE invite_race_events.starts_at END,
        round_count = CASE WHEN invite_race_events.rules_locked_at IS NULL THEN excluded.round_count ELSE invite_race_events.round_count END,
        rules = CASE WHEN invite_race_events.rules_locked_at IS NULL THEN excluded.rules ELSE invite_race_events.rules END,
        rules_locked_at = COALESCE(invite_race_events.rules_locked_at, excluded.rules_locked_at),
        ended_at = CASE WHEN excluded.status = 'ended' THEN COALESCE(invite_race_events.ended_at, now()) ELSE NULL END`);
    const planned = existing && isLocked ? existing.roundCount : input.roundCount;
    for (const r of inviteRaceRounds(isLocked && existing ? existing.startsAt : input.startsAt, planned)) {
      await tx.execute(sql`INSERT INTO invite_race_rounds (event_id, round_no, starts_at, ends_at, settle_after)
        VALUES (${input.id}, ${r.roundNo}, ${r.startsAt}, ${r.endsAt}, ${r.settleAfter})
        ON CONFLICT (event_id, round_no) DO UPDATE SET starts_at = excluded.starts_at, ends_at = excluded.ends_at, settle_after = excluded.settle_after
        WHERE invite_race_rounds.status = 'open'`);
    }
    // What's left after an end: only the periods up to the one it was ended in.
    const after = await inviteRaceEventById(input.id, tx);
    const keep = after ? after.roundCount : input.roundCount;
    await tx.execute(sql`DELETE FROM invite_race_rounds WHERE event_id = ${input.id} AND round_no > ${keep} AND status = 'open'`);
  });
}

// ─── Rollup ──────────────────────────────────────────────────────────

/** Recompute friends, tickets, standings and history for one event. */
export async function rollupInviteRace(event: InviteRaceEvent, now = new Date()): Promise<{ friends: number; tickets: number }> {
  const rules = event.rules;
  const start = event.startsAt;
  const end = eventEndsAt(event);
  const windowMs = rules.windowDays * DAY_MS;

  // 1. Enroll friends: new accounts that claimed a code during the event.
  await db.execute(sql`INSERT INTO invite_race_friends (invitee_id, inviter_id, event_id, joined_at, window_ends_at)
    SELECT u.id, u.referred_by, ${event.id}, u.referred_at, LEAST(u.referred_at + ${`${rules.windowDays} days`}::interval, ${end}::timestamptz)
    FROM "user" u
    WHERE u.referred_by IS NOT NULL AND u.referred_at >= ${start} AND u.referred_at < ${end} AND u.created_at >= ${start}
    ON CONFLICT (invitee_id) DO NOTHING`);

  // 2. Signup round, capped per inviter per round by claim order.
  await db.execute(sql`UPDATE invite_race_friends f SET signup_round = s.capped
    FROM (
      SELECT invitee_id, CASE WHEN row_number() OVER (PARTITION BY inviter_id, round_no ORDER BY joined_at, invitee_id) <= ${rules.signupCapPerRound}
        THEN round_no END capped
      FROM (SELECT invitee_id, inviter_id, joined_at,
              floor(extract(epoch FROM joined_at - ${start}::timestamptz) / ${WEEK_MS / 1000})::int + 1 round_no
            FROM invite_race_friends WHERE event_id = ${event.id}) x
    ) s
    WHERE f.invitee_id = s.invitee_id AND f.signup_round IS DISTINCT FROM s.capped`);

  // 3. Active round, from the existing qualified-referral check.
  await db.execute(sql`UPDATE invite_race_friends f SET active_at = q.rewarded_at,
      active_round = CASE WHEN q.rewarded_at < ${end}::timestamptz
        THEN floor(extract(epoch FROM q.rewarded_at - ${start}::timestamptz) / ${WEEK_MS / 1000})::int + 1 END
    FROM referral_qualifications q
    WHERE q.invitee_id = f.invitee_id AND f.event_id = ${event.id} AND q.status = 'rewarded' AND q.rewarded_at IS NOT NULL
      AND f.active_at IS DISTINCT FROM q.rewarded_at`);

  // 4. Platform mushies spent inside each friend's window, per round. BYOK
  //    never writes a usage row, so it is excluded without asking.
  //    Refunds count against the spend: usage_refund (chat), and refund rows
  //    that undo a usage charge (e.g. a failed image generation).
  //    last_at is the latest spend that could still earn a ticket (before the
  //    friend reached the top band), so spending past the cap can't push the
  //    inviter's tie-break time later.
  const topBand = rules.bands.at(-1)?.to ?? 15000;
  const spend = await db.execute(sql`
    WITH tx AS (
      SELECT f.invitee_id, t.id, t.created_at, -t.amount AS amt
      FROM invite_race_friends f
      JOIN credit_wallets w ON w.user_id = f.invitee_id
      JOIN credit_transactions t ON t.wallet_id = w.id
        AND t.created_at >= f.joined_at AND t.created_at < f.window_ends_at AND t.created_at < ${now}
        AND (t.type IN ('usage', 'usage_refund')
          OR (t.type = 'refund' AND EXISTS (SELECT 1 FROM credit_transactions u
                WHERE u.wallet_id = t.wallet_id AND u.type = 'usage' AND u.reference_id = t.reference_id)))
      WHERE f.event_id = ${event.id}
    ), run AS (
      SELECT *, COALESCE(SUM(amt) OVER (PARTITION BY invitee_id ORDER BY created_at, id ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS before
      FROM tx
    )
    SELECT invitee_id, floor(extract(epoch FROM created_at - ${start}::timestamptz) / ${WEEK_MS / 1000})::int + 1 AS round_no,
      SUM(amt)::float8 AS spent, MAX(created_at) FILTER (WHERE before < ${topBand}) AS last_at
    FROM run GROUP BY 1, 2`) as Rows<{ invitee_id: string; round_no: number; spent: number; last_at: Date | null }>;

  const friends = await db.execute(sql`SELECT f.invitee_id, f.inviter_id, f.joined_at, f.signup_round, f.active_round, f.active_at
    FROM invite_race_friends f
    WHERE f.event_id = ${event.id}
      AND NOT EXISTS (SELECT 1 FROM invite_race_exclusions x WHERE x.event_id = f.event_id AND x.kind = 'friend' AND x.user_id = f.invitee_id)
      AND NOT EXISTS (SELECT 1 FROM invite_race_exclusions x WHERE x.event_id = f.event_id AND x.kind = 'inviter' AND x.user_id = f.inviter_id)
      AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id IN (f.invitee_id, f.inviter_id) AND u.is_banned)
      AND EXISTS (SELECT 1 FROM "user" u WHERE u.id = f.invitee_id)
      AND EXISTS (SELECT 1 FROM "user" u WHERE u.id = f.inviter_id)`) as Rows<{
      invitee_id: string; inviter_id: string; joined_at: Date; signup_round: number | null; active_round: number | null; active_at: Date | null;
    }>;

  const spendBy = new Map<string, { round: number; spent: number; lastAt: Date | null }[]>();
  for (const s of spend.rows) {
    const list = spendBy.get(s.invitee_id) ?? [];
    list.push({ round: Number(s.round_no), spent: Number(s.spent), lastAt: s.last_at ? new Date(s.last_at) : null });
    spendBy.set(s.invitee_id, list);
  }

  type TicketRow = { round: number; invitee: string; inviter: string; signup: number; active: number; usage: number; lastAt: Date | null };
  const rows: TicketRow[] = [];
  const totals = new Map<string, number>();
  for (const f of friends.rows) {
    const byRound = new Map<number, TicketRow>();
    const row = (round: number) => {
      let r = byRound.get(round);
      if (!r) { r = { round, invitee: f.invitee_id, inviter: f.inviter_id, signup: 0, active: 0, usage: 0, lastAt: null }; byRound.set(round, r); }
      return r;
    };
    const later = (a: Date | null, b: Date) => (!a || b > a ? b : a);
    if (f.signup_round) { const r = row(f.signup_round); r.signup = rules.signupTickets; r.lastAt = later(r.lastAt, new Date(f.joined_at)); }
    if (f.active_round && f.active_at) { const r = row(f.active_round); r.active = rules.activeTickets; r.lastAt = later(r.lastAt, new Date(f.active_at)); }
    let cumulative = 0;
    for (const s of (spendBy.get(f.invitee_id) ?? []).sort((a, b) => a.round - b.round)) {
      const before = inviteRaceUsageTickets(cumulative, rules.bands);
      cumulative += s.spent;
      const delta = inviteRaceUsageTickets(cumulative, rules.bands) - before;
      if (delta > 0 && s.round >= 1 && s.round <= event.roundCount) {
        const r = row(s.round); r.usage += delta; if (s.lastAt) r.lastAt = later(r.lastAt, s.lastAt);
      }
    }
    totals.set(f.invitee_id, Math.max(0, Math.round(cumulative)));
    for (const r of byRound.values()) if (r.round >= 1 && r.round <= event.roundCount) rows.push(r);
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"invite-race:" + event.id}, 0))`);
    // Read after the lock: an approval that just finished must not be overwritten.
    const frozen = await tx.execute(sql`SELECT round_no FROM invite_race_rounds WHERE event_id = ${event.id} AND status IN ('approved', 'paid')`) as Rows<{ round_no: number }>;
    const frozenRounds = new Set(frozen.rows.map((r) => Number(r.round_no)));
    const totalsList = [...totals];
    for (let i = 0; i < totalsList.length; i += 500) {
      const chunk = totalsList.slice(i, i + 500);
      await tx.execute(sql`UPDATE invite_race_friends f SET spent_total = v.spent, updated_at = now()
        FROM (VALUES ${sql.join(chunk.map(([id, spent]) => sql`(${id}::text, ${spent}::int)`), sql`, `)}) AS v(id, spent)
        WHERE f.invitee_id = v.id AND f.spent_total <> v.spent`);
    }
    const frozenList = [...frozenRounds];
    const notFrozen = frozenList.length ? sql`AND round_no NOT IN (${sql.join(frozenList.map((n) => sql`${n}`), sql`, `)})` : sql``;
    await tx.execute(sql`DELETE FROM invite_race_tickets WHERE event_id = ${event.id} ${notFrozen}`);
    const live = rows.filter((r) => !frozenRounds.has(r.round));
    for (let i = 0; i < live.length; i += 500) {
      const chunk = live.slice(i, i + 500);
      await tx.execute(sql`INSERT INTO invite_race_tickets (event_id, round_no, invitee_id, inviter_id, signup, active, usage, last_earned_at) VALUES
        ${sql.join(chunk.map((r) => sql`(${event.id}, ${r.round}, ${r.invitee}, ${r.inviter}, ${r.signup}, ${r.active}, ${r.usage}, ${r.lastAt})`), sql`, `)}`);
    }

    // Standings for every round that is not frozen.
    await tx.execute(sql`DELETE FROM invite_race_standings WHERE event_id = ${event.id} ${notFrozen}`);
    const agg = await tx.execute(sql`SELECT round_no, inviter_id, SUM(signup + active + usage)::int tickets, MAX(last_earned_at) reached_at
      FROM invite_race_tickets WHERE event_id = ${event.id} ${notFrozen} GROUP BY 1, 2`) as Rows<{ round_no: number; inviter_id: string; tickets: number; reached_at: Date | null }>;
    const byRound = new Map<number, InviteRaceStanding[]>();
    for (const a of agg.rows) {
      const list = byRound.get(Number(a.round_no)) ?? [];
      list.push({ userId: a.inviter_id, tickets: Number(a.tickets), reachedAt: a.reached_at ? new Date(a.reached_at).toISOString() : null });
      byRound.set(Number(a.round_no), list);
    }
    for (const [round, list] of byRound) {
      const ranked = inviteRaceRank(list);
      for (let i = 0; i < ranked.length; i += 500) {
        const chunk = ranked.slice(i, i + 500);
        await tx.execute(sql`INSERT INTO invite_race_standings (event_id, round_no, inviter_id, tickets, reached_at, rank) VALUES
          ${sql.join(chunk.map((s, j) => sql`(${event.id}, ${round}, ${s.userId}, ${s.tickets}, ${s.reachedAt}, ${i + j + 1})`), sql`, `)}`);
      }
    }

    // Close rounds that have ended; they stay open to exclusions until approved.
    await tx.execute(sql`UPDATE invite_race_rounds SET status = 'review' WHERE event_id = ${event.id} AND status = 'open' AND ends_at <= ${now}`);

    // Hourly history point for the current round.
    const current = inviteRaceRoundAt(event.startsAt, event.roundCount, now);
    if (current && !frozenRounds.has(current)) {
      const list = byRound.get(current) ?? [];
      const settlement = settleInviteRaceRound(list, rules);
      const hour = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);
      await tx.execute(sql`INSERT INTO invite_race_round_history (event_id, round_no, at, total_tickets, participants, usd_per_ticket)
        VALUES (${event.id}, ${current}, ${hour}, ${settlement.totalTickets}, ${list.length}, ${settlement.usdPerTicket})
        ON CONFLICT (event_id, round_no, at) DO UPDATE SET total_tickets = excluded.total_tickets,
          participants = excluded.participants, usd_per_ticket = excluded.usd_per_ticket`);
    }
  });

  invalidateInviteRaceBoard();
  return { friends: friends.rows.length, tickets: rows.reduce((s, r) => s + r.signup + r.active + r.usage, 0) };
}

/** Called by the interval: roll up every event that is running or in review. */
export async function rollupActiveInviteRaces(now = new Date()) {
  const r = await db.execute(sql`SELECT id, starts_at, round_count, status, rules, ended_at FROM invite_race_events
    WHERE status IN ('preview', 'live', 'paused', 'ended')
      AND starts_at + (round_count * interval '7 days') + interval '7 days' > ${now}`) as unknown as Rows<Parameters<typeof toEvent>[0]>;
  const hasLive = r.rows.some((row) => row.status === "live");
  for (const row of r.rows) {
    const event = toEvent(row);
    // A paused event keeps its board frozen: no new tickets until it resumes.
    if (event.status === "paused") continue;
    // Friends belong to one event (invitee_id is the key): while a real event
    // runs, an admin preview must not claim them.
    if (event.status === "preview" && hasLive) continue;
    await rollupInviteRace(event, now);
  }
  // $10+ winners who didn't choose in time: pay mushies, as the page promises.
  const due = await db.execute(sql`SELECT DISTINCT event_id FROM invite_race_payouts WHERE method = 'choice_pending' AND choose_by <= ${now}`) as Rows<{ event_id: string }>;
  for (const d of due.rows) {
    const event = await inviteRaceEventById(d.event_id);
    if (event) await settleExpiredInviteRaceChoices(event, now);
  }
}

// ─── Standings and the player view ───────────────────────────────────

export async function roundStandings(eventId: string, roundNo: number): Promise<InviteRaceStanding[]> {
  const r = await db.execute(sql`SELECT inviter_id, tickets, reached_at FROM invite_race_standings
    WHERE event_id = ${eventId} AND round_no = ${roundNo}`) as Rows<{ inviter_id: string; tickets: number; reached_at: Date | null }>;
  return r.rows.map((s) => ({ userId: s.inviter_id, tickets: Number(s.tickets), reachedAt: s.reached_at ? new Date(s.reached_at).toISOString() : null }));
}

/**
 * The part of the board that is the same for every player — standings,
 * settlement, the top-5 names, the value-per-ticket history — computed once a
 * minute per server instance instead of once per request. Standings only
 * change when the 2-minute rollup runs, so a minute of staleness is free,
 * and a race page polling every 60s costs a couple of indexed reads.
 */
const SHARED_TTL_MS = 60_000;
const sharedCache = new Map<string, { at: number; value: Promise<SharedRoundBoard> }>();
interface SharedRoundBoard {
  standings: InviteRaceStanding[];
  settlement: ReturnType<typeof settleInviteRaceRound>;
  ranked: InviteRaceStanding[];
  payoutBy: Map<string, ReturnType<typeof settleInviteRaceRound>["payouts"][number]>;
  personBy: Map<string, { id: string; name: string; image: string | null }>;
  history: { at: Date; v: number }[];
}
async function sharedRoundBoard(event: InviteRaceEvent, roundNo: number): Promise<SharedRoundBoard> {
  const key = `${event.id}:${roundNo}`;
  const hit = sharedCache.get(key);
  if (hit && Date.now() - hit.at < SHARED_TTL_MS) return hit.value;
  const value = (async () => {
    const standings = await roundStandings(event.id, roundNo);
    const settlement = settleInviteRaceRound(standings, event.rules);
    const ranked = inviteRaceRank(standings);
    const leaderIds = ranked.slice(0, event.rules.rankPrizesUsd.length).map((s) => s.userId);
    const people = leaderIds.length
      ? await db.execute(sql`SELECT id, COALESCE(NULLIF(display_username, ''), name) AS name, image FROM "user"
          WHERE id IN (${sql.join(leaderIds.map((id) => sql`${id}`), sql`, `)})`) as Rows<{ id: string; name: string; image: string | null }>
      : { rows: [] };
    const history = await db.execute(sql`SELECT at, usd_per_ticket::float8 v FROM invite_race_round_history
      WHERE event_id = ${event.id} AND round_no = ${roundNo} ORDER BY at`) as Rows<{ at: Date; v: number }>;
    return {
      standings, settlement, ranked,
      payoutBy: new Map(settlement.payouts.map((p) => [p.userId, p])),
      personBy: new Map(people.rows.map((p) => [p.id, p])),
      history: history.rows,
    };
  })();
  sharedCache.set(key, { at: Date.now(), value });
  // A failed read must not be cached for a minute.
  value.catch(() => sharedCache.delete(key));
  if (sharedCache.size > 50) for (const k of sharedCache.keys()) { sharedCache.delete(k); if (sharedCache.size <= 25) break; }
  return value;
}

/** Drop the shared board after anything that changes it (rollup, exclusion, approval). */
export function invalidateInviteRaceBoard() {
  sharedCache.clear();
}

export async function inviteRaceView(event: InviteRaceEvent, userId: string, now = new Date()): Promise<InviteRaceView> {
  const rules = event.rules;
  const end = eventEndsAt(event);
  const currentNo = inviteRaceRoundAt(event.startsAt, event.roundCount, now) ?? (now >= end ? event.roundCount : null);
  const windows = inviteRaceRounds(event.startsAt, event.roundCount);
  const round = currentNo ? windows[currentNo - 1]! : null;

  const shared = currentNo ? await sharedRoundBoard(event, currentNo) : null;
  const standings = shared?.standings ?? [];
  const settlement = shared?.settlement ?? settleInviteRaceRound([], rules);
  const ranked = shared?.ranked ?? [];
  const payoutBy = shared?.payoutBy ?? new Map();
  const myIndex = ranked.findIndex((s) => s.userId === userId);
  const mine = myIndex >= 0 ? ranked[myIndex]! : null;
  const myPayout = payoutBy.get(userId);

  let nextRank: InviteRaceView["me"]["nextRank"] = null;
  if (mine && myIndex > 0) {
    const targetIndex = myIndex >= rules.rankPrizesUsd.length ? rules.rankPrizesUsd.length - 1 : myIndex - 1;
    const target = ranked[targetIndex]!;
    nextRank = {
      rank: targetIndex + 1,
      ticketsNeeded: Math.max(1, target.tickets - mine.tickets + 1, rules.rankMinTickets - mine.tickets),
      prizeUsd: rules.rankPrizesUsd[targetIndex] ?? 0,
    };
  } else if (!mine && ranked.length >= rules.rankPrizesUsd.length) {
    const target = ranked[rules.rankPrizesUsd.length - 1]!;
    nextRank = { rank: rules.rankPrizesUsd.length, ticketsNeeded: Math.max(target.tickets + 1, rules.rankMinTickets), prizeUsd: rules.rankPrizesUsd.at(-1) ?? 0 };
  }

  const personBy = shared?.personBy ?? new Map<string, { id: string; name: string; image: string | null }>();
  const history = { rows: shared?.history ?? [] };
  const dayAgo = now.getTime() - DAY_MS;
  const yesterday = [...history.rows].reverse().find((h) => new Date(h.at).getTime() <= dayAgo);

  const friends = await db.execute(sql`
    SELECT f.invitee_id, COALESCE(NULLIF(u.display_username, ''), u.name) AS name, u.image, f.joined_at, f.window_ends_at,
      f.signup_round, f.active_round, f.spent_total, q.returned, q.status AS q_status,
      COALESCE((SELECT SUM(signup + active + usage) FROM invite_race_tickets t WHERE t.event_id = f.event_id AND t.invitee_id = f.invitee_id), 0)::int tickets,
      EXISTS (SELECT 1 FROM invite_race_exclusions x WHERE x.event_id = f.event_id AND x.kind = 'friend' AND x.user_id = f.invitee_id) excluded
    FROM invite_race_friends f
    JOIN "user" u ON u.id = f.invitee_id
    LEFT JOIN referral_qualifications q ON q.invitee_id = f.invitee_id
    WHERE f.event_id = ${event.id} AND f.inviter_id = ${userId}
    ORDER BY f.joined_at DESC LIMIT 12`) as Rows<{
      invitee_id: string; name: string; image: string | null; joined_at: Date; window_ends_at: Date; signup_round: number | null;
      active_round: number | null; spent_total: number; returned: boolean | null; q_status: string | null; tickets: number; excluded: boolean;
    }>;

  const payouts = await db.execute(sql`SELECT p.round_no, r.status round_status, p.tickets, p.total_usd::float8 total_usd, p.rank, p.method, p.mushies, p.choose_by
    FROM invite_race_payouts p JOIN invite_race_rounds r ON r.event_id = p.event_id AND r.round_no = p.round_no
    WHERE p.event_id = ${event.id} AND p.user_id = ${userId} AND p.status <> 'cancelled' ORDER BY p.round_no`) as Rows<{
      round_no: number; round_status: "approved" | "paid"; tickets: number; total_usd: number; rank: number | null;
      method: "mushies_auto" | "choice_pending" | "mushies" | "cash"; mushies: number | null; choose_by: Date | null;
    }>;
  const closed = await db.execute(sql`SELECT r.round_no, r.status, COALESCE(s.tickets, 0) tickets FROM invite_race_rounds r
    LEFT JOIN invite_race_standings s ON s.event_id = r.event_id AND s.round_no = r.round_no AND s.inviter_id = ${userId}
    WHERE r.event_id = ${event.id} AND r.status = 'review' ORDER BY r.round_no`) as Rows<{ round_no: number; status: "review"; tickets: number }>;
  const results: InviteRaceView["results"] = [];
  for (const c of closed.rows) {
    if (Number(c.tickets) <= 0) continue;
    const est = (await sharedRoundBoard(event, Number(c.round_no))).payoutBy.get(userId);
    results.push({ roundNo: Number(c.round_no), status: "review", tickets: Number(c.tickets), totalUsd: est?.totalUsd ?? 0, rank: est?.rank ?? null, method: null, mushies: null, chooseBy: null });
  }
  for (const p of payouts.rows) {
    results.push({ roundNo: Number(p.round_no), status: p.round_status, tickets: Number(p.tickets), totalUsd: Number(p.total_usd), rank: p.rank, method: p.method, mushies: p.mushies, chooseBy: p.choose_by ? new Date(p.choose_by).toISOString() : null });
  }
  results.sort((a, b) => b.roundNo - a.roundNo);

  const code = await db.execute(sql`SELECT referral_code FROM "user" WHERE id = ${userId}`) as Rows<{ referral_code: string | null }>;
  const lastHistory = history.rows.at(-1);

  return {
    event: { id: event.id, status: event.status as InviteRaceView["event"]["status"], startsAt: event.startsAt.toISOString(), roundCount: event.roundCount, rules },
    round: round ? { roundNo: round.roundNo, startsAt: round.startsAt.toISOString(), endsAt: round.endsAt.toISOString() } : null,
    totals: {
      tickets: settlement.totalTickets,
      participants: ranked.length,
      usdPerTicket: settlement.usdPerTicket,
      usdPerTicketYesterday: yesterday ? Number(yesterday.v) : null,
    },
    history: history.rows.map((h) => ({ at: new Date(h.at).toISOString(), usdPerTicket: Number(h.v) })),
    me: {
      tickets: mine?.tickets ?? 0,
      rank: mine ? myIndex + 1 : null,
      estimateUsd: myPayout?.totalUsd ?? 0,
      rankUsd: myPayout?.rankUsd ?? 0,
      nextRank,
      referralCode: code.rows[0]?.referral_code ?? null,
    },
    leaders: ranked.slice(0, rules.rankPrizesUsd.length).map((s, i) => ({
      rank: i + 1,
      userId: s.userId,
      name: personBy.get(s.userId)?.name ?? "—",
      image: resolveImageCdn(personBy.get(s.userId)?.image),
      tickets: s.tickets,
      estimateUsd: payoutBy.get(s.userId)?.totalUsd ?? 0,
    })),
    friends: friends.rows.map((f) => ({
      inviteeId: f.invitee_id,
      name: f.name,
      image: resolveImageCdn(f.image),
      joinedAt: new Date(f.joined_at).toISOString(),
      windowEndsAt: new Date(f.window_ends_at).toISOString(),
      signupTicket: f.signup_round != null,
      active: f.active_round != null,
      activeHint: f.active_round != null ? null : f.returned ? "play_more" : "return_tomorrow",
      progress: inviteRaceBandProgress(Number(f.spent_total), rules.bands),
      tickets: Number(f.tickets),
      excluded: !!f.excluded,
    })),
    results,
    updatedAt: lastHistory ? new Date(lastHistory.at).toISOString() : null,
  };
}

// ─── Settlement and payouts ──────────────────────────────────────────

const payoutReference = (eventId: string, roundNo: number, userId: string) => `event_reward:invite-race:${eventId}:${roundNo}:${userId}`;

/** Credit mushies once per (event, round, user). The unique index on event_reward references makes a repeat a no-op. */
async function creditPrizeMushies(tx: LedgerDatabase, eventId: string, roundNo: number, userId: string, mushies: number): Promise<string> {
  const reference = payoutReference(eventId, roundNo, userId);
  const existing = await tx.execute(sql`SELECT id FROM credit_transactions WHERE reference_id = ${reference} AND type = 'event_reward' LIMIT 1`) as Rows<{ id: string }>;
  if (existing.rows[0]) return existing.rows[0].id;
  const wallets = await tx.execute(sql`UPDATE credit_wallets SET balance = balance + ${mushies}, addon_balance = addon_balance + ${mushies}, updated_at = now()
    WHERE user_id = ${userId} RETURNING id, balance`) as Rows<{ id: string; balance: number }>;
  const wallet = wallets.rows[0];
  if (!wallet) throw new Error("INVITE_RACE_WALLET_MISSING");
  const receipt = await insertHashedTransaction({
    walletId: wallet.id, amount: mushies, type: "event_reward", referenceId: reference,
    balanceAfter: Number(wallet.balance), description: `Invite Race round ${roundNo} prize`,
  }, tx);
  return receipt.id;
}

/** Approve a round: freeze standings, write payouts, pay the automatic mushie prizes. */
export async function approveInviteRaceRound(event: InviteRaceEvent, roundNo: number, adminId: string, now = new Date()) {
  const all = await roundStandings(event.id, roundNo);
  // Accounts deleted since the last rollup can't be paid; leave them out.
  const alive = all.length
    ? new Set(((await db.execute(sql`SELECT id FROM "user" WHERE id IN (${sql.join(all.map((s) => sql`${s.userId}`), sql`, `)})`)) as Rows<{ id: string }>).rows.map((r) => r.id))
    : new Set<string>();
  const standings = all.filter((s) => alive.has(s.userId));
  const settlement = settleInviteRaceRound(standings, event.rules);
  for (const p of settlement.payouts) await ensureWallet(p.userId);
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${"invite-race:" + event.id}, 0))`);
    const r = await tx.execute(sql`SELECT status, settle_after FROM invite_race_rounds WHERE event_id = ${event.id} AND round_no = ${roundNo} FOR UPDATE`) as Rows<{ status: string; settle_after: Date }>;
    const round = r.rows[0];
    if (!round) throw new Error("ROUND_NOT_FOUND");
    if (round.status !== "review") throw new Error("ROUND_NOT_IN_REVIEW");
    // Preview events may be approved early so the flow can be tested end to end.
    if (event.status !== "preview" && now < new Date(round.settle_after)) throw new Error("REVIEW_NOT_OVER");
    const chooseBy = new Date(now.getTime() + event.rules.chooseDays * DAY_MS);
    for (const p of settlement.payouts) {
      await tx.execute(sql`INSERT INTO invite_race_payouts (event_id, round_no, user_id, tickets, rank, rank_usd, share_usd, total_usd, method, mushies, choose_by)
        VALUES (${event.id}, ${roundNo}, ${p.userId}, ${p.tickets}, ${p.rank}, ${p.rankUsd}, ${p.shareUsd}, ${p.totalUsd}, ${p.method}, ${p.mushies},
          ${p.method === "choice_pending" ? chooseBy : null})
        ON CONFLICT (event_id, round_no, user_id) DO NOTHING`);
      if (p.method === "mushies_auto" && p.mushies) {
        const txId = await creditPrizeMushies(tx, event.id, roundNo, p.userId, p.mushies);
        await tx.execute(sql`UPDATE invite_race_payouts SET status = 'applied', credit_transaction_id = ${txId}
          WHERE event_id = ${event.id} AND round_no = ${roundNo} AND user_id = ${p.userId}`);
      }
    }
    await tx.execute(sql`UPDATE invite_race_rounds SET status = 'approved', total_tickets = ${settlement.totalTickets},
      approved_by = ${adminId}, approved_at = ${now} WHERE event_id = ${event.id} AND round_no = ${roundNo}`);
    return settlement;
  });
}

/**
 * Place the gift-card order for one payout (idempotent: the order's
 * external_id is the payout key). Marks the row sent on success, keeps it in
 * the admin queue with the error otherwise.
 */
export async function dispatchInviteRaceGiftCard(event: InviteRaceEvent, roundNo: number, userId: string) {
  const r = await db.execute(sql`SELECT p.total_usd::float8 total_usd, p.cash_status, u.email, COALESCE(NULLIF(u.display_username, ''), u.name) name
    FROM invite_race_payouts p JOIN "user" u ON u.id = p.user_id
    WHERE p.event_id = ${event.id} AND p.round_no = ${roundNo} AND p.user_id = ${userId} AND p.method = 'cash'`) as Rows<{ total_usd: number; cash_status: string | null; email: string; name: string }>;
  const row = r.rows[0];
  if (!row || row.cash_status === "sent") return { sent: row?.cash_status === "sent" };
  const result = await sendGiftCard({
    externalId: `invite-race:${event.id}:${roundNo}:${userId}`,
    amountUsd: Math.floor(Number(row.total_usd)),
    email: row.email,
    name: row.name,
  });
  if (result.ok) {
    await db.execute(sql`UPDATE invite_race_payouts SET cash_status = 'sent', status = 'applied', provider_order_id = ${result.orderId}, provider_error = NULL
      WHERE event_id = ${event.id} AND round_no = ${roundNo} AND user_id = ${userId}`);
    return { sent: true };
  }
  await db.execute(sql`UPDATE invite_race_payouts SET provider_error = ${result.configured ? result.error : null}
    WHERE event_id = ${event.id} AND round_no = ${roundNo} AND user_id = ${userId}`);
  return { sent: false, error: result.error };
}

/** A winner of $10+ picks a gift card or mushies. */
export async function chooseInviteRacePrize(event: InviteRaceEvent, roundNo: number, userId: string, choice: "cash" | "mushies") {
  await ensureWallet(userId);
  return db.transaction(async (tx) => {
    const r = await tx.execute(sql`SELECT total_usd::float8 total_usd, method, choose_by FROM invite_race_payouts
      WHERE event_id = ${event.id} AND round_no = ${roundNo} AND user_id = ${userId} FOR UPDATE`) as Rows<{ total_usd: number; method: string; choose_by: Date | null }>;
    const p = r.rows[0];
    if (!p) throw new Error("NO_PRIZE");
    if (p.method !== "choice_pending") throw new Error("ALREADY_CHOSEN");
    if (choice === "cash" && p.choose_by && new Date(p.choose_by) < new Date()) throw new Error("CHOICE_EXPIRED");
    const cents = Math.round(Number(p.total_usd) * 100);
    const rate = event.rules.mushiesPerUsd;
    if (choice === "cash") {
      // Gift card in whole dollars; the cents are paid right away as mushies.
      const change = Math.round(((cents % 100) * rate) / 100);
      let txId: string | null = null;
      if (change > 0) txId = await creditPrizeMushies(tx, event.id, roundNo, userId, change);
      await tx.execute(sql`UPDATE invite_race_payouts SET method = 'cash', cash_status = 'requested', mushies = ${change || null}, credit_transaction_id = ${txId}
        WHERE event_id = ${event.id} AND round_no = ${roundNo} AND user_id = ${userId}`);
      return { method: "cash" as const, giftCardUsd: Math.floor(cents / 100), mushies: change };
    }
    const mushies = Math.round((cents * rate) / 100);
    const txId = await creditPrizeMushies(tx, event.id, roundNo, userId, mushies);
    await tx.execute(sql`UPDATE invite_race_payouts SET method = 'mushies', mushies = ${mushies}, status = 'applied', credit_transaction_id = ${txId}
      WHERE event_id = ${event.id} AND round_no = ${roundNo} AND user_id = ${userId}`);
    return { method: "mushies" as const, mushies };
  });
}

/** Past the deadline with no choice: pay mushies at the chosen rate. */
export async function settleExpiredInviteRaceChoices(event: InviteRaceEvent, now = new Date()) {
  const due = await db.execute(sql`SELECT round_no, user_id FROM invite_race_payouts
    WHERE event_id = ${event.id} AND method = 'choice_pending' AND choose_by <= ${now}`) as Rows<{ round_no: number; user_id: string }>;
  for (const d of due.rows) await chooseInviteRacePrize(event, Number(d.round_no), d.user_id, "mushies").catch(() => undefined);
}

// ─── Admin ───────────────────────────────────────────────────────────

/** Friends a free account could have reached: at or under the v2 free ceiling. */
const FREE_CEILING = 2100;

export async function inviteRaceAdminOverview(event: InviteRaceEvent, roundNo: number) {
  const rounds = await db.execute(sql`SELECT round_no, starts_at, ends_at, settle_after, status, total_tickets, approved_at
    FROM invite_race_rounds WHERE event_id = ${event.id} ORDER BY round_no`);
  const standings = await roundStandings(event.id, roundNo);
  const settlement = settleInviteRaceRound(standings, event.rules);

  const headline = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE signup_round = ${roundNo})::int signups,
      COUNT(*) FILTER (WHERE active_round = ${roundNo})::int active,
      COUNT(*) FILTER (WHERE spent_total > ${FREE_CEILING} AND joined_at < (SELECT ends_at FROM invite_race_rounds WHERE event_id = ${event.id} AND round_no = ${roundNo}))::int past_free,
      COUNT(*)::int friends_total
    FROM invite_race_friends WHERE event_id = ${event.id}`) as Rows<{ signups: number; active: number; past_free: number; friends_total: number }>;

  // Inviters, with the free-alt signals: many free-only friends that share an
  // earliest-session IP with each other or with the inviter, or sign up minutes apart.
  const inviters = await db.execute(sql`
    WITH people AS (
      SELECT invitee_id AS id FROM invite_race_friends WHERE event_id = ${event.id}
      UNION SELECT inviter_id FROM invite_race_friends WHERE event_id = ${event.id}
    ), first_ip AS (
      SELECT DISTINCT ON (s.user_id) s.user_id, s.ip_address FROM session s JOIN people p ON p.id = s.user_id
      WHERE s.ip_address IS NOT NULL ORDER BY s.user_id, s.created_at
    ), f AS (
      SELECT f.*, fi.ip_address ip FROM invite_race_friends f LEFT JOIN first_ip fi ON fi.user_id = f.invitee_id WHERE f.event_id = ${event.id}
    )
    SELECT s.inviter_id, s.tickets, s.rank, COALESCE(NULLIF(u.display_username, ''), u.name) name, u.email,
      (SELECT COUNT(*) FROM f WHERE f.inviter_id = s.inviter_id)::int friends,
      (SELECT COUNT(*) FROM f WHERE f.inviter_id = s.inviter_id AND f.spent_total <= ${FREE_CEILING})::int free_only,
      (SELECT COUNT(*) FROM f WHERE f.inviter_id = s.inviter_id AND f.spent_total > ${FREE_CEILING})::int paid,
      (SELECT COUNT(*) FROM f WHERE f.inviter_id = s.inviter_id AND f.spent_total <= ${FREE_CEILING} AND f.ip IS NOT NULL AND (
        f.ip = (SELECT ip_address FROM first_ip WHERE user_id = s.inviter_id)
        OR EXISTS (SELECT 1 FROM f g WHERE g.inviter_id = s.inviter_id AND g.invitee_id <> f.invitee_id AND g.ip = f.ip)))::int free_shared_ip,
      (SELECT COUNT(*) FROM f WHERE f.inviter_id = s.inviter_id AND EXISTS (
        SELECT 1 FROM f g WHERE g.inviter_id = s.inviter_id AND g.invitee_id <> f.invitee_id AND abs(extract(epoch FROM g.joined_at - f.joined_at)) < 300))::int burst,
      EXISTS (SELECT 1 FROM invite_race_exclusions x WHERE x.event_id = ${event.id} AND x.kind = 'inviter' AND x.user_id = s.inviter_id) voided
    FROM invite_race_standings s JOIN "user" u ON u.id = s.inviter_id
    WHERE s.event_id = ${event.id} AND s.round_no = ${roundNo}
    ORDER BY s.rank LIMIT 200`) as Rows<Record<string, unknown> & { inviter_id: string }>;

  const payoutBy = new Map(settlement.payouts.map((p) => [p.userId, p]));
  const cash = await db.execute(sql`SELECT p.round_no, p.user_id, p.total_usd::float8 total_usd, floor(p.total_usd)::int gift_card_usd, p.cash_status, p.provider_order_id, p.provider_error, u.email, COALESCE(NULLIF(u.display_username, ''), u.name) name
    FROM invite_race_payouts p JOIN "user" u ON u.id = p.user_id WHERE p.event_id = ${event.id} AND p.method = 'cash' ORDER BY p.round_no, p.total_usd DESC`);

  return {
    event: { id: event.id, status: event.status, startsAt: event.startsAt.toISOString(), roundCount: event.roundCount, rules: event.rules },
    rounds: rounds.rows,
    roundNo,
    headline: {
      ...headline.rows[0],
      participants: standings.filter((s) => s.tickets > 0).length,
      tickets: settlement.totalTickets,
      usdPerTicket: settlement.usdPerTicket,
    },
    inviters: inviters.rows.map((i) => ({ ...i, estimateUsd: payoutBy.get(i.inviter_id)?.totalUsd ?? 0 })),
    preview: settlement,
    cashQueue: cash.rows,
    giftCardsAutomatic: giftCardsConfigured(),
  };
}

export async function inviteRaceAdminFriends(event: InviteRaceEvent, inviterId: string) {
  const r = await db.execute(sql`
    WITH people AS (
      SELECT invitee_id AS id FROM invite_race_friends WHERE event_id = ${event.id} AND inviter_id = ${inviterId}
      UNION SELECT ${inviterId}::text
    ), first_ip AS (
      SELECT DISTINCT ON (s.user_id) s.user_id, s.ip_address FROM session s JOIN people p ON p.id = s.user_id
      WHERE s.ip_address IS NOT NULL ORDER BY s.user_id, s.created_at
    )
    SELECT f.invitee_id, COALESCE(NULLIF(u.display_username, ''), u.name) name, u.email, f.joined_at, f.signup_round, f.active_round, f.spent_total,
      (fi.ip_address IS NOT NULL AND fi.ip_address = (SELECT ip_address FROM first_ip WHERE user_id = f.inviter_id)) same_ip_as_inviter,
      COALESCE((SELECT SUM(signup + active + usage) FROM invite_race_tickets t WHERE t.event_id = f.event_id AND t.invitee_id = f.invitee_id), 0)::int tickets,
      (SELECT reason FROM invite_race_exclusions x WHERE x.event_id = f.event_id AND x.kind = 'friend' AND x.user_id = f.invitee_id) excluded_reason
    FROM invite_race_friends f JOIN "user" u ON u.id = f.invitee_id LEFT JOIN first_ip fi ON fi.user_id = f.invitee_id
    WHERE f.event_id = ${event.id} AND f.inviter_id = ${inviterId} ORDER BY f.joined_at`);
  return r.rows;
}

export async function setInviteRaceExclusion(event: InviteRaceEvent, input: { userId: string; kind: "friend" | "inviter"; reason: string | null }, adminId: string) {
  if (input.reason) {
    await db.execute(sql`INSERT INTO invite_race_exclusions (event_id, user_id, kind, reason, excluded_by)
      VALUES (${event.id}, ${input.userId}, ${input.kind}, ${input.reason}, ${adminId})
      ON CONFLICT (event_id, user_id, kind) DO UPDATE SET reason = excluded.reason, excluded_by = excluded.excluded_by, excluded_at = now()`);
  } else {
    await db.execute(sql`DELETE FROM invite_race_exclusions WHERE event_id = ${event.id} AND user_id = ${input.userId} AND kind = ${input.kind}`);
  }
}

/** Retry every gift card that hasn't gone out yet (admin button / after config changes). */
export async function retryInviteRaceGiftCards(event: InviteRaceEvent) {
  if (!giftCardsConfigured()) return { attempted: 0, sent: 0 };
  const r = await db.execute(sql`SELECT round_no, user_id FROM invite_race_payouts
    WHERE event_id = ${event.id} AND method = 'cash' AND cash_status IS DISTINCT FROM 'sent'`) as Rows<{ round_no: number; user_id: string }>;
  let sent = 0;
  for (const row of r.rows) if ((await dispatchInviteRaceGiftCard(event, Number(row.round_no), row.user_id)).sent) sent++;
  return { attempted: r.rows.length, sent };
}

export async function markInviteRaceCashSent(event: InviteRaceEvent, roundNo: number, userId: string) {
  await db.execute(sql`UPDATE invite_race_payouts SET cash_status = 'sent', status = 'applied'
    WHERE event_id = ${event.id} AND round_no = ${roundNo} AND user_id = ${userId} AND method = 'cash'`);
}

/** The one-line entry in the credit popup: cheap, two indexed reads. */
export async function inviteRaceEntry(event: InviteRaceEvent, userId: string, now = new Date()) {
  const roundNo = inviteRaceRoundAt(event.startsAt, event.roundCount, now);
  if (!roundNo || event.status === "ended") return null;
  const round = inviteRaceRounds(event.startsAt, event.roundCount)[roundNo - 1]!;
  const mine = await db.execute(sql`SELECT tickets, rank FROM invite_race_standings
    WHERE event_id = ${event.id} AND round_no = ${roundNo} AND inviter_id = ${userId}`) as Rows<{ tickets: number; rank: number | null }>;
  const last = await db.execute(sql`SELECT usd_per_ticket::float8 v FROM invite_race_round_history
    WHERE event_id = ${event.id} AND round_no = ${roundNo} ORDER BY at DESC LIMIT 1`) as Rows<{ v: number }>;
  const tickets = Number(mine.rows[0]?.tickets ?? 0);
  const rank = mine.rows[0]?.rank ?? null;
  const rankUsd = rank && rank <= event.rules.rankPrizesUsd.length && tickets >= event.rules.rankMinTickets ? event.rules.rankPrizesUsd[rank - 1]! : 0;
  const share = tickets * Number(last.rows[0]?.v ?? 0);
  const code = await db.execute(sql`SELECT referral_code FROM "user" WHERE id = ${userId}`) as Rows<{ referral_code: string | null }>;
  return {
    eventId: event.id,
    referralCode: code.rows[0]?.referral_code ?? null,
    roundNo,
    endsAt: round.endsAt.toISOString(),
    tickets,
    estimateUsd: Math.round((share >= event.rules.minPayoutUsd ? share : 0) * 100 + rankUsd * 100) / 100,
  };
}
