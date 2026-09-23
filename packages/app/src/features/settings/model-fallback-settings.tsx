import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRightLeft } from "lucide-react";
import { DEFAULT_MODEL_FALLBACK_POLICY, formatModelId, modelFallbackText, type ModelFallbackMode } from "@yumina/shared";
import { useConfigStore } from "@/stores/config";
import { useCreditStore } from "@/edition/slots.state";
import { useUserProfileStore } from "@/stores/user-profile";
import { ModelBrowser } from "@/features/chat/model-browser";

export function ModelFallbackSettings() {
  const { i18n } = useTranslation();
  const storedPolicy = useConfigStore((s) => s.modelFallback);
  const setConfig = useConfigStore((s) => s.setConfig);
  const privateMode = useCreditStore((s) => s.provider === "private");
  const activeKey = useUserProfileStore((s) => s.profile?.preferences?.activeApiKeyId);
  const keyId = typeof activeKey === "string" ? activeKey : null;
  const policy = storedPolicy ?? DEFAULT_MODEL_FALLBACK_POLICY;
  const model = privateMode ? policy.privateKeyId === keyId ? policy.privateModel : "" : policy.officialModel;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pendingMode, setPendingMode] = useState<ModelFallbackMode | null>(null);
  const t = (key: Parameters<typeof modelFallbackText>[1]) => modelFallbackText(i18n.language, key);
  return (
    <section id="model-fallback" className="scroll-mt-6 border-b border-white/[0.06] pb-5" aria-labelledby="model-fallback-settings-title">
      <h3 id="model-fallback-settings-title" className="flex items-center gap-2 text-sm font-medium text-main"><ArrowRightLeft className="h-4 w-4 text-gold" aria-hidden="true" />{t("settingsTitle")}</h3>
      <p className="mt-1 text-xs text-sub">{t("settingsBody")}</p>
      <label className="mt-3 block text-xs font-medium text-main" htmlFor="model-fallback-mode">{t("mode")}</label>
      <select id="model-fallback-mode" value={policy.mode} onChange={(e) => {
        const mode = e.target.value as ModelFallbackMode;
        if (mode === "auto" && !model) { setPendingMode(mode); setPickerOpen(true); return; }
        setConfig("modelFallback", { ...policy, mode });
      }} className="profile-overview-input-surface mt-1.5 min-h-9 w-full appearance-none rounded-lg border border-gold/20 px-3 text-sm text-main focus-visible:outline focus-visible:outline-2 focus-visible:outline-gold">
        <option value="ask">{t("ask")}</option><option value="auto">{t("auto")}</option><option value="stop">{t("stopMode")}</option>
      </select>
      <button type="button" onClick={() => setPickerOpen(true)} aria-haspopup="dialog" className="profile-overview-input-surface mt-2 flex min-h-10 w-full items-center justify-between gap-3 rounded-lg border border-gold/20 px-3 py-2 text-left text-main transition-colors hover:border-gold/50">
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1"><span className="text-xs text-sub">{t("backup")}</span><span className="break-words text-xs font-medium">{model ? formatModelId(model) : t("empty")}</span></span>
      </button>
      <div className="mt-2 space-y-1 text-[11px] text-sub"><p>{t(privateMode ? "privateBilling" : "billing")}</p><p>{t("autoNote")}</p>{privateMode && <p>{t("keyNote")}</p>}</div>
      <ModelBrowser open={pickerOpen} onClose={() => { setPickerOpen(false); setPendingMode(null); }} selectionOnly selectedModel={model} onSelect={(id) => {
        setConfig("modelFallback", { ...policy, mode: pendingMode ?? policy.mode,
          ...(privateMode ? { privateModel: id, privateKeyId: keyId } : { officialModel: id }) });
        setPickerOpen(false); setPendingMode(null);
      }} />
    </section>
  );
}
