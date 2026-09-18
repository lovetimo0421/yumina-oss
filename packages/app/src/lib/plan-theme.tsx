// Shared plan tier theme, icons, and helpers used by credit-indicator + AI provider tab

export type PlanId = "free" | "go" | "plus" | "pro" | "ultra" | "internal";

export const PLAN_THEME: Record<PlanId, {
  label: string;
  color: string;
  colorHex: string;
  bg: string;
  bar: string;
  barBg: string;
  accent: string;
  glow: string;
  border: string;
}> = {
  free:     { label: "Free",      color: "text-zinc-400",    colorHex: "#a1a1aa", bg: "bg-zinc-500/10",    bar: "bg-zinc-400",    barBg: "bg-zinc-500/15",    accent: "text-zinc-400",    glow: "",                                            border: "border-zinc-500/20" },
  go:       { label: "Gold",      color: "text-amber-300",   colorHex: "#fcd34d", bg: "bg-amber-500/10",   bar: "bg-amber-400",   barBg: "bg-amber-500/15",   accent: "text-amber-300",   glow: "shadow-[0_0_8px_rgba(252,211,77,0.1)]",       border: "border-amber-500/20" },
  plus:     { label: "Platinum",  color: "text-cyan-300",    colorHex: "#67e8f9", bg: "bg-cyan-500/10",    bar: "bg-cyan-400",    barBg: "bg-cyan-500/15",    accent: "text-cyan-300",    glow: "shadow-[0_0_8px_rgba(103,232,249,0.1)]",      border: "border-cyan-500/20" },
  pro:      { label: "Diamond",   color: "text-violet-300",  colorHex: "#c4b5fd", bg: "bg-violet-500/10",  bar: "bg-violet-400",  barBg: "bg-violet-500/15",  accent: "text-violet-300",  glow: "shadow-[0_0_8px_rgba(196,181,253,0.1)]",      border: "border-violet-500/20" },
  ultra:    { label: "Ascendant", color: "text-rose-300",    colorHex: "#fda4af", bg: "bg-rose-500/10",    bar: "bg-rose-400",    barBg: "bg-rose-500/15",    accent: "text-rose-300",    glow: "shadow-[0_0_8px_rgba(253,164,175,0.1)]",      border: "border-rose-500/20" },
  internal: { label: "Creator",   color: "text-emerald-400", colorHex: "#34d399", bg: "bg-emerald-500/10", bar: "bg-emerald-400", barBg: "bg-emerald-500/15", accent: "text-emerald-400", glow: "shadow-[0_0_8px_rgba(52,211,153,0.1)]",       border: "border-emerald-500/20" },
};

export function MushroomIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} xmlns="http://www.w3.org/2000/svg">
      {/* Cap */}
      <path d="M12 3C7.5 3 4 6.5 4 10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2 0-3.5-3.5-7-8-7z" fill="currentColor" opacity="0.9" />
      {/* Cap spots */}
      <circle cx="9.5" cy="7.5" r="1.2" fill="currentColor" opacity="0.3" />
      <circle cx="14" cy="6.5" r="1" fill="currentColor" opacity="0.3" />
      <circle cx="12" cy="9.5" r="0.8" fill="currentColor" opacity="0.3" />
      {/* Stem */}
      <path d="M10 12h4v6c0 1.1-.9 2-2 2s-2-.9-2-2v-6z" fill="currentColor" opacity="0.4" />
    </svg>
  );
}

export function fmt(n: number): string {
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / 86_400_000) : 0;
}

/** Time remaining until `iso`, split into days/hours/minutes (min 1 min, so it never
 *  shows 0). A relative duration → timezone-independent, unlike an absolute UTC date
 *  (which reads off-by-one on the last day of the cycle for viewers east of UTC).
 *  Drives the monthly credit-refresh countdown; mirrors the daily check-in countdown
 *  (`timeUntil` in daily-check-in-card.tsx). `overdue` is true once the period instant
 *  has passed — the caller shows "refreshing soon" instead of a fake sub-minute count. */
export function timeUntilParts(
  iso: string | null,
  now = Date.now(),
): { days: number; hours: number; minutes: number; overdue: boolean } | null {
  if (!iso) return null;
  const diff = new Date(iso).getTime() - now;
  const total = Math.max(1, Math.ceil(diff / 60_000));
  return { days: Math.floor(total / 1440), hours: Math.floor((total % 1440) / 60), minutes: total % 60, overdue: diff <= 0 };
}

/** Daily-floor amount per plan. Mirrors server plan-config.ts dailyRecoveryAmount.
 *  If balance is below this, balance gets restored to this amount once per
 *  local check-in day (04:00 in the user's time zone, matching daily check-in).
 *  No spending prerequisite.
 *
 *  Authoritative per-user value comes from the API
 *  (`/api/check-ins/status` → `dailyRecovery.amount`); this constant is a
 *  client-side fallback / display reference only. */
export const DAILY_RECOVERY: Record<PlanId, number> = {
  free: 200,
  go: 500,
  plus: 1600,
  pro: 4000,
  ultra: 8000,
  internal: 0,
};
