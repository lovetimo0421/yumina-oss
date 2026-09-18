import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { Variable } from "@yumina/engine";
import { PanelRight, SlidersHorizontal, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import {
  useStudioSidebarStore,
  type PreviewVariableValue,
  type SidebarSectionKey,
} from "@/stores/studio-sidebar";

const SECTION_OPTIONS: Array<{
  key: SidebarSectionKey;
  labelKey: string;
  descriptionKey: string;
}> = [
  {
    key: "variables",
    labelKey: "studio.sidebar.variables",
    descriptionKey: "studio.sidebar.variablesDesc",
  },
  {
    key: "overridesOnly",
    labelKey: "studio.sidebar.overridesOnly",
    descriptionKey: "studio.sidebar.overridesOnlyDesc",
  },
  {
    key: "worldSummary",
    labelKey: "studio.sidebar.worldSummary",
    descriptionKey: "studio.sidebar.worldSummaryDesc",
  },
  {
    key: "componentSummary",
    labelKey: "studio.sidebar.componentSummary",
    descriptionKey: "studio.sidebar.componentSummaryDesc",
  },
];

function formatValue(value: PreviewVariableValue) {
  if (typeof value === "string") return value.length > 0 ? value : '""';
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2);
  return "";
}

const EMPTY_OVERRIDES: Record<string, PreviewVariableValue> = {};

export function SidebarPanel() {
  const { t } = useTranslation("editor");
  const worldDraft = useEditorStore(s => s.worldDraft);
  const worldKey = worldDraft.id || "new";

  const sectionVisibility = useStudioSidebarStore((state) => state.sectionVisibility);
  const previewVariableOverridesByWorld = useStudioSidebarStore(
    (state) => state.previewVariableOverridesByWorld
  );
  const setSectionVisibility = useStudioSidebarStore((state) => state.setSectionVisibility);
  const setPreviewVariableOverride = useStudioSidebarStore(
    (state) => state.setPreviewVariableOverride
  );
  const clearPreviewVariableOverride = useStudioSidebarStore(
    (state) => state.clearPreviewVariableOverride
  );
  const clearPreviewVariableOverrides = useStudioSidebarStore(
    (state) => state.clearPreviewVariableOverrides
  );

  const worldOverrides = useMemo(
    () => previewVariableOverridesByWorld[worldKey] ?? EMPTY_OVERRIDES,
    [previewVariableOverridesByWorld, worldKey]
  );

  const rows = useMemo(() => {
    return worldDraft.variables
      .map((variable) => {
        const hasOverride = Object.prototype.hasOwnProperty.call(
          worldOverrides,
          variable.id
        );
        const effectiveValue = hasOverride
          ? worldOverrides[variable.id]!
          : variable.defaultValue;
        return { variable, hasOverride, effectiveValue };
      })
      .filter((item) =>
        sectionVisibility.overridesOnly ? item.hasOverride : true
      );
  }, [worldDraft.variables, worldOverrides, sectionVisibility.overridesOnly]);

  const overrideCount = rows.filter((item) => item.hasOverride).length;
  const enabledEntries = worldDraft.entries.filter((entry) => entry.enabled).length;
  const enabledRules = worldDraft.rules.filter((rule) => rule.enabled).length;
  const visibleComponents = worldDraft.components
    .filter((component) => component.visible !== false)
    .sort((left, right) => left.order - right.order);
  // Every world has rootComponent after v19→v20 migration. Legacy customUI[]
  // visibility summary removed — the relevant measure is now "how many files
  // does the rootComponent have."
  const rootFileCount = Object.keys(worldDraft.rootComponent?.files ?? {}).length;

  const applyPreviewValue = (variable: Variable, nextValue: PreviewVariableValue) => {
    if (nextValue === variable.defaultValue) {
      clearPreviewVariableOverride(worldKey, variable.id);
      return;
    }
    setPreviewVariableOverride(worldKey, variable.id, nextValue);
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <PanelRight className="h-3.5 w-3.5 text-primary" />
        <span className="text-xs font-medium text-foreground">{t("studio.sidebar.title")}</span>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-3">
        <section className="rounded-lg border border-border/80 bg-card/70 p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-foreground">{t("studio.sidebar.previewControls")}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("studio.sidebar.previewControlsDesc")}
              </p>
            </div>
            <SlidersHorizontal className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          </div>

          <div className="mt-3 space-y-2">
            {SECTION_OPTIONS.map((section) => (
              <label
                key={section.key}
                className="flex cursor-pointer items-start gap-2 rounded-md border border-border/50 bg-background/60 px-2.5 py-2"
              >
                <input
                  type="checkbox"
                  checked={sectionVisibility[section.key]}
                  onChange={(event) =>
                    setSectionVisibility(section.key, event.target.checked)
                  }
                  className="mt-0.5 h-3.5 w-3.5 rounded border-border bg-background"
                />
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-foreground">
                    {t(section.labelKey as any)}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {t(section.descriptionKey as any)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </section>

        {sectionVisibility.worldSummary && (
          <section className="rounded-lg border border-border/80 bg-card/70 p-3">
            <p className="text-xs font-semibold text-foreground">{t("studio.sidebar.worldSummary")}</p>
            <div className="mt-2 grid grid-cols-2 gap-1.5 text-[11px] text-muted-foreground">
              <Stat label={t("studio.sidebar.lorebook")} value={`${enabledEntries}/${worldDraft.entries.length}`} />
              <Stat label={t("studio.sidebar.variables")} value={String(worldDraft.variables.length)} />
              <Stat label={t("studio.sidebar.rules")} value={`${enabledRules}/${worldDraft.rules.length}`} />
              <Stat label={t("studio.sidebar.widgets")} value={String(visibleComponents.length)} />
              <Stat label={t("studio.sidebar.customUi")} value={String(rootFileCount)} />
            </div>
          </section>
        )}

        {sectionVisibility.componentSummary && (
          <section className="rounded-lg border border-border/80 bg-card/70 p-3">
            <p className="text-xs font-semibold text-foreground">{t("studio.sidebar.componentSnapshot")}</p>
            {visibleComponents.length === 0 && rootFileCount === 0 ? (
              <p className="mt-2 text-[11px] text-muted-foreground">{t("studio.sidebar.noVisibleComponents")}</p>
            ) : (
              <div className="mt-2 space-y-1.5">
                {visibleComponents.map((component) => (
                  <div
                    key={component.id}
                    className="rounded-md border border-border/60 bg-background/60 px-2.5 py-2 text-[11px]"
                  >
                    <p className="truncate font-medium text-foreground">
                      {component.name || component.type}
                    </p>
                    <p className="text-muted-foreground">
                      {component.type} - {component.placement ?? "header"}
                    </p>
                  </div>
                ))}
                {worldDraft.rootComponent && Object.keys(worldDraft.rootComponent.files).map((filename) => (
                  <div
                    key={filename}
                    className="rounded-md border border-border/60 bg-background/60 px-2.5 py-2 text-[11px]"
                  >
                    <p className="truncate font-mono font-medium text-foreground">{filename}</p>
                    <p className="text-muted-foreground">
                      {filename === worldDraft.rootComponent?.entryFile ? "entry file" : "sub-file"}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {sectionVisibility.variables && (
          <section className="rounded-lg border border-border/80 bg-card/70 p-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-foreground">{t("studio.sidebar.variables")}</p>
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-muted-foreground">
                  {t("studio.sidebar.shown", { count: rows.length })}
                </span>
                <button
                  type="button"
                  disabled={overrideCount === 0}
                  onClick={() => clearPreviewVariableOverrides(worldKey)}
                  className="inline-flex items-center gap-1 rounded-md border border-border/70 px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                >
                  <RotateCcw className="h-3 w-3" />
                  {t("studio.sidebar.resetAll")}
                </button>
              </div>
            </div>

            {rows.length === 0 ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                {sectionVisibility.overridesOnly
                  ? t("studio.sidebar.noOverrides")
                  : t("studio.sidebar.noVariables")}
              </p>
            ) : (
              <div className="mt-2 space-y-2">
                {rows.map((item) => {
                  const { variable, hasOverride, effectiveValue } = item;
                  const badgeClass = hasOverride
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-border/60 bg-background/60 text-muted-foreground";

                  return (
                    <div
                      key={variable.id}
                      className="rounded-md border border-border/60 bg-background/50 p-2.5"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-xs font-medium text-foreground">
                            {variable.name || variable.id}
                          </p>
                          <p className="truncate text-[11px] text-muted-foreground">
                            {variable.id} - {variable.type}
                          </p>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span
                            className={cn(
                              "rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                              badgeClass
                            )}
                          >
                            {hasOverride ? t("studio.sidebar.override") : t("studio.sidebar.defaultBadge")}
                          </span>
                          {hasOverride && (
                            <button
                              type="button"
                              onClick={() =>
                                clearPreviewVariableOverride(worldKey, variable.id)
                              }
                              className="rounded border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                            >
                              {t("studio.sidebar.reset")}
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="mt-2">
                        {variable.type === "boolean" ? (
                          <div className="flex items-center gap-1.5">
                            {[true, false].map((value) => (
                              <button
                                key={String(value)}
                                type="button"
                                onClick={() => applyPreviewValue(variable, value)}
                                className={cn(
                                  "rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
                                  effectiveValue === value
                                    ? "border-primary/60 bg-primary/10 text-primary"
                                    : "border-border/70 text-muted-foreground hover:text-foreground"
                                )}
                              >
                                {value ? "true" : "false"}
                              </button>
                            ))}
                          </div>
                        ) : variable.type === "number" ? (
                          <input
                            type="number"
                            value={
                              typeof effectiveValue === "number"
                                ? String(effectiveValue)
                                : String(variable.defaultValue)
                            }
                            onChange={(event) => {
                              const raw = event.target.value.trim();
                              if (raw.length === 0) {
                                applyPreviewValue(
                                  variable,
                                  variable.defaultValue as number
                                );
                                return;
                              }
                              const parsed = Number(raw);
                              if (!Number.isNaN(parsed)) {
                                applyPreviewValue(variable, parsed);
                              }
                            }}
                            className="w-full rounded-md border border-border/70 bg-background px-2 py-1 text-[11px] text-foreground outline-none focus:border-primary/50"
                          />
                        ) : (
                          <input
                            type="text"
                            value={
                              typeof effectiveValue === "string"
                                ? effectiveValue
                                : String(variable.defaultValue)
                            }
                            onChange={(event) =>
                              applyPreviewValue(variable, event.target.value)
                            }
                            className="w-full rounded-md border border-border/70 bg-background px-2 py-1 text-[11px] text-foreground outline-none focus:border-primary/50"
                          />
                        )}
                      </div>

                      <p className="mt-1 text-[10px] text-muted-foreground">
                        {t("studio.sidebar.defaultValue", { value: formatValue(variable.defaultValue) })}
                        {hasOverride && (
                          <>
                            {" - "}{t("studio.sidebar.previewValue", { value: formatValue(effectiveValue) })}
                          </>
                        )}
                      </p>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-border/60 bg-background/60 px-2 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-muted-foreground/80">
        {label}
      </p>
      <p className="text-xs font-medium text-foreground">{value}</p>
    </div>
  );
}
