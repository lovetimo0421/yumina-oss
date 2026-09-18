import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, Hash, ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";
import { DOCS_URLS } from "@/lib/docs-urls";
import { useEditorStore } from "@/stores/editor";
import type { Variable, VariableActivation } from "@yumina/engine";
import { Select } from "@/components/ui/select";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";
import { NumberInput } from "@/components/ui/number-input";
import { DebouncedInput, DebouncedTextarea } from "../components/debounced-field";
import { OpeningValuesMatrix } from "../components/opening-values-matrix";
import { ConditionEditor } from "../components/condition-editor";

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
  // "openings" view = the per-greeting initial-value matrix (single edit entry
  // point; First Message mirrors it read-only). Only offered when the card has
  // at least one opening to seed.
  const [expandedJsonId, setExpandedJsonId] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "openings">("list");
  // The store silently dedupes colliding ids. This note sits under the ID
  // field so the creator sees why their input didn't land verbatim — a muted
  // hint, not a destructive error: nothing went wrong, the id just moved.
  const [idNote, setIdNote] = useState<string | null>(null);
  const selectVariable = (idx: number | null) => {
    setSelectedIdx(idx);
    setIdNote(null);
  };
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
            <button
              onClick={() => {
                addVariable();
                const vars = useEditorStore.getState().worldDraft.variables;
                selectVariable(vars.length - 1);
              }}
              data-tour="vars-add"
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow-[0_0_15px_hsl(var(--primary)/0.3)] transition-colors hover:bg-primary/90"
            >
              <Plus className="h-3.5 w-3.5" /> {t("variables.addVariable")}
            </button>
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
              <button
                onClick={() => {
                  addVariable();
                  const vars = useEditorStore.getState().worldDraft.variables;
                  selectVariable(vars.length - 1);
                }}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Plus className="h-3 w-3" /> {t("variables.add")}
              </button>
            </div>
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
          ) : (
            <div className="flex flex-col gap-2">
              {worldDraft.variables.map((v, idx) => {
                // Engine-managed vars (e.g. random-pick cooldown history) are
                // hidden — the creator shouldn't see or delete them. Return null
                // to keep the index-based selection below intact.
                if (v.internal) return null;
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
                      {(v.aiAccess === "read" || v.aiAccess === "none") && (
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
            <div className="p-8 lg:p-12">
              <button
                onClick={() => selectVariable(null)}
                className="mb-4 flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground @[640px]:hidden"
              >
                <ArrowLeft className="h-4 w-4" /> {t("variables.back")}
              </button>
              <div className="mb-8 flex max-w-3xl items-center justify-between">
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
                {/* ID */}
                <div className="space-y-3">
                  <label className="text-sm font-bold text-foreground">{t("variables.id")}</label>
                  <DebouncedInput
                    type="text"
                    value={selected.id}
                    transform={(raw) => raw.replace(/\s+/g, "_").toLowerCase()}
                    onCommit={(newId) => {
                      updateVariableAt(clampedIdx, { id: newId });
                      // The store dedupes colliding ids (auto _2/_3 suffix) and
                      // keeps the old id when the input was emptied — tell the
                      // creator when their input didn't land verbatim.
                      const finalId =
                        useEditorStore.getState().worldDraft.variables[clampedIdx]?.id;
                      setIdNote(
                        finalId && newId.trim() && finalId !== newId
                          ? t("variables.idTaken", { id: finalId })
                          : null
                      );
                    }}
                    syncKey={selected.id}
                    aria-describedby="variable-id-note"
                    className="w-full rounded-xl border border-border bg-card px-4 py-3 font-mono text-sm text-foreground shadow-inner transition-all focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                  {idNote && (
                    <p id="variable-id-note" role="status" className="text-sm text-muted-foreground/70">
                      {idNote}
                    </p>
                  )}
                  <p className="text-sm text-muted-foreground">
                    {t("variables.idHintPrefix")}{" "}
                    <span className="font-mono text-primary">{`{{${selected.id}}}`}</span>
                  </p>
                </div>

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
                    <input
                      type="text"
                      value={selected.defaultValue as string}
                      onChange={(e) =>
                        updateVariableAt(clampedIdx, {
                          defaultValue: e.target.value,
                        })
                      }
                      className="w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground shadow-inner transition-all focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                    />
                  )}
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
                    rows={4}
                    className="min-h-[120px] w-full resize-y rounded-xl border border-border bg-card px-4 py-4 text-sm leading-relaxed text-foreground shadow-inner transition-all placeholder:text-muted-foreground/30 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50"
                  />
                  <p className="text-sm text-muted-foreground">
                    {t("variables.behaviorRulesHint")}
                  </p>
                </div>

                {/* AI access — what the AI may do with this variable */}
                <div className="space-y-3">
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
                    options={aiAccessOptions}
                    className="py-3"
                  />
                  <p className="text-sm text-muted-foreground">
                    {t(`variables.aiAccessHint.${selected.aiAccess ?? "write"}` as any)}
                  </p>
                </div>

                {/* Activation — when this variable is "in play" */}
                {(() => {
                  const activation: VariableActivation = selected.activation ?? { mode: "always" };
                  const setMode = (mode: VariableActivation["mode"]) => {
                    if (mode === "always") {
                      updateVariableAt(clampedIdx, { activation: undefined });
                    } else if (mode === "conditions") {
                      const prev = activation.mode === "conditions" ? activation : null;
                      updateVariableAt(clampedIdx, {
                        activation: {
                          mode: "conditions",
                          conditions: prev?.conditions ?? [],
                          conditionLogic: prev?.conditionLogic ?? "all",
                        },
                      });
                    } else if (mode === "greeting") {
                      const prev = activation.mode === "greeting" ? activation : null;
                      updateVariableAt(clampedIdx, {
                        activation: { mode: "greeting", greetingIds: prev?.greetingIds ?? [] },
                      });
                    } else {
                      updateVariableAt(clampedIdx, { activation: { mode: "manual" } });
                    }
                  };
                  return (
                    <div className="space-y-3">
                      <label className="text-sm font-bold text-foreground">
                        {t("variables.activationLabel")}
                      </label>
                      <div className="flex w-fit flex-wrap gap-1 rounded-lg bg-card p-1">
                        {(["always", "manual", "conditions", "greeting"] as const).map((m) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => setMode(m)}
                            className={cn(
                              "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors",
                              activation.mode === m
                                ? "bg-primary text-primary-foreground"
                                : "text-muted-foreground hover:bg-accent hover:text-foreground"
                            )}
                          >
                            {t(`variables.activationModes.${m}` as any)}
                          </button>
                        ))}
                      </div>

                      {activation.mode === "manual" ? (
                        <div className="space-y-2 rounded-lg border border-border bg-accent/30 p-3">
                          <div className="flex items-center gap-3">
                            <span className="text-xs font-semibold text-muted-foreground">
                              {t("variables.enabledDefaultLabel")}
                            </span>
                            <button
                              type="button"
                              onClick={() =>
                                updateVariableAt(clampedIdx, {
                                  enabled: selected.enabled === false ? undefined : false,
                                })
                              }
                              className={cn(
                                "rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
                                selected.enabled !== false
                                  ? "bg-primary text-primary-foreground"
                                  : "bg-card text-muted-foreground"
                              )}
                            >
                              {selected.enabled !== false
                                ? t("variables.enabledOn")
                                : t("variables.enabledOff")}
                            </button>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {t("variables.manualHint", { path: `@vars.enabled.${selected.id}` })}
                          </p>
                        </div>
                      ) : activation.mode === "conditions" ? (
                        <div className="space-y-2 rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            {t("kb.logicLabel")}
                            {(["all", "any"] as const).map((lg) => (
                              <button
                                key={lg}
                                type="button"
                                onClick={() =>
                                  updateVariableAt(clampedIdx, {
                                    activation: {
                                      mode: "conditions",
                                      conditions: activation.mode === "conditions" ? activation.conditions : [],
                                      conditionLogic: lg,
                                    },
                                  })
                                }
                                className={cn(
                                  "rounded px-2 py-0.5 font-semibold uppercase",
                                  (activation.mode === "conditions" ? activation.conditionLogic : "all") === lg
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-card text-muted-foreground hover:text-foreground"
                                )}
                              >
                                {t(`kb.logic_${lg}` as any)}
                              </button>
                            ))}
                          </div>
                          <ConditionEditor
                            conditions={activation.mode === "conditions" ? activation.conditions : []}
                            variables={conditionVars}
                            onChange={(conditions) =>
                              updateVariableAt(clampedIdx, {
                                activation: {
                                  mode: "conditions",
                                  conditions,
                                  conditionLogic:
                                    activation.mode === "conditions" ? activation.conditionLogic : "all",
                                },
                              })
                            }
                          />
                          <p className="text-xs text-muted-foreground">{t("variables.conditionsHint")}</p>
                        </div>
                      ) : activation.mode === "greeting" ? (
                        <div className="space-y-2 rounded-lg border border-violet-500/20 bg-violet-500/5 p-3">
                          <p className="text-xs text-muted-foreground">{t("variables.greetingHint")}</p>
                          {greetings.length === 0 ? (
                            <p className="text-xs text-amber-500/80">{t("kb.greetingNone")}</p>
                          ) : (
                            <div className="space-y-1">
                              {greetings.map((g, i) => {
                                const checked =
                                  activation.mode === "greeting" && activation.greetingIds.includes(g.id);
                                return (
                                  <label
                                    key={g.id}
                                    className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-white/5"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={checked}
                                      onChange={() => {
                                        const prev =
                                          activation.mode === "greeting" ? activation.greetingIds : [];
                                        const next = prev.includes(g.id)
                                          ? prev.filter((x) => x !== g.id)
                                          : [...prev, g.id];
                                        updateVariableAt(clampedIdx, {
                                          activation: { mode: "greeting", greetingIds: next },
                                        });
                                      }}
                                      className="mt-0.5 shrink-0 accent-violet-400"
                                    />
                                    <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                                      <span className="mr-1.5 font-bold text-violet-300">#{i + 1}</span>
                                      {g.name || g.content.slice(0, 80) || "—"}
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">{t("variables.alwaysHint")}</p>
                      )}
                    </div>
                  );
                })()}

                <div className="pb-12" />
              </div>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center pb-20 text-center opacity-50">
              <Hash className="mb-4 h-16 w-16 text-muted-foreground opacity-50" />
              <h2 className="mb-2 text-xl font-bold text-foreground">
                {t("variables.emptyTitle")}
              </h2>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}
