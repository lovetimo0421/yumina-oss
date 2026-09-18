import { PLANS, normalizePlan, type PlanId } from "./plan-config.js";
import { computeEffectivePlanState, type EntitlementOverlay } from "./plan-state.js";
import type { CreditWallet } from "./credit-service.js";
import { USERS_CREATOR_NOTE, type UsersMetricsSnapshot } from "./admin-users-metrics.js";

export const USER_GROUPS = ["all", "activeToday", "players", "creators", "community", "lowBalance", "suspended"] as const;
export const USER_SORTS = ["messages", "tokens", "cost", "lastActive", "balance", "joined", "playtime", "studioMessages", "creatorInteractions"] as const;
type UserGroup = typeof USER_GROUPS[number];
type UserSort = typeof USER_SORTS[number];
export interface UsersQuery {
  unit: "day" | "week" | "month" | "all";
  start: string | null;
  end: string | null;
  search: string;
  plan: string;
  status: string;
  balanceRange: string;
  group: UserGroup;
  sort: UserSort;
  sortDir: "asc" | "desc";
  limit: number;
  offset: number;
}
export function parseUsersQuery(q: Record<string, string | undefined>, now: Date): UsersQuery {
  const unit = q.unit ?? "day";
  if (!["day", "week", "month", "all"].includes(unit)) throw new Error("Invalid period unit");
  let start: Date | null = null, end: Date | null = null;
  if (unit !== "all") {
    const date = q.date ?? now.toISOString().slice(0, 10);
    start = new Date(date + "T00:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(+start) || start.toISOString().slice(0, 10) !== date) throw new Error("Invalid UTC date");
    if (unit === "week") start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
    if (unit === "month") start.setUTCDate(1);
    end = new Date(start);
    if (unit === "month") end.setUTCMonth(end.getUTCMonth() + 1);
    else end.setUTCDate(end.getUTCDate() + (unit === "week" ? 7 : 1));
  }
  const integer = (value: string | undefined, fallback: number, minimum: number) => {
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) throw new Error("Invalid pagination");
    return Number(value);
  };
  const group = q.group || "all", sort = q.sort || "lastActive", plan = q.plan || "";
  if (!USER_GROUPS.includes(group as UserGroup)) throw new Error("Invalid user group");
  if (!USER_SORTS.includes(sort as UserSort)) throw new Error("Invalid sort");
  if (plan && !Object.hasOwn(PLANS, plan)) throw new Error("Invalid plan");
  if (q.sortDir && !["asc", "desc"].includes(q.sortDir)) throw new Error("Invalid sort direction");
  if (q.status && !["active", "suspended", "banned"].includes(q.status)) throw new Error("Invalid status");
  if (q.balanceRange && !["exhausted", "low", "healthy"].includes(q.balanceRange)) throw new Error("Invalid balance range");
  if ((q.search?.length ?? 0) > 500) throw new Error("Search is too long");
  return { unit: unit as UsersQuery["unit"], start: start?.toISOString().slice(0, 10) ?? null, end: end?.toISOString().slice(0, 10) ?? null,
    search: q.search?.trim().toLowerCase() ?? "", plan, status: q.status ?? "", balanceRange: q.balanceRange ?? "",
    group: group as UserGroup, sort: sort as UserSort, sortDir: q.sortDir === "asc" ? "asc" : "desc",
    limit: Math.min(integer(q.limit, 100, 1), 200), offset: integer(q.offset, 0, 0) };
}

export interface UsersAccount {
  id: string; name: string; email: string; username: string | null; image: string | null;
  role: string; isBanned: boolean; isSuspended: boolean; createdAt: string;
  lifetimePlaytimeSeconds?: number;
  wallet: CreditWallet | null;
  overlays: EntitlementOverlay[];
}
export interface UsersUsage {
  messages: number | null; studioMessages: number | null; tokens: number | null;
  promptTokens: number | null; completionTokens: number | null; byokMessages: number | null;
  lastActiveAt: string | null; topModel: string | null; estimatedCost: number | null;
  playtimeSeconds: number | null; creatorInteractions: number | null;
  costCoverage?: { observedUsd: number; estimatedUsd: number; observedRequests: number; estimatedRequests: number; unpricedRequests: number; unpricedTokens: number; complete: boolean };
}
export interface UsersDimensions {
  accounts: UsersAccount[];
  worldOwners: Map<string, string>;
  prices: Map<string, { input: number; output: number }>;
}

/** One projection is used for counts, filters, ordering and pagination. Account
 * plans are resolved at request time even when usage snapshots are unchanged. */
export function buildUnifiedUsers(dimensions: UsersDimensions, snapshot: UsersMetricsSnapshot | null, query: UsersQuery, now: Date) {
  const today = now.toISOString().slice(0, 10);
  const contains = (day: string) => (!query.start || day >= query.start) && (!query.end || day < query.end);
  const intersects = (month: string) => {
    const next = new Date(month + "-01T00:00:00Z"); next.setUTCMonth(next.getUTCMonth() + 1);
    return (!query.end || month + "-01" < query.end) && (!query.start || next.toISOString().slice(0, 10) > query.start);
  };
  const months = snapshot?.months.filter(intersects) ?? [];
  const buckets = snapshot?.aggregate ? [snapshot.aggregate] : months.flatMap(m => snapshot?.buckets[m] ? [snapshot.buckets[m]!] : []);
  const prepared = snapshot?.preparedComplete ?? (!!snapshot && months.length === buckets.length);
  // A period with no source facts is a measured zero only after month discovery.
  const allBuckets = snapshot?.aggregate ? [snapshot.aggregate] : Object.values(snapshot?.buckets ?? {});
  const usageAvailable = prepared && allBuckets.some(b => b.sources.usage.available) && buckets.every(b => b.sources.usage.available);
  const activityAvailable = prepared && allBuckets.some(b => b.sources.activity.available) && buckets.every(b => b.sources.activity.available);
  const playtimeAvailable = prepared && buckets.some(b => b.sources.playtime.available);
  const cohortsAvailable = usageAvailable && activityAvailable;
  const todayBucket = snapshot?.today ?? snapshot?.buckets[today.slice(0, 7)];
  const todayAvailable = !!todayBucket && todayBucket.sources.usage.available && todayBucket.sources.activity.available && todayBucket.through.slice(0, 10) >= today;
  const todayUsers = new Set(todayBucket?.rows.filter(r => r.day === today && r.active).map(r => r.userId));
  const knownIds = new Set(dimensions.accounts.map(a => a.id));
  const metrics = new Map<string, { usage: UsersUsage; standaloneSeconds: number; player: boolean; creator: boolean; community: boolean; models: Map<string, number> }>();
  const metricFor = (id: string) => {
    if (!metrics.has(id)) metrics.set(id, { usage: { messages: usageAvailable ? 0 : null, studioMessages: usageAvailable ? 0 : null,
      tokens: usageAvailable ? 0 : null, promptTokens: usageAvailable ? 0 : null, completionTokens: usageAvailable ? 0 : null,
      byokMessages: usageAvailable ? 0 : null, lastActiveAt: null, topModel: null, estimatedCost: usageAvailable ? 0 : null,
      // No measured interval is not proof of zero lifetime game time.
      playtimeSeconds: null, creatorInteractions: usageAvailable ? 0 : null,
      costCoverage: { observedUsd: 0, estimatedUsd: 0, observedRequests: 0, estimatedRequests: 0, unpricedRequests: 0, unpricedTokens: 0, complete: usageAvailable } }, standaloneSeconds: 0, player: false, creator: false, community: false, models: new Map() });
    return metrics.get(id)!;
  };
  for (const bucket of buckets) for (const row of bucket.rows) {
    if (!contains(row.day) || !knownIds.has(row.userId)) continue; // Respect live account deletions.
    const metric = metricFor(row.userId), usage = metric.usage;
    metric.player ||= row.player; metric.creator ||= row.creator; metric.community ||= row.community;
    if (row.lastActiveAt && (!usage.lastActiveAt || usage.lastActiveAt < row.lastActiveAt)) usage.lastActiveAt = row.lastActiveAt;
    if (bucket.sources.playtime.available && row.playtimeSeconds > 0) usage.playtimeSeconds = (usage.playtimeSeconds ?? 0) + row.playtimeSeconds;
    metric.standaloneSeconds += row.standaloneSeconds ?? 0;
    if (usageAvailable) {
      usage.messages! += row.messages; usage.studioMessages! += row.studioMessages; usage.byokMessages! += row.byokMessages;
      for (const [model, requests, input, output] of row.models) {
        metric.models.set(model, (metric.models.get(model) ?? 0) + requests);
        usage.promptTokens! += input; usage.completionTokens! += output; usage.tokens! += input + output;
      }
      for (const [model,observed,measured,input,output,requests] of row.costs ?? row.models.map(([m,n,,,pi,po]) => [m,0,0,pi,po,pi+po>0?n:0] as const)) {
        const c = usage.costCoverage!, price = dimensions.prices.get(model);
        c.observedUsd += observed; c.observedRequests += measured;
        if (price && Number.isFinite(price.input) && Number.isFinite(price.output) && price.input >= 0 && price.output >= 0) {
          c.estimatedUsd += (input * price.input + output * price.output) / 1_000_000;
          c.estimatedRequests += requests;
        } else if (requests > 0 || input + output > 0) {
          c.unpricedRequests += requests; c.unpricedTokens += input + output; c.complete = false;
        }
      }
      for (const [worldId, messages] of row.worldMessages) {
        const owner = dimensions.worldOwners.get(worldId);
        if (owner && owner !== row.userId && knownIds.has(owner)) metricFor(owner).usage.creatorInteractions! += messages;
      }
    }
  }
  const planCounts = Object.fromEntries(Object.keys(PLANS).map(p => [p, 0])) as Record<PlanId, number>;
  const groupCounts: Record<UserGroup, number | null> = { all: dimensions.accounts.length, activeToday: todayAvailable ? 0 : null,
    players: cohortsAvailable ? 0 : null, creators: cohortsAvailable ? 0 : null, community: activityAvailable ? 0 : null, lowBalance: 0, suspended: 0 };
  const projected = dimensions.accounts.map(account => {
    const wallet = account.wallet;
    // An entitlement can outlive a missing wallet; keep wallet=null while exposing
    // the canonical effectivePlan at user level for filters/badges/counts.
    const base = wallet ?? { id: "", userId: account.id, balance: 0, addonBalance: 0, plan: "free", monthlyCredits: 0, memoryCap: null,
      pendingPlan: null, pendingPlanEffective: null, planExpiresAt: null, planBaseline: null, planGrantQueue: [], subscriptionSource: null,
      subscriptionCancelAt: null, lastDailyRecovery: null, grokTrialRemaining: 0, planVersion: 1, periodStart: now, periodEnd: now } satisfies CreditWallet;
    const planState = computeEffectivePlanState(base, now, account.overlays);
    const effectivePlan = normalizePlan(planState.effective);
    planCounts[effectivePlan]++;
    const metric = metricFor(account.id), usage = metric.usage;
    if (query.unit === "all" && account.lifetimePlaytimeSeconds !== undefined)
      usage.playtimeSeconds = account.lifetimePlaytimeSeconds + metric.standaloneSeconds;
    usage.topModel = [...metric.models].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
    if (usageAvailable) {
      const c = usage.costCoverage!;
      usage.estimatedCost = c.complete || c.observedRequests + c.estimatedRequests > 0
        ? Number((c.observedUsd + c.estimatedUsd).toFixed(4)) : null;
    }
    const low = effectivePlan !== "internal" && base.balance > 0 && base.balance <= base.monthlyCredits * .1;
    const groups = { all: true, activeToday: todayAvailable && todayUsers.has(account.id), players: cohortsAvailable && metric.player,
      creators: cohortsAvailable && metric.creator, community: activityAvailable && metric.community, lowBalance: low, suspended: account.isSuspended };
    for (const group of USER_GROUPS) if (group !== "all" && groupCounts[group] !== null && groups[group]) groupCounts[group]!++;
    return { groups, rawBalance: base.balance, monthlyCredits: base.monthlyCredits, value: {
      id: account.id, name: account.name, email: account.email, username: account.username, image: account.image,
      role: account.role, isBanned: account.isBanned, isSuspended: account.isSuspended, createdAt: account.createdAt, effectivePlan,
      wallet: wallet ? { id: wallet.id, balance: Math.floor(wallet.balance), addonBalance: Math.floor(wallet.addonBalance), plan: wallet.plan,
        monthlyCredits: wallet.monthlyCredits, memoryCap: wallet.memoryCap, periodEnd: wallet.periodEnd.toISOString(), effectivePlan,
        planSource: planState.source, scheduledChange: planState.scheduled ? { plan: planState.scheduled.plan, when: planState.scheduled.when.toISOString(), reason: planState.scheduled.reason } : null,
        subscriptionSource: wallet.subscriptionSource } : null, usage,
    } };
  });
  const filtered = projected.filter(r => {
    const v = r.value;
    if (!r.groups[query.group]) return false;
    if (query.search && (query.search.startsWith("@")
      ? !v.username?.toLowerCase().includes(query.search.slice(1))
      : ![v.id, v.name, v.email, v.username].some(s => s?.toLowerCase().includes(query.search)))) return false;
    if (query.plan && v.effectivePlan !== query.plan) return false;
    if (query.status === "suspended" && !v.isSuspended || query.status === "banned" && !v.isBanned || query.status === "active" && (v.isSuspended || v.isBanned)) return false;
    if (query.balanceRange === "low" && !r.groups.lowBalance || query.balanceRange === "exhausted" && r.rawBalance > 0 || query.balanceRange === "healthy" && r.rawBalance <= r.monthlyCredits * .1) return false;
    return true;
  });
  const sortValue = (r: typeof projected[number]): string | number | null => {
    const v = r.value;
    switch (query.sort) {
      case "balance": return r.rawBalance;
      case "joined": return v.createdAt;
      case "lastActive": return v.usage.lastActiveAt;
      case "cost": return v.usage.estimatedCost;
      case "playtime": return v.usage.playtimeSeconds;
      default: return v.usage[query.sort];
    }
  };
  filtered.sort((a, b) => {
    const left = sortValue(a), right = sortValue(b);
    if (left === null || right === null) {
      if (left !== right) return left === null ? 1 : -1; // Unknown always last, including ascending.
    } else {
      const comparison = left < right ? -1 : left > right ? 1 : 0;
      if (comparison) return query.sortDir === "asc" ? comparison : -comparison;
    }
    return a.value.id.localeCompare(b.value.id); // Deterministic pagination ties.
  });
  const timestamps = buckets.map(b => b.generatedAt).sort(), coverageTimes = buckets.map(b => b.through).sort();
  const stale = buckets.some((bucket, index) => {
    const monthEnd = snapshot?.aggregate ? now : new Date(months[index]! + "-01T00:00:00Z");
    if (!snapshot?.aggregate) monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
    const expectedThrough = Math.min(+monthEnd, +now, query.end ? Date.parse(query.end) : +now);
    return expectedThrough - Date.parse(bucket.through) > 10 * 60_000;
  });
  return {
    users: filtered.slice(query.offset, query.offset + query.limit).map(r => r.value), total: filtered.length,
    limit: query.limit, offset: query.offset, hasMore: query.offset + query.limit < filtered.length,
    summary: { totalUsers: dimensions.accounts.length, activeToday: groupCounts.activeToday, lowBalance: groupCounts.lowBalance!, suspended: groupCounts.suspended!, planCounts, groupCounts },
    metrics: { status: !prepared || !usageAvailable ? "unavailable" as const : !activityAvailable || !playtimeAvailable || stale ? "partial" as const : "ready" as const,
      generatedAt: timestamps[0] ?? null, through: coverageTimes[0] ?? null, playtimeAvailable, creatorInteractionsAvailable: usageAvailable,
      note: USERS_CREATOR_NOTE + (!prepared ? " Requested historical buckets are still being prepared by the analytics worker." : stale ? " Some source coverage is delayed; totals reflect the displayed coverage." : "") },
  };
}
