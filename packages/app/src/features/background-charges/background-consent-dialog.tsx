import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Coins, Loader2 } from "lucide-react";
import { PLAY_MODELS, formatModelId, type BackgroundConsentNeeded } from "@yumina/shared";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { useUserProfileStore } from "@/stores/user-profile";
import {
  closeBackgroundConsent,
  currentBackgroundChargePrefs,
  declinedChoice,
  nextBackgroundChargePrefs,
  saveBackgroundChargePrefs,
  useBackgroundConsentStore,
} from "./background-consent-store";

export function backgroundModelName(id: string): string {
  return PLAY_MODELS.find((model) => model.id === id)?.name ?? formatModelId(id);
}

function AskRow({ ask }: { ask: BackgroundConsentNeeded }) {
  const { t } = useTranslation();
  return (
    <li className="rounded-xl border border-white/[0.07] bg-white/[0.035] p-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold text-foreground">{t(`backgroundCharges.features.${ask.feature}.name`)}</span>
        <span className={`shrink-0 text-xs tabular-nums ${ask.ownKey ? "text-muted-foreground" : "text-amber-300"}`}>
          {ask.ownKey
            ? t("backgroundCharges.ownKey")
            : ask.estCredits != null
              ? t(`backgroundCharges.features.${ask.feature}.perUse`, { n: ask.estCredits, defaultValue: t("backgroundCharges.perUse", { n: ask.estCredits }) })
              : t("backgroundCharges.perUseUnknown")}
        </span>
      </div>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {ask.ownKey
          ? t(`backgroundCharges.features.${ask.feature}.ownKeyDesc`, { defaultValue: t(`backgroundCharges.features.${ask.feature}.desc`) })
          : t(`backgroundCharges.features.${ask.feature}.desc`)}
      </p>
      <p className="mt-1.5 text-[11px] text-muted-foreground/70">
        {backgroundModelName(ask.model)}
        {" · "}
        {ask.hasFreeOption ? t("backgroundCharges.declineFree") : t("backgroundCharges.declineSkip")}
      </p>
    </li>
  );
}

/**
 * Asked once, the first time a background AI (recap, memory, state guard,
 * card AIs, run summary) would charge mushies. Mounted at the root; filled by
 * a reply's `done` event or the profile's waiting notes. Closing it saves
 * nothing: the server keeps those AIs from charging and asks again later.
 */
export function BackgroundConsentDialog() {
  const { t } = useTranslation();
  const asks = useBackgroundConsentStore((state) => state.asks);
  const held = useBackgroundConsentStore((state) => state.held);
  const preferences = useUserProfileStore((state) => state.profile?.preferences);
  const [dontAsk, setDontAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const allFree = asks.length > 0 && asks.every((ask) => ask.hasFreeOption);
  const noneFree = asks.every((ask) => !ask.hasFreeOption);
  const declineLabel = allFree ? t("backgroundCharges.useFree") : noneFree ? t("backgroundCharges.skip") : t("backgroundCharges.noCharge");
  // Only AIs on the player's own API: nothing here costs mushies.
  const ownKeyOnly = asks.length > 0 && asks.every((ask) => ask.ownKey);

  const answer = async (allow: boolean) => {
    setBusy(true);
    setFailed(false);
    const answers = Object.fromEntries(asks.map((ask) => [ask.feature, allow ? "allow" : declinedChoice(ask)]));
    const ok = await saveBackgroundChargePrefs(nextBackgroundChargePrefs(currentBackgroundChargePrefs(preferences), answers, allow && dontAsk ? true : undefined));
    setBusy(false);
    if (!ok) { setFailed(true); return; }
    setDontAsk(false);
    closeBackgroundConsent();
  };

  return (
    <Dialog open={asks.length > 0 && !held} onOpenChange={(next) => { if (!next && !busy) closeBackgroundConsent(); }}>
      <DialogContent mobileSheet className="gap-5 border-white/10 bg-[#17181D] p-5 sm:p-6">
        <DialogHeader className="pr-12 text-left">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.05] text-action-primary">
              <Coins className="h-5 w-5" aria-hidden="true" />
            </div>
            <DialogTitle className="text-xl leading-tight text-foreground">{t(ownKeyOnly ? "backgroundCharges.titleOwnKey" : "backgroundCharges.title")}</DialogTitle>
          </div>
          <DialogDescription asChild>
            <div className="pt-1 text-sm leading-relaxed text-muted-foreground">{t(ownKeyOnly ? "backgroundCharges.bodyOwnKey" : "backgroundCharges.body")}</div>
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-2">
          {asks.map((ask) => <AskRow key={ask.feature} ask={ask} />)}
        </ul>

        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-muted-foreground">
          <Checkbox checked={dontAsk} onCheckedChange={(value) => setDontAsk(value === true)} disabled={busy} className="mt-0.5" />
          <span>
            <span className="text-foreground">{t("backgroundCharges.dontAskAgain")}</span>
            <span className="block text-xs text-muted-foreground/70">{t("backgroundCharges.dontAskAgainHint")}</span>
          </span>
        </label>

        {failed && <p className="text-xs text-destructive">{t("backgroundCharges.saveFailed")}</p>}
        <p className="text-[11px] text-muted-foreground/60">{t("backgroundCharges.changeLater")}</p>

        <DialogFooter className="gap-y-3">
          <button
            type="button"
            onClick={() => void answer(false)}
            disabled={busy || dontAsk}
            className="inline-flex min-h-11 flex-1 items-center justify-center rounded-xl border border-white/10 bg-white/[0.035] px-4 text-sm font-semibold text-foreground transition-colors hover:bg-white/[0.07] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[#17181D] disabled:opacity-50 sm:flex-none"
          >
            {declineLabel}
          </button>
          <button
            type="button"
            onClick={() => void answer(true)}
            disabled={busy}
            className="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-action-primary px-4 text-sm font-semibold text-action-primary-foreground transition-colors hover:bg-action-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action-primary/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#17181D] disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
            {t(ownKeyOnly ? "backgroundCharges.allowOwnKey" : "backgroundCharges.allow")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
