import { env } from "./env.js";

export const CHECK_IN_REWARDS = [100, 100, 125, 125, 150, 150, 250] as const;
export const CHECK_IN_RESET_HOUR = 4;

export interface CheckInWindow {
  dayKey: string;
  weekKey: string;
  weekdayIndex: number;
  timeZone: string;
  resetHour: number;
  /** Most-recent 04:00-local boundary that has already passed. Daily
   *  check-in counts and daily-recovery eligibility both reset at this
   *  instant — `last_daily_recovery >= previousResetAt` ⇒ already received. */
  previousResetAt: Date;
  /** Next upcoming 04:00-local boundary. Always > previousResetAt; the
   *  difference is 24h normally but 23h or 25h on DST transition days. */
  nextResetAt: Date;
  /** 04:00-local on the reward week's Monday. Weekly quests count from here. */
  weekStartsAt: Date;
  weekEndsAt: Date;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const parts = getFormatter(timeZone).formatToParts(date);
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
    second: values.second!,
  };
}

function formatUtcYmd(date: Date): string {
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function parseYmd(dayKey: string): Date {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

export function addDaysToDayKey(dayKey: string, days: number): string {
  const date = parseYmd(dayKey);
  date.setUTCDate(date.getUTCDate() + days);
  return formatUtcYmd(date);
}

function zonedDateTimeToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour: number,
): Date {
  let utcMs = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
  for (let i = 0; i < 3; i++) {
    const parts = getZonedParts(new Date(utcMs), timeZone);
    const localAsUtcMs = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      0,
    );
    const targetAsUtcMs = Date.UTC(year, month - 1, day, hour, 0, 0, 0);
    utcMs += targetAsUtcMs - localAsUtcMs;
  }
  return new Date(utcMs);
}

function weekKeyForDay(dayKey: string): string {
  const date = parseYmd(dayKey);
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceMonday);
  return formatUtcYmd(date);
}

function weekdayIndexForDay(dayKey: string): number {
  return ((parseYmd(dayKey).getUTCDay() + 6) % 7) + 1;
}

export function normalizeCheckInTimeZone(timeZone?: string | null): string {
  const candidate = typeof timeZone === "string" ? timeZone.trim() : "";
  if (candidate && candidate.length <= 64) {
    try {
      getFormatter(candidate).format(new Date());
      return candidate;
    } catch {
      // Fall through to the product default.
    }
  }
  return env.YUMINA_CHECKIN_TIME_ZONE;
}

/**
 * Compute the current check-in / daily-supply window. Called with NO timezone
 * argument in production — it defaults to the single platform reset zone
 * (env.YUMINA_CHECKIN_TIME_ZONE = Asia/Shanghai), giving ONE universal 04:00
 * boundary (20:00 UTC, no DST) for every user. The `timeZone` parameter is
 * retained only so unit tests can exercise the boundary math (incl. DST) for
 * arbitrary zones; nothing in the request path passes a per-user value.
 */
export function getCheckInWindow(now = new Date(), timeZone = env.YUMINA_CHECKIN_TIME_ZONE): CheckInWindow {
  const resolvedTimeZone = normalizeCheckInTimeZone(timeZone);
  const local = getZonedParts(now, resolvedTimeZone);
  const localToday = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const activeDate = new Date(localToday);
  if (local.hour < CHECK_IN_RESET_HOUR) {
    activeDate.setUTCDate(activeDate.getUTCDate() - 1);
  }

  // `activeDate` already encodes the most-recent local-04:00 boundary
  // (the day whose 04:00 has passed but whose next 04:00 hasn't yet).
  const previousResetAt = zonedDateTimeToUtc(
    resolvedTimeZone,
    activeDate.getUTCFullYear(),
    activeDate.getUTCMonth() + 1,
    activeDate.getUTCDate(),
    CHECK_IN_RESET_HOUR,
  );

  const nextResetLocalDate = new Date(localToday);
  if (local.hour >= CHECK_IN_RESET_HOUR) {
    nextResetLocalDate.setUTCDate(nextResetLocalDate.getUTCDate() + 1);
  }
  const nextResetAt = zonedDateTimeToUtc(
    resolvedTimeZone,
    nextResetLocalDate.getUTCFullYear(),
    nextResetLocalDate.getUTCMonth() + 1,
    nextResetLocalDate.getUTCDate(),
    CHECK_IN_RESET_HOUR,
  );

  const dayKey = formatUtcYmd(activeDate);
  const weekKey = weekKeyForDay(dayKey);
  const weekStart = parseYmd(weekKey);
  const weekStartsAt = zonedDateTimeToUtc(
    resolvedTimeZone,
    weekStart.getUTCFullYear(),
    weekStart.getUTCMonth() + 1,
    weekStart.getUTCDate(),
    CHECK_IN_RESET_HOUR,
  );
  const nextWeekStart = parseYmd(weekKey);
  nextWeekStart.setUTCDate(nextWeekStart.getUTCDate() + 7);
  const weekEndsAt = zonedDateTimeToUtc(
    resolvedTimeZone,
    nextWeekStart.getUTCFullYear(),
    nextWeekStart.getUTCMonth() + 1,
    nextWeekStart.getUTCDate(),
    CHECK_IN_RESET_HOUR,
  );

  return {
    dayKey,
    weekKey,
    weekdayIndex: weekdayIndexForDay(dayKey),
    timeZone: resolvedTimeZone,
    resetHour: CHECK_IN_RESET_HOUR,
    previousResetAt,
    nextResetAt,
    weekStartsAt,
    weekEndsAt,
  };
}

export function getRewardForIndex(rewardIndex: number): number {
  return CHECK_IN_REWARDS[Math.max(0, Math.min(CHECK_IN_REWARDS.length - 1, rewardIndex - 1))]!;
}

/**
 * A wallet timestamp alone is not proof that daily supply was granted.
 * Re-created accounts temporarily store their reward-unblock deadline in
 * `last_daily_recovery` to keep the recovery cron from bypassing the
 * deletion tombstone. Only a matching ledger row represents a real grant.
 */
export function hasDailyRecoveryReceiptSince(
  lastDailyRecovery: Date | null | undefined,
  previousResetAt: Date,
  latestRecoveryTransactionAt: Date | null | undefined,
): boolean {
  return !!lastDailyRecovery
    && lastDailyRecovery.getTime() >= previousResetAt.getTime()
    && !!latestRecoveryTransactionAt
    && latestRecoveryTransactionAt.getTime() >= previousResetAt.getTime();
}
