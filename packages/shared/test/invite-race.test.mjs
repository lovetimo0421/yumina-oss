import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_INVITE_RACE_RULES as R,
  inviteRaceBandProgress,
  inviteRaceMaxTicketsPerFriend,
  inviteRaceRoundAt,
  inviteRaceRounds,
  inviteRaceUsageTickets,
  settleInviteRaceRound,
} from "../dist/index.js";

test("nothing below 1,000 mushies earns a usage ticket", () => {
  for (const spent of [0, 1, 700, 999, 1000, 1099]) assert.equal(inviteRaceUsageTickets(spent), 0);
});

test("each band pays exactly 20, at 100 / 200 / 400 per ticket", () => {
  assert.equal(inviteRaceUsageTickets(1100), 1);
  assert.equal(inviteRaceUsageTickets(3000), 20);
  assert.equal(inviteRaceUsageTickets(3199), 20);
  assert.equal(inviteRaceUsageTickets(3200), 21);
  assert.equal(inviteRaceUsageTickets(7000), 40);
  assert.equal(inviteRaceUsageTickets(7400), 41);
  assert.equal(inviteRaceUsageTickets(15000), 60);
  assert.equal(inviteRaceUsageTickets(1_000_000), 60);
});

test("a friend is worth at most 64 tickets", () => {
  assert.equal(inviteRaceMaxTicketsPerFriend(), 64);
});

test("usage tickets never go down as spend grows", () => {
  let prev = 0;
  for (let s = 0; s <= 16000; s += 37) {
    const t = inviteRaceUsageTickets(s);
    assert.ok(t >= prev);
    prev = t;
  }
});

test("band progress speaks in tickets, never mushies", () => {
  assert.deepEqual(inviteRaceBandProgress(0), { band: 0, usageTickets: 0, ticketsToNextBand: 20, fraction: 0, maxed: false });
  const mid = inviteRaceBandProgress(2340);
  assert.equal(mid.band, 1);
  assert.equal(mid.usageTickets, 13);
  assert.equal(mid.ticketsToNextBand, 7);
  assert.equal(inviteRaceBandProgress(15000).maxed, true);
});

test("rounds are exactly 7 days, review closes 7 days later", () => {
  const start = new Date("2026-10-05T20:00:00Z");
  const rounds = inviteRaceRounds(start, 4);
  assert.equal(rounds[1].startsAt.toISOString(), "2026-10-12T20:00:00.000Z");
  assert.equal(rounds[3].endsAt.toISOString(), "2026-11-02T20:00:00.000Z");
  assert.equal(rounds[0].settleAfter.toISOString(), "2026-10-19T20:00:00.000Z");
  assert.equal(inviteRaceRoundAt(start, 4, new Date("2026-10-05T19:59:59Z")), null);
  assert.equal(inviteRaceRoundAt(start, 4, new Date("2026-10-12T19:59:59Z")), 1);
  assert.equal(inviteRaceRoundAt(start, 4, new Date("2026-10-12T20:00:00Z")), 2);
  assert.equal(inviteRaceRoundAt(start, 4, new Date("2026-11-02T20:00:00Z")), null);
});

const at = (m) => new Date(Date.UTC(2026, 9, 6, 0, m)).toISOString();

test("the whole $1,000 is paid out, to the cent", () => {
  const standings = Array.from({ length: 40 }, (_, i) => ({ userId: `u${i}`, tickets: 5 + i * 7, reachedAt: at(i) }));
  const s = settleInviteRaceRound(standings);
  const total = s.payouts.reduce((a, p) => a + Math.round(p.totalUsd * 100), 0);
  assert.equal(total, 100_000);
});

test("rank prizes go to the top five, ties to whoever got there first", () => {
  const s = settleInviteRaceRound([
    { userId: "late", tickets: 100, reachedAt: at(9) },
    { userId: "early", tickets: 100, reachedAt: at(1) },
    { userId: "c", tickets: 80, reachedAt: at(2) },
    { userId: "d", tickets: 60, reachedAt: at(3) },
    { userId: "e", tickets: 40, reachedAt: at(4) },
    { userId: "f", tickets: 30, reachedAt: at(5) },
  ]);
  const byId = Object.fromEntries(s.payouts.map((p) => [p.userId, p]));
  assert.equal(byId.early.rank, 1);
  assert.equal(byId.late.rank, 2);
  assert.equal(byId.f.rank, null);
  assert.equal(byId.early.rankUsd, 120);
});

test("any ticket earns a top-5 prize; empty spots move into the pot", () => {
  const s = settleInviteRaceRound([
    { userId: "a", tickets: 5, reachedAt: at(1) },
    { userId: "b", tickets: 1, reachedAt: at(2) },
  ]);
  assert.equal(s.potUsd, 700 + 50 + 30 + 20);
  const byId = Object.fromEntries(s.payouts.map((p) => [p.userId, p]));
  assert.equal(byId.a.rankUsd, 120);
  assert.equal(byId.b.rankUsd, 80);
  assert.equal(Math.round((byId.a.totalUsd + byId.b.totalUsd) * 100), 100_000);
});

test("shares under $1 are dropped and re-split", () => {
  const standings = [{ userId: "big", tickets: 5000, reachedAt: at(1) }];
  for (let i = 0; i < 20; i++) standings.push({ userId: `tiny${i}`, tickets: 1, reachedAt: at(2 + i) });
  const s = settleInviteRaceRound(standings);
  assert.ok(s.payouts.every((p) => p.totalUsd >= 1));
  // Four tiny players hold places 2–5 and keep those prizes; the rest drop out.
  assert.equal(s.payouts.filter((p) => p.userId.startsWith("tiny") && !p.rank).length, 0);
});

test("under $10 pays mushies at 1,000 per dollar; $10 and up waits for a choice", () => {
  const s = settleInviteRaceRound([
    { userId: "a", tickets: 900, reachedAt: at(1) },
    ...["c1", "c2", "c3", "c4"].map((userId, i) => ({ userId, tickets: 500, reachedAt: at(2 + i) })),
    { userId: "b", tickets: 10, reachedAt: at(9) },
  ]);
  const byId = Object.fromEntries(s.payouts.map((p) => [p.userId, p]));
  assert.equal(byId.a.method, "choice_pending");
  assert.equal(byId.a.mushies, null);
  assert.equal(byId.b.method, "mushies_auto");
  assert.equal(byId.b.mushies, Math.round(byId.b.totalUsd * 1000));
  assert.equal(R.mushiesPerUsd, 1000);
});

test("gift cards are whole dollars; the cents become mushies", () => {
  const s = settleInviteRaceRound([
    { userId: "a", tickets: 333, reachedAt: at(1) },
    { userId: "b", tickets: 333, reachedAt: at(2) },
    { userId: "c", tickets: 334, reachedAt: at(3) },
  ]);
  for (const p of s.payouts.filter((x) => x.method === "choice_pending")) {
    assert.equal(Number.isInteger(p.giftCardUsd), true);
    assert.equal(p.giftCardUsd + p.giftCardChangeMushies / 1000, p.totalUsd);
  }
});

test("an empty round pays nothing", () => {
  const s = settleInviteRaceRound([]);
  assert.equal(s.payouts.length, 0);
  assert.equal(s.usdPerTicket, 0);
});
