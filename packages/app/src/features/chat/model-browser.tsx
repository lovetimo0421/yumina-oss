import { savePreferredProvider } from "@/lib/provider-switch";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useNavigate } from "@tanstack/react-router";
import { X, Search, Loader2, Clock, Star, Lock, Unlock, Key, Sparkles, Layers, Shuffle, Plus, ArrowLeft, ChevronDown, Info, Check, Globe, ArrowDownWideNarrow } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTransientFlag } from "@/hooks/use-transient-flag";
import {
  ProviderSwitchConfirmDialog,
  ProviderSwitchControl,
  type ProviderSwitchCopy,
} from "@/components/provider-switch-confirm-dialog";
import { resolveModelSourceKey, useModelsStore, type ModelInfo } from "@/stores/models";
import { useConfigStore } from "@/stores/config";
import { useCreditStore } from "@/edition/slots.state";
import { useFeature } from "@/edition/edition";
import {
  DeepSeekPricingInfo,
  type DeepSeekPricingCopy,
} from "./deepseek-pricing-info";
import { useUserProfileStore } from "@/stores/user-profile";
import {
  PLAY_MODELS, STUDIO_MODELS, STUDIO_MODEL_IDS, STUDIO_RECOMMENDED_MODEL, MODEL_POPULARITY_SEED, type ModelPopularitySnapshot,
  PLAN_HIERARCHY, MAX_PINNED_MODELS, formatAvgCost, formatModelId, type CostTier, type StudioModel,
} from "@yumina/shared";
import {
  fetchApiKeyModelProfiles,
  resolveOfficialSelectedModel,
  resolvePrivateSelectedModel,
} from "@/lib/provider-model-selection";
import { getPoolPercentages, MAX_POOL_SIZE } from "@/lib/model-mix";
import { estimateReplyCost, formatCostEstimate } from "@yumina/shared";
import { CostEstimateInfo } from "./cost-estimate-info";
import { orderOfficialModels, type OfficialModelSort } from "@/lib/official-model-order";

const apiBase = import.meta.env.VITE_API_URL || "";

const STUDIO_META_MAP = new Map<string, StudioModel>(STUDIO_MODELS.map((m) => [m.id, m]));

interface ModelBrowserProps {
  open: boolean;
  onClose: () => void;
  onSelect: (modelId: string) => void;
  selectedModel: string;
  studioMode?: boolean;
  /** Use the current BYOK configuration without offering provider or mix changes. */
  privateOnly?: boolean;
  /** Select a secondary model without changing the active provider or mix mode. */
  selectionOnly?: boolean;
  onMixMode?: () => void;
  /**
   * Tokens the model will read for the next reply in the open chat (the last
   * reply's total token count is a good proxy). Scales the measured estimate to
   * this chat; omit outside a chat to show the fleet-wide range.
   */
  contextTokens?: number | null;
}

const TIERS: CostTier[] = ["budget", "standard", "premium", "ultra"];

const TIER_META: Record<CostTier, { color: string; dot: string; bg: string; border: string; glow: string; costWarning?: boolean }> = {
  budget:   { color: "text-emerald-400", dot: "bg-emerald-400", bg: "bg-emerald-400/10", border: "border-emerald-400/25", glow: "shadow-emerald-500/20" },
  standard: { color: "text-blue-400",    dot: "bg-blue-400",    bg: "bg-blue-400/10",    border: "border-blue-400/25",    glow: "shadow-blue-500/20" },
  premium:  { color: "text-purple-400",  dot: "bg-purple-400",  bg: "bg-purple-400/10",  border: "border-purple-400/25",  glow: "shadow-purple-500/20", costWarning: true },
  ultra:    { color: "text-amber-400",   dot: "bg-amber-400",   bg: "bg-amber-400/10",   border: "border-amber-400/25",   glow: "shadow-amber-500/20", costWarning: true },
};

const PROVIDER_COLORS: Record<string, string> = {
  Anthropic: "text-orange-400",
  OpenAI: "text-green-400",
  Google: "text-blue-400",
  Meta: "text-sky-400",
  Mistral: "text-violet-400",
  DeepSeek: "text-cyan-400",
  Cohere: "text-pink-400",
  xAI: "text-amber-400",
  Custom: "text-amber-300",
};

function canAccessPlan(minPlan: string | undefined, userPlan: string): boolean {
  if (!minPlan) return true;
  return (
    PLAN_HIERARCHY.indexOf(userPlan as (typeof PLAN_HIERARCHY)[number]) >=
    PLAN_HIERARCHY.indexOf(minPlan as (typeof PLAN_HIERARCHY)[number])
  );
}

function useDeepSeekPricingCopy(): DeepSeekPricingCopy {
  const { t } = useTranslation("chat");
  return {
    triggerLabel: t("modelBrowser.deepSeekPricing.triggerLabel"),
    title: t("modelBrowser.deepSeekPricing.title"),
    body: t("modelBrowser.deepSeekPricing.body"),
  };
}

export function ModelBrowser({
  contextTokens = null,
  open,
  onClose,
  onSelect,
  selectedModel,
  studioMode,
  privateOnly: privateOnlyProp = false,
  selectionOnly = false,
}: ModelBrowserProps) {
  const { models, recentlyUsed, loading, fetchModels } = useModelsStore();
  // Stars live only in the BYOK picker, so it reads the BYOK-scoped list. The
  // official list is a separate universe: its ids can never render here.
  const pinnedPrivateModels = useConfigStore((s) => s.pinnedPrivateModels);
  const pinModel = useConfigStore((s) => s.pinModel);
  const unpinModel = useConfigStore((s) => s.unpinModel);
  const setConfig = useConfigStore((s) => s.setConfig);
  const userPlan = useCreditStore((s) => s.plan) ?? "free";
  const { t } = useTranslation(["chat", "common", "profile"]);
  const navigate = useNavigate();
  // Without platform models (open-source build) the BYOK picker is the whole
  // browser: no provider switch, no official/studio views, no plan locks or
  // trial counters. An empty key list shows the "add a key in Settings" state.
  const officialModelsEnabled = useFeature("officialModels");
  const privateOnly = privateOnlyProp || !officialModelsEnabled;

  const [confirmProvider, setConfirmProvider] = useState<"official" | "private" | null>(null);
  const [switching, setSwitching] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [showMix, setShowMix] = useState(false);

  const provider = useCreditStore((s) => s.provider);
  const creditLastFetched = useCreditStore((s) => s.lastFetched);
  const { profile } = useUserProfileStore();
  const expectedSourceKey = resolveModelSourceKey(
    provider,
    creditLastFetched,
    profile?.preferences ?? null,
  );
  const lastSourceKey = useModelsStore((s) => s.lastSourceKey);
  const sourceMatches = expectedSourceKey === lastSourceKey;
  const activeModels = sourceMatches && (!privateOnly || expectedSourceKey.startsWith("private:")) ? models : [];
  const showLoadingState = loading && activeModels.length === 0;
  const isOfficialMode = !expectedSourceKey.startsWith("private:");
  const activeKeyId = (profile?.preferences?.activeApiKeyId as string | undefined) ?? null;

  useEffect(() => {
    if (open && (!privateOnly || !isOfficialMode)) fetchModels();
  }, [open, expectedSourceKey, fetchModels, privateOnly, isOfficialMode]);

  useEffect(() => {
    if (!open) {
      setConfirmProvider(null);
      setSwitchError(null);
      setSwitching(false);
      setShowMix(false);
    }
  }, [open]);

  useEffect(() => {
    setConfirmProvider(null);
    setSwitchError(null);
  }, [provider]);

  // Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (confirmProvider && !switching) {
        setConfirmProvider(null);
        setSwitchError(null);
        return;
      }
      if (!confirmProvider) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [confirmProvider, open, onClose, switching]);

  const requestProvider = useCallback((value: "official" | "private") => {
    if (privateOnly || value === provider || switching) return;
    setSwitchError(null);
    setConfirmProvider(value);
  }, [provider, switching, privateOnly]);

  const confirmProviderSwitch = useCallback(async () => {
    if (!confirmProvider || switching) return;
    setSwitching(true);
    setSwitchError(null);
    try {
      await savePreferredProvider(confirmProvider);
      if (confirmProvider === "official") {
        const nextModel = resolveOfficialSelectedModel(useConfigStore.getState().selectedModel, userPlan);
        if (nextModel !== useConfigStore.getState().selectedModel) setConfig("selectedModel", nextModel);
      } else {
        const profiles = await fetchApiKeyModelProfiles(apiBase).catch(() => []);
        const nextModel = resolvePrivateSelectedModel(profiles, activeKeyId);
        if (nextModel && nextModel !== useConfigStore.getState().selectedModel) setConfig("selectedModel", nextModel);
      }
      // No pill: the provider control now reads the new value, and the model
      // list below it re-renders around the switch.
      setConfirmProvider(null);
    } catch {
      setSwitchError(t("modelBrowser.switchFailed"));
    } finally {
      setSwitching(false);
    }
  }, [confirmProvider, switching, userPlan, activeKeyId, setConfig, t]);

  const handleSelect = (modelId: string) => {
    onSelect(modelId);
    useModelsStore.getState().addToRecent(modelId);
    onClose();
  };

  if (!open) return null;

  const usageNote = t("tokenUsageHint");
  const providerSwitchCopy: ProviderSwitchCopy = {
    official: {
      title: t("modelBrowser.switchToOfficial"),
      description: t("modelBrowser.officialSwitchDesc"),
    },
    private: {
      title: t("modelBrowser.switchToPrivate"),
      description: t("modelBrowser.privateSwitchDesc"),
    },
    confirmLabel: t("modelBrowser.confirmSwitch"),
    cancelLabel: t("modelBrowser.cancel"),
  };

  const providerSwitch = (selectionOnly || privateOnly) ? null : (
    <ProviderSwitchControl
      provider={provider}
      disabled={switching}
      onRequest={requestProvider}
      officialLabel={t("modelBrowser.sourceOfficial")}
      privateLabel={t("modelBrowser.sourcePrivate")}
    />
  );

  const compactProviderSwitch = (selectionOnly || privateOnly) ? null : (
    <div className="relative ml-auto min-w-0 max-w-[125px] shrink-0">
    <Globe aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-white/55 max-[390px]:hidden" />
    <select aria-label={t("modelBrowser.sourceLabel")} value={provider} disabled={switching}
      onChange={e => requestProvider(e.target.value as "official" | "private")}
      className="h-8 w-full appearance-none rounded-[9px] border border-white/10 bg-[#242228] pl-7 pr-6 text-[11px] text-white/65 max-[390px]:pl-2 [@media(pointer:coarse)]:h-11">
      <option value="official">{t("modelBrowser.sourceOfficial")}</option>
      <option value="private">{t("modelBrowser.sourcePrivate")}</option>
    </select>
    <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-white/55" />
    </div>
  );
  const expandedOfficial = isOfficialMode && !studioMode && !privateOnly && !showMix;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[1200] flex items-center justify-center" onClick={onClose}>
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      <div
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("modelBrowser.title")}
        className={cn("relative z-10 flex flex-col overflow-hidden border border-white/[0.08] shadow-2xl shadow-black/40 animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200", expandedOfficial
          ? "h-[min(800px,calc(100dvh-2rem))] w-[min(540px,calc(100vw-1rem))] rounded-[22px] bg-[#1b1a1e]"
          : "w-[min(440px,calc(100vw-2rem))] max-h-[min(600px,calc(100dvh-4rem))] rounded-2xl bg-[#1a1b1e]")}
      >
        {showMix && !privateOnly && !selectionOnly ? (
          <MixConfigView
            availableModels={activeModels}
            onBack={() => setShowMix(false)}
            onClose={onClose}
          />
        ) : isOfficialMode && !studioMode && !privateOnly ? (
          <OfficialView
            selectedModel={selectedModel}
            userPlan={userPlan}
            contextTokens={contextTokens}
            onSelect={handleSelect}
            onClose={onClose}
            providerSwitch={compactProviderSwitch}
            onMixMode={selectionOnly ? undefined : () => {
              const store = useConfigStore.getState();
              if (store.modelPool.length === 0) store.addToPool(selectedModel);
              setShowMix(true);
            }}
          />
        ) : isOfficialMode && studioMode && !privateOnly ? (
          <StudioView
            models={activeModels}
            selectedModel={selectedModel}
            loading={showLoadingState}
            onSelect={handleSelect}
            onClose={onClose}
            providerSwitch={providerSwitch}
            usageNote={usageNote}
          />
        ) : (
          <PrivateView
            models={activeModels}
            selectedModel={selectedModel}
            pinnedModels={pinnedPrivateModels}
            recentlyUsed={recentlyUsed}
            loading={showLoadingState && !(privateOnly && isOfficialMode)}
            hasKey={!!activeKeyId && !(privateOnly && isOfficialMode)}
            setupRequired={privateOnly && isOfficialMode}
            onSelect={handleSelect}
            onClose={onClose}
            onPin={(id) => pinModel(id, "private")}
            onUnpin={(id) => unpinModel(id, "private")}
            onGoToSettings={() => { onClose(); navigate({ to: "/app/settings", hash: "ai-config" }); }}
            providerSwitch={providerSwitch}
            usageNote={usageNote}
            onMixMode={(selectionOnly || privateOnly) ? undefined : () => {
              const store = useConfigStore.getState();
              if (store.modelPool.length === 0) store.addToPool(selectedModel);
              setShowMix(true);
            }}
          />
        )}
      </div>
      </div>

      {!privateOnly && !selectionOnly && <ProviderSwitchConfirmDialog
        provider={confirmProvider}
        copy={providerSwitchCopy}
        busy={switching}
        error={switchError}
        onConfirm={confirmProviderSwitch}
        onCancel={() => {
          if (switching) return;
          setConfirmProvider(null);
          setSwitchError(null);
        }}
      />}
    </>,
    document.body,
  );
}

/* ── Mix Pill (shared between OfficialView / PrivateView) ──
 * MIRROR: Keep in sync with SandboxMixPill + SandboxMixConfig in
 * packages/app/sandbox/chat/model-picker-modal.tsx — the sandbox
 * iframe has its own copy of this UI since it can't share React tree. */

function MixPill({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation("chat");
  const mixMode = useConfigStore((s) => s.mixMode);
  const modelPool = useConfigStore((s) => s.modelPool);
  const isActive = mixMode && modelPool.length >= 2;
  const percentages = useMemo(() => (isActive ? getPoolPercentages(modelPool) : []), [isActive, modelPool]);

  if (isActive) {
    return (
      <button
        onClick={onClick}
        className="flex shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/[0.08] px-2.5 py-1 text-[10px] font-medium text-primary transition-all hover:border-primary/50 hover:bg-primary/[0.14]"
      >
        <Shuffle className="h-3 w-3" />
        <div className="flex h-1.5 w-8 overflow-hidden rounded-full bg-white/[0.08]">
          {percentages.map((entry, i) => (
            <div
              key={entry.modelId}
              className={POOL_COLORS[i % POOL_COLORS.length].bg}
              style={{ width: `${entry.pct}%` }}
            />
          ))}
        </div>
        <span>{modelPool.length}</span>
      </button>
    );
  }

  return (
    <button
      onClick={onClick}
      className="flex shrink-0 items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 py-1 text-[10px] font-medium text-white/50 transition-all hover:border-primary/30 hover:bg-primary/[0.08] hover:text-primary"
    >
      <Shuffle className="h-3 w-3" />
      {t("modelMix.title")}
    </button>
  );
}

/* ── Mix Config View ── */

const POOL_COLORS = [
  { bg: "bg-blue-500", dot: "bg-blue-400" },
  { bg: "bg-violet-500", dot: "bg-violet-400" },
  { bg: "bg-emerald-500", dot: "bg-emerald-400" },
  { bg: "bg-amber-500", dot: "bg-amber-400" },
  { bg: "bg-rose-500", dot: "bg-rose-400" },
];

function MixConfigView({
  availableModels,
  onBack,
  onClose,
}: {
  availableModels: ModelInfo[];
  onBack: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("chat");
  const [addQuery, setAddQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  const mixMode = useConfigStore((s) => s.mixMode);
  const modelPool = useConfigStore((s) => s.modelPool);
  const addToPool = useConfigStore((s) => s.addToPool);
  const removeFromPool = useConfigStore((s) => s.removeFromPool);
  const setPoolWeight = useConfigStore((s) => s.setPoolWeight);
  const togglePoolLock = useConfigStore((s) => s.togglePoolLock);
  const setConfig = useConfigStore((s) => s.setConfig);
  const userPlan = useCreditStore((s) => s.plan) ?? "free";
  const canActivate = modelPool.length >= 2;
  const canLockWeights = modelPool.length > 2;

  const poolModelIds = useMemo(() => new Set(modelPool.map((e) => e.modelId)), [modelPool]);
  const percentages = useMemo(() => getPoolPercentages(modelPool), [modelPool]);

  const addResults = useMemo(() => {
    if (!addQuery) return [];
    const q = addQuery.toLowerCase();
    return availableModels
      .filter((m) => !poolModelIds.has(m.id))
      .filter(
        (m) =>
          m.id.toLowerCase().includes(q) ||
          m.name.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q),
      )
      .slice(0, 5);
  }, [addQuery, availableModels, poolModelIds]);

  const resolveInfo = (id: string): ModelInfo =>
    availableModels.find((m) => m.id === id) ?? {
      id,
      name: formatModelId(id),
      provider: id.split("/")[0] ?? "",
      contextLength: 0,
      isCurated: false,
    };

  const handleToggle = () => {
    if (mixMode) {
      setConfig("mixMode", false);
    } else if (canActivate) {
      setConfig("mixMode", true);
    }
  };

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-5 pb-1">
        <div className="flex items-center gap-2.5">
          <button
            onClick={onBack}
            className="flex h-8 w-8 items-center justify-center rounded-xl bg-white/[0.04] text-white/40 transition-colors hover:bg-white/[0.08] hover:text-white/70"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <h2 className="text-sm font-bold text-white">{t("modelMix.title")}</h2>
            <p className="text-[11px] text-white/40">
              {modelPool.length}/{MAX_POOL_SIZE}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <CostEstimateInfo />
          <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-white/30 transition-colors hover:bg-white/5 hover:text-white/60">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <p className="border-y border-white/[0.06] px-5 py-2 text-[11px] leading-snug text-white/45">
        {t("modelMix.description")}
      </p>

      {/* Weight distribution bar */}
      {modelPool.length > 0 && (
        <div className="px-5 pt-3 pb-1">
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-white/[0.04]">
            {percentages.map((entry, i) => (
              <div
                key={entry.modelId}
                className={cn(
                  "transition-all duration-300 ease-out",
                  POOL_COLORS[i % POOL_COLORS.length].bg,
                )}
                style={{ width: `${entry.pct}%` }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Pool models */}
      <div className="flex-1 overflow-y-auto px-4 py-2">
        <div className="space-y-1">
          {modelPool.map((entry, i) => {
            const info = resolveInfo(entry.modelId);
            const pct = percentages.find((p) => p.modelId === entry.modelId)?.pct ?? 0;
            const color = POOL_COLORS[i % POOL_COLORS.length];
            const locked = canLockWeights && !!entry.locked;
            const lockLabel = locked
              ? t("modelMix.unlockWeight" as any)
              : t("modelMix.lockWeight" as any);

            return (
              <div
                key={entry.modelId}
                className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-3 transition-all hover:border-white/10"
              >
                <div className="flex items-center gap-2.5 mb-1.5">
                  <div className={cn("h-2.5 w-2.5 shrink-0 rounded-full", color.dot)} />
                  <p className="min-w-0 flex-1 truncate text-sm font-medium text-white/80">{info.name}</p>
                  <span className="text-xs font-semibold tabular-nums text-white/50">{pct}%</span>
                  {canLockWeights && (
                    <button
                      onClick={() => togglePoolLock(entry.modelId)}
                      title={lockLabel}
                      aria-label={lockLabel}
                      className={cn(
                        "flex h-6 w-6 items-center justify-center rounded-lg transition-all",
                        locked
                          ? "bg-primary/15 text-primary hover:bg-primary/25"
                          : "text-white/25 hover:bg-white/[0.06] hover:text-white/60",
                      )}
                    >
                      {locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />}
                    </button>
                  )}
                  <button
                    onClick={() => removeFromPool(entry.modelId)}
                    className="flex h-6 w-6 items-center justify-center rounded-lg text-white/20 transition-all hover:bg-red-500/10 hover:text-red-400"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={pct}
                  onChange={(e) => setPoolWeight(entry.modelId, Number(e.target.value))}
                  className="w-full h-1.5 appearance-none rounded-full bg-white/[0.06] outline-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white/80 [&::-webkit-slider-thumb]:shadow-sm [&::-webkit-slider-thumb]:transition-all [&::-webkit-slider-thumb]:hover:bg-white [&::-webkit-slider-thumb]:hover:scale-110 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-white/80 [&::-moz-range-thumb]:border-0"
                />
              </div>
            );
          })}
        </div>

        {/* Add model search */}
        {modelPool.length < MAX_POOL_SIZE && (
          <div className="mt-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/25" />
              <input
                ref={searchRef}
                type="text"
                value={addQuery}
                onChange={(e) => setAddQuery(e.target.value)}
                placeholder={t("modelMix.addPlaceholder")}
                className="w-full rounded-xl border border-white/[0.06] bg-white/[0.02] py-2.5 pl-9 pr-3 text-xs text-white placeholder:text-white/20 focus:border-white/15 focus:outline-none"
              />
            </div>
            {addResults.length > 0 && (
              <div className="mt-1.5 space-y-0.5">
                {addResults.map((m) => {
                  const locked = !canAccessPlan(m.minPlan, userPlan);
                  return (
                    <button
                      key={m.id}
                      onClick={() => {
                        if (!locked) {
                          addToPool(m.id);
                          setAddQuery("");
                        }
                      }}
                      disabled={locked}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-all",
                        locked ? "cursor-not-allowed opacity-30" : "hover:bg-white/[0.04]",
                      )}
                    >
                      <Plus className="h-3.5 w-3.5 shrink-0 text-primary/60" />
                      <span className="flex-1 truncate text-xs font-medium text-white/70">{m.name}</span>
                      <span className="shrink-0 text-[10px] text-white/25">{m.provider}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Toggle + Reset */}
      <div className="border-t border-white/[0.06] px-5 py-3">
        <button
          onClick={handleToggle}
          disabled={!canActivate && !mixMode}
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-xs font-semibold transition-all",
            mixMode
              ? "border border-white/[0.08] bg-white/[0.04] text-white/60 hover:bg-white/[0.08]"
              : canActivate
                ? "bg-primary text-white hover:bg-primary/90"
                : "bg-white/[0.04] text-white/20 cursor-not-allowed",
          )}
        >
          {mixMode ? t("modelMix.deactivate" as any) : t("modelMix.activate" as any)}
        </button>
        {!canActivate && !mixMode && (
          <p className="mt-1.5 text-center text-[10px] text-white/25">
            {t("modelMix.needTwo" as any)}
          </p>
        )}
        <button
          onClick={() => useConfigStore.getState().resetPool()}
          className="mt-2 w-full text-center text-[10px] text-white/25 transition-colors hover:text-primary/60"
        >
          {t("modelBrowser.resetToDefault" as any)}
        </button>
      </div>
    </>
  );
}

/* ── Official picker (tier tabs, warm cards) ── */

function OfficialView({
  selectedModel, userPlan, onSelect, onClose, providerSwitch, onMixMode, contextTokens = null,
}: {
  selectedModel: string;
  userPlan: string;
  contextTokens?: number | null;
  onSelect: (id: string) => void;
  onClose: () => void;
  providerSwitch: React.ReactNode;
  onMixMode?: () => void;
}) {
  const { t } = useTranslation(["chat", "common", "profile"]);
  const mixMode = useConfigStore(s => s.mixMode);
  const modelPool = useConfigStore(s => s.modelPool);
  const grokTrialRemaining = useCreditStore(s => s.grokTrialRemaining);
  const storeModels = useModelsStore(s => s.models);
  const statsById = useMemo(() => new Map(storeModels.map(x => [x.id, x.costStats])), [storeModels]);
  const pinnedModels = useConfigStore(s => s.pinnedModels);
  const pinModel = useConfigStore(s => s.pinModel);
  const unpinModel = useConfigStore(s => s.unpinModel);
  const recentlyUsed = useModelsStore(s => s.recentlyUsed);
  const deepSeekPricingCopy = useDeepSeekPricingCopy();
  const isMixActive = !!onMixMode && mixMode && modelPool.length >= 2;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<OfficialModelSort>("popular");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [pinLimitNonce, setPinLimitNonce] = useState(0);
  const pinLimitHit = useTransientFlag(pinLimitNonce, 2500);
  const [activeTier, setActiveTier] = useState<CostTier | "all">(() => PLAY_MODELS.find(m => m.id === selectedModel)?.tier ?? "budget");
  const [popularity, setPopularity] = useState<ModelPopularitySnapshot>(MODEL_POPULARITY_SEED);
  const [info, setInfo] = useState<"cost" | "popularity" | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const infoRef = useRef<HTMLDivElement>(null);
  const infoTrigger = useRef<HTMLButtonElement | null>(null);
  const closeInfo = useCallback(() => { setInfo(null); infoTrigger.current?.focus(); }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${apiBase}/api/models/popularity`, { credentials: "include", signal: controller.signal })
      .then(r => r.ok ? r.json() : null)
      .then(result => {
        const next = result?.data as ModelPopularitySnapshot | undefined;
        if (next?.scores && typeof next.externalReportingDate === "string" && Number.isFinite(Date.parse(next.externalReportingDate)) && [next.updatedAt,next.windowStart,next.windowEnd].every(d => typeof d === "string" && Number.isFinite(Date.parse(d))) && Date.parse(next.windowStart) < Date.parse(next.windowEnd) && Number.isInteger(next.sourceApps) && next.sourceApps >= 10 && PLAY_MODELS.every(m => Number.isFinite(next.scores[m.id]) && next.scores[m.id]! >= 0)) setPopularity(next);
      }).catch(() => { /* Keep the reviewed dated snapshot. */ });
    return () => controller.abort();
  }, []);

  useEffect(() => { listRef.current?.scrollTo({ top: 0 }); }, [query, sort, activeTier, favoritesOnly]);
  useEffect(() => {
    if (!info) return;
    infoRef.current?.focus({ preventScroll: true });
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeInfo(); }
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [info, closeInfo]);

  const showInfo = (kind: "cost" | "popularity", event: React.MouseEvent<HTMLButtonElement>) => {
    infoTrigger.current = event.currentTarget;
    setInfo(current => current === kind ? null : kind);
  };
  const getDesc = (m: (typeof PLAY_MODELS)[number]) => t(`aiProvider.models.${m.descKey?.split(".").pop()}` as any, { ns: "profile", defaultValue: "" }) || formatModelId(m.id);
  const models = orderOfficialModels(PLAY_MODELS, {
    tier: activeTier, query, sort, pinned: pinnedModels, favoritesOnly,
    recent: recentlyUsed, description: getDesc, popularityScores: popularity.scores,
  });
  const cost = (m: (typeof PLAY_MODELS)[number]) => {
    if (m.avgCostMushies === 0) return t("modelBrowser.free");
    if (m.avgCostMushiesByPeriod) {
      const { peak, offPeak } = m.avgCostMushiesByPeriod;
      return `~${formatAvgCost(Math.min(peak, offPeak))}–${formatAvgCost(Math.max(peak, offPeak))}`;
    }
    return `~${formatAvgCost(m.avgCostMushies)}`;
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-[17px] pb-3 pt-4 max-[390px]:gap-1.5 max-[390px]:px-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[11px] bg-gold/10 text-gold max-[390px]:h-7 max-[390px]:w-6"><Sparkles aria-hidden="true" className="h-4 w-4" /></span>
        <h2 className="mr-auto min-w-0 truncate text-base font-semibold text-white max-[390px]:text-sm">{t("modelBrowser.compactTitle")}</h2>
        {providerSwitch}
        {onMixMode && <button type="button" onClick={onMixMode} aria-label={t("modelMix.title")} title={t("modelMix.title")} className={cn("flex h-8 w-7 shrink-0 items-center justify-center rounded-lg text-white/55 hover:bg-white/5 hover:text-white [@media(pointer:coarse)]:h-11", isMixActive && "bg-gold/10 text-gold")}><Shuffle className="h-4 w-4" /></button>}
        <button type="button" onClick={onClose} aria-label={t("modelBrowser.closePicker")} className="flex h-8 w-7 shrink-0 items-center justify-center rounded-lg text-white/55 hover:bg-white/5 hover:text-white [@media(pointer:coarse)]:h-11"><X className="h-4 w-4" /></button>
      </div>
      {isMixActive && onMixMode && <button type="button" onClick={onMixMode} className="flex shrink-0 items-center gap-2 px-4 pb-2 text-xs text-gold"><Shuffle className="h-3.5 w-3.5" />{t("modelBrowser.mixPool")} · {t("modelBrowser.mixPoolCount", {count:modelPool.length})}<ChevronDown className="ml-auto h-3.5 w-3.5 -rotate-90" /></button>}
      <div className="flex shrink-0 gap-2 px-[17px] pb-2.5 max-[390px]:px-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 rounded-xl border border-white/10 bg-[#242228] px-2.5 focus-within:border-purple-300/40">
          <Search className="h-4 w-4 shrink-0 text-white/45" />
          <input value={query} onChange={e => {setQuery(e.target.value); if(e.target.value) setActiveTier("all");}} aria-label={t("modelBrowser.searchPlaceholder")} placeholder={t("modelBrowser.searchPlaceholder")} className="h-10 min-w-0 w-full bg-transparent text-[13px] text-white outline-none placeholder:text-white/40 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:text-base" />
        </label>
        <div className="relative flex min-w-[90px] max-w-[42%]">
        <span aria-hidden="true" className="pointer-events-none invisible block truncate pl-7 pr-6 text-xs">{t(`modelBrowser.sort.${sort}`)}</span>
        <ArrowDownWideNarrow aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-white/55" />
        <select value={sort} onChange={e => setSort(e.target.value as OfficialModelSort)} aria-label={t("modelBrowser.sortLabel")} className="absolute inset-0 min-w-0 w-full appearance-none rounded-xl border border-white/10 bg-[#242228] pl-7 pr-6 text-xs text-white/80">
          {(["popular", "costAsc", "costDesc", "newest", "recent", "name"] as const).map(value => <option key={value} value={value}>{t(`modelBrowser.sort.${value}`)}</option>)}
        </select>
        <ChevronDown aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 h-3 w-3 -translate-y-1/2 text-white/55" />
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5 px-[17px] pb-1 max-[390px]:px-3">
        <div className="grid min-w-0 flex-1 grid-cols-5 gap-1">
          {(["all", ...TIERS] as const).map(tier => {
            const meta = TIER_META[tier === "all" ? "premium" : tier];
            return <button type="button" key={tier} onClick={() => setActiveTier(tier)} aria-pressed={activeTier === tier} className={cn("flex h-9 min-w-0 items-center justify-center gap-1 rounded-[10px] border px-0.5 text-xs transition-colors motion-reduce:transition-none max-[390px]:gap-0.5 max-[390px]:text-[11px] [@media(pointer:coarse)]:h-11", meta.color, activeTier === tier ? `${meta.bg} ${meta.border} shadow-md ${meta.glow}` : "border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05]")}>
            <span className="truncate">{tier === "all" ? t("modelBrowser.tabAll") : t(`modelBrowser.tier${tier.charAt(0).toUpperCase()+tier.slice(1)}` as any)}</span><span className="text-[10px] opacity-60">{tier === "all" ? PLAY_MODELS.length : PLAY_MODELS.filter(m => m.tier === tier).length}</span>
          </button>;
          })}
        </div>
        <button type="button" aria-pressed={favoritesOnly} aria-label={t("modelBrowser.favoritesOnly")} title={t("modelBrowser.favoritesOnly")} onClick={() => setFavoritesOnly(v=>!v)} className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg hover:bg-white/5 [@media(pointer:coarse)]:h-11",favoritesOnly ? "bg-gold/10 text-gold" : "text-white/55")}><Star className={cn("h-4 w-4", favoritesOnly && "fill-current")} /></button>
      </div>
      <div className="flex min-h-8 shrink-0 items-center justify-between gap-1 px-5 text-[11px] text-white/55" aria-live="polite">
        <span>{pinLimitHit ? t("modelBrowser.pinLimit",{max:MAX_PINNED_MODELS}) : t("modelBrowser.modelsFound",{count:models.length})}</span>
        {sort === "popular" && <button type="button" onClick={e=>showInfo("popularity",e)} aria-expanded={info === "popularity"} className="flex items-center gap-1 rounded px-1 py-1 hover:text-white">· {t("modelBrowser.popularityLabel")}<Info className="h-3 w-3" /></button>}
      </div>
      <div ref={listRef} data-testid="official-model-list" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3 max-[390px]:px-2">
        {models.map(m => {
          const isSelected = !isMixActive && selectedModel === m.id;
          const hasGrokTrial = m.id === "anthropic/claude-sonnet-4.6" && grokTrialRemaining > 0;
          const locked = !hasGrokTrial && !canAccessPlan(m.minPlan,userPlan);
          const meta = TIER_META[m.tier as CostTier];
          return <div key={m.id} className={cn("mb-1.5 flex min-h-[68px] w-full items-center rounded-[13px] border transition-colors motion-reduce:transition-none",isSelected ? `${meta.border} ${meta.bg} shadow-md ${meta.glow}` : "border-white/[0.07] bg-white/[0.02]",!locked && !isSelected && "hover:border-white/15 hover:bg-white/[0.04]",locked && "opacity-60")}>
            <button type="button" disabled={locked} aria-pressed={isSelected} onClick={() => {if(isMixActive)useConfigStore.getState().setConfig("mixMode",false);onSelect(m.id);}} title={(() => {const stats=statsById.get(m.id);if(!stats)return undefined;const estimate=estimateReplyCost(stats,contextTokens);return t(estimate.scaled?"modelBrowser.costForThisChat":"modelBrowser.costRange",{typical:formatCostEstimate(estimate.typical),heavy:formatCostEstimate(estimate.heavy)});})()} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl py-2.5 pl-3.5 pr-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25 max-[390px]:gap-2 max-[390px]:pl-2.5">
              <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full",meta.dot,isSelected ? "opacity-100 ring-4 ring-white/5" : "opacity-70")} />
              <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 text-sm font-medium text-white/90 [overflow-wrap:anywhere]">{m.name}</span>
                {isSelected && !locked && <Check aria-hidden="true" className={cn("h-3 w-3 shrink-0 self-center",meta.color)} />}
                <span className={cn("shrink-0 whitespace-nowrap text-[11px] tabular-nums",m.avgCostMushies === 0 ? "text-emerald-400/80" : "text-gold/75")}>{cost(m)}</span>
              </div>
              <p className="mt-1 text-xs leading-snug text-white/55">{getDesc(m)}</p>
              {(locked || hasGrokTrial || m.badge) && <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                {locked && <span className="inline-flex items-center gap-1 rounded bg-white/[0.06] px-1.5 py-0.5 text-white/60"><Lock className="h-3 w-3" />{t(`planName.${m.minPlan}` as never,{ns:"common"})}</span>}
                {hasGrokTrial && <span className="rounded bg-amber-400/10 px-1.5 py-0.5 text-amber-400">{t("modelBrowser.freeTriesLeft",{count:grokTrialRemaining})}</span>}
                {m.badge && !locked && <span className="rounded bg-gold/10 px-1.5 py-0.5 text-gold/80">{m.badge}</span>}
              </div>}
              </div>
            </button>
            <button type="button" aria-pressed={pinnedModels.includes(m.id)} aria-label={t(pinnedModels.includes(m.id)?"modelBrowser.unpinFromQuickSelect":"modelBrowser.pinToQuickSelect")+`: ${m.name}`} onClick={() => {if(pinnedModels.includes(m.id))unpinModel(m.id,"official");else if(!pinModel(m.id,"official"))setPinLimitNonce(n=>n+1);}} className="mr-1 flex h-10 w-8 shrink-0 items-center justify-center rounded-lg text-white/50 hover:bg-white/5 hover:text-gold focus-visible:ring-2 focus-visible:ring-primary [@media(pointer:coarse)]:h-11"><Star className={cn("h-4 w-4",pinnedModels.includes(m.id)&&"fill-gold text-gold")} /></button>
            {!statsById.get(m.id) && <DeepSeekPricingInfo modelId={m.id} modelName={m.name} copy={deepSeekPricingCopy} className="mr-1" />}
          </div>;
        })}
        {models.length === 0 && <p className="py-8 text-center text-xs text-white/55">{t("modelBrowser.noMatches")}</p>}
      </div>
      <div className="flex min-h-10 shrink-0 items-center justify-between gap-2 border-t border-white/[0.08] px-[18px] py-2.5 text-[11px] text-white/50">
        <button type="button" onClick={e=>showInfo("cost",e)} aria-expanded={info === "cost"} className="flex items-center gap-1 rounded hover:text-white/80">{t("modelBrowser.compactCostUnit")}<Info className="h-3 w-3" /></button>
        <span className="text-right text-gold/75">{userPlan === "free" ? t("modelBrowser.upgradeForMore") : t("modelBrowser.currentPlan",{plan:t(`planName.${userPlan}` as never,{ns:"common"})})}</span>
      </div>
      {info && <div ref={infoRef} role="dialog" aria-label={t(info === "cost"?"modelBrowser.costHelpTitle":"modelBrowser.popularityInfoTitle")} tabIndex={-1} className="absolute inset-x-3 bottom-12 z-20 max-h-[60%] overflow-y-auto rounded-xl border border-white/15 bg-[#242529] p-4 shadow-xl outline-none">
        <button type="button" onClick={closeInfo} aria-label={t("modelBrowser.closePicker")} className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-lg text-white/60 hover:bg-white/5"><X className="h-4 w-4" /></button>
        <h3 className="mb-2 pr-8 text-sm font-medium text-white">{t(info === "cost"?"modelBrowser.costHelpTitle":"modelBrowser.popularityInfoTitle")}</h3>
        {info === "cost" ? <><p className="text-xs leading-relaxed text-white/65">{t("tokenUsageHint")}</p><p className="mt-2 text-xs leading-relaxed text-white/65">{t("modelBrowser.referenceCostBasis")}</p></> : <><p className="text-xs leading-relaxed text-white/65">{t("modelBrowser.popularityInfoBody")}</p><p className="mt-2 text-xs leading-relaxed text-white/50">{t("modelBrowser.popularityWindow",{start:popularity.windowStart.slice(0,10),end:new Date(Date.parse(popularity.windowEnd)-1).toISOString().slice(0,10),date:popularity.updatedAt.slice(0,10),count:popularity.sourceApps,externalDate:popularity.externalReportingDate})}</p></>}
      </div>}
    </>
  );
}

/* ── Private / BYOK picker (search + pinned/recent/all) ── */

function PrivateView({
  models, selectedModel, pinnedModels, recentlyUsed, loading, hasKey,
  onSelect, onClose, onPin, onUnpin, onGoToSettings, providerSwitch, usageNote, onMixMode, setupRequired,
}: {
  models: ModelInfo[];
  selectedModel: string;
  pinnedModels: string[];
  recentlyUsed: string[];
  loading: boolean;
  hasKey: boolean;
  setupRequired?: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** Returns false when the pin list is already full. */
  onPin: (id: string) => boolean;
  onUnpin: (id: string) => void;
  onGoToSettings: () => void;
  providerSwitch: React.ReactNode;
  onMixMode?: () => void;
  usageNote: string;
}) {
  const { t } = useTranslation("chat");
  const mixMode = useConfigStore((s) => s.mixMode);
  const modelPoolLen = useConfigStore((s) => s.modelPool).length;
  const isMixActive = !!onMixMode && mixMode && modelPoolLen >= 2;
  const [query, setQuery] = useState("");
  // A star that refuses to light says why — beside the pinned list it belongs
  // to, not in a pill (blocked-action guidance is never a pill).
  const [pinLimitNonce, setPinLimitNonce] = useState(0);
  const pinLimitHit = useTransientFlag(pinLimitNonce, 2500);
  const pinnedSet = useMemo(() => new Set(pinnedModels), [pinnedModels]);

  const filtered = useMemo(() => {
    if (!query) return [];
    const q = query.toLowerCase();
    return models.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || m.provider.toLowerCase().includes(q));
  }, [query, models]);

  const pinnedInfos = useMemo(
    () => pinnedModels.map((id) => models.find((m) => m.id === id)).filter(Boolean) as ModelInfo[],
    [pinnedModels, models],
  );
  const recentInfos = useMemo(
    () => recentlyUsed.filter((id) => !pinnedSet.has(id)).slice(0, 5).map((id) => models.find((m) => m.id === id)).filter(Boolean) as ModelInfo[],
    [recentlyUsed, pinnedSet, models],
  );
  const recentSet = useMemo(() => new Set(recentInfos.map((m) => m.id)), [recentInfos]);
  const otherModels = useMemo(
    () => models.filter((m) => !pinnedSet.has(m.id) && !recentSet.has(m.id)),
    [models, pinnedSet, recentSet],
  );

  const handleTogglePin = (modelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (pinnedSet.has(modelId)) {
      onUnpin(modelId);
      return;
    }
    // At the cap, the note under the Pinned label explains it — silently doing
    // nothing reads as "the pin didn't save".
    if (!onPin(modelId)) {
      setPinLimitNonce((n) => n + 1);
    }
  };

  const renderModel = (m: ModelInfo) => {
    const isSelected = !isMixActive && selectedModel === m.id;
    const isPinned = pinnedSet.has(m.id);
    const providerColor = PROVIDER_COLORS[m.provider] ?? "text-white/40";

    return (
      <button
        key={m.id}
        onClick={() => {
          if (isMixActive) useConfigStore.getState().setConfig("mixMode", false);
          onSelect(m.id);
        }}
        className={cn(
          "group flex w-full items-center gap-2.5 rounded-xl border p-3 text-left transition-all",
          isSelected
            ? "border-slate-400/25 bg-slate-400/8 shadow-md shadow-slate-500/10"
            : "border-white/[0.05] bg-white/[0.015] hover:border-slate-400/15 hover:bg-slate-400/[0.04]",
        )}
      >
        <span
          role="button"
          tabIndex={0}
          aria-label={t(isPinned ? "modelPicker.unpinModel" : "modelPicker.pinModel")}
          onClick={(e) => handleTogglePin(m.id, e)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              handleTogglePin(m.id, e as unknown as React.MouseEvent);
            }
          }}
          className={cn(
            // span, not button: this sits inside the model-row <button>, and
            // nested interactive elements are invalid HTML with flaky tap behavior.
            "flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors [@media(hover:none)]:h-9 [@media(hover:none)]:w-9 [@media(hover:none)]:-m-1.5",
            isPinned
              ? "text-slate-300/70 hover:text-slate-300"
              : "text-transparent group-hover:text-white/20 hover:!text-white/40 [@media(hover:none)]:text-white/25",
          )}
        >
          <Star className={cn("h-3 w-3", isPinned && "fill-current")} />
        </span>
        <div className="flex-1 min-w-0">
          <p className={cn("truncate text-sm font-medium", isSelected ? "text-white" : "text-white/80")}>
            {m.name || formatModelId(m.id)}
          </p>
        </div>
        <span className={cn("shrink-0 text-[10px] font-medium", providerColor)}>{m.provider}</span>
        {m.contextLength > 0 && (
          <span className="shrink-0 text-[10px] text-white/20">{Math.round(m.contextLength / 1000)}k</span>
        )}
        {isSelected && (
          <div className="h-2 w-2 shrink-0 rounded-full bg-slate-300 shadow-lg shadow-slate-400/30" />
        )}
      </button>
    );
  };

  return (
    <>
      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-5 pb-1">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-400/10">
            <Sparkles className="h-4 w-4 text-slate-300" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white">{t("modelBrowser.title")}</h2>
            <p className="text-[11px] text-white/40">{t("modelBrowser.sourcePrivate")}</p>
          </div>
        </div>
        <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-white/30 transition-colors hover:bg-white/5 hover:text-white/60">
          <X className="h-4 w-4" />
        </button>
      </div>

      {providerSwitch}

      <div className="flex items-center gap-2 border-y border-white/[0.06] px-5 py-2">
        <p className="flex-1 text-[11px] leading-snug text-white/45">
          {usageNote}
        </p>
        {onMixMode && <MixPill onClick={onMixMode} />}
      </div>

      {/* No key empty state */}
      {!hasKey && models.length === 0 && !loading && (
        <div className="flex flex-1 flex-col items-center justify-center py-12 text-center px-5">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-white/[0.08] bg-white/[0.03]">
            <Key className="h-5 w-5 text-white/25" />
          </div>
          <p className="text-sm font-medium text-white/60">{t(setupRequired ? "modelBrowser.privateSetupTitle" : "modelBrowser.noPrivateKey")}</p>
          <p className="mt-1 max-w-[260px] text-[11px] text-white/30">{t(setupRequired ? "modelBrowser.privateSetupDescription" : "modelBrowser.noPrivateKeyDesc")}</p>
          <button onClick={onGoToSettings}
            className="mt-4 rounded-lg border border-white/[0.1] bg-white/[0.04] px-4 py-2 text-xs font-medium text-white/70 transition-colors hover:bg-white/[0.08]">
            {t("modelBrowser.goToSettings")}
          </button>
        </div>
      )}

      {/* Search */}
      {(hasKey || models.length > 0) && (
        <div className="px-4 pt-3 pb-1">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/25" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("modelBrowser.searchPlaceholder")}
              autoFocus
              className="w-full rounded-xl border border-slate-400/10 bg-slate-400/[0.03] py-2.5 pl-9 pr-3 text-xs text-white placeholder:text-white/25 focus:border-slate-400/20 focus:outline-none"
            />
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-2">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-white/20" />
          </div>
        ) : query ? (
          <div className="space-y-1">
            <SectionLabel>{t("modelPicker.results", { count: filtered.length })}</SectionLabel>
            {filtered.length === 0 && (
              <p className="py-6 text-center text-xs text-white/25">{t("modelPicker.noModelsMatch", { query })}</p>
            )}
            {filtered.map(renderModel)}
          </div>
        ) : (
          <div className="space-y-3">
            {pinnedInfos.length > 0 && (
              <div className="space-y-1">
                <SectionLabel icon={<Star className="h-3 w-3" />}>{t("modelPicker.pinned")}</SectionLabel>
                {pinLimitHit && (
                  <p role="status" className="px-1 text-[11px] text-amber-300/70">
                    {t("modelBrowser.pinLimit", { max: MAX_PINNED_MODELS })}
                  </p>
                )}
                {pinnedInfos.map(renderModel)}
              </div>
            )}
            {recentInfos.length > 0 && (
              <div className="space-y-1">
                <SectionLabel icon={<Clock className="h-3 w-3" />}>{t("modelBrowser.recentlyUsed")}</SectionLabel>
                {recentInfos.map(renderModel)}
              </div>
            )}
            {otherModels.length > 0 && (
              <div className="space-y-1">
                <SectionLabel icon={<Layers className="h-3 w-3" />}>{t("modelBrowser.allModels")} ({otherModels.length})</SectionLabel>
                {otherModels.map(renderModel)}
              </div>
            )}
            {models.length === 0 && hasKey && (
              <p className="py-8 text-center text-xs text-white/25">{t("modelBrowser.noPrivateKey")}</p>
            )}
          </div>
        )}
      </div>

    </>
  );
}

/* ── Studio picker (simple list, studioMode filtering) ── */

function StudioView({
  models, selectedModel, loading, onSelect, onClose, providerSwitch, usageNote,
}: {
  models: ModelInfo[];
  selectedModel: string;
  loading: boolean;
  onSelect: (id: string) => void;
  onClose: () => void;
  providerSwitch: React.ReactNode;
  usageNote: string;
}) {
  const { t } = useTranslation("chat");
  const deepSeekPricingCopy = useDeepSeekPricingCopy();

  const studioModels = useMemo(() => {
    const filtered = models.filter((m) => STUDIO_MODEL_IDS.has(m.id));
    const studioOnly = STUDIO_MODELS.filter((sm) => !filtered.some((m) => m.id === sm.id))
      .map((sm): ModelInfo => ({
        id: sm.id, name: sm.name, provider: sm.id.split("/")[0] ?? "", contextLength: 0, isCurated: false,
      }));
    const all = [...filtered, ...studioOnly];
    all.sort((a, b) => {
      const pa = STUDIO_META_MAP.get(a.id);
      const pb = STUDIO_META_MAP.get(b.id);
      const costA = pa ? pa.inputPrice + pa.outputPrice : 999;
      const costB = pb ? pb.inputPrice + pb.outputPrice : 999;
      return costA - costB;
    });
    return all;
  }, [models]);
  const recommended = studioModels.find((m) => m.id === STUDIO_RECOMMENDED_MODEL);

  return (
    <>
      <div className="flex items-center justify-between px-5 pt-5 pb-1">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary/10">
            <Sparkles className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white">{t("modelBrowser.title")}</h2>
            <p className="text-[11px] text-white/40">{t("modelBrowser.studioSubtitle")}</p>
          </div>
        </div>
        <button onClick={onClose} className="flex h-7 w-7 items-center justify-center rounded-lg text-white/30 transition-colors hover:bg-white/5 hover:text-white/60">
          <X className="h-4 w-4" />
        </button>
      </div>

      {providerSwitch}

      <p className="border-y border-white/[0.06] px-5 py-2 text-[11px] leading-snug text-white/45">
        {usageNote}
      </p>

      <div className="flex-1 overflow-y-auto px-4 py-2">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-white/20" />
          </div>
        ) : (
          <div className="space-y-1.5">
            {recommended && (
              <div className="mb-3">
                <SectionLabel icon={<Star className="h-3 w-3 text-amber-400" />}>
                  {t("modelBrowser.recommended")}
                </SectionLabel>
                <button
                  onClick={() => onSelect(recommended.id)}
                  className={cn(
                    "group flex w-full items-center gap-3 rounded-xl border p-3.5 text-left transition-all",
                    selectedModel === recommended.id
                      ? "border-amber-400/25 bg-amber-400/10 shadow-md shadow-amber-500/20"
                      : "border-white/[0.06] bg-white/[0.02] hover:border-white/10 hover:bg-white/[0.04]",
                  )}
                >
                  <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400" />
                  <div className="flex-1 min-w-0">
                    <div>
                      <span className="text-sm font-medium text-white">{recommended.name}</span>
                      <span className="ml-2 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-400">
                        {t("modelBrowser.recommendedBadge")}
                      </span>
                    </div>
                    {(() => { const rm = STUDIO_META_MAP.get(recommended.id); return rm ? (
                      <div className="mt-0.5 text-[10px] text-white/25">${rm.inputPrice}/M in · ${rm.outputPrice}/M out</div>
                    ) : null; })()}
                  </div>
                  {selectedModel === recommended.id && (
                    <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400 shadow-lg shadow-amber-500/30" />
                  )}
                </button>
              </div>
            )}
            <SectionLabel>{t("modelBrowser.allModels")}</SectionLabel>
            {studioModels.filter((m) => m.id !== STUDIO_RECOMMENDED_MODEL).map((m) => {
              const isSelected = selectedModel === m.id;
              const meta = STUDIO_META_MAP.get(m.id);
              const tier = m.tier ? TIER_META[m.tier] : null;
              return (
                <div
                  key={m.id}
                  className={cn(
                    "group/row flex w-full items-center rounded-xl border transition-all",
                    isSelected && tier
                      ? `${tier.border} ${tier.bg} shadow-md ${tier.glow}`
                      : isSelected
                        ? "border-primary/30 bg-primary/8 shadow-md shadow-primary/10"
                        : "border-white/[0.06] bg-white/[0.02] hover:border-white/10 hover:bg-white/[0.04]",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onSelect(m.id)}
                    className="group flex min-w-0 flex-1 items-center gap-3 rounded-xl p-3.5 pr-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/25"
                  >
                    {tier && <div className={cn("h-2.5 w-2.5 shrink-0 rounded-full", tier.dot, isSelected ? "opacity-100" : "opacity-50")} />}
                    <div className="flex-1 min-w-0">
                      <span className={cn("text-sm font-medium", isSelected ? "text-white" : "text-white/80")}>
                        {meta?.name ?? m.name}
                      </span>
                      {meta?.avgCostMushiesByPeriod ? (
                        <div className="mt-0.5 text-[10px] text-gold/50">
                          {t("modelBrowser.avgCostByPeriod", {
                            peak: formatAvgCost(meta.avgCostMushiesByPeriod.peak),
                            offPeak: formatAvgCost(meta.avgCostMushiesByPeriod.offPeak),
                          })}
                        </div>
                      ) : meta && (
                        <div className="mt-0.5 text-[10px] text-white/25">
                          ${meta.inputPrice}/M in · ${meta.outputPrice}/M out
                        </div>
                      )}
                    </div>
                    {isSelected && tier && <div className={cn("h-2.5 w-2.5 shrink-0 rounded-full shadow-lg", tier.dot, tier.glow)} />}
                    {isSelected && !tier && <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-primary shadow-lg shadow-primary/30" />}
                  </button>
                  <DeepSeekPricingInfo
                    modelId={m.id}
                    modelName={meta?.name ?? m.name}
                    copy={deepSeekPricingCopy}
                    className="mr-2"
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

/* ── Shared sub-components ── */

function SectionLabel({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 px-1 pb-1 pt-2">
      {icon && <span className="text-white/20">{icon}</span>}
      <span className="text-[10px] font-semibold uppercase tracking-wider text-white/25">{children}</span>
    </div>
  );
}
