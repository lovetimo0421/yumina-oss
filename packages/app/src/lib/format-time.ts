/**
 * Format a timestamp as a localized relative time ("just now", "2 minutes ago",
 * "刚刚", "2 分钟前", etc.). Falls back to a localized date for anything older
 * than a week. Uses Intl.RelativeTimeFormat under the hood so the output respects
 * the active i18next language.
 *
 * Pass `i18n.language` from `useTranslation()` for the locale parameter.
 */
export function formatTimeAgo(iso: string, locale: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "—";
  const diffMs = Date.now() - then;
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return rtf.format(-Math.max(seconds, 0), "second");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return rtf.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return rtf.format(-hours, "hour");
  const days = Math.floor(hours / 24);
  if (days < 7) return rtf.format(-days, "day");
  return new Date(iso).toLocaleDateString(locale);
}
