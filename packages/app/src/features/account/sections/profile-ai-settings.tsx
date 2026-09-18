import { savePreferredProvider } from "@/lib/provider-switch";
import { estimateReplyCost, formatCostEstimate } from "@yumina/shared";
import { useState, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import {
  Globe,
  Key,
  ChevronRight,
  Settings2,
  Loader2,
  Plug,
  Shuffle,
} from "lucide-react";
import {
  ProviderSwitchConfirmDialog,
  type ProviderSwitchCopy,
} from "@/components/provider-switch-confirm-dialog";
import { useUserProfileStore } from "@/stores/user-profile";
import { useConfigStore } from "@/stores/config";
import { useCreditStore } from "@/edition/slots.state";
import { ProfilePlanSummary } from "@/edition/slots";
import { useFeature } from "@/edition/edition";
import { useModelsStore } from "@/stores/models";
import { PLAY_MODELS, formatModelId, formatAvgCost } from "@yumina/shared";
import { ModelBrowser } from "@/features/chat/model-browser";
import { getPoolPercentages } from "@/lib/model-mix";
import {
  fetchApiKeyModelProfiles,
  resolveOfficialSelectedModel,
  resolvePrivateSelectedModel,
} from "@/lib/provider-model-selection";

const apiBase = import.meta.env.VITE_API_URL || "";

const TIER_DOT: Record<string, string> = {
  budget: "bg-emerald-400",
  standard: "bg-blue-400",
  premium: "bg-purple-400",
  ultra: "bg-amber-400",
};

/** Minimum profile data we need to render the active-key card. Sourced from
 *  GET /api/keys (the same listing the BYOK panel uses). Not stored — we
 *  fetch on demand when private mode is active. */
interface ActiveKey {
  id: string;
  label: string;
  provider: string;
}

// ─── Main Component ──────────────────────────────────────────────────

export function ProfileAiSettings() {
  const { t } = useTranslation("profile");
  const { t: tChat } = useTranslation("chat");
  const { t: tc } = useTranslation();
  const navigate = useNavigate();
  const { profile } = useUserProfileStore();
  // The subscription block (plan badge, Billing, wallet) is hosted; without
  // billing the card starts at the model row. Without official models there
  // is nothing to switch to, so the provider pill is a label, not a toggle.
  const hasBilling = useFeature("billing");
  const canSwitchProvider = useFeature("officialModels");

  const {
    plan,
    provider: storedProvider,
    loading: creditLoading, fetchCredits,
  } = useCreditStore();

  const { selectedModel, maxContext, streaming, mixMode, modelPool, setConfig } = useConfigStore();

  const [provider, setProvider] = useState<"official" | "private">(storedProvider);
  const [switching, setSwitching] = useState(false);
  const [pendingProvider, setPendingProvider] = useState<"official" | "private" | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [modelModalOpen, setModelModalOpen] = useState(false);

  // Active key (only loaded in private mode) — used to label the current
  // BYOK profile on the card. Null while loading; ActiveKey | "missing" once
  // resolved.
  const [activeKey, setActiveKey] = useState<ActiveKey | "missing" | null>(null);
  const activeKeyId = (profile?.preferences?.activeApiKeyId as string | undefined) ?? null;

  useEffect(() => { fetchCredits(); }, [fetchCredits]);
  useEffect(() => { setProvider(storedProvider); }, [storedProvider]);

  // Resolve the active key by listing /api/keys and picking the matching id.
  // Skipped in official mode; resets when the key id changes.
  useEffect(() => {
    if (provider !== "private" || !activeKeyId) {
      setActiveKey(provider === "private" ? "missing" : null);
      return;
    }
    let cancelled = false;
    setActiveKey(null);
    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/keys`, { credentials: "include" });
        if (!res.ok) { if (!cancelled) setActiveKey("missing"); return; }
        const { data } = await res.json();
        if (cancelled) return;
        const found = (data as ActiveKey[]).find((k) => k.id === activeKeyId);
        setActiveKey(found ?? "missing");
      } catch {
        if (!cancelled) setActiveKey("missing");
      }
    })();
    return () => { cancelled = true; };
  }, [provider, activeKeyId]);

  const syncSelectedModelForProvider = useCallback(async (value: "official" | "private") => {
    if (value === "official") {
      const nextModel = resolveOfficialSelectedModel(useConfigStore.getState().selectedModel, plan ?? "free");
      if (nextModel !== useConfigStore.getState().selectedModel) {
        setConfig("selectedModel", nextModel);
      }
      return;
    }

    const profiles = await fetchApiKeyModelProfiles(apiBase).catch(() => []);
    const nextModel = resolvePrivateSelectedModel(profiles, activeKeyId);
    if (nextModel && nextModel !== useConfigStore.getState().selectedModel) {
      setConfig("selectedModel", nextModel);
    }
  }, [activeKeyId, plan, setConfig]);

  const requestProviderToggle = useCallback(() => {
    if (switching) return;
    const value = provider === "official" ? "private" : "official";
    setSwitchError(null);
    setPendingProvider(value);
  }, [provider, switching]);

  const confirmProviderSwitch = useCallback(async () => {
    if (!pendingProvider || switching) return;
    const value = pendingProvider;
    setSwitching(true);
    setSwitchError(null);
    try {
      await savePreferredProvider(value);
      setProvider(value);
      await syncSelectedModelForProvider(value);
      // R1: the provider toggle itself now reads as the chosen source.
      setPendingProvider(null);
    } catch {
      setSwitchError(tChat("modelBrowser.switchFailed"));
    } finally {
      setSwitching(false);
    }
  }, [pendingProvider, switching, syncSelectedModelForProvider, tChat]);

  if (plan === null && creditLoading) {
    return (
      <section>
        <div className="mb-4 flex items-center gap-2">
          <div className="h-4 w-1 rounded-full bg-gold" />
          <h2 className="text-lg font-bold text-main">{t("tabs.aiSettings")}</h2>
        </div>
        <div className="h-48 rounded-2xl bg-white/[0.03] animate-pulse" />
      </section>
    );
  }

  const currentModel = PLAY_MODELS.find((m) => m.id === selectedModel);
  const currentDot = currentModel ? TIER_DOT[currentModel.tier] : null;
  const currentModelStats = useModelsStore((st) => st.models.find((m) => m.id === selectedModel)?.costStats);
  const currentModelAvgCost = currentModelStats
    ? t("aiProvider.avgCostPerChatRange", {
        typical: formatCostEstimate(estimateReplyCost(currentModelStats, null).typical),
        heavy: formatCostEstimate(estimateReplyCost(currentModelStats, null).heavy),
      })
    : currentModel?.avgCostMushiesByPeriod
    ? t("aiProvider.avgCostPerChatByPeriod", {
        peak: formatAvgCost(currentModel.avgCostMushiesByPeriod.peak),
        offPeak: formatAvgCost(currentModel.avgCostMushiesByPeriod.offPeak),
      })
    : currentModel
      ? t("aiProvider.avgCostPerChat", { amount: formatAvgCost(currentModel.avgCostMushies) })
      : null;

  // Context cap
  const isByok = provider === "private";
  const memoryCap = useCreditStore.getState().memoryCap;
  const contextCapped = !isByok && memoryCap !== null && memoryCap > 0;
  const contextMax = contextCapped ? memoryCap : 2000000;
  const providerSwitchCopy: ProviderSwitchCopy = {
    official: {
      title: tChat("modelBrowser.switchToOfficial"),
      description: tChat("modelBrowser.officialSwitchDesc"),
    },
    private: {
      title: tChat("modelBrowser.switchToPrivate"),
      description: tChat("modelBrowser.privateSwitchDesc"),
    },
    confirmLabel: tChat("modelBrowser.confirmSwitch"),
    cancelLabel: tChat("modelBrowser.cancel"),
  };

  return (
    <section>
      <div className="mb-4 flex items-center gap-2">
        <div className="h-4 w-1 rounded-full bg-gold" />
        <h2 className="text-lg font-bold text-main">{t("tabs.aiSettings")}</h2>
      </div>

      <div className="overflow-hidden rounded-2xl border border-white/[0.06]">
        {/* ── Plan Section (hosted: plan badge, Billing, wallet) ── */}
        {hasBilling && <ProfilePlanSummary />}

        {/* ── Model Selector ──
            The row always opens the model browser so the provider switch stays
            discoverable. In private mode, show the active key's profile + model. */}
        {provider === "official" ? (
          <button
            type="button"
            onClick={() => setModelModalOpen(true)}
            className="group flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-white/[0.02]"
          >
            {mixMode && modelPool.length >= 2 ? (
              <>
                <Shuffle className="h-4 w-4 shrink-0 text-primary/70" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-white/90">
                      {tc("modelMix.title", { ns: "chat" })} · {modelPool.length}
                    </span>
                    <div className="flex h-2 w-16 overflow-hidden rounded-full bg-white/[0.06]">
                      {getPoolPercentages(modelPool).map((entry, i) => {
                        const colors = ["bg-blue-500", "bg-violet-500", "bg-emerald-500", "bg-amber-500", "bg-rose-500"];
                        return (
                          <div
                            key={entry.modelId}
                            className={colors[i % colors.length]}
                            style={{ width: `${entry.pct}%` }}
                          />
                        );
                      })}
                    </div>
                  </div>
                  <span className="text-[11px] text-white/35">
                    {modelPool.map((e) => {
                      const m = PLAY_MODELS.find((pm) => pm.id === e.modelId);
                      return m?.name ?? formatModelId(e.modelId);
                    }).join(", ")}
                  </span>
                </div>
              </>
            ) : (
              <>
                {currentDot ? (
                  <div className={`h-2.5 w-2.5 shrink-0 rounded-full ${currentDot}`} />
                ) : (
                  <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-white/20" />
                )}
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium text-white/90">
                    {currentModel?.name ?? formatModelId(selectedModel)}
                  </span>
                  {currentModel && (
                    <span className="ml-2 text-[11px] text-white/35">
                      {t(currentModel.descKey as any)} · {currentModelAvgCost}
                    </span>
                  )}
                </div>
              </>
            )}
            <ChevronRight className="h-4 w-4 text-white/20 transition-colors group-hover:text-white/40" />
          </button>
        ) : (
          <PrivateActiveKeyRow
            activeKey={activeKey}
            selectedModel={selectedModel}
            onOpenModelBrowser={() => setModelModalOpen(true)}
          />
        )}

        {/* ── Controls Section ── */}
        <div className={`px-5 py-4 ${provider === "private" ? "bg-slate-400/[0.03]" : "bg-white/[0.01]"}`}>
          <div className="flex flex-col gap-2 md:flex-row md:items-center">
            {/* Memory */}
            <div className="flex flex-1 flex-col gap-2 rounded-lg bg-white/[0.02] px-3 py-2.5 sm:flex-row sm:items-center sm:gap-2.5">
              <div className="flex flex-col">
                <span className="text-xs font-medium text-white/60">{t("config.memory", { defaultValue: "Memory" })}</span>
                <span className="text-[11px] text-white/30">{t("config.memoryDesc", { defaultValue: "How many tokens the AI remembers (higher = more credits)" })}</span>
              </div>
              <div className="flex items-center gap-2 sm:ml-auto">
                <input
                  type="text"
                  inputMode="numeric"
                  value={maxContext.toLocaleString()}
                  placeholder="64,000"
                  onChange={(e) => {
                    const raw = e.target.value.replace(/,/g, "");
                    const num = parseInt(raw, 10);
                    if (!isNaN(num)) {
                      const clamped = Math.max(4096, Math.min(contextMax, num));
                      setConfig("maxContext", clamped);
                    }
                  }}
                  className={`${maxContext >= 1_000_000 ? "w-[6.5rem]" : maxContext >= 100_000 ? "w-[5.5rem]" : "w-[5rem]"} rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 py-1 text-right text-xs font-semibold tabular-nums text-white/70 placeholder:text-white/20 focus:border-gold/30 focus:outline-none`}
                />
                {maxContext !== 64000 && (
                  <button
                    type="button"
                    onClick={() => setConfig("maxContext", Math.min(64000, contextMax))}
                    className="shrink-0 rounded-md bg-gold/15 px-2 py-0.5 text-[10px] font-bold text-gold/80 transition-colors hover:bg-gold/25 hover:text-gold"
                  >
                    {t("summary.memoryRecommended", { value: "64K" })}
                  </button>
                )}
              </div>
            </div>

            <div className="hidden md:block mx-3 h-8 w-px bg-white/[0.04]" />

            {/* Streaming */}
            <div className="flex items-center gap-3 rounded-lg bg-white/[0.02] px-3 py-2.5 md:shrink-0">
              <div className="flex flex-col">
                <span className="text-xs font-medium text-white/60">{t("config.streaming")}</span>
                <span className="text-[11px] text-white/30">{t("config.streamingBypass", { defaultValue: "Disable to bypass filters" })}</span>
              </div>
              <label className="relative inline-flex cursor-pointer items-center">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={streaming}
                  onChange={() => setConfig("streaming", !streaming)}
                />
                <div className="h-5 w-9 rounded-full border border-white/10 bg-white/10 after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:border after:border-transparent after:bg-white after:transition-all peer-checked:bg-gold peer-checked:after:translate-x-full peer-checked:after:border-transparent peer-focus:outline-none" />
              </label>
            </div>
          </div>

          {/* Provider + Advanced */}
          <div className="mt-3 flex items-center justify-between">
            <button
              type="button"
              onClick={canSwitchProvider ? requestProviderToggle : undefined}
              disabled={switching}
              aria-disabled={!canSwitchProvider}
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-medium transition-all disabled:opacity-60 ${
                canSwitchProvider ? "hover:brightness-110" : "cursor-default"
              } ${
                provider === "official"
                  ? "border-gold/20 bg-gold/5 text-white/45"
                  : "border-slate-400/20 bg-slate-400/5 text-white/45"
              }`}
            >
              {switching ? (
                <Loader2 className="h-3 w-3 animate-spin text-white/40" />
              ) : provider === "official" ? (
                <Globe className="h-3 w-3 text-gold/60" />
              ) : (
                <Key className="h-3 w-3 text-slate-300/60" />
              )}
              <span>{provider === "official" ? t("aiProvider.yuminaApi") : t("aiProvider.privateKey")}</span>
            </button>

            <button
              type="button"
              onClick={() => navigate({ to: "/app/settings", hash: "ai-config" })}
              className="flex items-center gap-1 text-[10px] font-medium text-white/30 transition-colors hover:text-white/50"
            >
              <Settings2 className="h-3 w-3" />
              <span>{t("summary.advanced")}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Model picker modal */}
      <ModelBrowser
        open={modelModalOpen}
        onClose={() => setModelModalOpen(false)}
        selectedModel={selectedModel}
        onSelect={(id) => {
          setConfig("selectedModel", id);
          useModelsStore.getState().addToRecent(id);
          setModelModalOpen(false);
        }}
      />

      <ProviderSwitchConfirmDialog
        provider={pendingProvider}
        copy={providerSwitchCopy}
        busy={switching}
        error={switchError}
        onConfirm={confirmProviderSwitch}
        onCancel={() => {
          if (switching) return;
          setPendingProvider(null);
          setSwitchError(null);
        }}
      />
    </section>
  );
}

// ─── Private Mode: active key + current model row ────────────────────

/** Replaces the official-model summary on the simplified AI Settings card when
 *  the user is in private (BYOK) mode. The row still opens ModelBrowser so the
 *  user can change models, switch providers, or continue to BYOK settings. */
function PrivateActiveKeyRow({
  activeKey,
  selectedModel,
  onOpenModelBrowser,
}: {
  activeKey: ActiveKey | "missing" | null;
  selectedModel: string;
  onOpenModelBrowser: () => void;
}) {
  const { t } = useTranslation("profile");

  // Loading skeleton — same height as the resolved row to avoid layout jank.
  if (activeKey === null) {
    return (
      <div className="flex w-full items-center gap-3 px-5 py-3.5">
        <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-white/10 animate-pulse" />
        <div className="flex-1 min-w-0">
          <div className="h-3.5 w-32 rounded bg-white/[0.06] animate-pulse" />
          <div className="mt-1.5 h-2.5 w-48 rounded bg-white/[0.04] animate-pulse" />
        </div>
      </div>
    );
  }

  // Keep the provider switch discoverable even when no private key is set.
  if (activeKey === "missing") {
    return (
      <button
        type="button"
        onClick={onOpenModelBrowser}
        className="group flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-slate-400/[0.04]"
      >
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-400/30 bg-slate-400/10">
          <Plug className="h-3.5 w-3.5 text-slate-300" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-white/90">
            {t("summary.privateNoActiveProfile")}
          </div>
          <div className="text-[11px] text-white/35">
            {t("summary.privateNoActiveProfileDesc")}
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-white/20 transition-colors group-hover:text-white/40" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpenModelBrowser}
      className="group flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-slate-400/[0.04]"
    >
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-400/30 bg-slate-400/10">
        <Key className="h-3.5 w-3.5 text-slate-300" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-300/60">
            {t("summary.privateActiveProfile")}
          </span>
          <span className="text-sm font-medium text-white/90 truncate">{activeKey.label}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-white/40">
          <span className="text-white/30">{t("summary.privateCurrentModel")}:</span>
          <span className="font-mono text-white/60 truncate">
            {selectedModel || t("summary.privateNoModel")}
          </span>
        </div>
      </div>
      <ChevronRight className="h-4 w-4 text-white/20 transition-colors group-hover:text-white/40" />
    </button>
  );
}
