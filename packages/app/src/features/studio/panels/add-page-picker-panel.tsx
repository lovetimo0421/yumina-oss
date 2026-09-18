import { useMemo } from "react";
import type { IDockviewPanelProps } from "dockview-react";
import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import {
  addStudioPanelInstance,
  PANEL_MENU_GROUPS,
  type StudioAddPagePickerParams,
} from "../studio-page-catalog";

const VARIANT_RESTRICTED_PANELS = new Set(["overview"]);

export function AddPagePickerPanel(props: IDockviewPanelProps<StudioAddPagePickerParams>) {
  const { t } = useTranslation("editor");
  const variants = useEditorStore((s) => s.variants);
  const serverWorldId = useEditorStore((s) => s.serverWorldId);

  // Flag-based (not tab-position) primary detection — matches the 主/副 model.
  const currentVariant = variants.find((v) => v.id === serverWorldId);
  const isNonPrimaryVariant = !!currentVariant && currentVariant.isPrimaryVariant === false;

  const filteredGroups = useMemo(() => {
    if (!isNonPrimaryVariant) return PANEL_MENU_GROUPS;
    return PANEL_MENU_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter((item) => !VARIANT_RESTRICTED_PANELS.has(item.id)),
    })).filter((group) => group.items.length > 0);
  }, [isNonPrimaryVariant]);

  const handleSelect = (panelId: string, title: string) => {
    addStudioPanelInstance({
      containerApi: props.containerApi,
      panelId,
      title,
      referenceGroupId: props.api.group.id,
      referencePanelId: props.api.id,
    });
    props.api.close();
  };

  return (
    <div className="h-full overflow-y-auto bg-background/70 p-4">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <div className="rounded-2xl border border-border/60 bg-muted/20 px-4 py-3">
          <p className="text-sm font-semibold text-foreground">{t("studio.addPanel")}</p>
        </div>

        {filteredGroups.map((group) => (
          <section
            key={group.labelKey}
            className="rounded-2xl border border-border/60 bg-muted/10 p-4"
          >
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
              {t(group.labelKey)}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              {group.items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleSelect(item.id, t(item.labelKey))}
                  className={cn(
                    "group flex items-center gap-3 rounded-xl border border-border/60 bg-background/40 px-3 py-3 text-left transition-colors",
                    "hover:border-primary/30 hover:bg-background/70"
                  )}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/70 text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                    <item.icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{t(item.labelKey)}</p>
                    <p className="text-xs text-muted-foreground">{t(group.labelKey)}</p>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground/70 transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
