import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Check, Copy, Ticket } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useAuthGuard } from "@/hooks/use-auth-guard";
import { useUserProfileStore } from "@/stores/user-profile";
import { DEFAULT_INVITE_RACE_RULES } from "@yumina/shared";
import { HowItWorksSteps, PrizeSplit } from "./how-it-works";
import { inviteUrlFor } from "./share-bar";
import { useInviteRaceEntry } from "./invite-race-entry";

const seenKey = (eventId: string) => `yumina:invite-race-promo:${eventId}`;

/**
 * The launch popup: once per event per browser, only on browse pages (never
 * while playing or making), and only while a round is running. It says the
 * whole thing in one screen — the prize, the three steps, how the $1,000 is
 * split — and its main button copies your link.
 */
export function InviteRacePromo() {
  const { t } = useTranslation("profile");
  const { isAuthenticated } = useAuthGuard();
  const location = useLocation();
  const navigate = useNavigate();
  const profile = useUserProfileStore((s) => s.profile);
  const entry = useInviteRaceEntry();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const isPlayPage = location.pathname.startsWith("/app/chat/") || location.pathname.startsWith("/app/preview/");
  // Never while making a world either: the editor has its own dialogs competing for that space.
  const isMakingPage = /^\/app\/(worlds\/(create|[^/]+\/edit)|studio)/.test(location.pathname);
  const eligible = isAuthenticated && !!profile?.username && !isPlayPage && !isMakingPage
    && !location.pathname.startsWith("/app/invite-race");

  useEffect(() => {
    if (!eligible || !entry) return;
    // ?invite-race-promo in the URL shows it again, even after it was dismissed.
    const force = new URLSearchParams(window.location.search).has("invite-race-promo");
    if (!force) {
      try { if (localStorage.getItem(seenKey(entry.eventId))) return; } catch { return; }
    }
    // Give the page a moment to settle so this isn't the first thing that flashes.
    const id = setTimeout(() => setOpen(true), 1200);
    return () => clearTimeout(id);
  }, [eligible, entry]);

  const close = () => {
    setOpen(false);
    if (entry) try { localStorage.setItem(seenKey(entry.eventId), "1"); } catch { /* private mode */ }
  };
  const code = entry?.referralCode ?? null;
  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(t("inviteRace.shareText", { url: inviteUrlFor(code) }));
      setCopied(true);
    } catch { /* ignore */ }
  };

  if (!entry) return null;
  const rules = DEFAULT_INVITE_RACE_RULES;
  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) close(); }}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto border-gold/25 bg-[#131419] p-0">
        <div className="relative overflow-hidden rounded-t-lg bg-[radial-gradient(circle_at_85%_10%,rgba(201,162,94,0.45),transparent_60%)] px-5 pb-5 pt-6">
          <p className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-gold"><Ticket className="h-3.5 w-3.5" />{t("inviteRace.title")}</p>
          <DialogTitle className="mt-2 text-3xl font-black leading-tight tracking-tight text-main">{t("inviteRace.promo.title")}</DialogTitle>
          <DialogDescription className="mt-1.5 text-sm text-sub/75">{t("inviteRace.promo.sub", { days: Math.max(1, Math.ceil((Date.parse(entry.endsAt) - Date.now()) / 86_400_000)) })}</DialogDescription>
        </div>
        <div className="flex flex-col gap-4 px-5 pb-5">
          <HowItWorksSteps rules={rules} compact />
          <PrizeSplit rules={rules} />
          <p className="rounded-xl border border-white/[0.07] bg-white/[0.02] px-3 py-2 text-xs text-sub/70">
            {t("inviteRace.payout.small", { cash: `$${rules.cashThresholdUsd}`, rate: rules.mushiesPerUsd.toLocaleString() })}{" "}
            {t("inviteRace.payout.large", { cash: `$${rules.cashThresholdUsd}` })}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <button type="button" disabled={!code} onClick={copy}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-gold px-4 py-3 text-sm font-bold text-black disabled:opacity-50">
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? t("inviteRace.copied") : t("inviteRace.promo.copy")}
            </button>
            <button type="button" onClick={() => { close(); void navigate({ to: "/app/invite-race" }); }}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-white/15 px-4 py-3 text-sm font-bold text-main">
              {t("inviteRace.promo.open")}<ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
