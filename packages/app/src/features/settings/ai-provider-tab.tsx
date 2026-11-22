import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Cpu, Plug } from "lucide-react";
import { cn } from "@/lib/utils";
import { ApiKeysSettings } from "@/features/settings/api-keys";
import { ProfileAiSettings } from "@/features/account/sections/profile-ai-settings";
import { LocalModelPanel } from "@/features/local-model/local-model-panel";
import { guideOpenRequested } from "@/features/local-model/local-model-guide";
import { isLikelyPhone } from "@/features/local-model/local-model-picker-view";
import { useLocalModelStore } from "@/features/local-model/store";
import { isLocalModelId } from "@/features/local-model/enabled-flag";
import { useUserProfileStore } from "@/stores/user-profile";
import { useConfigStore } from "@/stores/config";
import { useCreditStore } from "@/edition/slots.state";

/**
 * Top of Settings → AI config: the same plan / wallet / model card as the
 * profile's "Plan & model" page, because which AI you're on and what you have
 * left to spend is what a newcomer opens this page for.
 */
export function AiProviderTab() {
  return (
    <div className="max-w-3xl animate-in fade-in slide-in-from-bottom-4 duration-500">
      <ProfileAiSettings embedded />
    </div>
  );
}

/**
 * Bring-your-own AI: a personal API key, or a model on this computer.
 *
 * Both are for players who already know what they want, so they sit at the
 * bottom as folded rows instead of greeting a newcomer with setup forms.
 * A row opens by itself when the player is already using it, arrived from the
 * model picker's setup-guide button, or was sent here by settings search.
 */
export function OwnAiSettings() {
  const { t } = useTranslation(["settings", "profile"]);
  const selectedModel = useConfigStore((s) => s.selectedModel);
  const provider = useCreditStore((s) => s.provider);
  const activeKeyId = useUserProfileStore((s) => s.profile?.preferences?.activeApiKeyId);
  const localArmed = useLocalModelStore((s) => s.armed);
  const usingLocal = isLocalModelId(selectedModel) || localArmed;
  // A phone can't run a model itself; the picker explains playing on one
  // that runs on the player's computer.
  const offerLocal = usingLocal || !isLikelyPhone();

  return (
    <div className="space-y-3">
      <div className="px-1 text-xs font-medium text-sub/60">{t("aiConfig.ownAi")}</div>
      <FoldedRow
        id="settings-target-byok"
        icon={<Plug className="h-5 w-5 text-violet-300" />}
        tint="bg-violet-400/10 border-violet-400/20"
        title={t("apiKeys.title", { ns: "profile" })}
        subtitle={t("apiKeys.subtitle", { ns: "profile" })}
        initiallyOpen={provider === "private" || !!activeKeyId}
      >
        <ApiKeysSettings embedded />
      </FoldedRow>
      {offerLocal && (
        <FoldedRow
          id="settings-target-local-model"
          icon={<Cpu className="h-5 w-5 text-emerald-400" />}
          tint="bg-emerald-500/10 border-emerald-500/20"
          title={t("localModel.title", { ns: "profile" })}
          subtitle={t("localModel.subtitle", { ns: "profile" })}
          initiallyOpen={usingLocal || guideOpenRequested()}
        >
          <LocalModelPanel embedded />
        </FoldedRow>
      )}
    </div>
  );
}

function FoldedRow({ id, icon, tint, title, subtitle, initiallyOpen, children }: {
  id: string;
  icon: ReactNode;
  tint: string;
  title: string;
  subtitle: string;
  initiallyOpen: boolean;
  children: ReactNode;
}) {
  const [opened, setOpened] = useState<boolean | null>(null);
  // Follows the "already using it" signal until the player clicks; the
  // profile and credits load after first paint.
  const open = opened ?? initiallyOpen;
  return (
    <div
      id={id}
      tabIndex={-1}
      // Settings search focuses its target: arriving here means "show me".
      onFocus={(e) => { if (e.target === e.currentTarget) setOpened(true); }}
      className="profile-overview-glass profile-overview-glass--soft scroll-mt-4 rounded-2xl overflow-hidden outline-none"
    >
      <button
        type="button"
        onClick={() => setOpened(!open)}
        aria-expanded={open}
        className="group flex w-full items-center gap-3.5 p-5 text-left transition-colors hover:bg-white/[0.02]"
      >
        <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border", tint)}>{icon}</div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-main">{title}</div>
          <div className="mt-0.5 text-[11px] leading-relaxed text-sub/50">{subtitle}</div>
        </div>
        <ChevronDown className={cn("h-4 w-4 shrink-0 text-sub/30 transition-transform group-hover:text-sub/50", open && "rotate-180")} />
      </button>
      {open && <div className="px-5 pb-5">{children}</div>}
    </div>
  );
}
