import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronRight, Shuffle, Sparkles } from "lucide-react";
import { ApiKeysSettings } from "@/features/settings/api-keys";
import { useConfigStore } from "@/stores/config";
import { useCreditStore } from "@/edition/slots.state";
import { useModelsStore } from "@/stores/models";
import { PLAY_MODELS, formatModelId } from "@yumina/shared";
import { ModelBrowser } from "@/features/chat/model-browser";

/** Model picker trigger + BYOK key management (the Settings "AI config" tab). */
export function AiProviderTab() {
  const { t: tc } = useTranslation("chat");
  const setConfig = useConfigStore((s) => s.setConfig);
  const { selectedModel, mixMode, modelPool } = useConfigStore();
  const provider = useCreditStore((s) => s.provider);
  const [modelModalOpen, setModelModalOpen] = useState(false);

  const currentModel = PLAY_MODELS.find((m) => m.id === selectedModel);
  const isMixActive = mixMode && modelPool.length >= 2;
  const providerLabel = provider === "private"
    ? tc("modelBrowser.sourcePrivate", { ns: "chat" })
    : tc("modelBrowser.sourceOfficial", { ns: "chat" });

  const subtitle = isMixActive
    ? `${tc("modelMix.title", { ns: "chat" })} · ${modelPool.length}`
    : `${providerLabel} · ${currentModel?.name ?? formatModelId(selectedModel)}`;

  return (
    <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500 space-y-6">
      {/* Model Selection — trigger opens ModelBrowser */}
      <div className="profile-overview-glass profile-overview-glass--soft rounded-2xl overflow-hidden">
        <button
          type="button"
          onClick={() => setModelModalOpen(true)}
          className="group flex w-full items-center gap-3.5 p-5 text-left transition-colors hover:bg-white/[0.02]"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 border border-primary/20">
            {isMixActive
              ? <Shuffle className="h-5 w-5 text-primary" />
              : <Sparkles className="h-5 w-5 text-primary" />}
          </div>
          <div className="flex-1 min-w-0">
            <span className="text-sm font-semibold text-main">
              {tc("modelSelector.title", { ns: "chat" })}
            </span>
            <div className="text-[11px] text-sub/50">{subtitle}</div>
          </div>
          <ChevronRight className="h-4 w-4 text-sub/30 transition-colors group-hover:text-sub/50" />
        </button>
      </div>

      {/* API Keys (BYOK) — always visible */}
      <ApiKeysSettings />

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
    </div>
  );
}
