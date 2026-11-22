import { useTranslation } from "react-i18next";
import { useState } from "react";
import { MEMORY_EVERY_CHOICES, MEMORY_EVERY_MAX, MEMORY_EVERY_MIN, RECAP_SHARES, recapBudgetTokens, resolveMemoryEvery, resolveRecapShare, type RecapShare } from "@yumina/shared";
import { useConfigStore } from "@/stores/config";
import { InfoTip } from "@/components/ui/info-tip";
import { AiRoleTiles } from "@/features/settings/ai-role-tiles";

/**
 * The recap ("前情提要"): scenes that no longer fit in story memory are folded
 * into it, and it goes out with every reply. Its size is a cost the player
 * pays on each turn, so the player picks it, as a share of story memory, with
 * the numbers in front of them.
 */
export function RecapShareSetting({ storyMemory }: { storyMemory: number }) {
  const { t } = useTranslation("profile");
  const recapShare = useConfigStore((s) => s.recapShare);
  const setConfig = useConfigStore((s) => s.setConfig);
  const share: RecapShare = resolveRecapShare({ chosen: recapShare });
  const budget = recapBudgetTokens(storyMemory, share);

  return (
    <div className="border-b border-white/5 pb-6">
      <div className="mb-3 flex items-center justify-between">
        <label className="flex items-center gap-1.5 text-sm font-semibold text-main">
          {t("config.recap")}
          <InfoTip text={t("config.recapDesc")} />
        </label>
        <span className="text-xs text-sub tabular-nums">
          {budget > 0 ? t("config.recapUpTo", { n: budget.toLocaleString() }) : t("config.recapOffShort")}
        </span>
      </div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {RECAP_SHARES.map((option) => {
          const active = share === option;
          const tokens = recapBudgetTokens(storyMemory, option);
          return (
            <button
              key={option}
              type="button"
              aria-pressed={active}
              onClick={() => setConfig("recapShare", option)}
              className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                active
                  ? "border-gold/50 bg-gold/10 text-action-primary"
                  : "border-white/[0.07] bg-white/[0.02] text-sub hover:bg-white/[0.05]"
              }`}
            >
              {t(`config.recapShares.${option}`)}
              {tokens > 0 && <span className="ml-1.5 tabular-nums opacity-60">≈{tokens.toLocaleString()}</span>}
              {option === "standard" && (
                <span className="ml-1.5 text-[9px] font-semibold uppercase tracking-wide text-action-primary/70">
                  {t("config.storyMemorySuggested")}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="text-xs leading-relaxed text-sub">
        {budget > 0 ? t("config.recapExplainOn", { n: budget.toLocaleString() }) : t("config.recapExplainOff")}
      </p>
      {budget > 0 && <AiRoleTiles roles={["summary"]} className="mt-3 md:grid-cols-2" />}
    </div>
  );
}

/** How many turns session memory waits before it writes down what happened. Fewer updates cost less; the
 *  newest turns are still in the AI's view word for word until then. */
export function MemoryEverySetting() {
  const { t } = useTranslation("profile");
  const chosen = useConfigStore((s) => s.memoryEvery);
  const setConfig = useConfigStore((s) => s.setConfig);
  const every = resolveMemoryEvery(chosen ?? undefined);
  const isPreset = (MEMORY_EVERY_CHOICES as readonly number[]).includes(every);
  const [customOpen, setCustomOpen] = useState(!isPreset);
  const [draft, setDraft] = useState(isPreset ? "" : String(every));
  const commit = (raw: string) => {
    const n = Math.round(Number(raw));
    if (Number.isFinite(n)) setConfig("memoryEvery", Math.min(MEMORY_EVERY_MAX, Math.max(MEMORY_EVERY_MIN, n)));
  };
  const chip = (active: boolean) => `rounded-lg border px-3 py-1.5 text-xs transition-colors ${
    active ? "border-gold/50 bg-gold/10 text-action-primary" : "border-white/[0.07] bg-white/[0.02] text-sub hover:bg-white/[0.05]"
  }`;
  return (
    <div className="border-b border-white/5 pb-6">
      <div className="mb-3 flex items-center justify-between">
        <label className="flex items-center gap-1.5 text-sm font-semibold text-main">
          {t("config.memoryEvery")}
          <InfoTip text={t("config.memoryEveryDesc")} />
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {MEMORY_EVERY_CHOICES.map((option) => {
          const active = !customOpen && every === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={active}
              onClick={() => { setCustomOpen(false); setConfig("memoryEvery", option); }}
              className={chip(active)}
            >
              {t("config.memoryEveryOption", { n: option })}
            </button>
          );
        })}
        {customOpen ? (
          <label className={`${chip(true)} inline-flex items-center gap-1.5`}>
            <input
              type="number"
              inputMode="numeric"
              min={MEMORY_EVERY_MIN}
              max={MEMORY_EVERY_MAX}
              autoFocus={!isPreset ? undefined : true}
              value={draft}
              onChange={(e) => { setDraft(e.target.value); commit(e.target.value); }}
              onBlur={() => setDraft(String(every))}
              aria-label={t("config.memoryEveryCustom")}
              className="w-10 bg-transparent text-center tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
            />
            <span>{t("config.memoryEveryTurns")}</span>
          </label>
        ) : (
          <button type="button" onClick={() => { setCustomOpen(true); setDraft(String(every)); }} className={chip(false)}>
            {t("config.memoryEveryCustom")}
          </button>
        )}
      </div>
    </div>
  );
}
