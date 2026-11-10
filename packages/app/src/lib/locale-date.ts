import i18n from "@/lib/i18n";
import { formatTimeAgo } from "@/lib/format-time";

/**
 * Locale-aware date formatting for UI copy. Every helper takes an optional
 * locale; without one it follows the active i18next language, so a zh/ja/es
 * viewer never sees "Sep 25, 2026" or "1m ago".
 */
function activeLocale(locale?: string): string | undefined {
  const value = locale ?? i18n.language;
  if (!value) return undefined;
  try {
    return Intl.getCanonicalLocales(value)[0];
  } catch {
    return undefined;
  }
}

function valid(input: string | number | Date): Date | null {
  const date = input instanceof Date ? input : new Date(input);
  return Number.isFinite(date.getTime()) ? date : null;
}

function format(input: string | number | Date, options: Intl.DateTimeFormatOptions, locale?: string): string {
  const date = valid(input);
  if (!date) return "—";
  return new Intl.DateTimeFormat(activeLocale(locale), options).format(date);
}

/** "Sep 25, 2026" / "2026年9月25日" */
export function formatDate(input: string | number | Date, locale?: string): string {
  return format(input, { year: "numeric", month: "short", day: "numeric" }, locale);
}

/** "Sep 25, 2026, 9:28 PM" / "2026年9月25日 21:28" */
export function formatDateTime(input: string | number | Date, locale?: string): string {
  return format(input, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }, locale);
}

/** "Sep 25, 9:57 PM" / "9月25日 21:57" — for ledgers where the year is implied. */
export function formatShortDateTime(input: string | number | Date, locale?: string): string {
  return format(input, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }, locale);
}

/** "Apr 2026" / "2026年4月" */
export function formatMonthYear(input: string | number | Date, locale?: string): string {
  return format(input, { year: "numeric", month: "short" }, locale);
}

/** "2 minutes ago" / "2 分钟前"; a plain localized date past a week. */
export function formatRelativeTime(input: string | number | Date, locale?: string): string {
  const date = valid(input);
  if (!date) return "—";
  return formatTimeAgo(date.toISOString(), activeLocale(locale) ?? "en");
}
