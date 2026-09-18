import { useTranslation } from "react-i18next";
import { Star, Download, Check } from "lucide-react";
import type { ExtensionSummary } from "@yumina/shared";
import { useExtensionsStore } from "@/stores/extensions";
import { useFeature } from "@/edition/edition";
import { useExtensionPreview } from "./extension-preview-store";
import { ExtensionIcon } from "./extension-icon";
import { useLocalizedExtension } from "./use-localized-extension";

// Discover-grid card — mirrors the hub card chrome. Status badge + button state
// read the store's installState selector (not the frozen row) so an install
// elsewhere reflects here instantly.
export function ExtensionCard({ extension }: { extension: ExtensionSummary }) {
  const { t } = useTranslation("extensions");
  const localized = useLocalizedExtension(extension);
  const open = useExtensionPreview((s) => s.open);
  // Ratings and download counts are hosted marketplace metadata; the local
  // edition's first-party catalog has neither.
  const showsMarketplaceStats = useFeature("reviews");
  const status = useExtensionsStore(
    (s) => s.installState[extension.key] ?? extension.installState?.status ?? "not-installed",
  );

  return (
    <button
      onClick={() => open(extension, "overview")}
      className="group relative flex min-w-0 flex-col rounded-[20px] border border-white/[0.06] bg-[#1F1D21]/70 p-5 text-left transition-all hover:border-gold/30 hover:bg-[#1F1D21] hover:shadow-[0_8px_30px_rgba(0,0,0,0.3)]"
    >
      <div className="mb-3 flex items-start gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-[#C9A25E]/25 bg-gradient-to-br from-[#C9A25E]/15 to-white/5">
          <ExtensionIcon name={extension.icon} className="h-6 w-6 text-[#C9A25E]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-sm font-bold text-main">{localized.name}</h3>
            {status === "installed" && (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-emerald-400/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                <Check className="h-3 w-3" />
                {t("installedBadge")}
              </span>
            )}
          </div>
          <p className="mt-0.5 line-clamp-2 text-xs text-sub/70">{localized.shortDescription}</p>
        </div>
      </div>
      {showsMarketplaceStats && (
      <div className="mt-auto flex items-center gap-4 pt-2 text-xs text-white/55">
        <span className="flex items-center gap-1 text-[#C9A25E]">
          <Star className="h-3.5 w-3.5 fill-current" />
          {extension.stats.reviewCount > 0 ? extension.stats.averageRating.toFixed(1) : "—"}
        </span>
        <span className="flex items-center gap-1">
          <Download className="h-3.5 w-3.5" />
          {extension.stats.downloadCount}
        </span>
      </div>
      )}
    </button>
  );
}
