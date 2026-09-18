import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Lock } from "lucide-react";
import { isKimiAntiRepetitionModel } from "@/lib/kimi-repetition";
import { useConfigStore } from "@/stores/config";
import { useCreditStore } from "@/edition/slots.state";
import { GlobalPrompts } from "@/features/configs/global-prompts";
import { Select } from "@/components/ui/select";
import { NumberInput } from "@/components/ui/number-input";
import { ModelFallbackSettings } from "@/features/settings/model-fallback-settings";

export function AiConfigTab() {
  const { t } = useTranslation("profile");
  const {
    maxTokens,
    maxContext,
    temperature,
    topP,
    frequencyPenalty,
    presencePenalty,
    repetitionPenalty,
    topK,
    minP,
    reasoningEffort,
    streaming,
    selectedModel,
    setConfig,
    resetDefaults,
  } = useConfigStore();

  // Context cap: only applies to official API users with a memoryCap (Free/Gold)
  const { memoryCap, provider, fetchCredits } = useCreditStore();
  useEffect(() => { fetchCredits(); }, [fetchCredits]);
  const isByok = provider === "private";
  const contextCapped = !isByok && memoryCap !== null && memoryCap > 0;
  const contextMax = contextCapped ? memoryCap : 2000000;

  // If user's current maxContext exceeds their cap, clamp it down
  useEffect(() => {
    if (contextCapped && maxContext > memoryCap) {
      setConfig("maxContext", memoryCap);
    }
  }, [contextCapped, memoryCap, maxContext, setConfig]);

  // Claude (Anthropic) only accepts temperature in [0, 1]; other families allow
  // up to the 1.5 slider max. Cap the slider when a Claude model is selected, and
  // snap an out-of-range value (carried over from another model) back down to 1.0
  // on switch. The server clamps too as a backstop — this just makes the UI honest.
  const isClaudeSelected =
    /(^|\/)anthropic\//i.test(selectedModel) || /claude/i.test(selectedModel);
  const isKimiSelected = isKimiAntiRepetitionModel(selectedModel);
  const tempMax = isClaudeSelected ? 1 : 1.5;
  useEffect(() => {
    if (isClaudeSelected && temperature > 1) setConfig("temperature", 1);
  }, [isClaudeSelected, temperature, setConfig]);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const themedNumberInputClass =
    "profile-overview-input-surface rounded-xl border-gold/20 [&_button]:border-white/10 [&_button]:text-sub/80 [&_button:hover]:bg-white/[0.04] [&_button:hover]:text-main [&_input]:text-left [&_input]:font-medium [&_input]:text-main [&_input]:placeholder:text-sub/50 focus-within:border-gold/50 focus-within:ring-gold/30";
  const reasoningEffortOptions = [
    { value: "minimal", label: t("config.reasoningOptions.minimal"), description: t("config.reasoningOptions.minimalDesc") },
    { value: "low",     label: t("config.reasoningOptions.low"),     description: t("config.reasoningOptions.lowDesc") },
    { value: "medium",  label: t("config.reasoningOptions.medium"),  description: t("config.reasoningOptions.mediumDesc") },
    { value: "high",    label: t("config.reasoningOptions.high"),    description: t("config.reasoningOptions.highDesc") },
  ];

  return (
    <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="mb-1 text-xl font-bold text-main">{t("config.title")}</h2>
          <p className="text-xs text-sub">{t("config.subtitle")}</p>
        </div>
        <button
          onClick={resetDefaults}
          className="text-sm text-sub transition-colors hover:text-main"
        >
          {t("config.resetDefaults")}
        </button>
      </div>

      <div className="space-y-6">
        <ModelFallbackSettings />
        <div className="profile-overview-glass profile-overview-glass--soft rounded-2xl p-6">
          <div className="space-y-6">
            {/* Context Size */}
            <div className="border-b border-white/5 pb-6">
              <div className="mb-3 flex items-center justify-between">
                <label className="text-sm font-semibold text-main">{t("config.contextSize")}</label>
                <div className="flex items-center gap-2">
                  {contextCapped && (
                    <span className="inline-flex items-center gap-1 rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-400">
                      <Lock className="h-2.5 w-2.5" />
                      {t("config.contextCapped", { limit: memoryCap.toLocaleString() })}
                    </span>
                  )}
                  <span className="text-xs text-sub">{maxContext.toLocaleString()} tokens</span>
                </div>
              </div>
              <NumberInput
                min={4096}
                max={contextMax}
                step={1024}
                value={maxContext}
                onChange={(value) =>
                  setConfig("maxContext", Math.max(4096, Math.min(contextMax, Number(value) || 4096)))
                }
                className={themedNumberInputClass}
              />
              <p className="mt-2 text-xs text-sub">
                {contextCapped
                  ? t("config.contextUpgrade")
                  : t("config.contextSizeDesc")
                }
              </p>
            </div>

            {/* Response Length */}
            <div className="border-b border-white/5 pb-6">
              <div className="mb-3 flex items-center justify-between">
                <label className="text-sm font-semibold text-main">{t("config.responseLength")}</label>
                <span className="text-xs text-sub">{maxTokens.toLocaleString()} tokens</span>
              </div>
              <NumberInput
                min={256}
                max={32768}
                step={256}
                value={maxTokens}
                onChange={(value) =>
                  setConfig("maxTokens", Math.max(256, Math.min(32768, Number(value) || 256)))
                }
                className={themedNumberInputClass}
              />
              <p className="mt-2 text-xs text-sub">{t("config.responseLengthDesc")}</p>
            </div>

            {/* Temperature */}
            <div className="border-b border-white/5 pb-6">
              <div className="mb-4 flex items-center justify-between">
                <label className="text-sm font-semibold text-main">{t("config.creativity")}</label>
                <span className="text-xs text-sub">{temperature.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0.5}
                max={tempMax}
                step={0.01}
                value={temperature}
                onChange={(e) => setConfig("temperature", Number(e.target.value))}
                className="w-full accent-gold"
              />
              <div className="mt-1 flex justify-between text-xs text-sub">
                <span>{t("config.precise")}</span>
                <span>{t("config.creative")} ({tempMax.toFixed(2)})</span>
              </div>
            </div>

            {/* Reasoning Effort */}
            <div className="border-b border-white/5 pb-6">
              <div className="mb-3 flex items-center justify-between">
                <label className="text-sm font-semibold text-main">{t("config.reasoningEffort")}</label>
                <span className="text-xs text-sub">
                  {t(`config.reasoningOptions.${reasoningEffort}` as const, {
                    defaultValue: reasoningEffort,
                  })}
                </span>
              </div>
              <Select
                value={reasoningEffort}
                onValueChange={(value) => setConfig("reasoningEffort", value)}
                options={reasoningEffortOptions}
                triggerClassName="profile-overview-input-surface rounded-xl border-gold/20 py-3 text-main hover:bg-white/[0.04] focus:border-gold/50 focus:ring-gold/30"
                contentClassName="profile-overview-dropdown-surface rounded-xl border border-gold/20 p-1.5 text-main shadow-2xl shadow-black/40 backdrop-blur-xl"
              />
              <p className="mt-2 text-xs text-sub">{t("config.reasoningDesc")}</p>
            </div>

            {/* Streaming */}
            <div className="flex items-center justify-between pb-2">
              <div>
                <div className="text-sm font-semibold text-main">{t("config.streaming")}</div>
                <div className="mt-1 text-xs text-sub">{t("config.streamingDesc")}</div>
              </div>
              <label className="relative inline-flex cursor-pointer items-center">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={streaming}
                  onChange={() => setConfig("streaming", !streaming)}
                />
                <div className="h-6 w-11 rounded-full border border-white/10 bg-white/10 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-transparent after:bg-white after:transition-all peer-checked:bg-gold peer-checked:after:translate-x-full peer-checked:after:border-transparent peer-focus:outline-none" />
              </label>
            </div>

            {/* Advanced Parameters */}
            <div className="pt-2">
              <button
                onClick={() => setAdvancedOpen(!advancedOpen)}
                className="flex items-center gap-2 text-sm font-medium text-sub transition-colors hover:text-main"
              >
                <ChevronRight className={`h-4 w-4 transition-transform ${advancedOpen ? "rotate-90" : ""}`} />
                {t("config.advancedParams")}
              </button>

              {advancedOpen && (
                <div className="mt-4 space-y-5 animate-in fade-in duration-200">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium text-main">{t("config.topP")}</label>
                      <span className="text-xs text-sub">{topP.toFixed(2)}</span>
                    </div>
                    <input type="range" min={0} max={1} step={0.01} value={topP} onChange={(e) => setConfig("topP", Number(e.target.value))} className="w-full accent-gold" />
                    <div className="flex justify-between text-[11px] text-sub/60"><span>{t("config.narrow")}</span><span>{t("config.full")}</span></div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium text-main">{t("config.frequencyPenalty")}</label>
                      <span className="text-xs text-sub">{frequencyPenalty.toFixed(2)}</span>
                    </div>
                    <input type="range" min={-2} max={2} step={0.01} value={frequencyPenalty} onChange={(e) => setConfig("frequencyPenalty", Number(e.target.value))} className="w-full accent-gold" />
                    <div className="flex justify-between text-[11px] text-sub/60"><span>{t("config.encourage")}</span><span>{t("config.penalize")}</span></div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium text-main">{t("config.presencePenalty")}</label>
                      <span className="text-xs text-sub">{presencePenalty.toFixed(2)}</span>
                    </div>
                    <input type="range" min={-2} max={2} step={0.01} value={presencePenalty} onChange={(e) => setConfig("presencePenalty", Number(e.target.value))} className="w-full accent-gold" />
                    <div className="flex justify-between text-[11px] text-sub/60"><span>{t("config.encourage")}</span><span>{t("config.penalize")}</span></div>
                  </div>

                  {isKimiSelected && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <label className="text-sm font-medium text-main">{t("config.repetitionPenalty")}</label>
                        <span className="text-xs text-sub">{repetitionPenalty.toFixed(2)}</span>
                      </div>
                      <input type="range" min={1} max={1.5} step={0.01} value={repetitionPenalty} onChange={(e) => setConfig("repetitionPenalty", Number(e.target.value))} className="w-full accent-gold" />
                      <p className="text-[11px] text-sub/60">{t("config.repetitionPenaltyDesc")}</p>
                    </div>
                  )}

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium text-main">{t("config.topK")}</label>
                      <span className="text-xs text-sub">{topK === 0 ? t("config.topKDisabled") : topK}</span>
                    </div>
                    <NumberInput min={0} max={500} step={1} value={topK} onChange={(value) => setConfig("topK", Math.max(0, Math.min(500, Number(value) || 0)))} className={themedNumberInputClass} />
                    <p className="text-[11px] text-sub/60">{t("config.topKDesc")}</p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium text-main">{t("config.minP")}</label>
                      <span className="text-xs text-sub">{minP === 0 ? t("config.minPDisabled") : minP.toFixed(2)}</span>
                    </div>
                    <input type="range" min={0} max={1} step={0.01} value={minP} onChange={(e) => setConfig("minP", Number(e.target.value))} className="w-full accent-gold" />
                    <div className="flex justify-between text-[11px] text-sub/60"><span>{t("config.disabled")}</span><span>{t("config.strict")}</span></div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <GlobalPrompts />
      </div>
    </div>
  );
}
