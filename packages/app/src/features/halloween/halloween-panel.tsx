import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "@tanstack/react-router";
import { Check, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { PumpkinGlyph } from "@/components/halloween-decor";
import { useAuthGuard } from "@/hooks/use-auth-guard";
import { MushroomIcon } from "@/lib/plan-theme";
import { useUserProfileStore } from "@/stores/user-profile";
import { PUMPKIN_SPOTS, halloweenRunning, useHalloweenStore } from "./halloween-store";
import "./halloween.css";

const SEEN_KEY = "yumina:halloween-2026-promo";

/** The event's illustration: the Mushie in a witch hat under the Halloween moon. */
export const HALLOWEEN_HERO_IMAGE = "/images/halloween/hero.jpg";
const PANEL_IMAGE = "/images/halloween/panel.jpg";

/**
 * Loads the event once per account and hosts the panel; always mounted with
 * the shell overlays, so anything can open it through the store.
 */
export function HalloweenBoot() {
  const accountKey = useUserProfileStore((s) => s.profile?.id ?? "guest");
  const load = useHalloweenStore((s) => s.load);
  const panelOpen = useHalloweenStore((s) => s.panelOpen);
  const setPanelOpen = useHalloweenStore((s) => s.setPanelOpen);
  useEffect(() => { void load(accountKey); }, [accountKey, load]);
  return <HalloweenPanel open={panelOpen} onClose={() => setPanelOpen(false)} />;
}

/** The top-bar pumpkin: how many of the five you've found; opens the panel. */
export function HalloweenTopBarEntry() {
  const { t } = useTranslation("common");
  const state = useHalloweenStore((s) => s.state);
  const setPanelOpen = useHalloweenStore((s) => s.setPanelOpen);
  if (!halloweenRunning(state)) return null;
  const found = Object.keys(state?.found ?? {}).length;
  return (
    <button type="button" className="halloween-entry" onClick={() => setPanelOpen(true)}
      title={t("halloween.title")} aria-label={t("halloween.entryLabel", { found })}>
      <PumpkinGlyph className="h-5 w-5" />
      {!state?.guest && <span className="halloween-entry__count">{found}/5</span>}
    </button>
  );
}

/**
 * The launch popup: once per browser, only on browse pages (never over a game
 * or the editor), a moment after the page settles.
 */
export function HalloweenPromo() {
  const state = useHalloweenStore((s) => s.state);
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const isPlayPage = location.pathname.startsWith("/app/chat/") || location.pathname.startsWith("/app/preview/");
  const isMakingPage = /^\/app\/(worlds\/(create|[^/]+\/edit)|studio)/.test(location.pathname);
  const running = halloweenRunning(state);
  // A new account finishes the welcome step (birth year, username) first.
  const onboarding = useUserProfileStore((s) => !!s.profile && (s.profile.birthYear === null || !s.profile.username));

  useEffect(() => {
    // Never over a game or the editor; the invite-race popup owns the auth-return moment.
    if (!running || isPlayPage || isMakingPage || onboarding) return;
    try { if (localStorage.getItem(SEEN_KEY)) return; } catch { return; }
    const id = setTimeout(() => setOpen(true), 1600);
    return () => clearTimeout(id);
  }, [running, isPlayPage, isMakingPage, onboarding]);

  const close = () => {
    setOpen(false);
    try { localStorage.setItem(SEEN_KEY, "1"); } catch { /* private mode */ }
  };
  if (!running) return null;
  return <HalloweenPanel open={open} onClose={close} />;
}

function HalloweenPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation("common");
  const { isAuthenticated, requireAuth } = useAuthGuard();
  const state = useHalloweenStore((s) => s.state);
  const claimTurns = useHalloweenStore((s) => s.claimTurns);
  const [claiming, setClaiming] = useState(false);
  if (!state) return null;

  const found = state.found ?? {};
  const foundCount = Object.keys(found).length;
  const ends = new Date(state.endsAt).toLocaleString(i18n.language, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const turns = state.turns;
  const bonus = state.allFoundBonus ?? 500;

  const onClaim = async () => {
    setClaiming(true);
    const result = await claimTurns();
    setClaiming(false);
    if (result.ok) toast.success(t("halloween.turnsClaimed", { amount: result.amount }));
    else toast.error(t("halloween.failed"));
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent hideClose className="halloween-panel max-h-[92vh] max-w-[480px] overflow-y-auto overflow-x-hidden border-[#F08A24]/30 bg-[#120E1A] p-0">
        <div className="halloween-panel__hero">
          <img src={PANEL_IMAGE} alt="" className="halloween-panel__art" decoding="async" />
          <span className="halloween-panel__shade" aria-hidden />
          <svg className="halloween-panel__bat halloween-panel__bat--a" viewBox="0 0 48 24" aria-hidden><use href="#halloween-bat" /></svg>
          <svg className="halloween-panel__bat halloween-panel__bat--b" viewBox="0 0 48 24" aria-hidden><use href="#halloween-bat" /></svg>
          <DialogClose className="halloween-panel__close" aria-label={t("action.close")}><X className="h-4 w-4" /></DialogClose>
          <div className="halloween-panel__copy">
            <span className="halloween-panel__kicker">{t("halloween.kicker")}</span>
            <DialogTitle className="halloween-panel__title">{t("halloween.title")}</DialogTitle>
            <DialogDescription className="halloween-panel__sub">{t("halloween.sub", { ends })}</DialogDescription>
          </div>
        </div>

        <div className="flex flex-col gap-3 px-5 pb-5 pt-1">
          <div className="halloween-panel__shelf">
            <div className="halloween-panel__shelf-head">
              <span>{t("halloween.mapTitle")}</span>
              {!state.guest && <b>{foundCount}/5</b>}
            </div>
            <div className="grid grid-cols-5 gap-1.5">
              {PUMPKIN_SPOTS.map((spot, i) => {
                const paid = found[spot];
                const lit = paid !== undefined;
                return (
                  <div key={spot} className={`halloween-panel__slot ${lit ? "halloween-panel__slot--lit" : ""}`} style={{ animationDelay: `${i * 0.4}s` }}>
                    <span className="halloween-panel__lantern">
                      <PumpkinGlyph className="h-full w-full" />
                      {!lit && <span className="halloween-panel__q" aria-hidden>?</span>}
                    </span>
                    <span className="halloween-panel__spot">{t(`halloween.spot.${spot}`)}</span>
                    <span className={lit ? "halloween-panel__candy" : "halloween-panel__candy halloween-panel__candy--empty"}>
                      {lit ? `+${paid}` : t("halloween.notYet")}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          <Reward
            icon={<CandyBucketGlyph className="h-9 w-9" />}
            done={!!state.allFoundClaimed}
            title={t("halloween.allFoundRow", { bonus })}
            progress={state.guest ? null : { value: foundCount, goal: 5 }}
            right={null}
          />

          {turns && (
            <Reward
              icon={<span className="halloween-panel__dice" aria-hidden>13</span>}
              done={turns.claimed}
              title={t("halloween.turnsRow", { goal: turns.goal, reward: turns.reward })}
              progress={{ value: Math.min(turns.progress, turns.goal), goal: turns.goal }}
              right={!turns.claimed && turns.progress >= turns.goal ? (
                <button type="button" onClick={onClaim} disabled={claiming}
                  className="halloween-panel__claim">
                  {claiming && <Loader2 className="h-3 w-3 animate-spin" />}{t("halloween.claim")}
                </button>
              ) : null}
            />
          )}

          {!isAuthenticated ? (
            <button type="button" onClick={() => { onClose(); requireAuth(t("halloween.loginToOpen")); }}
              className="halloween-panel__cta">
              {t("halloween.loginCta")}
            </button>
          ) : (
            <div className="halloween-panel__foot">
              <span>{state.eligible === false ? t("halloween.playFirst") : t("halloween.howTo")}</span>
              <span className="halloween-panel__total" title={t("halloween.collected")}>
                <MushroomIcon className="h-4 w-4" />{state.total ?? 0}
              </span>
            </div>
          )}
        </div>
        <BatSymbol />
      </DialogContent>
    </Dialog>
  );
}

function Reward({ icon, title, progress, right, done }: {
  icon: React.ReactNode;
  title: string;
  progress: { value: number; goal: number } | null;
  right: React.ReactNode;
  done: boolean;
}) {
  const pct = progress ? Math.round((progress.value / progress.goal) * 100) : 0;
  return (
    <div className={`halloween-panel__reward ${done ? "halloween-panel__reward--done" : ""}`}>
      <span className="halloween-panel__reward-icon">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="halloween-panel__reward-title">{title}</p>
        {progress && !done && (
          <div className="mt-1.5 flex items-center gap-2">
            <span className="halloween-panel__bar"><span style={{ width: `${pct}%` }} /></span>
            <span className="halloween-panel__count">{progress.value}/{progress.goal}</span>
          </div>
        )}
      </div>
      {done ? <span className="halloween-panel__done"><Check className="h-4 w-4" /></span> : right}
    </div>
  );
}

/** A jack-o'-lantern bucket heaped with wrapped sweets. */
export function CandyBucketGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 120" className={className} aria-hidden xmlns="http://www.w3.org/2000/svg">
      <path d="M22 52 C22 18 98 18 98 52" fill="none" stroke="#3A2A20" strokeWidth="5" strokeLinecap="round" />
      <circle cx="40" cy="50" r="11" fill="#F4A6B0" /><path d="M27 46l-7-6 1 12zM53 54l7 6-1-12z" fill="#F4A6B0" />
      <circle cx="62" cy="44" r="11" fill="#A58BCB" /><path d="M58 33l-4-8 10 4zM66 55l4 8-10-4z" fill="#A58BCB" />
      <circle cx="82" cy="52" r="10" fill="#FFD66B" /><path d="M76 48a6 6 0 0 1 12 0" stroke="#F08A24" strokeWidth="2.5" fill="none" />
      <ellipse cx="60" cy="82" rx="46" ry="34" fill="#E07418" />
      <ellipse cx="60" cy="82" rx="30" ry="34" fill="#F08A24" />
      <ellipse cx="60" cy="54" rx="40" ry="8" fill="#B5521A" />
      <path d="M38 78l8-11 8 11zM66 78l8-11 8 11z" fill="#FFE08A" />
      <path d="M36 90c8 12 40 12 48 0l-5 3-4-3-5 4-4-4-5 4-4-4-5 4-4-4z" fill="#FFE08A" />
    </svg>
  );
}

function BatSymbol() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden>
      <defs>
        <symbol id="halloween-bat" viewBox="0 0 48 24">
          <path d="M22 12C18 6 12 4 3 6c3 1.6 4 3.4 3.6 5.6 2-1.4 4.4-1.2 5.6.6 1.4-1.4 4-1.4 5.4.4z" fill="#8E74B8" />
          <path d="M26 12c4-6 10-8 19-6-3 1.6-4 3.4-3.6 5.6-2-1.4-4.4-1.2-5.6.6-1.4-1.4-4-1.4-5.4.4z" fill="#8E74B8" />
          <ellipse cx="24" cy="13" rx="3.6" ry="4.6" fill="#A58BCB" />
          <path d="M21.4 9.4l.9-2.6 1.3 2.2zM26.6 9.4l-.9-2.6-1.3 2.2z" fill="#A58BCB" />
          <circle cx="22.7" cy="12" r="0.8" fill="#FFE08A" /><circle cx="25.3" cy="12" r="0.8" fill="#FFE08A" />
        </symbol>
      </defs>
    </svg>
  );
}

/** The event's card at the top of Community (and among the events there). */
export function HalloweenCommunityCard({ className = "" }: { className?: string }) {
  const { t } = useTranslation("common");
  const state = useHalloweenStore((s) => s.state);
  const setPanelOpen = useHalloweenStore((s) => s.setPanelOpen);
  if (!state || !halloweenRunning(state)) return null;
  const found = Object.keys(state.found ?? {}).length;
  return (
    <button type="button" className={`halloween-community-card ${className}`} onClick={() => setPanelOpen(true)}>
      <img src={HALLOWEEN_HERO_IMAGE} alt="" decoding="async" loading="lazy" />
      <span className="halloween-community-card__shade" aria-hidden />
      <span className="halloween-community-card__copy">
        <span className="halloween-panel__kicker self-start">{t("halloween.kicker")}</span>
        <span className="text-2xl font-black leading-tight text-[#FFF3DC] [text-shadow:0_0_18px_rgba(255,150,50,0.4),0_2px_0_#7A3A10]">{t("halloween.title")}</span>
        <span className="text-[13px] leading-snug text-[#F5E9D2]/80">{t("halloween.heroSub")}</span>
        <span className="halloween-community-card__cta">
          {state.guest || found === 0 ? t("halloween.heroCta") : found >= 5 ? t("halloween.heroCtaDone") : t("halloween.heroCtaProgress", { found })}
        </span>
      </span>
    </button>
  );
}
