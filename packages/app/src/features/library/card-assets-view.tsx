import { useState } from "react";
import { useTranslation } from "react-i18next";
import { LibraryAssetsTab } from "@/features/library/library-assets-tab";
import { BoundAssetsView } from "@/features/library/bound-assets-view";
import { useEditorStore } from "@/stores/editor";

/**
 * Asset surface shown inside the card editor (both the classic editor shell and
 * the new Studio "资源" panel). Defaults to the card's own bound folders +
 * referenced assets, with a toggle to the full asset library. Falls back to the
 * full library when the card hasn't been saved yet (no id to bind against).
 */
export function CardAssetsView() {
  const { t } = useTranslation("library");
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const [tab, setTab] = useState<"card" | "all">("card");

  const activeTab = serverWorldId ? tab : "all";

  return (
    <div>
      {serverWorldId && (
        <div className="mb-5 inline-flex rounded-lg border border-border bg-card/40 p-0.5">
          <button
            onClick={() => setTab("card")}
            className={`rounded-md px-4 py-1.5 text-xs font-semibold transition-colors ${
              activeTab === "card"
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t("bindings.tabCard")}
          </button>
          <button
            onClick={() => setTab("all")}
            className={`rounded-md px-4 py-1.5 text-xs font-semibold transition-colors ${
              activeTab === "all"
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {t("bindings.tabAll")}
          </button>
        </div>
      )}

      {activeTab === "card" && serverWorldId ? (
        <BoundAssetsView worldId={serverWorldId} />
      ) : (
        <LibraryAssetsTab />
      )}
    </div>
  );
}
