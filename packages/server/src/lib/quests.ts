/**
 * Quest board for billing lineup v2 — the replacement for unconditional
 * check-ins (owner decisions 2026-09-14 / 2026-09-15 / 2026-09-16).
 *
 * Three boards, one currency:
 *
 *   DAILY   Six quests form a pool; three of them are on the board each day,
 *           on a fixed weekly schedule so the whole site sees the same three
 *           and every quest comes round several times a week. A fourth card,
 *           the invite quest, is on the board every day. Three chances a day
 *           means no day is lost to "this one I can't do".
 *
 *   WEEKLY  Four goals that put a THRESHOLD ON WHAT PLAYERS ALREADY DO rather
 *           than asking for new behaviour, plus the weekly invite quest. Every
 *           threshold is a measured percentile of real free-tier use
 *           (2026-09-15 production sample, 5,008 weekly-active free users):
 *
 *             messages in a week      median 22, p75 89, p90 196   → 100 (p78)
 *             turns in one world      median 15, p75 53, p90 136   →  50 (p74)
 *             days played in a week   median  1, p90 6             →   5 (p85)
 *
 *   CYCLE   The forge rungs (plan-config-v2.ts FORGE_RUNGS): rebates that
 *           unlock on mushies burned in the current billing cycle. Platinum
 *           and up; Gold sees them locked; Free does not see them at all.
 *           They sit in the weekly list on the client, numbered after it.
 *
 * Two kinds of reward:
 *   - COUNTED quests pay the tier's amount (PLANS_V2.questPayout), scaled by
 *     the global dial and clamped to the cycle cap (questMonthlyCap).
 *   - FIXED quests (both invite quests, every forge rung) pay a set amount at
 *     every tier, scaled only by the dial, and never count against the cap.
 *
 * Two quests were deliberately NOT included. "Write a review" and "share a
 * playthrough" would pollute the very thing they measure: the site has 478
 * reviews total from 328 people, 46 writers in a week — paying for reviews
 * would multiply that by a hundred with reviews written for mushies, and the
 * ratings would stop meaning anything.
 *
 * Nothing here counts worlds from `usage_logs.analytics_world_id`: 61% of turns
 * carry no world id (459,658 turns in 7 days, 38.9% with an id), so a player
 * who really did play two worlds could be told they had not. World work is
 * counted from play_sessions → messages, which is complete, and aggregated
 * ACROSS a world's sessions — reopening a save must not reset progress.
 */
import { and, eq, gt, gte, lt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import {
  creditTransactions, creditWallets, favorites, messages, playSessions, posts, questClaims,
  referralQualifications, threadLikes, threads, usageLogs, user,
} from "../db/schema.js";
import { planMeetsMinimum, type PlanId } from "./plan-config.js";
import { FORGE_RUNGS, INVITE_QUEST_PAYOUT, PLANS_V2, questMultiplierV2, type QuestPayoutTable } from "./plan-config-v2.js";
import type { LedgerDatabase } from "./transaction-hash.js";

export type QuestPeriod = "day" | "week" | "cycle";

export type DailyQuestKey =
  | "play_3"        // send three turns
  | "favorite"      // favourite any world
  | "community"     // post, reply or like
  | "world_depth"   // ten turns inside one world
  | "new_world"     // open a world never played before
  | "two_models"    // finish turns on two different models
  | "invite_day";   // someone signed up with your code today (fixed)

export type WeeklyQuestKey =
  | "week_messages"        // 100 turns across the week
  | "week_depth"           // 50 turns inside one world
  | "week_days"            // played on five separate days
  | "week_dailies"         // claimed twelve daily quests
  | "week_active_friends"; // three friends qualified as active this week (fixed)

export type CycleQuestKey = `cycle_${number}`;

export type QuestKey = DailyQuestKey | WeeklyQuestKey | CycleQuestKey;

export interface QuestDef {
  key: QuestKey;
  period: QuestPeriod;
  /** How many of the counted thing finishes it. */
  target: number;
  /** Which tier payout applies (scaled per tier and by the dial). Ignored when `fixed` is set. */
  payout: keyof QuestPayoutTable;
  /** A fixed reward, the same at every tier and outside the cycle cap. */
  fixed?: number;
  /** Lowest plan that can claim it; lower tiers see it locked (Free never sees cycle quests). */
  minPlan?: PlanId;
}

/** The six rotating quests a day can draw from. */
export const DAILY_POOL: readonly QuestDef[] = [
  { key: "play_3",      period: "day", target: 3,  payout: "dailyLight" },
  { key: "favorite",    period: "day", target: 1,  payout: "dailyLight" },
  { key: "community",   period: "day", target: 1,  payout: "dailyLight" },
  { key: "world_depth", period: "day", target: 10, payout: "dailyHeavy" },
  { key: "new_world",   period: "day", target: 1,  payout: "dailyHeavy" },
  { key: "two_models",  period: "day", target: 2,  payout: "dailyHeavy" },
];

/** On the board every day, after the three rotating ones. Fixed, outside the cap. */
export const DAILY_INVITE: QuestDef = { key: "invite_day", period: "day", target: 1, payout: "dailyLight", fixed: INVITE_QUEST_PAYOUT.day };

/**
 * The five weekly goals. All of them are claimable in the same week.
 *
 * The three that take the whole week pay the heavy rate; "claim twelve
 * dailies" is a single moment and pays the regular one; the invite goal is
 * fixed. "100 messages" is Gold and up — it is the one weekly a Free player
 * sees locked, with Gold's amount on it.
 */
export const WEEKLY_BOARD: readonly QuestDef[] = [
  { key: "week_messages",       period: "week", target: 100, payout: "weeklyHeavy", minPlan: "go" },
  { key: "week_depth",          period: "week", target: 50,  payout: "weeklyHeavy" },
  { key: "week_days",           period: "week", target: 5,   payout: "weeklyHeavy" },
  { key: "week_dailies",        period: "week", target: 12,  payout: "weekly" },
  { key: "week_active_friends", period: "week", target: 3,   payout: "weekly", fixed: INVITE_QUEST_PAYOUT.week },
];

/** The forge rungs as quests. `target` is the burn threshold; progress is mushies burned this cycle. */
export const CYCLE_BOARD: readonly QuestDef[] = FORGE_RUNGS.map((r) => ({
  key: r.key, period: "cycle" as const, target: r.burn, payout: "weeklyHeavy" as const, fixed: r.pay, minPlan: r.minPlan,
}));

/**
 * Which three of the pool are on the board, by weekday (1 = Monday … 7 = Sunday,
 * matching CheckInWindow.weekdayIndex). Fixed, not random: everyone sees the
 * same board so the community can talk about it and promotions can be planned.
 *
 * Every day is TWO light quests and ONE heavy one — 14 light and 7 heavy slots
 * a week. That shape is what the per-tier amounts in plan-config-v2.ts are
 * solved against, and it guarantees a player always has both something they
 * can finish in passing and something worth sitting down for. Each light quest
 * comes round 4–5 times a week, each heavy one 2–3.
 */
const DAILY_SCHEDULE: Record<number, readonly DailyQuestKey[]> = {
  1: ["play_3", "favorite", "world_depth"],
  2: ["play_3", "community", "new_world"],
  3: ["favorite", "community", "two_models"],
  4: ["play_3", "favorite", "world_depth"],
  5: ["play_3", "community", "new_world"],
  6: ["favorite", "community", "world_depth"],
  7: ["play_3", "favorite", "two_models"],
};

/** Today's three rotating quests (without the invite card). */
export function dailyBoardFor(weekdayIndex: number): QuestDef[] {
  const slot = (((weekdayIndex - 1) % 7) + 7) % 7 + 1;
  const keys = DAILY_SCHEDULE[slot] ?? DAILY_SCHEDULE[1]!;
  return keys.map((k) => DAILY_POOL.find((q) => q.key === k)).filter((q): q is QuestDef => !!q);
}

/** Today's full daily board: the three rotating quests, then the invite card. */
export function dailyBoardWithInvite(weekdayIndex: number): QuestDef[] {
  return [...dailyBoardFor(weekdayIndex), DAILY_INVITE];
}

export function questDef(key: string): QuestDef | null {
  if (key === DAILY_INVITE.key) return DAILY_INVITE;
  return DAILY_POOL.find((q) => q.key === key)
    ?? WEEKLY_BOARD.find((q) => q.key === key)
    ?? CYCLE_BOARD.find((q) => q.key === key)
    ?? null;
}

/** A quest this plan can see but not claim. Free never sees cycle quests (handled by the route). */
export function isLockedFor(plan: PlanId, quest: QuestDef): boolean {
  if (quest.minPlan && !planMeetsMinimum(plan, quest.minPlan)) return true;
  return (PLANS_V2[plan] ?? PLANS_V2.free).weeklyLocked.includes(quest.key);
}

/** The lowest plan that unlocks a quest this plan sees locked, for the badge. */
export function unlockPlanFor(plan: PlanId, quest: QuestDef): PlanId | null {
  if (!isLockedFor(plan, quest)) return null;
  if (quest.minPlan) return quest.minPlan;
  // A weekly Free does not get: the next tier up has it.
  return "go";
}

export interface QuestProgress {
  key: QuestKey;
  period: QuestPeriod;
  target: number;
  progress: number;
  done: boolean;
  /**
   * False when the activity tables could not be read, so `progress` means
   * "not known yet", NOT "nothing done". The board shows "checking…" and the
   * claim route answers 503 — never paying for work nobody did, and never
   * telling a player who did finish the quest that they did not.
   */
  verified: boolean;
}

/**
 * Turns the user has taken in each world between two instants, summed across
 * every session in that world, highest first.
 *
 * `messages` carries the turns and `play_sessions` carries the world, so this
 * is the only complete source for world work — and summing across sessions is
 * what makes reopening a save harmless (owner decision 2026-09-15).
 */
export type WorldTurnCache = Map<string, Promise<{ worldId: string; turns: number }[]>>;

async function turnsPerWorld(
  userId: string, from: Date, to: Date, database: LedgerDatabase, cache?: WorldTurnCache,
): Promise<{ worldId: string; turns: number }[]> {
  // One daily quest (world_depth) and one weekly (week_depth) ask for this,
  // over different windows — so on today's board the cache dedupes nothing. It
  // is kept because it costs one Map and makes adding a second quest on either
  // window free rather than doubling a join over a 42 GB table.
  const key = `${userId}|${from.getTime()}|${to.getTime()}`;
  const cached = cache?.get(key);
  if (cached) return cached;

  const pending = (async () => {
    const rows = await database
      .select({ worldId: playSessions.worldId, turns: sql<number>`COUNT(*)` })
      .from(messages)
      .innerJoin(playSessions, eq(playSessions.id, messages.sessionId))
      .where(and(
        eq(playSessions.userId, userId),
        // Studio playtest sessions are ephemeral, and the rest of the board
        // counts play through `usage_logs.endpoint IN (send,regenerate,continue)`
        // which already excludes them. Without this the two halves of one board
        // disagree about what counts as playing, and a creator clears the
        // 10-turn daily and the 50-turn weekly inside their own draft.
        eq(playSessions.ephemeral, false),
        eq(messages.role, "user"),
        gte(messages.createdAt, from),
        lt(messages.createdAt, to),
      ))
      .groupBy(playSessions.worldId)
      .orderBy(sql`COUNT(*) DESC`);
    return rows.map((r) => ({ worldId: r.worldId, turns: Number(r.turns) }));
  })();

  cache?.set(key, pending);
  return pending;
}

/**
 * Mushies the wallet has burned on generation between two instants — the
 * forge's progress. Read from the ledger (type = usage, negative amounts) so
 * the number a player sees is the number the wallet actually lost; a counter
 * on the wallet row would be one more thing to keep in step with it.
 */
export async function cycleSpent(userId: string, from: Date, to: Date, database: LedgerDatabase = db): Promise<number> {
  const [r] = await database
    .select({ total: sql<number>`COALESCE(SUM(-${creditTransactions.amount}), 0)` })
    .from(creditTransactions)
    .innerJoin(creditWallets, eq(creditWallets.id, creditTransactions.walletId))
    .where(and(
      eq(creditWallets.userId, userId),
      eq(creditTransactions.type, "usage"),
      gte(creditTransactions.createdAt, from),
      lt(creditTransactions.createdAt, to),
    ));
  return Math.max(0, Math.floor(Number(r?.total ?? 0)));
}

/** Verify one quest. Never throws; a failed read comes back `verified: false`. */
export async function questProgress(
  userId: string,
  quest: QuestDef,
  windowStart: Date,
  windowEnd: Date,
  database: LedgerDatabase = db,
  cache?: WorldTurnCache,
): Promise<QuestProgress> {
  const finish = (progress: number): QuestProgress => ({
    key: quest.key, period: quest.period, target: quest.target,
    progress: Math.min(progress, quest.target), done: progress >= quest.target, verified: true,
  });
  const chatTurns = and(
    eq(usageLogs.userId, userId),
    gte(usageLogs.createdAt, windowStart), lt(usageLogs.createdAt, windowEnd),
    sql`${usageLogs.endpoint} IN ('send','regenerate','continue')`,
    gt(usageLogs.completionTokens, 0),
  );
  const first = async (rows: Promise<{ n: unknown }[]>) => Number((await rows)[0]?.n ?? 0);

  try {
    if (quest.period === "cycle") {
      // The forge: progress is the real burn, and the bar shows it against the rung.
      return finish(await cycleSpent(userId, windowStart, windowEnd, database));
    }

    switch (quest.key) {
      case "play_3":
      case "week_messages":
        return finish(await first(database.select({ n: sql<number>`COUNT(*)` }).from(usageLogs).where(chatTurns)));

      case "week_days": {
        // Reward days, not UTC calendar days. Everything else rolls over at
        // 04:00 Asia/Shanghai (20:00 UTC), so DATE() cuts one reward day in
        // two: an evening that crosses midnight UTC booked two days and the
        // five-day goal fell in three. Bucket by whole days since this week's
        // own 04:00 boundary, which is exactly `windowStart`.
        const weekStartEpoch = Math.floor(windowStart.getTime() / 1000);
        return finish(await first(database
          .select({ n: sql<number>`COUNT(DISTINCT FLOOR((EXTRACT(EPOCH FROM ${usageLogs.createdAt}) - ${weekStartEpoch}) / 86400))` })
          .from(usageLogs).where(chatTurns)));
      }

      case "two_models":
        // Two models TODAY, not "different from yesterday". The old comparison
        // handed the quest free to anyone who had not played the day before and
        // charged an extra step to everyone who plays daily.
        return finish(await first(database
          .select({ n: sql<number>`COUNT(DISTINCT ${usageLogs.model})` }).from(usageLogs).where(chatTurns)));

      case "favorite":
        return finish(await first(database.select({ n: sql<number>`COUNT(*)` }).from(favorites)
          .where(and(eq(favorites.userId, userId), gte(favorites.createdAt, windowStart), lt(favorites.createdAt, windowEnd)))));

      case "community": {
        const [t, p, l] = await Promise.all([
          first(database.select({ n: sql<number>`COUNT(*)` }).from(threads)
            .where(and(eq(threads.authorId, userId), gte(threads.createdAt, windowStart), lt(threads.createdAt, windowEnd)))),
          first(database.select({ n: sql<number>`COUNT(*)` }).from(posts)
            .where(and(eq(posts.authorId, userId), gte(posts.createdAt, windowStart), lt(posts.createdAt, windowEnd)))),
          first(database.select({ n: sql<number>`COUNT(*)` }).from(threadLikes)
            .where(and(eq(threadLikes.userId, userId), gte(threadLikes.createdAt, windowStart), lt(threadLikes.createdAt, windowEnd)))),
        ]);
        return finish(t + p + l);
      }

      // Deepest single world in the window — the RP shape. Progress is the best
      // world's turn count, so the bar tracks the story the player is actually in.
      case "world_depth":
      case "week_depth": {
        const worlds = await turnsPerWorld(userId, windowStart, windowEnd, database, cache);
        return finish(worlds[0]?.turns ?? 0);
      }

      case "new_world":
        return finish(await first(database.select({ n: sql<number>`COUNT(*)` }).from(playSessions)
          .where(and(
            eq(playSessions.userId, userId),
            gte(playSessions.createdAt, windowStart), lt(playSessions.createdAt, windowEnd),
            sql`NOT EXISTS (SELECT 1 FROM play_sessions p2 WHERE p2.user_id = ${userId} AND p2.world_id = ${playSessions.worldId} AND p2.created_at < ${windowStart})`,
          ))));

      case "week_dailies":
        // Every daily claim counts, the invite card included — it is on the
        // daily board, so a player who did four things a day did four.
        return finish(await first(database.select({ n: sql<number>`COUNT(*)` }).from(questClaims)
          .where(and(
            eq(questClaims.userId, userId), eq(questClaims.periodKind, "day"),
            gte(questClaims.claimedAt, windowStart), lt(questClaims.claimedAt, windowEnd),
          ))));

      case "invite_day":
        // Registrations, not qualified play: one slot a day, a signup is enough.
        return finish(await first(database.select({ n: sql<number>`COUNT(*)` }).from(user)
          .where(and(eq(user.referredBy, userId), gte(user.referredAt, windowStart), lt(user.referredAt, windowEnd)))));

      case "week_active_friends":
        // Friends whose referral qualification settled as rewarded this week —
        // the same "active friend" the referral ladder counts (3 AI turns or 10
        // played minutes, and they came back). The referral campaign pays its
        // own reward for the same event; this quest is on top of it.
        return finish(await first(database.select({ n: sql<number>`COUNT(*)` }).from(referralQualifications)
          .where(and(
            eq(referralQualifications.referrerId, userId),
            eq(referralQualifications.status, "rewarded"),
            gte(referralQualifications.rewardedAt, windowStart), lt(referralQualifications.rewardedAt, windowEnd),
          ))));

      default:
        // Fail safe, exactly like a failed read below: a quest this build does
        // not know how to verify is NOT finished. `finish(quest.target)` paid a
        // new quest key out in full to every player the moment someone added it
        // to a board and forgot the case — and the compiler said nothing,
        // because the switch is exhaustive only as long as nobody extends it.
        return { key: quest.key, period: quest.period, target: quest.target, progress: 0, done: false, verified: false };
    }
  } catch (err) {
    console.error(`[Quests] ${quest.key} check failed:`, err instanceof Error ? err.message : err);
    return { key: quest.key, period: quest.period, target: quest.target, progress: 0, done: false, verified: false };
  }
}

/** Whether a quest's reward counts against the cycle cap. */
export function countsAgainstCap(quest: QuestDef): boolean {
  return quest.fixed === undefined;
}

/** Every quest key whose reward is fixed and outside the cap. */
export const FIXED_QUEST_KEYS: readonly string[] = [DAILY_INVITE, ...WEEKLY_BOARD, ...CYCLE_BOARD]
  .filter((q) => !countsAgainstCap(q))
  .map((q) => q.key);

/** What one quest pays this wallet, before the cycle cap. */
export function questReward(plan: PlanId, quest: QuestDef): number {
  const config = PLANS_V2[plan] ?? PLANS_V2.free;
  const base = quest.fixed ?? config.questPayout[quest.payout];
  return Math.max(0, Math.round(base * questMultiplierV2()));
}

/** …and what it pays once the cycle's remaining budget is applied. Fixed quests ignore the budget. */
export function questRewardCapped(plan: PlanId, quest: QuestDef, usedThisCycle: number): number {
  const reward = questReward(plan, quest);
  if (!countsAgainstCap(quest)) return reward;
  const cap = (PLANS_V2[plan] ?? PLANS_V2.free).questMonthlyCap;
  const remaining = cap > 0 ? Math.max(0, cap - usedThisCycle) : 0;
  return Math.min(reward, remaining);
}

/** Quest Bonus already earned in the wallet's current cycle that COUNTS against the cap. */
export async function questBonusUsedThisCycle(userId: string, periodStart: Date, database: LedgerDatabase = db): Promise<number> {
  const [r] = await database.select({ total: sql<number>`COALESCE(SUM(${questClaims.rewardAmount}), 0)` }).from(questClaims)
    .where(and(
      eq(questClaims.userId, userId),
      gte(questClaims.claimedAt, periodStart),
      sql`${questClaims.questKey} NOT IN (${sql.join(FIXED_QUEST_KEYS.map((k) => sql`${k}`), sql`, `)})`,
    ));
  return Number(r?.total ?? 0);
}

/** Fixed-reward Bonus earned this cycle (invite + forge) — shown on the dial, never capped. */
export async function fixedBonusThisCycle(userId: string, periodStart: Date, database: LedgerDatabase = db): Promise<number> {
  const [r] = await database.select({ total: sql<number>`COALESCE(SUM(${questClaims.rewardAmount}), 0)` }).from(questClaims)
    .where(and(
      eq(questClaims.userId, userId),
      gte(questClaims.claimedAt, periodStart),
      sql`${questClaims.questKey} IN (${sql.join(FIXED_QUEST_KEYS.map((k) => sql`${k}`), sql`, `)})`,
    ));
  return Number(r?.total ?? 0);
}

/** Which quests of a period the user has already claimed, and for how much. */
export async function claimedInPeriod(
  userId: string, period: QuestPeriod, periodKey: string, database: LedgerDatabase = db,
): Promise<Map<string, number>> {
  const rows = await database
    .select({ questKey: questClaims.questKey, rewardAmount: questClaims.rewardAmount })
    .from(questClaims)
    .where(and(eq(questClaims.userId, userId), eq(questClaims.periodKind, period), eq(questClaims.periodKey, periodKey)));
  return new Map(rows.map((r) => [r.questKey, r.rewardAmount]));
}

/** Guard for the claim route: is this key actually on today's board? */
export function isOnBoard(quest: QuestDef, weekdayIndex: number): boolean {
  if (quest.period === "week" || quest.period === "cycle") return true;
  return dailyBoardWithInvite(weekdayIndex).some((q) => q.key === quest.key);
}

/** Every key the boards can produce — used to keep the i18n bundles honest. */
export const ALL_QUEST_KEYS: readonly QuestKey[] = [
  ...DAILY_POOL.map((q) => q.key),
  DAILY_INVITE.key,
  ...WEEKLY_BOARD.map((q) => q.key),
  ...CYCLE_BOARD.map((q) => q.key),
];
