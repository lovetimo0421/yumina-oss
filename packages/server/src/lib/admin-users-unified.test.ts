import test from "node:test";
import assert from "node:assert/strict";
import { buildUnifiedUsers, parseUsersQuery, type UsersAccount, type UsersDimensions } from "./admin-users-unified.js";
import type { CreditWallet } from "./credit-service.js";
import type { UsersMetricBucket, UsersMetricRow, UsersMetricsSnapshot } from "./admin-users-metrics.js";

const now = new Date("2026-09-12T12:00:00Z");
const account = (id: string, overrides: Partial<UsersAccount> = {}): UsersAccount => ({ id, name: id, email: id + "@test.invalid", username: null,
  image: null, role: "user", isBanned: false, isSuspended: false, createdAt: "2026-01-01T00:00:00Z", wallet: null, overlays: [], ...overrides });
const wallet = (id: string, overrides: Partial<CreditWallet> = {}): CreditWallet => ({ id: "wallet:" + id, userId: id, balance: 5, addonBalance: 0,
  plan: "free", monthlyCredits: 100, memoryCap: null, pendingPlan: null, pendingPlanEffective: null, planExpiresAt: null, planBaseline: null,
  planGrantQueue: [], subscriptionSource: null, subscriptionCancelAt: null, lastDailyRecovery: null, grokTrialRemaining: 0, planVersion: 1,
  periodStart: now, periodEnd: new Date("2026-10-01T00:00:00Z"), ...overrides });
const row = (userId: string, overrides: Partial<UsersMetricRow> = {}): UsersMetricRow => ({ userId, day: "2026-09-12", messages: 1,
  studioMessages: 0, byokMessages: 0, models: [["model", 1, 100, 20, 100, 20]], lastActiveAt: now.toISOString(), player: true, creator: false,
  community: false, active: true, worldMessages: [], playtimeSeconds: 0, ...overrides });
const bucket = (rows: UsersMetricRow[]): UsersMetricBucket => ({ generatedAt: now.toISOString(), through: now.toISOString(), rows,
  sources: { usage: { available: true, through: now.toISOString(), note: "Retained" }, activity: { available: true, through: now.toISOString(), note: "Retained" }, playtime: { available: true, through: now.toISOString(), note: "Measured" } } });
const snapshot = (rows: UsersMetricRow[]): UsersMetricsSnapshot => ({ version: 1, discoveredAt: now.toISOString(), months: ["2026-09"], buckets: { "2026-09": bucket(rows) } });
const dimensions = (accounts: UsersAccount[]): UsersDimensions => ({ accounts, worldOwners: new Map(), prices: new Map() });
const query = (q: Record<string, string | undefined> = {}) => parseUsersQuery({ unit: "all", ...q }, now);

test("effective plan counts and filters include overlays, expiry, queued grants and walletless free accounts", () => {
  const accounts = [account("free"), account("gift", { wallet: wallet("gift"), overlays: [{ planId: "pro", status: "active", endsAt: new Date("2026-10-01"), source: "event" }] }),
    account("expired", { wallet: wallet("expired", { plan: "ultra", planExpiresAt: new Date("2026-09-01"), planBaseline: "go" }) }),
    account("wechat", { wallet: wallet("wechat", { plan: "pro", subscriptionSource: "wechat", periodEnd: new Date("2026-09-01") }) }),
    account("pending", { wallet: wallet("pending", { plan: "ultra", pendingPlan: "plus", pendingPlanEffective: new Date("2026-09-01") }) }),
    account("queued", { wallet: wallet("queued", { plan: "ultra", planExpiresAt: new Date("2026-09-12T11:00Z"), planGrantQueue: [{ plan: "pro", durationMs: 86400000 }] }) }),
    account("internal", { wallet: wallet("internal", { plan: "internal" }) }),
    account("no-wallet-gift", { overlays: [{ planId: "plus", status: "active", endsAt: null, source: "admin" }] }),
    account("future-gift", { wallet: wallet("future-gift"), overlays: [{ planId: "ultra", status: "queued", endsAt: null, source: "admin" }] })];
  const result = buildUnifiedUsers(dimensions(accounts), snapshot([]), query({ plan: "pro", limit: "1" }), now);
  assert.equal(result.total, 2); assert.equal(result.users.length, 1); assert.equal(result.hasMore, true);
  assert.deepEqual(result.summary.planCounts, { free: 3, go: 1, plus: 2, pro: 2, ultra: 0, internal: 1 });
  assert.equal(result.users[0]!.effectivePlan, "pro");
  assert.equal(result.summary.lowBalance, 6); // Internal and walletless accounts excluded.
  const noWallet = buildUnifiedUsers(dimensions(accounts), snapshot([]), query({ search: "no-wallet-gift" }), now).users[0]!;
  assert.equal(noWallet.wallet, null); assert.equal(noWallet.effectivePlan, "plus");
});

test("global ordering and pagination reach all users beyond 500 with deterministic ties", () => {
  const accounts = Array.from({ length: 650 }, (_, i) => account("user-" + String(i).padStart(4, "0")));
  const rows = accounts.map((a, i) => row(a.id, { messages: i, playtimeSeconds: i * 10, studioMessages: i }));
  for (const sort of ["messages", "playtime", "studioMessages"]) {
    const result = buildUnifiedUsers(dimensions(accounts), snapshot(rows), query({ sort, limit: "20", offset: "620" }), now);
    assert.equal(result.total, 650); assert.equal(result.users[0]!.id, "user-0029"); assert.equal(result.users.at(-1)!.id, "user-0010");
    assert.equal(result.hasMore, true);
  }
  const asc = buildUnifiedUsers(dimensions(accounts.reverse()), snapshot([]), query({ sort: "joined", sortDir: "asc", offset: "600" }), now);
  assert.equal(asc.users[0]!.id, "user-0600"); assert.equal(asc.total, 650); assert.equal(asc.hasMore, false);
  assert.equal(buildUnifiedUsers(dimensions(accounts), snapshot(rows), query({ offset: "999" }), now).users.length, 0);
});

test("cohorts overlap, count meaningful activity, and activeToday ignores historical period and filters", () => {
  const data = snapshot([row("player", { community: true }), row("studio", { messages: 0, player: false, creator: true }),
    row("reward", { messages: 0, player: false }), row("passive", { messages: 0, player: false, active: false }),
    row("deleted"), row("yesterday", { day: "2026-09-11" })]);
  const accounts = ["player", "studio", "reward", "passive", "yesterday"].map(id => account(id));
  const result = buildUnifiedUsers(dimensions(accounts), data, query({ unit: "day", date: "2026-09-11", group: "activeToday", search: "player" }), now);
  assert.equal(result.total, 1); assert.equal(result.users[0]!.usage.messages, 0);
  assert.equal(result.summary.activeToday, 3); assert.equal(result.summary.groupCounts.players, 1);
  const all = buildUnifiedUsers(dimensions(accounts), data, query(), now);
  assert.equal(all.summary.groupCounts.players, 2); assert.equal(all.summary.groupCounts.community, 1); assert.equal(all.summary.groupCounts.creators, 1);
  assert.equal(buildUnifiedUsers(dimensions(accounts), data, query({ group: "community" }), now).total, 1);
});

test("creator interactions attribute other players to current world authors and keep Studio use separate", () => {
  const dims = dimensions([account("author"), account("player"), account("studio-only")]);
  dims.worldOwners.set("world-a", "author"); dims.worldOwners.set("translation-a", "author");
  const data = snapshot([row("author", { worldMessages: [["world-a", 20]], messages: 20, studioMessages: 3, creator: true }),
    row("player", { worldMessages: [["world-a", 7], ["translation-a", 4], ["missing-world", 99]] }),
    row("studio-only", { messages: 0, studioMessages: 100, creator: true, player: false }),
    row("deleted-player", { worldMessages: [["world-a", 9]] })]);
  const result = buildUnifiedUsers(dims, data, query({ sort: "creatorInteractions" }), now);
  assert.equal(result.users[0]!.id, "author"); assert.equal(result.users[0]!.usage.creatorInteractions, 11);
  assert.equal(result.users.find(u => u.id === "studio-only")!.usage.creatorInteractions, 0);
  assert.equal(result.users.find(u => u.id === "studio-only")!.usage.studioMessages, 100);
  assert.match(result.metrics.note, /self-play is excluded/);
});

test("cost is estimated using model token totals; most-used model ties and ordering are deterministic", () => {
  const dims = dimensions([account("a"), account("b")]); dims.prices.set("known", { input: 1, output: 2 });
  dims.prices.set("other", { input: 3, output: 15 });
  const data = snapshot([row("a", { models: [["known", 3, 1000000, 1000000, 1000000, 1000000], ["other", 2, 0, 1000000, 0, 1000000]] }), row("b", { models: [["z", 4, 10, 0, 10, 0], ["a", 4, 5, 0, 5, 0]] })]);
  const result = buildUnifiedUsers(dims, data, query({ sort: "cost" }), now);
  assert.equal(result.users[0]!.usage.estimatedCost, 18); assert.equal(result.users[0]!.usage.topModel, "known");
  assert.equal(result.users[1]!.usage.topModel, "a"); assert.equal(result.users[0]!.usage.tokens, 3000000);
  assert.equal(result.users[1]!.usage.estimatedCost, null);
  const missingFirst = snapshot([row("a", { models: [["missing", 1, 5, 0, 5, 0], ["known", 1, 10, 0, 10, 0]] })]);
  const partial = buildUnifiedUsers(dims, missingFirst, query(), now).users.find(u => u.id === "a")!;
  assert.equal(partial.usage.estimatedCost, 0); // Rounds to 4 decimals, not erased by an unknown model.
  assert.equal(partial.usage.costCoverage?.complete, false); assert.equal(partial.usage.costCoverage?.unpricedTokens, 5);
  const byok = snapshot([row("a", { byokMessages: 2, models: [["missing-byok", 1, 1000, 1000, 0, 0], ["known", 2, 3000000, 3000000, 1000000, 1000000]] })]);
  const paidOnly = buildUnifiedUsers(dims, byok, query(), now).users.find(u => u.id === "a")!;
  assert.equal(paidOnly.usage.estimatedCost, 3); assert.equal(paidOnly.usage.tokens, 6002000); assert.equal(paidOnly.usage.byokMessages, 2);
});

test("recorded charges replace estimates only for those requests; missing pricing cannot erase a high-cost user", () => {
  const dims = dimensions([account("high", {username:"okok",lifetimePlaytimeSeconds:10000}),account("low")]);
  dims.prices.set("known", {input:1,output:2});
  const data = snapshot([row("high", {models:[["known",3,1000000,1000000,1000000,1000000]],
    costs:[["known",.25,1,500000,500000,2],["missing",0,0,100,100,1]],playtimeSeconds:50,standaloneSeconds:20}),
    row("low",{models:[["known",1,100,100,100,100]],costs:[["known",0,1,0,0,0]]})]);
  const result = buildUnifiedUsers(dims,data,query({sort:"cost"}),now);
  assert.equal(result.users[0]!.id,"high"); assert.equal(result.users[0]!.usage.estimatedCost,1.75);
  assert.deepEqual(result.users[0]!.usage.costCoverage,{observedUsd:.25,observedRequests:1,estimatedUsd:1.5,estimatedRequests:2,unpricedRequests:1,unpricedTokens:200,complete:false});
  assert.equal(result.users[1]!.usage.estimatedCost,0,"Recorded zero charge is not estimated again");
  assert.equal(result.users[0]!.usage.playtimeSeconds,10020,"Lifetime counters replace, not add to, main-app intervals");
  assert.equal(buildUnifiedUsers(dims,data,query({unit:"day"}),now).users.find(u=>u.id==="high")!.usage.playtimeSeconds,50);
  assert.equal(buildUnifiedUsers(dims,data,query({search:"@OKOK"}),now).users[0]!.id,"high");
});

test("cold and incomplete metrics stay null without hiding account/plan counts; unknown sorts last", () => {
  const dims = dimensions([account("a"), account("b")]);
  const cold = buildUnifiedUsers(dims, null, query(), now);
  assert.equal(cold.total, 2); assert.equal(cold.summary.totalUsers, 2); assert.equal(cold.summary.planCounts.free, 2);
  assert.equal(cold.users[0]!.usage.tokens, null); assert.equal(cold.users[0]!.usage.creatorInteractions, null);
  assert.equal(cold.summary.activeToday, null); assert.equal(cold.summary.groupCounts.creators, null);
  assert.equal(cold.metrics.status, "unavailable");
  const data = snapshot([row("b", { playtimeSeconds: 100 })]); data.months.unshift("2026-08");
  assert.equal(buildUnifiedUsers(dims, data, query(), now).users[0]!.usage.messages, null);
  const selected = buildUnifiedUsers(dims, data, query({ unit: "day", date: "2026-09-12", sort: "playtime", sortDir: "asc" }), now);
  assert.equal(selected.users[0]!.id, "b"); assert.equal(selected.users[1]!.usage.playtimeSeconds, null);
});

test("UTC boundaries and malformed input cannot widen to an unbounded history query", () => {
  assert.equal(query({ unit: "week", date: "2026-09-13" }).start, "2026-09-07");
  assert.equal(query({ unit: "month", date: "2026-12-31" }).end, "2027-01-01");
  assert.equal(query({ limit: "500" }).limit, 200);
  for (const q of [{ date: "2026-02-30", unit: "day" }, { unit: "bogus" }, { limit: "0" }, { limit: "20junk" }, { offset: "-1" }, { offset: "NaN" },
    { group: "constructor" }, { plan: "toString" }, { sort: "x; DROP TABLE" }, { sortDir: "NULLS FIRST" }]) assert.throws(() => query(q));
});
