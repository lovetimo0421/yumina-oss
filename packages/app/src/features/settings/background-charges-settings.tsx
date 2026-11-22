import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Coins } from "lucide-react";
import {
  BACKGROUND_CHARGE_FEATURES,
  BACKGROUND_CHARGE_FREE_OPTION,
  readBackgroundChargePrefs,
  type BackgroundChargeChoice,
  type BackgroundChargeFeature,
} from "@yumina/shared";
import { useUserProfileStore } from "@/stores/user-profile";
import { InfoTip } from "@/components/ui/info-tip";
import { nextBackgroundChargePrefs, saveBackgroundChargePrefs } from "@/features/background-charges/background-consent-store";
import { cn } from "@/lib/utils";

type RowChoice = BackgroundChargeChoice | "ask";

const chip = (active: boolean, disabled?: boolean) => cn(
  "rounded-lg border px-3 py-1.5 text-xs transition-colors",
  active ? "border-gold/50 bg-gold/10 text-action-primary" : "border-white/[0.07] bg-white/[0.02] text-sub hover:bg-white/[0.05]",
  disabled && "pointer-events-none opacity-40",
);

/**
 * The player's answers to "may this background AI charge mushies?" (the
 * dialog asks once; this is where they are changed later). Stored in
 * user.preferences.backgroundCharges; the server enforces them.
 */
export function BackgroundChargesSettings() {
  const { t } = useTranslation();
  const preferences = useUserProfileStore((s) => s.profile?.preferences);
  const saved = readBackgroundChargePrefs(preferences);
  const [failed, setFailed] = useState(false);

  const save = async (answers: Partial<Record<BackgroundChargeFeature, RowChoice>>, allowAll?: boolean) => {
    setFailed(false);
    if (!await saveBackgroundChargePrefs(nextBackgroundChargePrefs(saved, answers, allowAll))) setFailed(true);
  };

  return (
    <section id="background-charges" className="scroll-mt-6 border-b border-white/[0.06] pb-5" aria-labelledby="background-charges-title">
      <h3 id="background-charges-title" className="flex items-center gap-2 text-sm font-medium text-main">
        <Coins className="h-4 w-4 text-gold" aria-hidden="true" />{t("backgroundCharges.settingsTitle")}<InfoTip text={t("backgroundCharges.settingsTip")} />
      </h3>
      <label className="mt-3 flex cursor-pointer items-center justify-between gap-4 rounded-xl border border-white/8 bg-white/[0.02] px-4 py-3">
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-main">{t("backgroundCharges.dontAskAgain")}</span>
          <span className="block text-xs text-sub">{t("backgroundCharges.dontAskAgainHint")}</span>
        </span>
        <input
          type="checkbox"
          className="h-4 w-4 shrink-0 accent-gold"
          checked={saved.allowAll === true}
          onChange={(event) => void save({}, event.target.checked)}
        />
      </label>
      <div className="mt-3 space-y-3">
        {BACKGROUND_CHARGE_FEATURES.map((feature) => {
          const current: RowChoice = saved.features?.[feature] ?? "ask";
          const options: RowChoice[] = ["ask", "allow", BACKGROUND_CHARGE_FREE_OPTION[feature] ? "free" : "skip"];
          return (
            <div key={feature}>
              <div className="flex items-center gap-1.5 text-xs font-medium text-main">
                {t(`backgroundCharges.features.${feature}.name`)}
                <InfoTip text={t(`backgroundCharges.features.${feature}.desc`)} />
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5" role="radiogroup" aria-label={t(`backgroundCharges.features.${feature}.name`)}>
                {options.map((option) => {
                  const active = saved.allowAll ? option === "allow" : current === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={saved.allowAll === true}
                      onClick={() => void save({ [feature]: option })}
                      className={chip(active, saved.allowAll === true && !active)}
                    >
                      {t(`backgroundCharges.choice.${option}`)}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {failed && <p className="mt-2 text-xs text-destructive">{t("backgroundCharges.saveFailed")}</p>}
    </section>
  );
}
