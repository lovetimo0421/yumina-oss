import { useState, useMemo, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useEditorFocus } from "@/features/studio/lib/use-editor-focus";
import { Plus, Trash2, Hash, ArrowLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { DOCS_URLS } from "@/lib/docs-urls";
import { useEditorStore } from "@/stores/editor";
import { isContinuityOwned } from "@yumina/engine";
import { ModuleScopeChips } from "../components/module-scope-chips";
import { inModuleScope, moduleIdOfScope, normalizeModuleScope } from "../lib/module-scope";
import type { Variable } from "@yumina/engine";
import { OptionsEditor, PreciseTrackingEditor } from "../components/precise-tracking";
import { Select } from "@/components/ui/select";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";
import { NumberInput } from "@/components/ui/number-input";
import { DebouncedInput, DebouncedTextarea } from "../components/debounced-field";
import { OpeningValuesMatrix } from "../components/opening-values-matrix";
import { VariableActivationEditor } from "../components/variable-activation-editor";
import { VariableIdEditor, VariableNameReferenceHint } from "../components/variable-id-editor";

import { JsonDefaultValueEditor } from "../components/json-default-value-editor";

const TYPE_INDICATORS: Record<
  string,
  { symbol: string; colors: string; activeColors: string }
> = {
  number: {
    symbol: "#",
    colors: "border-border bg-card text-muted-foreground",
    activeColors: "border-primary/30 bg-primary/10 text-primary",
  },
  string: {
    symbol: "T",
    colors: "border-border bg-card text-muted-foreground",
    activeColors: "border-primary/30 bg-primary/10 text-primary",
  },
  boolean: {
    symbol: "?",
    colors: "border-border bg-card text-muted-foreground",
    activeColors: "border-primary/30 bg-primary/10 text-primary",
  },
  json: {
    symbol: "{}",
    colors: "border-border bg-card text-muted-foreground",
    activeColors: "border-primary/30 bg-primary/10 text-primary",
  },
};

export function VariablesSection({ compact, mobileListMode }: { compact?: boolean; mobileListMode?: boolean } = {}) {
  const { t } = useTranslation("editor");
  const worldDraft = useEditorStore(s => s.worldDraft);
  const addVariable = useEditorStore(s => s.addVariable);
  // 添加变量 puts a new one on the list and opens it, as the canvas does:
  // what it is, its range, whether the player sees it are all set in its
  // own form afterwards, not asked before it exists.
  const addNew = () => {
    const store = useEditorStore.getState();
    store.beginBatch();
    try {
      addVariable(moduleIdOfScope(scope) ?? undefined);
      const idx = useEditorStore.getState().worldDraft.variables.length - 1;
      if (idx < 0) return;
      useEditorStore.getState().updateVariableAt(idx, { name: String(t("blueprint.defaults.variable")) });
      selectVariable(idx);
    } finally {
      store.commitBatch();
    }
  };
  const updateVariableAt = useEditorStore(s => s.updateVariableAt);
  const removeVariableAt = useEditorStore(s => s.removeVariableAt);

  const typeOptions = useMemo(
    () =>
      (["number", "string", "boolean", "json"] as const).map((value) => ({
        value,
        label: t(`variables.types.${value}` as any),
      })),
    [t]
  );
  const aiAccessOptions = useMemo(
    () =>
      (["write", "read", "none"] as const).map((value) => ({
        value,
        label: t(`variables.aiAccessOptions.${value}` as any),
      })),
    [t]
  );
  // Openings for the greeting activation mode (same source as the worldbook picker).
  const greetings = useMemo(
    () => worldDraft.entries.filter((e) => e.role === "greeting"),
    [worldDraft.entries]
  );
  // Condition targets: any declared (non-engine) variable, self included — a
  // variable may gate on its own value ("show rage only while > 0").
  const conditionVars = useMemo(
    () => worldDraft.variables.filter((v) => !v.internal),
    [worldDraft.variables]
  );
  const [selectedIdx, setSelectedIdx] = useState<number | null>(() => {
    if (mobileListMode) return null;
    const first = worldDraft.variables.findIndex((v) => !v.internal); // skip hidden engine vars
    return first === -1 ? null : first;
  });

  // One module, or the card's shared ones — the same chip row the lorebook
  // and behaviours pages wear, so the module page can hand it over.
  const moduleScope = useEditorStore((s) => s.moduleScope);
  const setModuleScope = useEditorStore((s) => s.setModuleScope);
  const books = worldDraft.worldbooks ?? [];
  const scope = normalizeModuleScope(moduleScope, books);

  const [view, setView] = useState<"list" | "openings">("list");

  // Another page asked for one variable: open it, including from the values matrix.
  const pendingFocus = useEditorStore((s) => s.pendingFocus);
  const clearPendingFocus = useEditorStore((s) => s.clearPendingFocus);
  useEffect(() => {
    if (pendingFocus?.kind !== "variable") return;
    const idx = worldDraft.variables.findIndex((v) => v.id === pendingFocus.id);
    if (idx >= 0) {
      setSelectedIdx(idx);
      setView("list");
    }
    clearPendingFocus();
  }, [pendingFocus, worldDraft.variables, clearPendingFocus]);
  // "openings" view = the per-greeting initial-value matrix (single edit entry
  // point; First Message mirrors it read-only). Only offered when the card has
  // at least one opening to seed.
  // Which JSON default is expanded to full-height editing; the form hides its
  // other fields while one is (see the container's class below).
  const [expandedJsonId, setExpandedJsonId] = useState<string | null>(null);
  // Whether the "Technical information" <details> is open (see below).
  const [technicalOpenFor, setTechnicalOpenFor] = useState<string | null>(null);
  const selectVariable = (idx: number | null) => setSelectedIdx(idx);
  const greetingCount = worldDraft.entries.filter((e) => e.role === "greeting").length;
  const showOpeningsToggle = greetingCount >= 1 && worldDraft.variables.length >= 1;

  // Clamp selectedIdx when variables array changes (e.g., AI adds/removes variables).
  // Respect an explicit null so the mobile back button (which sets selectedIdx=null)
  // actually returns the user to the list view instead of snapping back to index 0.
  const clampedIdx = useMemo(() => {
    if (selectedIdx === null) return null;
    if (worldDraft.variables.length === 0) return null;
    if (selectedIdx >= worldDraft.variables.length) return worldDraft.variables.length - 1;
    return selectedIdx;
  }, [selectedIdx, worldDraft.variables.length]);

  const selectedRaw = clampedIdx !== null ? worldDraft.variables[clampedIdx] ?? null : null;
  const selected = selectedRaw?.internal ? null : selectedRaw; // never open a hidden engine var
  const preciseOwned = selected ? isContinuityOwned(worldDraft, selected) : false;
  useEditorFocus("variable", selected?.id, worldDraft);

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      {/* Header (full editor only) */}
      {!compact && (
        <div className="shrink-0 border-b border-border bg-card px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="max-w-xl">
              <h1 className="text-[22px] font-bold tracking-tight text-foreground">
                {t("variables.title")}
              </h1>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t("variables.description")}{" "}
                <a href={DOCS_URLS.variables} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t("variables.learnMore")}</a>
              </p>
            </div>
            <div className="relative">
              <button
                onClick={addNew}
                data-tour="vars-add"
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow-[0_0_15px_hsl(var(--primary)/0.3)] transition-colors hover:bg-primary/90"
              >
                <Plus className="h-3.5 w-3.5" /> {t("variables.addVariable")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* View toggle — per-variable editing vs the per-opening initial-value matrix */}
      {showOpeningsToggle && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border bg-card px-4 py-2">
          {(["list", "openings"] as const).map((mode) => (
            <button
              key={mode}
              onClick={() => setView(mode)}
              className={cn(
                "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                view === mode
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground"
              )}
            >
              {mode === "list" ? t("variables.viewList") : t("variables.viewOpenings")}
            </button>
          ))}
        </div>
      )}

      {showOpeningsToggle && view === "openings" ? (
        <OpeningValuesMatrix />
      ) : (
      /* Two-panel body */
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden @[640px]:flex-row">
        {/* Left panel — variable list */}
        <div className={cn(
          "w-full overflow-y-auto border-b border-border bg-sidebar p-5",
          "@[640px]:w-80 @[640px]:shrink-0 @[640px]:border-b-0 @[640px]:border-r",
          clampedIdx !== null && "hidden @[640px]:flex @[640px]:flex-col"
        )}>
          {/* Compact add button */}
          {compact && (
            <div className="mb-3 flex items-center justify-end">
              <div className="relative">
                <button
                  onClick={addNew}
                  data-tour="vars-add"
                  className="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <Plus className="h-3 w-3" /> {t("variables.add")}
                </button>
              </div>
            </div>
          )}
          {books.length > 0 && (
            <ModuleScopeChips value={scope} onChange={setModuleScope} books={books} className="mb-3" />
          )}
          {!worldDraft.variables.some((v) => !v.internal) ? (
            <div className="px-4 py-10 text-center">
              <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent">
                <Hash className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-muted-foreground">
                {t("variables.noVariables")}
              </p>
              <p className="mt-1.5 max-w-xs mx-auto text-xs text-muted-foreground/60">{t("variables.noVariablesDesc")}</p>
              <a href={DOCS_URLS.variables} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs text-primary hover:underline">{t("variables.learnMore")}</a>
            </div>
          ) : !worldDraft.variables.some((v) => !v.internal && inModuleScope(scope, v.worldbookId)) ? (
            // The module chips can hide every variable while the card still
            // has some — say so instead of showing a blank list.
            <div className="rounded-xl border border-dashed border-border py-8 text-center">
              <p className="text-xs text-muted-foreground/50">
                {t("modules.scope.empty", "Nothing in this module yet")}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2" data-tour="vars-list">
              {worldDraft.variables.map((v, idx) => {
                // Engine-managed vars (e.g. random-pick cooldown history) are
                // hidden — the creator shouldn't see or delete them. Return null
                // to keep the index-based selection below intact. Out-of-scope
                // variables are skipped the same way.
                if (v.internal || !inModuleScope(scope, v.worldbookId)) return null;
                const isActive = clampedIdx === idx;
                const indicator = TYPE_INDICATORS[v.type] ?? TYPE_INDICATORS.string;
                return (
                  <button
                    key={idx}
                    onClick={() => selectVariable(idx)}
                    className={cn(
                      "flex items-center justify-between rounded-xl p-4 text-left transition-all",
                      isActive
                        ? "border border-primary/30 bg-primary/[0.06] shadow-[0_0_15px_hsl(var(--primary)/0.08)]"
                        : "border border-transparent hover:bg-accent"
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={cn(
                          "flex h-6 w-6 items-center justify-center rounded-lg border font-mono text-xs font-bold",
                          isActive ? indicator.activeColors : indicator.colors
                        )}
                      >
                        {indicator.symbol}
                      </div>
                      <span
                        className={cn(
                          "text-sm font-bold",
                          isActive ? "text-primary" : "text-foreground"
                        )}
                      >
                        {v.name || t("variables.unnamed")}
                      </span>
                      {isContinuityOwned(worldDraft, v) ? (
                        <span className="shrink-0 rounded-full bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                          {t("variables.badges.precise")}
                        </span>
                      ) : (v.aiAccess === "read" || v.aiAccess === "none") && (
                        <span className="shrink-0 rounded-full bg-white/5 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                          {t(`variables.badges.${v.aiAccess}` as any)}
                        </span>
                      )}
                      {v.activation && v.activation.mode !== "always" && (
                        <span className="shrink-0 rounded-full bg-sky-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-sky-300">
                          {t(`variables.badges.${v.activation.mode}` as any)}
                        </span>
                      )}
                    </div>
                    {isActive && (
                      <div className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.8)]" />
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Right panel — variable form */}
        <div className={cn(
          "flex-1 overflow-y-auto",
          clampedIdx === null && "hidden @[640px]:flex"
        )}>
          {selected && clampedIdx !== null ? (
            <div className="p-4 @[900px]:p-6">
              <button
                onClick={() => selectVariable(null)}
                className="mb-4 flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground @[640px]:hidden"
              >
                <ArrowLeft className="h-4 w-4" /> {t("variables.back")}
              </button>
              <div className="mb-5 flex max-w-3xl items-center justify-between">
                <h2 className="text-xl font-bold text-foreground">{t("variables.editVariable")}</h2>
                <TwoTapDeleteButton
                  onConfirm={() => {
                    removeVariableAt(clampedIdx);
                    const vars =
                      useEditorStore.getState().worldDraft.variables;
                    selectVariable(vars.length > 0 ? 0 : null);
                  }}
                  className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10"
                  armedChildren={<><Trash2 className="h-4 w-4" /> {t("twoTapConfirm")}</>}
                >
                  <Trash2 className="h-4 w-4" /> {t("variables.delete")}
                </TwoTapDeleteButton>
              </div>

              <div className={cn("max-w-3xl space-y-8", expandedJsonId === selected.id && selected.type === "json" && "[&>div:not([data-json-default])]:hidden")} data-tour="vars-form">
                {/* Name */}
                <div className="space-y-3">
                  <label className="text-sm font-bold text-foreground">
                    {t("variables.displayName")}
                  </label>
                  <DebouncedInput
                    type="text"
                    value={selected.name}
                    onCommit={(name) => updateVariableAt(clampedIdx, { name })}
                    syncKey={selected.id}
                    className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground shadow-inner transition-all focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                  <VariableNameReferenceHint world={worldDraft} variable={selected} />
                </div>

                {/* Type */}
                <div className="space-y-3">
                  <label className="text-sm font-bold text-foreground">{t("variables.type")}</label>
                  <Select
                    value={selected.type}
                    onValueChange={(value) => {
                      const type = value as Variable["type"];
                      const defaultValue =
                        type === "number" ? 0 : type === "boolean" ? false : type === "json" ? {} : "";
                      updateVariableAt(clampedIdx, { type, defaultValue, defaultValueText: undefined });
                    }}
                    options={typeOptions}
                    className="py-3"
                  />
                </div>

                {/* Default value */}
                <div data-json-default className="space-y-3">
                  <label className="text-sm font-bold text-foreground">
                    {t("variables.defaultValue")}
                  </label>
                  {selected.type === "boolean" ? (
                    <button
                      onClick={() =>
                        updateVariableAt(clampedIdx, {
                          defaultValue: !selected.defaultValue,
                        })
                      }
                      className={cn(
                        "rounded-xl px-4 py-3 text-sm font-medium transition-colors",
                        selected.defaultValue
                          ? "bg-primary text-primary-foreground"
                          : "bg-accent text-muted-foreground"
                      )}
                    >
                      {selected.defaultValue ? t("variables.booleanTrue") : t("variables.booleanFalse")}
                    </button>
                  ) : selected.type === "number" ? (
                    <NumberInput
                      value={selected.defaultValue as number}
                      onChange={(val) =>
                        updateVariableAt(clampedIdx, {
                          defaultValue: val === "" ? 0 : val,
                        })
                      }
                    />
                  ) : selected.type === "json" ? (
                    <JsonDefaultValueEditor
                      key={selected.id}
                      variable={selected}
                      expanded={expandedJsonId === selected.id}
                      onExpandedChange={(expanded) => setExpandedJsonId(expanded ? selected.id : null)}
                      onChange={(updates) => updateVariableAt(clampedIdx, updates)}
                    />
                  ) : (
                    <DebouncedInput
                      type="text"
                      value={String(selected.defaultValue ?? "")}
                      onCommit={(defaultValue) => updateVariableAt(clampedIdx, { defaultValue })}
                      syncKey={selected.id}
                      className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground shadow-inner transition-all focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                    />
                  )}
                </div>

                {/* Activation — when this variable is "in play" */}
                <div role="group" className="space-y-3 border-t border-border/60 pt-5" aria-label={t("variables.activationLabel")}>
                  <h3 className="text-sm font-semibold text-foreground">{t("variables.activationLabel")}</h3>
                  <VariableActivationEditor key={selected.id} variable={selected} variables={conditionVars} greetings={greetings}
                    onChange={(updates) => updateVariableAt(clampedIdx, updates)} />
                </div>

                {/* Number-specific: min/max */}
                {selected.type === "number" && (
                  <div className="grid grid-cols-2 gap-6">
                    <div className="space-y-3">
                      <label className="text-sm font-bold text-foreground">{t("variables.min")}</label>
                      <NumberInput
                        value={selected.min ?? ""}
                        onChange={(val) =>
                          updateVariableAt(clampedIdx, {
                            min: val === "" ? undefined : val,
                          })
                        }
                        placeholder={t("variables.noMin")}
                      />
                    </div>
                    <div className="space-y-3">
                      <label className="text-sm font-bold text-foreground">{t("variables.max")}</label>
                      <NumberInput
                        value={selected.max ?? ""}
                        onChange={(val) =>
                          updateVariableAt(clampedIdx, {
                            max: val === "" ? undefined : val,
                          })
                        }
                        placeholder={t("variables.noMax")}
                      />
                    </div>
                  </div>
                )}

                {/* String-specific: the fixed set of values it may take. Not
                    adding any = the AI writes it freely, as before. */}
                {selected.type === "string" && (
                  <div className="space-y-3">
                    <label className="text-sm font-bold text-foreground">{t("variables.optionsLabel")}</label>
                    <OptionsEditor
                      key={selected.id}
                      values={selected.options ?? []}
                      onChange={(options) => updateVariableAt(clampedIdx, { options: options.length > 0 ? options : undefined })}
                      addLabel={t("variables.optionsAdd")}
                      placeholder={t("variables.optionsPlaceholder")}
                    />
                    <p className="text-sm text-muted-foreground">{t("variables.optionsHint")}</p>
                  </div>
                )}

                {/* Precise tracking — the continuity judge, not the narrative
                    model, sets this value after each reply. Strings only get
                    the box once they have a value list to pick from. */}
                {(selected.type === "number" ||
                  selected.type === "boolean" ||
                  (selected.type === "string" && (selected.options?.length ?? 0) > 0)) && (
                  <PreciseTrackingEditor key={selected.id} variable={selected} onChange={(u) => updateVariableAt(clampedIdx, u)} />
                )}

                {/* Behavior Rules */}
                <div className="space-y-3">
                  <label className="text-sm font-bold text-foreground">
                    {t("variables.behaviorRules")}
                  </label>
                  <DebouncedTextarea
                    value={selected.behaviorRules ?? selected.updateHints ?? ""}
                    onCommit={(v) =>
                      updateVariableAt(clampedIdx, {
                        behaviorRules: v || undefined,
                      })
                    }
                    syncKey={selected.id}
                    placeholder={t("variables.behaviorRulesPlaceholder")}
                    rows={3}
                    className="min-h-[96px] w-full resize-y rounded-xl border border-border bg-card px-4 py-4 text-sm leading-relaxed text-foreground shadow-inner transition-all placeholder:text-muted-foreground/30 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                  <p className="text-sm text-muted-foreground">
                    {t("variables.behaviorRulesHint")}
                  </p>
                </div>

                {/* Module membership — inactive worldbook gates the variable */}
                {(worldDraft.worldbooks?.length ?? 0) > 0 && (
                  <div className="space-y-2">
                    <label className="text-sm font-bold text-foreground">
                      {t("variables.worldbookLabel")}
                    </label>
                    <select
                      value={selected.worldbookId ?? ""}
                      onChange={(e) =>
                        updateVariableAt(clampedIdx, { worldbookId: e.target.value || undefined })
                      }
                      className="w-full rounded-xl border border-border bg-card px-4 py-2.5 text-sm text-foreground focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                    >
                      <option value="">{t("variables.worldbookCore")}</option>
                      {(worldDraft.worldbooks ?? []).map((wb) => (
                        <option key={wb.id} value={wb.id}>{wb.name}</option>
                      ))}
                    </select>
                    <p className="text-sm text-muted-foreground">{t("variables.worldbookHint")}</p>
                  </div>
                )}

                {/* AI access — what the AI may do with this variable. Last on
                    purpose: most authors never change it. */}
                <div className="space-y-3 border-t border-border/60 pt-5">
                  <label className="text-sm font-bold text-foreground">
                    {t("variables.aiAccessLabel")}
                  </label>
                  <Select
                    value={selected.aiAccess ?? "write"}
                    onValueChange={(value) =>
                      // Store the default ("write") as undefined so legacy
                      // exports stay byte-identical.
                      updateVariableAt(clampedIdx, {
                        aiAccess: value === "write" ? undefined : (value as Variable["aiAccess"]),
                      })
                    }
                    options={
                      preciseOwned
                        ? aiAccessOptions.map((o) =>
                            o.value === "write" ? { ...o, label: t("variables.aiAccessOptions.precise") } : o,
                          )
                        : aiAccessOptions
                    }
                    className="py-3"
                  />
                  <p className="text-sm text-muted-foreground">
                    {preciseOwned
                      ? t("variables.aiAccessHint.precise")
                      : t(`variables.aiAccessHint.${selected.aiAccess ?? "write"}` as any)}
                  </p>
                </div>

                <details
                  key={`technical-${clampedIdx}`}
                  className="group/technical rounded-xl border border-border/60"
                  onToggle={(e) => setTechnicalOpenFor(e.currentTarget.open ? selected.id : null)}
                >
                  <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                    <ChevronRight className="h-4 w-4 shrink-0 transition-transform group-open/technical:rotate-90" />
                    {t("variables.editing.technicalInfo", { defaultValue: "Technical information" })}
                    <code className="ml-auto min-w-0 truncate text-[11px] font-normal">{selected.id}</code>
                  </summary>
                  <div className="space-y-3 border-t border-border/60 px-4 py-4">
                    {/* Mounted only while open: a closed <details> still renders
                        its children, and the ID editor scans every entry and
                        interface file for references. */}
                    {technicalOpenFor === selected.id && (
                      <VariableIdEditor key={clampedIdx} world={worldDraft} variable={selected} onCommit={(id) => {
                        updateVariableAt(clampedIdx, { id });
                        const nextId = useEditorStore.getState().worldDraft.variables[clampedIdx]?.id ?? selected.id;
                        // Keep the section open across the id change.
                        setTechnicalOpenFor(nextId);
                        return nextId;
                      }} />
                    )}
                  </div>
                </details>

                <div className="pb-12" />
              </div>
            </div>
          ) : conditionVars.length > 0 ? (
            // The list on the left already says when there are none.
            <div className="flex flex-1 flex-col items-center justify-center pb-20 text-center opacity-50">
              <Hash className="mb-4 h-16 w-16 text-muted-foreground opacity-50" />
              <p className="text-sm text-muted-foreground">{t("variables.pickToEdit")}</p>
            </div>
          ) : null}
        </div>
      </div>
      )}
    </div>
  );
}
