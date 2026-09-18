import type {
  CommunityEvent,
  CommunityEventPhase,
  SocialEntryStatus,
  SocialPlatform,
} from "@/lib/community-events";
import { deriveEventPhase, SOCIAL_PLATFORMS } from "@yumina/shared";

export const SOCIAL_PLATFORM_OPTIONS: SocialPlatform[] = [...SOCIAL_PLATFORMS];

export function resolveEventPhase(event: CommunityEvent, now = Date.now()): CommunityEventPhase {
  if (event.phase) return event.phase;
  if (
    event.registrationOpensAt &&
    event.registrationClosesAt &&
    event.finalDataOpensAt &&
    event.finalDataClosesAt &&
    event.settlementDeadlineAt
  ) {
    return deriveEventPhase(now, {
      registrationOpensAt: event.registrationOpensAt,
      registrationClosesAt: event.registrationClosesAt,
      finalDataOpensAt: event.finalDataOpensAt,
      finalDataClosesAt: event.finalDataClosesAt,
      settlementDeadlineAt: event.settlementDeadlineAt,
    }, event.status === "closed" ? "completed" : "not_started");
  }
  return event.status === "closed" ? "completed" : "registration_open";
}

export function entryStatusTone(status: SocialEntryStatus): string {
  if (status === "settled" || status === "initial_approved") {
    return "border-emerald-500/20 bg-emerald-500/[0.07] text-emerald-800";
  }
  if (status === "needs_changes" || status === "initial_rejected" || status === "disqualified") {
    return "border-rose-500/20 bg-rose-500/[0.07] text-rose-800";
  }
  return "border-amber-500/20 bg-amber-500/[0.07] text-amber-800";
}

export function canEditSocialEntry(
  status: SocialEntryStatus,
  phase: CommunityEventPhase,
): boolean {
  return phase === "registration_open" && (
    status === "draft"
    || status === "submitted"
    || status === "under_initial_review"
    || status === "needs_changes"
  );
}

export function formatEventDate(value: string | null | undefined, locale: string): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Hong_Kong",
  }).format(new Date(value));
}

export function toEventApiDate(value: string): string | null {
  if (!value) return null;
  if (/Z$|[+-]\d{2}:\d{2}$/.test(value)) return value;
  return `${value.length === 16 ? value : value.slice(0, 16)}:00+08:00`;
}

export function toEventDateTimeInput(value: string | null | undefined): string {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}
