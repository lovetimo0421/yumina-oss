export function formatPlaytimeHours(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null) return "--";
  const safeSeconds = Math.max(0, totalSeconds);
  const hours = safeSeconds / 3600;
  return `${hours.toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} h`;
}
