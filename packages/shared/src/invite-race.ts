// ─── Invite Race ─────────────────────────────────────────────────────
//
// A weekly event with a fixed prize pool, split by tickets. Tickets come from
// the friends an inviter brings: 1 for signing up, 3 for becoming active, and up
// to 60 more from the mushies the friend uses in their first 14 days, in three
// bands that each pay exactly 20. The server rollup, the live board and the
// settlement all use these functions, so the numbers a player sees are the
// numbers they get paid on.
//
// Design: docs/superpowers/specs/2026-09-23-invite-race-design.md

export interface InviteRaceBand {
  /** Mushies used before this band starts paying. */
  from: number;
  /** Mushies used where this band stops paying. */
  to: number;
  /** Mushies per ticket inside the band. */
  per: number;
}

export interface InviteRaceRules {
  signupTickets: number;
  /** Most signup tickets one inviter can earn in one round. */
  signupCapPerRound: number;
  activeTickets: number;
  /** Days after signup in which a friend's mushie use counts. */
  windowDays: number;
  bands: InviteRaceBand[];
  sharedPotUsd: number;
  /** Rank prizes, best first. */
  rankPrizesUsd: number[];
  rankMinTickets: number;
  /** Shares under this are dropped and re-split among everyone else. */
  minPayoutUsd: number;
  /** Prizes under this are paid in mushies automatically; at or above it the winner can take a gift card. */
  cashThresholdUsd: number;
  /** One rate for every mushie payout. */
  mushiesPerUsd: number;
  /** @deprecated kept so older stored rule sets still parse; ignored. */
  mushiesPerUsdAuto?: number;
  /** @deprecated kept so older stored rule sets still parse; ignored. */
  mushiesPerUsdChosen?: number;
  chooseDays: number;
}

export const DEFAULT_INVITE_RACE_RULES: InviteRaceRules = {
  signupTickets: 1,
  signupCapPerRound: 30,
  activeTickets: 3,
  windowDays: 7,
  bands: [
    { from: 1000, to: 3000, per: 100 },
    { from: 3000, to: 7000, per: 200 },
    { from: 7000, to: 15000, per: 400 },
  ],
  sharedPotUsd: 700,
  rankPrizesUsd: [120, 80, 50, 30, 20],
  // Any ticket qualifies: the full pool goes out even if one person plays (owner 2026-09-24).
  rankMinTickets: 1,
  minPayoutUsd: 1,
  cashThresholdUsd: 10,
  mushiesPerUsd: 1000,
  chooseDays: 14,
};

/** Tickets from a friend's cumulative mushie use. Monotonic, so round deltas are never negative. */
export function inviteRaceUsageTickets(spent: number, bands: InviteRaceBand[] = DEFAULT_INVITE_RACE_RULES.bands): number {
  if (!Number.isFinite(spent) || spent <= 0) return 0;
  let tickets = 0;
  for (const b of bands) {
    const inBand = Math.min(Math.max(spent - b.from, 0), b.to - b.from);
    tickets += Math.floor(inBand / b.per);
  }
  return tickets;
}

/** The most tickets one friend can ever be worth. */
export function inviteRaceMaxTicketsPerFriend(rules: InviteRaceRules = DEFAULT_INVITE_RACE_RULES): number {
  const top = rules.bands.reduce((m, b) => Math.max(m, b.to), 0);
  return rules.signupTickets + rules.activeTickets + inviteRaceUsageTickets(top, rules.bands);
}

export interface InviteRaceBandProgress {
  /** 0 = below the first band, bands.length = past the last one. */
  band: number;
  usageTickets: number;
  /** Tickets still to earn in the current band; 0 once every band is full. */
  ticketsToNextBand: number;
  /** 0..1 progress through the current band. */
  fraction: number;
  maxed: boolean;
}

/**
 * Where a friend is on the band ladder, for the progress bar. Deliberately
 * speaks in tickets, never mushies: the inviter must not be able to read a
 * friend's spending off the page.
 */
export function inviteRaceBandProgress(spent: number, bands: InviteRaceBand[] = DEFAULT_INVITE_RACE_RULES.bands): InviteRaceBandProgress {
  const usageTickets = inviteRaceUsageTickets(spent, bands);
  const last = bands[bands.length - 1];
  if (!last || spent >= last.to) return { band: bands.length, usageTickets, ticketsToNextBand: 0, fraction: 1, maxed: true };
  const i = bands.findIndex((b) => spent < b.to);
  const b = bands[i]!;
  const bandTickets = Math.floor((b.to - b.from) / b.per);
  const earnedInBand = Math.floor(Math.max(spent - b.from, 0) / b.per);
  return {
    band: spent < b.from ? 0 : i + 1,
    usageTickets,
    ticketsToNextBand: bandTickets - earnedInBand,
    fraction: spent < b.from ? Math.max(0, spent) / b.from : (spent - b.from) / (b.to - b.from),
    maxed: false,
  };
}

// ─── Rounds ──────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

export interface InviteRaceRoundWindow {
  roundNo: number;
  startsAt: Date;
  endsAt: Date;
  settleAfter: Date;
}

/** Round windows: exactly 7 days each from the event start, review 7 days after close. */
export function inviteRaceRounds(startsAt: Date, roundCount: number): InviteRaceRoundWindow[] {
  return Array.from({ length: roundCount }, (_, i) => {
    const s = new Date(startsAt.getTime() + i * 7 * DAY_MS);
    const e = new Date(s.getTime() + 7 * DAY_MS);
    return { roundNo: i + 1, startsAt: s, endsAt: e, settleAfter: new Date(e.getTime() + 7 * DAY_MS) };
  });
}

/** Which round an instant falls in, or null outside the event. */
export function inviteRaceRoundAt(startsAt: Date, roundCount: number, at: Date): number | null {
  const offset = at.getTime() - startsAt.getTime();
  if (offset < 0) return null;
  const n = Math.floor(offset / (7 * DAY_MS)) + 1;
  return n <= roundCount ? n : null;
}

// ─── Settlement ──────────────────────────────────────────────────────

export interface InviteRaceStanding {
  userId: string;
  tickets: number;
  /** When the inviter reached their current total (tie-break: earlier wins). */
  reachedAt: string | null;
}

export type InviteRacePayoutMethod = "mushies_auto" | "choice_pending";

export interface InviteRacePayout {
  userId: string;
  tickets: number;
  rank: number | null;
  rankUsd: number;
  shareUsd: number;
  totalUsd: number;
  method: InviteRacePayoutMethod;
  /** Mushies for automatic payouts; null while the winner chooses. */
  mushies: number | null;
  /**
   * For $10+ prizes: the gift card is whole dollars only, and the cents become
   * mushies, so nobody ever has to send or receive a $23.47 card.
   */
  giftCardUsd: number | null;
  giftCardChangeMushies: number | null;
}

export interface InviteRaceSettlement {
  totalTickets: number;
  /** Shared pot actually split, after unclaimed rank prizes moved in. */
  potUsd: number;
  /** Value of one ticket in the final split (0 when nobody qualifies). */
  usdPerTicket: number;
  payouts: InviteRacePayout[];
}

/** Standings sorted the way ranks are decided: tickets desc, then who got there first. */
export function inviteRaceRank(standings: InviteRaceStanding[]): InviteRaceStanding[] {
  return standings
    .filter((s) => s.tickets > 0)
    .slice()
    .sort((a, b) => b.tickets - a.tickets
      || (Date.parse(a.reachedAt ?? "") || Infinity) - (Date.parse(b.reachedAt ?? "") || Infinity)
      || a.userId.localeCompare(b.userId));
}

const cents = (usd: number) => Math.round(usd * 100);

/**
 * The whole payout for one round, from final standings. Pure and
 * deterministic: the live board calls it for the estimate, the admin preview
 * and the approval call it for the real thing.
 *
 *   1. Rank prizes go to the top N with at least rankMinTickets; any prize
 *      nobody qualifies for moves into the shared pot.
 *   2. The pot splits by tickets. Anyone whose share is under minPayoutUsd is
 *      dropped and the pot re-splits among the rest, until nobody is under.
 *   3. Shares are floored to cents; leftover cents go to the largest share.
 */
export function settleInviteRaceRound(standings: InviteRaceStanding[], rules: InviteRaceRules = DEFAULT_INVITE_RACE_RULES): InviteRaceSettlement {
  const ranked = inviteRaceRank(standings);
  const totalTickets = ranked.reduce((s, r) => s + r.tickets, 0);

  const rankUsd = new Map<string, { rank: number; usd: number }>();
  let unclaimedCents = 0;
  rules.rankPrizesUsd.forEach((prize, i) => {
    const r = ranked[i];
    if (r && r.tickets >= rules.rankMinTickets) rankUsd.set(r.userId, { rank: i + 1, usd: prize });
    else unclaimedCents += cents(prize);
  });

  const potCents = cents(rules.sharedPotUsd) + unclaimedCents;
  let eligible = ranked;
  for (;;) {
    const t = eligible.reduce((s, r) => s + r.tickets, 0);
    if (t === 0) { eligible = []; break; }
    const keep = eligible.filter((r) => (potCents * r.tickets) / t >= cents(rules.minPayoutUsd));
    if (keep.length === eligible.length) break;
    eligible = keep;
  }
  const eligibleTickets = eligible.reduce((s, r) => s + r.tickets, 0);
  const share = new Map<string, number>();
  let assigned = 0;
  for (const r of eligible) {
    const c = Math.floor((potCents * r.tickets) / eligibleTickets);
    share.set(r.userId, c);
    assigned += c;
  }
  if (eligible[0] && potCents - assigned > 0) share.set(eligible[0].userId, share.get(eligible[0].userId)! + (potCents - assigned));

  const payouts: InviteRacePayout[] = [];
  for (const r of ranked) {
    const shareCents = share.get(r.userId) ?? 0;
    const rank = rankUsd.get(r.userId);
    const totalCents = shareCents + cents(rank?.usd ?? 0);
    if (totalCents <= 0) continue;
    const totalUsd = totalCents / 100;
    const auto = totalUsd < rules.cashThresholdUsd;
    const rate = rules.mushiesPerUsd;
    payouts.push({
      userId: r.userId,
      tickets: r.tickets,
      rank: rank?.rank ?? null,
      rankUsd: rank?.usd ?? 0,
      shareUsd: shareCents / 100,
      totalUsd,
      method: auto ? "mushies_auto" : "choice_pending",
      mushies: auto ? Math.round((totalCents * rate) / 100) : null,
      giftCardUsd: auto ? null : Math.floor(totalCents / 100),
      giftCardChangeMushies: auto ? null : Math.round(((totalCents % 100) * rate) / 100),
    });
  }
  return {
    totalTickets,
    potUsd: potCents / 100,
    usdPerTicket: eligibleTickets ? potCents / 100 / eligibleTickets : 0,
    payouts,
  };
}

// ─── API shapes ──────────────────────────────────────────────────────

export type InviteRaceFriendStep = "signed_up" | "active" | "using";

export interface InviteRaceFriendView {
  inviteeId: string;
  name: string;
  image: string | null;
  joinedAt: string;
  /** Last moment this friend's mushie use can still count. */
  windowEndsAt: string;
  signupTicket: boolean;
  active: boolean;
  /** Days of play still needed before "active", from the qualified-referral check. */
  activeHint: "return_tomorrow" | "play_more" | null;
  progress: InviteRaceBandProgress;
  /** Tickets this friend has earned the inviter across the whole event. */
  tickets: number;
  excluded: boolean;
}

export interface InviteRaceLeader {
  rank: number;
  userId: string;
  name: string;
  image: string | null;
  tickets: number;
  estimateUsd: number;
}

export interface InviteRaceRoundResult {
  roundNo: number;
  status: "closed" | "review" | "approved" | "paid";
  tickets: number;
  totalUsd: number;
  rank: number | null;
  method: "mushies_auto" | "choice_pending" | "mushies" | "cash" | null;
  mushies: number | null;
  chooseBy: string | null;
}

export interface InviteRaceView {
  event: {
    id: string;
    status: "preview" | "live" | "paused" | "ended";
    startsAt: string;
    roundCount: number;
    rules: InviteRaceRules;
  };
  round: { roundNo: number; startsAt: string; endsAt: string } | null;
  totals: { tickets: number; participants: number; usdPerTicket: number; usdPerTicketYesterday: number | null };
  /** Hourly value-per-ticket for the sparkline. */
  history: { at: string; usdPerTicket: number }[];
  me: {
    tickets: number;
    rank: number | null;
    estimateUsd: number;
    rankUsd: number;
    /** Tickets needed to pass the next rank up, and what that rank pays. */
    nextRank: { rank: number; ticketsNeeded: number; prizeUsd: number } | null;
    referralCode: string | null;
  };
  leaders: InviteRaceLeader[];
  friends: InviteRaceFriendView[];
  results: InviteRaceRoundResult[];
  updatedAt: string | null;
}
