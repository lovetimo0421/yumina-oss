import { useTranslation } from "react-i18next";
import { feedback } from "@/lib/feedback";
import { Loader2, Trash2, RotateCcw } from "lucide-react";
import type { ExtensionSummary } from "@yumina/shared";
import { useExtensionsStore } from "@/stores/extensions";
import { useExtensionPreview } from "./extension-preview-store";
import { notifyMemoryCost } from "./extension-preview-modal";
import { ExtensionIcon } from "./extension-icon";
import { useLocalizedExtension } from "./use-localized-extension";

// Dense horizontal row for the Manage section. Card body opens the popup; the
// inline action button uninstalls (installed list) or reinstalls (previously-
// installed list) without opening it.
export function ExtensionManageCard({
  extension,
  mode,
}: {
  extension: ExtensionSummary;
  mode: "installed" | "uninstalled";
}) {
  const { t } = useTranslation("extensions");
  const localized = useLocalizedExtension(extension);
  const open = useExtensionPreview((s) => s.open);
  const uninstall = useExtensionsStore((s) => s.uninstall);
  const reinstall = useExtensionsStore((s) => s.reinstall);
  const pending = useExtensionsStore((s) => s.pendingAction[extension.key] ?? false);

  const onAction = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (mode === "installed") {
      const ok = await uninstall(extension.key);
      if (!ok) feedback.error(t("toast.uninstallFailed"));
    } else {
      const ok = await reinstall(extension.key);
      if (!ok) feedback.error(t("toast.installFailed"));
      if (ok) notifyMemoryCost(extension.key, t("toast.memoryCostNotice"));
    }
  };

  return (
    <div
      onClick={() => open(extension, "overview")}
      className="flex cursor-pointer items-center gap-4 rounded-2xl border border-white/5 bg-white/[0.02] p-4 transition-all hover:border-gold/30 hover:bg-white/[0.03]"
    >
      <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#C9A25E]/25 bg-gradient-to-br from-[#C9A25E]/15 to-white/5">
        <ExtensionIcon name={extension.icon} className="h-5 w-5 text-[#C9A25E]" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-main">{localized.name}</div>
        <div className="truncate text-xs text-sub/60">{localized.shortDescription}</div>
      </div>
      <button
        onClick={onAction}
        disabled={pending}
        className={
          mode === "installed"
            ? "inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs font-semibold text-white/70 transition-all hover:border-red-400/40 hover:bg-red-400/[0.08] hover:text-red-300 disabled:opacity-40"
            : "inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[#C9A25E]/30 bg-[#C9A25E]/[0.08] px-3 py-2 text-xs font-semibold text-[#C9A25E] transition-all hover:bg-[#C9A25E]/[0.15] disabled:opacity-40"
        }
      >
        {pending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : mode === "installed" ? (
          <Trash2 className="h-3.5 w-3.5" />
        ) : (
          <RotateCcw className="h-3.5 w-3.5" />
        )}
        {mode === "installed" ? t("uninstall") : t("reinstall")}
      </button>
    </div>
  );
}
