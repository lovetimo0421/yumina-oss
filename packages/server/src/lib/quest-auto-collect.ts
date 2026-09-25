import { sql } from "drizzle-orm";
import { db, readOwn } from "../db/index.js";
import { edition } from "../edition/index.js";
import { getCheckInWindow, type CheckInWindow } from "./check-ins.js";
import { runExclusive } from "./leader.js";
import { posthog } from "./posthog.js";
import { redis } from "./redis.js";
import { claimQuest, questClaimContext, questClaimGate, questPeriod, type QuestClaimTrigger } from "./quest-claim.js";
import { WEEKLY_BOARD, claimedInPeriod, dailyBoardFor, questProgress, walletUsesQuests, type WorldTurnCache } from "./quests.js";

/**
 * Finished quests collect themselves (owner decision 2026-09-24).
 *
 * On Tuesday 2026-09-22, 1,527 players finished "play 3 turns" and 586 claimed
 * it: more than one in three of everyone who played earned a reward and never
 * tapped the button. So the server now pays finished daily and weekly quests
 * without the tap:
 *
 *   - within minutes: every write that can finish a quest (a chat turn, a
 *     favorite, a community visit or post, a new world, a rewarded referral)
 *     calls scheduleQuestCollect(). The check is debounced per player and runs
 *     off the request path, against the reward window the event fell in, so a
 *     turn at 19:59 still pays for that day after the 20:00 UTC reset.
 *   - a sweep in the last minutes before the reset, and once more just after it
 *     for the day that ended, pays anything the event path missed.
 *
 * The forge rungs keep their button: burning mushies to reach one is a
 * deliberate purchase. Everything else about a payout (board, plan, lock, cycle
 * cap, ledger row, Bonus lot) is the same code the button uses (quest-claim.ts).
 *
 * QUEST_AUTO_COLLECT: unset / 1 / true / on → on; 0 / false / off → kill switch
 * (the button still works, the collector stops).
 */
export function questAutoCollectEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env.QUEST_AUTO_COLLECT ?? "").trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

function active(): boolean {
  return edition.info().features.billing && questAutoCollectEnabled();
}

export interface QuestAutoAward {
  questKey: string;
  period: "day" | "week";
  reward: number;
}

/**
 * Pay every finished, unclaimed, unlocked daily and weekly quest for one player
 * in the reward window `at` falls in. Dailies go first so "claim twelve
 * dailies" counts them in the same pass. Idempotent: a second run pays nothing.
 */
export async function collectFinishedQuests(
  userId: string,
  options: { at?: Date; trigger: Exclude<QuestClaimTrigger, "claim"> },
): Promise<QuestAutoAward[]> {
  if (!active()) return [];
  const at = options.at ?? new Date();
  const ctx = await questClaimContext(userId, at);
  if (!walletUsesQuests(ctx.planVersion, at) || ctx.effectivePlan === "internal") return [];
  // A player's own progress is read-after-write sensitive (the turn that
  // finished the quest was written a moment ago), so read the primary.
  const mine = await readOwn(userId);
  const [dayClaims, weekClaims] = await Promise.all([
    claimedInPeriod(userId, "day", ctx.window.dayKey, mine),
    claimedInPeriod(userId, "week", ctx.window.weekKey, mine),
  ]);
  const cache: WorldTurnCache = new Map();
  const awards: QuestAutoAward[] = [];
  for (const quest of [...dailyBoardFor(ctx.window.weekdayIndex), ...WEEKLY_BOARD]) {
    const claims = quest.period === "day" ? dayClaims : weekClaims;
    if (claims.has(quest.key) || questClaimGate(ctx, quest)) continue;
    const { from, to } = questPeriod(quest, ctx);
    const progress = await questProgress(userId, quest, from, to, mine, cache);
    if (!progress.verified || !progress.done) continue;
    const outcome = await claimQuest(ctx, quest, { trigger: options.trigger });
    if (outcome.kind === "claimed") awards.push({ questKey: quest.key, period: quest.period as "day" | "week", reward: outcome.reward });
    // cap_reached only stops capped quests; fixed ones (invites) still pay, so keep going.
  }
  return awards;
}

// ─── Event path: debounced per player, one check per burst ─────────────────

export const QUEST_COLLECT_DEBOUNCE_MS = 20_000;
export const QUEST_COLLECT_COOLDOWN_MS = 60_000;

type Runner = (userId: string, at: Date) => Promise<unknown>;

export function createQuestCollectScheduler(
  run: Runner,
  options: {
    debounceMs?: number;
    cooldownMs?: number;
    clock?: () => number;
    setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
    /** Cross-replica guard; resolve false to let another instance take the run. */
    dedupe?: (userId: string) => Promise<boolean>;
    onError?: (userId: string, error: unknown) => void;
  } = {},
) {
  const debounceMs = options.debounceMs ?? QUEST_COLLECT_DEBOUNCE_MS;
  const cooldownMs = options.cooldownMs ?? QUEST_COLLECT_COOLDOWN_MS;
  const clock = options.clock ?? Date.now;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const pending = new Map<string, { at: Date; timer: { unref?: () => void } }>();
  const lastRun = new Map<string, number>();
  return {
    /** True when this call armed a check; false when one was already pending. */
    schedule(userId: string, at: Date = new Date(clock())): boolean {
      if (!userId) return false;
      const existing = pending.get(userId);
      if (existing) {
        // Keep the latest event time so the check reads the window it fell in.
        if (at > existing.at) existing.at = at;
        return false;
      }
      const now = clock();
      const delay = Math.max(debounceMs, (lastRun.get(userId) ?? -Infinity) + cooldownMs - now);
      const entry: { at: Date; timer: { unref?: () => void } } = { at, timer: {} };
      entry.timer = setTimer(() => {
        pending.delete(userId);
        lastRun.set(userId, clock());
        if (lastRun.size > 50_000) {
          const cutoff = clock() - cooldownMs;
          for (const [id, ran] of lastRun) if (ran < cutoff) lastRun.delete(id);
        }
        void (async () => {
          try {
            if (options.dedupe && !(await options.dedupe(userId))) return;
            await run(userId, entry.at);
          } catch (error) {
            options.onError?.(userId, error);
          }
        })();
      }, delay);
      entry.timer.unref?.();
      pending.set(userId, entry);
      return true;
    },
    pendingCount: () => pending.size,
  };
}

async function redisDedupe(userId: string): Promise<boolean> {
  if (!redis) return true;
  try {
    return (await redis.set(`quest:collect:${userId}`, "1", "EX", 30, "NX")) === "OK";
  } catch {
    return true; // Redis down: run on every replica; the claim itself is idempotent.
  }
}

const scheduler = createQuestCollectScheduler(
  (userId, at) => collectFinishedQuests(userId, { at, trigger: "event" }),
  { dedupe: redisDedupe, onError: (userId, error) => console.error(`[Quests] auto-collect failed for ${userId}:`, error instanceof Error ? error.message : error) },
);

/**
 * Call after any write that can finish a quest. Cheap and fire-and-forget: the
 * first call in a burst arms one check ~20 s out; later calls only move its
 * event time forward. A player is checked at most once a minute.
 */
export function scheduleQuestCollect(userId: string, at: Date = new Date()): void {
  if (!userId || !active()) return;
  scheduler.schedule(userId, at);
}

// ─── Day-end sweep: the safety net ─────────────────────────────────────────

/** Everyone who did something in the window that a daily or weekly quest counts. */
export async function questSweepCandidates(window: CheckInWindow, database: { execute: typeof db.execute } = db): Promise<string[]> {
  const from = window.previousResetAt, to = window.nextResetAt;
  const result = await database.execute(sql`SELECT DISTINCT user_id FROM (
      SELECT user_id FROM usage_logs WHERE created_at >= ${from} AND created_at < ${to}
        AND endpoint IN ('send','regenerate','continue') AND completion_tokens > 0
      UNION SELECT user_id FROM favorites WHERE created_at >= ${from} AND created_at < ${to}
      UNION SELECT user_id FROM analytics_activity WHERE surface = 'community' AND occurred_at >= ${from} AND occurred_at < ${to}
      UNION SELECT user_id FROM play_sessions WHERE created_at >= ${from} AND created_at < ${to}
      UNION SELECT author_id AS user_id FROM threads WHERE created_at >= ${from} AND created_at < ${to}
      UNION SELECT author_id AS user_id FROM posts WHERE created_at >= ${from} AND created_at < ${to}
    ) activity WHERE user_id IS NOT NULL`);
  return result.rows.map((row) => String((row as { user_id: unknown }).user_id));
}

export interface QuestSweepSummary {
  dayKey: string;
  users: number;
  paid: number;
  awards: number;
  mushies: number;
  failed: number;
}

export async function sweepQuestCollection(
  window: CheckInWindow,
  options: {
    concurrency?: number;
    candidates?: (window: CheckInWindow) => Promise<string[]>;
    collect?: (userId: string, at: Date) => Promise<QuestAutoAward[]>;
  } = {},
): Promise<QuestSweepSummary> {
  const at = new Date(window.nextResetAt.getTime() - 1);
  const ids = await (options.candidates ?? questSweepCandidates)(window);
  const collect = options.collect ?? ((userId: string, when: Date) => collectFinishedQuests(userId, { at: when, trigger: "sweep" }));
  const summary: QuestSweepSummary = { dayKey: window.dayKey, users: ids.length, paid: 0, awards: 0, mushies: 0, failed: 0 };
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const userId = ids[next++]!;
      try {
        const awards = await collect(userId, at);
        if (awards.length) { summary.paid++; summary.awards += awards.length; summary.mushies += awards.reduce((s, a) => s + a.reward, 0); }
      } catch (error) {
        summary.failed++;
        console.error(`[Quests] sweep failed for ${userId}:`, error instanceof Error ? error.message : error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 6, ids.length)) }, worker));
  console.log(`[Quests] sweep ${window.dayKey}: ${summary.users} candidates, ${summary.paid} paid, ${summary.awards} quests, ${summary.mushies} mushies, ${summary.failed} failed`);
  try {
    posthog.capture({ distinctId: "system", event: "quest_autocollect_sweep", properties: { ...summary } });
  } catch { /* diagnostics only */ }
  return summary;
}

/** Sweep in the last ten minutes of a reward day, and again 2–15 minutes after it ended. */
export const QUEST_SWEEP_BEFORE_RESET_MS = 10 * 60_000;
export const QUEST_SWEEP_AFTER_RESET_FROM_MS = 2 * 60_000;
export const QUEST_SWEEP_AFTER_RESET_UNTIL_MS = 15 * 60_000;

/** Which sweeps are due at `now`. Pure, so the schedule is testable. */
export function dueQuestSweeps(now: Date): Array<{ job: string; window: CheckInWindow }> {
  const current = getCheckInWindow(now);
  const due: Array<{ job: string; window: CheckInWindow }> = [];
  const untilReset = current.nextResetAt.getTime() - now.getTime();
  if (untilReset > 0 && untilReset <= QUEST_SWEEP_BEFORE_RESET_MS) due.push({ job: `quest-sweep-pre:${current.dayKey}`, window: current });
  const sinceReset = now.getTime() - current.previousResetAt.getTime();
  if (sinceReset >= QUEST_SWEEP_AFTER_RESET_FROM_MS && sinceReset <= QUEST_SWEEP_AFTER_RESET_UNTIL_MS) {
    const previous = getCheckInWindow(new Date(current.previousResetAt.getTime() - 1));
    due.push({ job: `quest-sweep-post:${previous.dayKey}`, window: previous });
  }
  return due;
}

let sweeperHandle: ReturnType<typeof setInterval> | null = null;
const ranJobs = new Map<string, number>();

export async function tickQuestSweeper(now: Date = new Date()): Promise<void> {
  if (!active()) return;
  for (const { job, window } of dueQuestSweeps(now)) {
    if (ranJobs.has(job)) continue;
    ranJobs.set(job, now.getTime());
    // The lock TTL outlives the due window, so one replica runs each sweep.
    await runExclusive(job, 1500, () => sweepQuestCollection(window).then(() => undefined))
      .catch((error) => console.error(`[Quests] ${job} failed:`, error instanceof Error ? error.message : error));
  }
  const cutoff = now.getTime() - 3 * 86_400_000;
  for (const [job, ran] of ranJobs) if (ran < cutoff) ranJobs.delete(job);
}

export function startQuestAutoCollectSweeper(): void {
  if (sweeperHandle) return;
  sweeperHandle = setInterval(() => { void tickQuestSweeper(); }, 60_000);
  sweeperHandle.unref();
}

export function stopQuestAutoCollectSweeper(): void {
  if (sweeperHandle) {
    clearInterval(sweeperHandle);
    sweeperHandle = null;
  }
}
