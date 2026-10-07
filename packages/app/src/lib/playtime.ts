export function formatPlaytimeHours(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null) return "--";
  const safeSeconds = Math.max(0, totalSeconds);
  const hours = safeSeconds / 3600;
  return `${hours.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} h`;
}

/**
 * A session's playtime for a list row: "<1 min", "12 min", "1.5 hr" in the
 * reader's language. `formatPlaytimeHours` read "0.0 h" for any session under
 * three minutes, which is every session a player just started.
 */
export function formatPlaytimeShort(totalSeconds: number | null | undefined, locale: string): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return "--";
  const seconds = Math.max(0, totalSeconds);
  const unit = (value: number, name: "minute" | "hour", maximumFractionDigits = 0) => {
    try {
      return new Intl.NumberFormat(locale, { style: "unit", unit: name, unitDisplay: "short", maximumFractionDigits }).format(value);
    } catch {
      return `${value} ${name === "hour" ? "h" : "min"}`;
    }
  };
  if (seconds < 60) return `<${unit(1, "minute")}`;
  if (seconds < 3600) return unit(Math.floor(seconds / 60), "minute");
  return unit(Math.round((seconds / 3600) * 10) / 10, "hour", 1);
}
