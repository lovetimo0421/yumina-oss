import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { Plus, Loader2 } from "lucide-react";
import { useExtensionsStore } from "@/stores/extensions";
import { useExtensionPreview } from "@/features/extensions/extension-preview-store";
import { ExtensionIcon } from "@/features/extensions/extension-icon";
import type { ExtensionSummary } from "@yumina/shared";
import { useLocalizedExtension } from "@/features/extensions/use-localized-extension";

// Profile "Extensions" section — a visual sibling of the Personas carousel
// (same glass card + gold accent). Shows installed extensions as icon tiles plus
// a dashed "Get More" tile and a bottom-right "View More", both routing to the
// full extensions page.
export function ExtensionsSection() {
  const { t } = useTranslation("extensions");
  const router = useRouter();
  const installedList = useExtensionsStore((s) => s.installedList);
  const manageLoading = useExtensionsStore((s) => s.manageLoading);
  const fetchManage = useExtensionsStore((s) => s.fetchManage);
  const openPreview = useExtensionPreview((s) => s.open);

  useEffect(() => {
    void fetchManage();
  }, [fetchManage]);

  const goToDiscover = () => router.navigate({ to: "/app/extensions", search: { tab: "discover" } });
  const goToManage = () => router.navigate({ to: "/app/extensions", search: { tab: "manage" } });

  return (
    <section>
      {/* Section header */}
      <div className="mb-4 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-bold text-main">
          <div className="h-4 w-1 rounded-full bg-gold" />
          {t("title")}
        </h2>
      </div>

      {/* Glass card */}
      <div className="profile-overview-glass profile-overview-glass--soft group/section relative overflow-hidden rounded-2xl transition-all duration-300 hover:border-gold/30">
        <div className="absolute left-0 top-0 h-[2px] w-full bg-gradient-to-r from-gold/20 via-gold to-gold/20 opacity-50 transition-opacity group-hover/section:opacity-100" />

        {manageLoading && installedList.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-5 w-5 animate-spin text-gold/40" />
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3 p-5 sm:grid-cols-4 md:grid-cols-5">
              {installedList.map((ext) => (
                <InstalledExtensionTile key={ext.key} extension={ext} onOpen={() => openPreview(ext, "overview")} />
              ))}

              {/* Get more tile */}
              <button onClick={goToDiscover} className="group/new flex flex-col items-center gap-1.5">
                <div className="flex h-14 w-14 items-center justify-center rounded-xl border-2 border-dashed border-white/15 bg-white/[0.02] transition-all group-hover/new:border-gold/40 group-hover/new:bg-gold/5">
                  <Plus className="h-5 w-5 text-gold/40 transition-colors group-hover/new:text-gold/70" />
                </div>
                <span className="text-[10px] font-semibold text-sub/60 transition-colors group-hover/new:text-sub">
                  {t("getMore")}
                </span>
              </button>
            </div>

            {/* View more */}
            <div className="flex justify-end border-t border-white/5 px-5 py-3">
              <button
                onClick={goToManage}
                className="text-xs font-semibold text-gold/70 transition-colors hover:text-gold"
              >
                {t("viewMore")}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function InstalledExtensionTile({
  extension,
  onOpen,
}: {
  extension: ExtensionSummary;
  onOpen: () => void;
}) {
  const localized = useLocalizedExtension(extension);

  return (
    <button onClick={onOpen} className="group/tile flex flex-col items-center gap-1.5">
      <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-[#C9A25E]/25 bg-gradient-to-br from-[#C9A25E]/15 to-white/5 transition-all group-hover/tile:border-gold/50">
        <ExtensionIcon name={extension.icon} className="h-6 w-6 text-[#C9A25E]" />
      </div>
      <span className="max-w-[80px] truncate text-center text-[10px] font-medium text-sub/70">
        {localized.name}
      </span>
    </button>
  );
}
