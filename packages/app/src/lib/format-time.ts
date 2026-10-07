/**
 * Format a timestamp as a localized relative time ("just now", "2 minutes ago",
 * "刚刚", "2 分钟前", etc.). Falls back to a localized date for anything older
 * than a week. Uses Intl.RelativeTimeFormat under the hood so the output respects
 * the active i18next language.
 *
 * Pass `i18n.language` from `useTranslation()` for the locale parameter.
 */
/**
 * Parse a server timestamp. Some endpoints select raw SQL expressions
 * (`COALESCE(last_played_at, created_at)`), which come back as Postgres text
 * with no zone — "2026-09-25 08:12:03.123". `new Date()` reads that as LOCAL
 * time, so a player at UTC+8 saw "-416m ago" (launch QA). Database times are
 * UTC; say so when the string does not.
 */
export function parseServerTime(value: string | number | Date): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const trimmed = value.trim();
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}(?::?\d{2})?)?$/i.exec(trimmed);
  if (!match) return new Date(trimmed).getTime();
  // Postgres text offsets can be "+00" / "+0800": make them ISO "+00:00".
  const zone = !match[3] ? "Z"
    : /^z$/i.test(match[3]) ? "Z"
    : match[3].length === 3 ? `${match[3]}:00`
    : match[3].includes(":") ? match[3] : `${match[3].slice(0, 3)}:${match[3].slice(3)}`;
  return new Date(`${match[1]}T${match[2]}${zone}`).getTime();
}

export function formatTimeAgo(iso: string, locale: string): string {
  const then = parseServerTime(iso);
  if (!Number.isFinite(then)) return "—";
  // A clock a little ahead of the server's must read "just now", not "in 2 min".
  const diffMs = Math.max(0, Date.now() - then);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return rtf.format(-Math.max(seconds, 0), "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 7) return rtf.format(-days, "day");
  return new Date(then).toLocaleDateString(locale);
}
