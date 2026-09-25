import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, Ticket } from "lucide-react";
import { useUserProfileStore } from "@/stores/user-profile";

const API = import.meta.env?.VITE_API_URL || "";

export interface InviteRaceEntry { eventId: string; referralCode: string | null; roundNo: number; endsAt: string; tickets: number; estimateUsd: number }

let cached: { key: string; at: number; value: InviteRaceEntry | null } | null = null;

/** Only renders while a round is running. One cheap request, cached for a minute. */
export function useInviteRaceEntry() {
  // Loads the profile strings too, for callers (Home, sidebar) that live in other namespaces.
  useTranslation("profile");
  // Keyed by account: after switching accounts the old estimate must not show.
  const key = useUserProfileStore((s) => s.profile?.id ?? "guest");
  const [entry, setEntry] = useState<InviteRaceEntry | null>(cached?.key === key ? cached.value : null);
  useEffect(() => {
    if (cached && cached.key === key && Date.now() - cached.at < 60_000) { setEntry(cached.value); return; }
    let alive = true;
    // Signed out → the public summary, so the Home banner still shows the race.
    fetch(`${API}/api/invite-race/entry`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : r.status === 401 ? fetch(`${API}/api/invite-race/public`).then((p) => (p.ok ? p.json() : { data: null })) : { data: null }))
      .then((j: { data: InviteRaceEntry | null }) => {
        cached = { key, at: Date.now(), value: j.data };
        if (alive) setEntry(j.data);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [key]);
  return entry;
}

const daysLeft = (iso: string) => Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000));

/**
 * The race as a banner card, for Community, the profile page and the invite
 * page: the prize, the three steps in one line, your live estimate, and one
 * button. Renders nothing when no round is running.
 */
export function InviteRaceBanner({ className = "" }: { className?: string }) {
  const { t } = useTranslation("profile");
  const navigate = useNavigate();
  const entry = useInviteRaceEntry();
  if (!entry) return null;
  const days = daysLeft(entry.endsAt);
  return (
    <button type="button" onClick={() => void navigate({ to: "/app/invite-race" })}
      className={`group relative flex w-full flex-col gap-3 overflow-hidden rounded-2xl border border-gold/30 bg-[#121317] p-4 text-left shadow-[0_0_60px_-32px_rgba(201,162,94,0.9)] sm:flex-row sm:items-center sm:gap-5 sm:p-5 ${className}`}>
      <span aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_90%_0%,rgba(201,162,94,0.35),transparent_55%)]" />
      <span className="relative min-w-0 flex-1">
        <span className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-gold">
          <Ticket className="h-3.5 w-3.5" />{t("inviteRace.title")}
          <span className="rounded-full bg-gold/15 px-2 py-0.5 text-[10px] normal-case tracking-normal">{t("inviteRace.banner.live", { days })}</span>
        </span>
        <span className="mt-1.5 block text-xl font-black tracking-tight text-main sm:text-2xl">{t("inviteRace.banner.title")}</span>
        <span className="mt-1 block text-[13px] text-sub/70">{t("inviteRace.banner.steps")}</span>
      </span>
      <span className="relative flex shrink-0 items-center gap-4 sm:flex-col sm:items-end sm:gap-1">
        <span className="text-right">
          <span className="block text-2xl font-black tabular-nums text-gold">${entry.estimateUsd.toFixed(2)}</span>
          <span className="block text-[10px] uppercase tracking-wider text-sub/50">{t("inviteRace.banner.yourEstimate")}</span>
        </span>
        <span className="inline-flex items-center gap-1 rounded-xl bg-gold px-3.5 py-2 text-sm font-bold text-black transition-transform group-hover:translate-x-0.5">
          {t("inviteRace.banner.cta")}<ChevronRight className="h-4 w-4" />
        </span>
      </span>
    </button>
  );
}

/** Kept for the invite page import. */
export const InviteRaceInviteCard = () => <InviteRaceBanner />;

/**
 * The quiet way in on the profile page: one small line under "Invite friends".
 * No banner, no colour block — people who don't care can ignore it.
 */
export function InviteRaceTag() {
  const { t } = useTranslation("profile");
  const navigate = useNavigate();
  const entry = useInviteRaceEntry();
  if (!entry) return null;
  return (
    <button type="button" onClick={() => void navigate({ to: "/app/invite-race" })}
      className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-gold/20 px-2 py-0.5 text-[11px] font-semibold text-gold/85 transition-colors hover:border-gold/40 hover:text-gold">
      <Ticket className="h-3 w-3" />
      {t("inviteRace.tag", { usd: `$${entry.estimateUsd.toFixed(2)}` })}
      <ChevronRight className="h-3 w-3" />
    </button>
  );
}

/** For inside another button (the phone shortcut): a label only, no link of its own. */
export function InviteRaceDot() {
  const { t } = useTranslation("profile");
  const entry = useInviteRaceEntry();
  if (!entry) return null;
  return <span className="rounded-full bg-gold/15 px-1.5 text-[9px] font-bold leading-4 text-gold">{t("inviteRace.title")}</span>;
}

/**
 * The race as a card in Community → Events, next to the regular events, in
 * the same light panel style as CommunityEventCard. Only while it runs.
 */
export function InviteRaceEventCard() {
  const { t } = useTranslation("profile");
  const navigate = useNavigate();
  const entry = useInviteRaceEntry();
  if (!entry) return null;
  const days = daysLeft(entry.endsAt);
  return (
    <button type="button" onClick={() => void navigate({ to: "/app/invite-race" })}
      className="group overflow-hidden rounded-2xl text-left community-panel community-panel--interactive">
      <div className="aspect-[16/5] overflow-hidden bg-black/10">
        <img src="/images/invite-race/mascot-art.jpg" alt="" className="h-full w-full object-cover object-right transition-transform duration-500 group-hover:scale-[1.02]" />
      </div>
      <div className="p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="rounded-full border border-emerald-600/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-emerald-700">{t("inviteRace.eventCard.status")}</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-black/[0.08] bg-black/[0.025] px-2 py-0.5 text-[11px] text-black/55"><Ticket className="h-3 w-3" />{t("inviteRace.title")}</span>
          <span className="ml-auto text-xs text-black/40">{t("inviteRace.banner.live", { days })}</span>
        </div>
        <h3 className="text-lg font-bold text-black transition-colors group-hover:text-[#7a5c20]">{t("inviteRace.eventCard.title")}</h3>
        <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-black/60">{t("inviteRace.hero.subtitle", { days })}</p>
        <div className="mt-4 flex justify-end text-xs">
          <span className="inline-flex items-center gap-1 font-semibold text-[#9A7B3E]">{t("inviteRace.hero.cta")}<ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" /></span>
        </div>
      </div>
    </button>
  );
}
