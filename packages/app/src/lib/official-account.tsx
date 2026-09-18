import { BadgeCheck } from "lucide-react";

export const OFFICIAL_USERNAME = "yumina";
export const OFFICIAL_USER_ID = "34c14da628cf4046b238c073b7ce7b92";
export const OFFICIAL_SUPPORT_EMAIL = "support@yumina.io";

export function isOfficialAccount(opts: { username?: string | null; userId?: string | null }): boolean {
  if (opts.username && opts.username.toLowerCase() === OFFICIAL_USERNAME) return true;
  if (opts.userId && opts.userId === OFFICIAL_USER_ID) return true;
  return false;
}

export function OfficialBadge({
  size = "sm",
  withLabel = false,
  className = "",
}: {
  size?: "xs" | "sm" | "md";
  withLabel?: boolean;
  className?: string;
}) {
  const iconSize = size === "xs" ? "h-3 w-3" : size === "md" ? "h-5 w-5" : "h-4 w-4";
  if (withLabel) {
    return (
      <span
        className={`inline-flex items-center gap-1 rounded-md bg-gradient-to-r from-cyan-500/15 to-sky-500/15 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-cyan-300 shadow-[0_0_18px_rgba(56,189,248,0.18)] ring-1 ring-cyan-400/30 ${className}`}
        title="Official Yumina account"
      >
        <BadgeCheck className={iconSize} />
        Official
      </span>
    );
  }
  return (
    <BadgeCheck
      className={`text-cyan-400 drop-shadow-[0_0_6px_rgba(56,189,248,0.55)] ${iconSize} ${className}`}
      aria-label="Verified official account"
    />
  );
}
