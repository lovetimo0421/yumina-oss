import { useEditorFocus } from "@/features/studio/lib/use-editor-focus";
import { useState, useMemo, useEffect } from "react";
import {
  Plus,
  Trash2,
  ChevronDown,
  MessageSquare,
  Clock,
  Play,
  Zap,
  ArrowUpDown,
  Eye,
  Search,
  Ban,
  ArrowLeft,
  Dices,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DOCS_URLS } from "@/lib/docs-urls";
import { SECONDARY_LOGIC_OPTIONS } from "@/lib/entry-constants";
import { useTranslation } from "react-i18next";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TFn = (key: any) => string;
import { useEditorStore } from "@/stores/editor";
import { ConditionEditor } from "../components/condition-editor";
import { KeywordsInput } from "../components/keywords-input";
import { ModuleScopeChips } from "../components/module-scope-chips";
import { inModuleScope, moduleIdOfScope, normalizeModuleScope } from "../lib/module-scope";
import { DebouncedInput, DebouncedTextarea } from "../components/debounced-field";
import { StyledCheckbox } from "../components/styled-checkbox";
import { DraftNumberInput } from "../components/condition-editor";
import { Select } from "@/components/ui/select";
import { NumberInput } from "@/components/ui/number-input";
import { sampleRandomSpec } from "@yumina/engine";
import { editableBehaviors, preserveLegacyEffect } from "../lib/editable-behaviors";
import type {
  Reaction,
  ReactionEffect,
  Variable,
  WorldEntry,
  AudioTrack,
  TriggerConfig,
} from "@yumina/engine";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";
import { resolveWhenPreset, buildWhenForPreset, describeWhenValues } from "../lib/when-preset-logic";

import {
  extractFieldValues,
  getDoPresets,
  identifyPreset,
  parseSmartValue,
  type DoField,
  type DoPreset,
} from "../lib/behavior-effect-presets";

// ── Shared input classes (matching variables section) ──

const inputClass =
  "w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground shadow-inner focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50 transition-all";

const fieldInputClass =
  "w-full rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-foreground shadow-inner focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50 transition-all [&>option]:bg-popover";

// Compact, directly-typeable number field for inline use (range/dice/cooldown).
// These small fields keep their own local draft so the box can be cleared and
// retyped freely without widening the surrounding inline slot. It commits
// valid numbers live and snaps blank → min on blur.
function NumField({
  value, onChange, min, className,
}: { value: number; onChange: (n: number) => void; min?: number; className?: string }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  return (
    <input
      type="number"
      inputMode="numeric"
      value={draft}
      min={min}
      onChange={(e) => {
        setDraft(e.target.value);
        if (e.target.value !== "" && !isNaN(Number(e.target.value))) onChange(Number(e.target.value));
      }}
      onBlur={() => {
        if (draft === "" || isNaN(Number(draft))) { const f = min ?? 0; setDraft(String(f)); onChange(f); }
      }}
      className={cn(
        "w-[88px] rounded-lg border border-border bg-card px-3 py-1.5 text-sm text-foreground text-center outline-none transition-colors focus:border-primary/50",
        className,
      )}
    />
  );
}

// ── WHEN presets — friendly names for event patterns ──

export interface WhenPreset {
  id: string;
  label: string;
  description: string;
  icon: typeof Zap;
  category: string;
  eventType: string;
  /** Fields to show when this preset is selected */
  fields?: WhenField[];
}

interface WhenField {
  name: string;
  label: string;
  type: "text" | "number" | "variable" | "select" | "keyword";
  placeholder?: string;
  options?: { value: string; label: string }[];
  /** Override the default operator (eq for selects/numbers/variables, contains for text) */
  operator?: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "every";
}

export function getWhenPresets(t: TFn): WhenPreset[] {
  return [
    // Messages
    { id: "every-turn", label: t("behaviors.whenPresets.everyTurn"), description: t("behaviors.whenPresets.everyTurnDesc"), icon: Zap, category: t("behaviors.whenCategories.messages"), eventType: "turn:complete" },
    { id: "player-keyword", label: t("behaviors.whenPresets.playerKeyword"), description: t("behaviors.whenPresets.playerKeywordDesc"), icon: MessageSquare, category: t("behaviors.whenCategories.messages"), eventType: "message:user", fields: [{ name: "content", label: t("behaviors.whenFields.keyword"), type: "keyword", placeholder: "attack, fight..." }] },
    { id: "ai-keyword", label: t("behaviors.whenPresets.aiKeyword"), description: t("behaviors.whenPresets.aiKeywordDesc"), icon: Eye, category: t("behaviors.whenCategories.messages"), eventType: "message:ai", fields: [{ name: "content", label: t("behaviors.whenFields.keyword"), type: "keyword", placeholder: "treasure, danger..." }] },
    { id: "session-start", label: t("behaviors.whenPresets.sessionStart"), description: t("behaviors.whenPresets.sessionStartDesc"), icon: Play, category: t("behaviors.whenCategories.messages"), eventType: "session:start" },
    // Game State
    { id: "state-changed", label: t("behaviors.whenPresets.stateChanged"), description: t("behaviors.whenPresets.stateChangedDesc"), icon: Zap, category: t("behaviors.whenCategories.gameState"), eventType: "state:changed", fields: [
      { name: "variableId", label: t("behaviors.whenFields.variable"), type: "variable" },
    ] },
    { id: "var-crossed", label: t("behaviors.whenPresets.varCrossed"), description: t("behaviors.whenPresets.varCrossedDesc"), icon: ArrowUpDown, category: t("behaviors.whenCategories.gameState"), eventType: "state:crossed", fields: [
      { name: "variableId", label: t("behaviors.whenFields.variable"), type: "variable" },
      { name: "direction", label: t("behaviors.whenFields.direction"), type: "select", options: [{ value: "drops-below", label: t("behaviors.whenFields.dropsBelow") }, { value: "rises-above", label: t("behaviors.whenFields.risesAbove") }] },
      { name: "threshold", label: t("behaviors.whenFields.value"), type: "number", placeholder: "20" },
    ] },
    { id: "action-fired", label: t("behaviors.whenPresets.actionFired"), description: t("behaviors.whenPresets.actionFiredDesc"), icon: Play, category: t("behaviors.whenCategories.gameState"), eventType: "action:fired", fields: [{ name: "actionId", label: t("behaviors.whenFields.actionId"), type: "text", placeholder: "attack" }] },
    // Timing
    { id: "turn-n", label: t("behaviors.whenPresets.everyNTurns"), description: t("behaviors.whenPresets.everyNTurnsDesc"), icon: Clock, category: t("behaviors.whenCategories.timing"), eventType: "turn:complete", fields: [{ name: "turnCount", label: t("behaviors.whenFields.everyNTurns"), type: "number", placeholder: "5", operator: "every" }] },
    // Real time, while the game is open: the open page ticks it (chat-view).
    { id: "clock-every", label: t("behaviors.whenPresets.everyNSeconds"), description: t("behaviors.whenPresets.everyNSecondsDesc"), icon: Clock, category: t("behaviors.whenCategories.timing"), eventType: "clock:every", fields: [{ name: "seconds", label: t("behaviors.whenFields.everyNSeconds"), type: "number", placeholder: "30" }] },
  ];
}

// ── Event type badge mapping for sidebar cards ──

// `key` resolves under behaviors.eventBadge.*; `label` is the English fallback.
const EVENT_TYPE_BADGES: Record<string, { key: string; label: string; color: string }> = {
  "turn:complete": { key: "turn", label: "TURN", color: "bg-secondary text-primary/80 border-primary/20" },
  "message:user": { key: "user", label: "MSG", color: "bg-secondary text-muted-foreground border-border" },
  "message:ai": { key: "ai", label: "AI", color: "bg-secondary text-muted-foreground border-border" },
  "session:start": { key: "start", label: "START", color: "bg-secondary text-muted-foreground border-border" },
  "state:changed": { key: "state", label: "STATE", color: "bg-secondary text-primary/80 border-primary/20" },
  "state:crossed": { key: "threshold", label: "THRESH", color: "bg-secondary text-muted-foreground border-border" },
  "action:fired": { key: "action", label: "ACT", color: "bg-secondary text-muted-foreground border-border" },
};

const DEFAULT_BADGE = { key: "event", label: "EVT", color: "bg-secondary text-muted-foreground border-border" };

// ── DO action presets — friendly names for effects ──

// ── Helpers: extract human-readable info from a Reaction ──

function describeWhen(reaction: Reaction, t: TFn, variables: ReadonlyArray<{ id: string; name: string }>): string {
  const preset = resolveWhenPreset(getWhenPresets(t), reaction.when);
  if (!preset) return reaction.when.eventType;
  const matchValues = describeWhenValues(preset, reaction.when.match, variables);
  return matchValues.length > 0 ? `${preset.label}: ${matchValues.join(", ")}` : preset.label;
}

// ══════════════════════════════════════════════
// Main component
// ══════════════════════════════════════════════

export function BehaviorsSection({ compact, mobileListMode }: { compact?: boolean; mobileListMode?: boolean } = {}) {
  const { t } = useTranslation("editor");
  const worldDraft = useEditorStore(s => s.worldDraft);
  const addReaction = useEditorStore(s => s.addReaction);
  const updateReaction = useEditorStore(s => s.updateReaction);
  const removeReaction = useEditorStore(s => s.removeReaction);

  // Initialize to the first reaction so desktop users (with two visible panels)
  // see content immediately. Mobile back button sets this to null and we respect
  // that — see effectiveSelectedId below.
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    if (mobileListMode) return null;
    return editableBehaviors(worldDraft)[0]?.id ?? null;
  });
  const [search, setSearch] = useState("");
  const [showLimits, setShowLimits] = useState(false);

  // One module, or the card's shared ones — the same chip row the lorebook
  // and variables pages wear, so the module page can hand it over.
  const moduleScope = useEditorStore((s) => s.moduleScope);
  const setModuleScope = useEditorStore((s) => s.setModuleScope);
  const books = worldDraft.worldbooks ?? [];
  const scope = normalizeModuleScope(moduleScope, books);

  // Another page asked for one behaviour: open it.
  const pendingFocus = useEditorStore((s) => s.pendingFocus);
  const clearPendingFocus = useEditorStore((s) => s.clearPendingFocus);
  useEffect(() => {
    if (pendingFocus?.kind !== "reaction") return;
    setSelectedId(pendingFocus.id);
    clearPendingFocus();
  }, [pendingFocus, clearPendingFocus]);

  // Show the same legacy + native behavior list that mutations operate on.
  const reactions = useMemo(() => {
    return editableBehaviors(worldDraft);
  }, [worldDraft.reactions, worldDraft.rules]);

  const filtered = useMemo(() => {
    const scoped = reactions.filter((r) => inModuleScope(scope, r.worldbookId));
    if (!search) return scoped;
    const q = search.toLowerCase();
    return scoped.filter((r) =>
      r.name.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q)
    );
  }, [reactions, search, scope]);

  // Respect an explicit null (mobile back button) so the user can return to
  // the list view. Only fall back when the previously selected reaction has
  // disappeared from the full list (e.g. deleted) — search filtering alone
  // shouldn't blow away the open detail.
  const effectiveSelectedId = useMemo(() => {
    if (!selectedId) return null;
    if (reactions.some((r) => r.id === selectedId)) return selectedId;
    return null;
  }, [selectedId, reactions]);

  const selected = reactions.find((r) => r.id === effectiveSelectedId);
  useEditorFocus("reaction", selected?.id, worldDraft);

  // Hide engine-managed vars (e.g. random-pick cooldown history) from every
  // picker — the creator never targets them by hand.
  const variables = worldDraft.variables.filter((v) => !v.internal);
  const entries = worldDraft.entries;
  const audioTracks = worldDraft.audioTracks ?? [];

  // 添加行为 puts a new one on the list and opens it, as on the canvas: its
  // sentence is written in its own form afterwards.
  const addNew = () => {
    const store = useEditorStore.getState();
    store.beginBatch();
    try {
      addReaction(moduleIdOfScope(scope) ?? undefined);
      const latest = useEditorStore.getState().worldDraft.reactions ?? [];
      const created = latest[latest.length - 1];
      if (!created) return;
      useEditorStore.getState().updateReaction(created.id, { name: String(t("blueprint.defaults.behavior")) });
      setSearch("");
      setSelectedId(created.id);
    } finally {
      store.commitBatch();
    }
  };

  function handleDelete(id: string) {
    removeReaction(id);
    if (selectedId === id) {
      const remaining = filtered.filter((r) => r.id !== id);
      const allReactions = useEditorStore.getState().worldDraft.reactions ?? [];
      setSelectedId(remaining[0]?.id ?? allReactions[0]?.id ?? null);
    }
  }

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      {/* ── Header (full editor only) ── */}
      {!compact && (
        <div className="shrink-0 border-b border-border bg-card px-6 py-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="max-w-xl">
              <h1 className="text-[22px] font-bold tracking-tight text-foreground">
                {t("behaviors.title")}
              </h1>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t("behaviors.description")}{" "}
                <a href={DOCS_URLS.rulesEngine} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t("behaviors.learnMore")}</a>
              </p>
            </div>
            <div className="relative">
              <button
                onClick={addNew}
                data-tour="behaviors-add"
                className="flex items-center gap-2 rounded-lg bg-primary px-4 py-1.5 text-xs font-semibold text-primary-foreground shadow-[0_0_15px_hsl(var(--primary)/0.3)] transition-colors hover:bg-primary/90"
              >
                <Plus className="h-3.5 w-3.5" />
                {t("behaviors.addBehavior")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Body: two-panel ── */}
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden @[640px]:flex-row">
        {/* Left sidebar */}
        <div
          className={cn(
            "w-full @[640px]:w-80 @[640px]:shrink-0 flex flex-col border-b @[640px]:border-b-0 @[640px]:border-r border-border bg-sidebar",
            selected && "hidden @[640px]:flex"
          )}
        >
          {/* Search + compact add button */}
          <div className={cn("border-b border-border", compact ? "px-3 py-2" : "p-5")}>
            <div className={cn(compact && "flex items-center gap-2")}>
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/40" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("behaviors.searchPlaceholder")}
                  className="w-full rounded-xl border border-border bg-card py-2.5 pl-9 pr-4 text-sm text-foreground shadow-inner placeholder:text-muted-foreground/40 focus:border-primary/50 focus:outline-none transition-all"
                />
              </div>
              {compact && (
                <div className="relative shrink-0">
                  <button
                    onClick={addNew}
                    data-tour="behaviors-add"
                    className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Behavior cards */}
          <div className="flex flex-col gap-2 overflow-y-auto p-5" data-tour="behaviors-list">
            {books.length > 0 && (
              <ModuleScopeChips value={scope} onChange={setModuleScope} books={books} className="mb-1" />
            )}
            {reactions.length === 0 && (
              <div className="rounded-xl border border-dashed border-border py-12 text-center">
                <Zap className="mx-auto h-8 w-8 text-muted-foreground/20" />
                <p className="mt-2 text-sm text-muted-foreground/40">
                  {t("behaviors.noBehaviors")}
                </p>
                <p className="mt-1.5 max-w-xs mx-auto text-xs text-muted-foreground/30">{t("behaviors.noBehaviorsDesc")}</p>
                <a href={DOCS_URLS.rulesEngine} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block text-xs text-primary hover:underline">{t("behaviors.learnMore")}</a>
              </div>
            )}
            {filtered.map((reaction) => {
              const badge = EVENT_TYPE_BADGES[reaction.when.eventType] ?? DEFAULT_BADGE;
              const isActive = effectiveSelectedId === reaction.id;
              return (
                <button
                  key={reaction.id}
                  onClick={() => setSelectedId(reaction.id)}
                  className={cn(
                    "flex items-center gap-3 rounded-xl p-3.5 text-left transition-all",
                    isActive
                      ? "border border-primary/30 bg-primary/[0.06] shadow-[0_0_15px_hsl(var(--primary)/0.08)]"
                      : "border border-transparent hover:bg-accent/50"
                  )}
                >
                  <div
                    className={cn(
                      "shrink-0 rounded px-2 py-0.5 text-[10px] font-bold border",
                      badge.color
                    )}
                  >
                    {t(`behaviors.eventBadge.${badge.key}` as never, badge.label)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <span
                      className={cn(
                        "block truncate text-sm font-bold",
                        isActive ? "text-primary" : "text-foreground"
                      )}
                    >
                      {reaction.name || t("behaviors.namePlaceholder")}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {describeWhen(reaction, t, worldDraft.variables)}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {!reaction.enabled && (
                      <span className="text-[9px] text-muted-foreground/40">{t("modules.badge.disabled")}</span>
                    )}
                    {isActive && (
                      <div className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.8)]" />
                    )}
                  </div>
                </button>
              );
            })}
            {filtered.length === 0 && reactions.length > 0 && search && (
              <p className="px-3 py-2 text-xs text-muted-foreground/40">
                {t("behaviors.noBehaviorsMatch", { query: search })}
              </p>
            )}
            {/* The module chips can hide every behaviour while the card still
                has some — say so instead of showing a blank list. */}
            {filtered.length === 0 && reactions.length > 0 && !search && (
              <div className="rounded-xl border border-dashed border-border py-8 text-center">
                <p className="text-xs text-muted-foreground/50">
                  {t("modules.scope.empty", "Nothing in this module yet")}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Right detail panel */}
        <div
          className={cn(
            "flex-1 overflow-y-auto min-w-0",
            !selected && "hidden @[640px]:flex"
          )}
        >
          {selected ? (
            <div className="p-8 lg:p-12">
              {/* Back button — mobile only */}
              <button
                onClick={() => setSelectedId(null)}
                className="mb-4 flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground @[640px]:hidden"
              >
                <ArrowLeft className="h-4 w-4" />
                {t("behaviors.back")}
              </button>

              <div className="mx-auto max-w-3xl space-y-6" data-tour="behaviors-detail">
                {/* Header */}
                <div className="mb-8 flex items-center justify-between">
                  <h2 className="text-xl font-bold text-foreground">
                    {t("behaviors.editBehavior")}
                  </h2>
                  <TwoTapDeleteButton
                    onConfirm={() => handleDelete(selected.id)}
                    className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10"
                    armedChildren={<><Trash2 className="h-4 w-4" />{t("twoTapConfirm")}</>}
                  >
                    <Trash2 className="h-4 w-4" />
                    {t("behaviors.delete")}
                  </TwoTapDeleteButton>
                </div>

                {/* Name */}
                <div className="space-y-1.5">
                  <label className="text-[13px] font-bold text-foreground">
                    {t("behaviors.nameLabel")}
                  </label>
                  <DebouncedInput
                    type="text"
                    value={selected.name}
                    onCommit={(name) => updateReaction(selected.id, { name })}
                    syncKey={selected.id}
                    placeholder={t("behaviors.namePlaceholder")}
                    className={cn(inputClass, "font-bold")}
                  />
                </div>

                {/* Description */}
                <div className="space-y-1.5">
                  <label className="text-[13px] font-bold text-foreground">
                    {t("behaviors.descriptionLabel")}
                  </label>
                  <DebouncedInput
                    type="text"
                    value={selected.description ?? ""}
                    onCommit={(v) =>
                      updateReaction(selected.id, { description: v || undefined })
                    }
                    syncKey={selected.id}
                    placeholder={t("behaviors.descriptionPlaceholder")}
                    className={inputClass}
                  />
                </div>

                {/* Module membership — inactive worldbook mutes the behavior */}
                {(worldDraft.worldbooks?.length ?? 0) > 0 && (
                  <div className="space-y-1.5">
                    <label className="text-[13px] font-bold text-foreground">
                      {t("behaviors.worldbookLabel")}
                    </label>
                    <select
                      value={selected.worldbookId ?? ""}
                      onChange={(e) =>
                        updateReaction(selected.id, { worldbookId: e.target.value || undefined })
                      }
                      className={inputClass}
                    >
                      <option value="">{t("behaviors.worldbookCore")}</option>
                      {(worldDraft.worldbooks ?? []).map((wb) => (
                        <option key={wb.id} value={wb.id}>{wb.name}</option>
                      ))}
                    </select>
                    <p className="text-xs text-muted-foreground">{t("behaviors.worldbookHint")}</p>
                  </div>
                )}

                {/* ════ WHEN ════ */}
                <div className="border-t border-border pt-6">
                  <div className="mb-6 flex items-center gap-2">
                    <Zap className="h-5 w-5 text-primary" />
                    <h3 className="text-base font-bold tracking-wide text-foreground">
                      {t("behaviors.whenLabel")}
                    </h3>
                  </div>
                  <WhenEditor
                    reaction={selected}
                    variables={variables}
                    onUpdate={(updates) => updateReaction(selected.id, updates)}
                  />
                </div>

                {/* ════ ONLY IF ════ */}
                <div className="border-t border-border pt-8">
                  <div className="mb-6 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Search className="h-5 w-5 text-amber-500" />
                      <h3 className="text-base font-bold tracking-wide text-foreground">
                        {t("behaviors.onlyIf")}
                      </h3>
                    </div>
                    <div className="flex rounded-lg border border-border bg-card p-1">
                      <button
                        onClick={() =>
                          updateReaction(selected.id, { conditionLogic: "all" })
                        }
                        className={cn(
                          "rounded-md px-3 py-1 text-xs font-bold transition-colors",
                          selected.conditionLogic === "all"
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {t("blueprint.logic.all")}
                      </button>
                      <button
                        onClick={() =>
                          updateReaction(selected.id, { conditionLogic: "any" })
                        }
                        className={cn(
                          "rounded-md px-3 py-1 text-xs font-bold transition-colors",
                          selected.conditionLogic === "any"
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        {t("blueprint.logic.any")}
                      </button>
                    </div>
                  </div>

                  {selected.conditions.length === 0 && (
                    <p className="mb-4 text-sm italic text-muted-foreground/50">
                      {t("behaviors.onlyIfEmptyHint", "optional -- leave empty for unconditional trigger")}
                    </p>
                  )}

                  <ConditionEditor
                    conditions={selected.conditions}
                    variables={variables}
                    onChange={(conditions) =>
                      updateReaction(selected.id, { conditions })
                    }
                    label={t("conditionEditor.conditions")}
                  />
                </div>

                {/* ════ STOP WHEN ════ */}
                <div className="border-t border-border pt-8">
                  <div className="mb-6 flex items-center gap-2">
                    <Ban className="h-5 w-5 text-rose-500" />
                    <h3 className="text-base font-bold tracking-wide text-foreground">
                      {t("behaviors.stopWhen")}
                    </h3>
                  </div>

                  {(selected.stopConditions ?? []).length === 0 && (
                    <p className="mb-4 text-sm italic text-muted-foreground/50">
                      {t("behaviors.stopWhenHint")}
                    </p>
                  )}

                  <ConditionEditor
                    conditions={selected.stopConditions ?? []}
                    variables={variables}
                    onChange={(stopConditions) =>
                      updateReaction(selected.id, {
                        stopConditions:
                          stopConditions.length > 0 ? stopConditions : undefined,
                      })
                    }
                    label={t("behaviors.stopConditionsLabel")}
                  />
                  <p className="mt-3 text-sm text-muted-foreground">
                    {t("behaviors.stopWhenNote")}
                  </p>
                </div>

                {/* ════ DO ════ */}
                <div className="border-t border-border pt-8">
                  <div className="mb-6 flex items-center gap-2">
                    <Play className="h-5 w-5 fill-emerald-500/20 text-emerald-500" />
                    <h3 className="text-base font-bold tracking-wide text-foreground">
                      {t("behaviors.doLabel")}
                    </h3>
                  </div>
                  <DoEditor
                    effects={selected.then}
                    variables={variables}
                    entries={entries}
                    audioTracks={audioTracks}
                    allReactions={reactions}
                    onChange={(then) => updateReaction(selected.id, { then })}
                  />
                </div>

                {/* ════ Advanced (Limits & Priority) ════ */}
                <div className="overflow-hidden rounded-2xl border border-border bg-card">
                  <button
                    onClick={() => setShowLimits(!showLimits)}
                    className="group flex w-full items-center justify-between p-5 transition-colors hover:bg-accent/50"
                  >
                    <span className="text-sm font-bold text-foreground">
                      {t("behaviors.limitsPriority")}
                    </span>
                    <ChevronDown
                      className={cn(
                        "h-4 w-4 text-muted-foreground transition-transform group-hover:text-primary",
                        showLimits && "rotate-180"
                      )}
                    />
                  </button>

                  {showLimits && (
                    <div className="space-y-6 border-t border-border p-6 pt-4">
                      {/* Priority */}
                      <div className="space-y-3">
                        <label className="text-sm font-bold text-foreground">
                          {t("behaviors.priority")}
                        </label>
                        <NumberInput
                          value={selected.priority}
                          onChange={(val) =>
                            updateReaction(selected.id, {
                              priority: val === "" ? 0 : val,
                            })
                          }
                          className="max-w-[200px]"
                        />
                        <p className="text-sm text-muted-foreground">
                          {t("behaviors.priorityHint")}
                        </p>
                      </div>

                      {/* Cooldown */}
                      <div className="space-y-3">
                        <label className="text-sm font-bold text-foreground">
                          {t("behaviors.cooldown")}
                        </label>
                        <NumberInput
                          min={0}
                          value={selected.cooldownTurns ?? ""}
                          onChange={(val) =>
                            updateReaction(selected.id, {
                              cooldownTurns: val === "" ? undefined : val,
                            })
                          }
                          placeholder={t("behaviors.cooldownPlaceholder")}
                          className="max-w-[200px]"
                        />
                        <p className="text-sm text-muted-foreground">
                          {t("behaviors.cooldownHint")}
                        </p>
                      </div>

                      {/* Max Fire Count */}
                      <div className="space-y-3">
                        <label className="text-sm font-bold text-foreground">
                          {t("behaviors.maxFireCount")}
                        </label>
                        <NumberInput
                          min={0}
                          value={selected.maxFireCount ?? ""}
                          onChange={(val) =>
                            updateReaction(selected.id, {
                              maxFireCount: val === "" ? undefined : val,
                            })
                          }
                          placeholder={t("behaviors.maxFireCountPlaceholder")}
                          className="max-w-[200px]"
                        />
                        <p className="text-sm text-muted-foreground">
                          {t("behaviors.maxFireCountHint")}
                        </p>
                      </div>

                      {/* Chance % — "sometimes it happens" */}
                      <div className="space-y-3">
                        <label className="text-sm font-bold text-foreground">
                          {t("behaviors.chance", { defaultValue: "Chance to fire (%)" })}
                        </label>
                        <NumberInput
                          min={0}
                          max={100}
                          value={selected.chance ?? ""}
                          onChange={(val) =>
                            updateReaction(selected.id, {
                              chance: val === "" ? undefined : val,
                            })
                          }
                          placeholder="100"
                          className="max-w-[200px]"
                        />
                        <p className="text-sm text-muted-foreground">
                          {t("behaviors.chanceHint", { defaultValue: "Only fire this behavior this % of the time it otherwise would. Blank = always." })}
                        </p>
                      </div>

                      {/* Enabled */}
                      <div className="mt-6">
                        <StyledCheckbox
                          checked={selected.enabled}
                          onChange={(enabled) => updateReaction(selected.id, { enabled })}
                          label={t("behaviors.enabled")}
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="pb-20" />
              </div>
            </div>
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <p className="text-sm text-muted-foreground/40">
                {reactions.length === 0
                  ? t("behaviors.noBehaviorsDesc")
                  : t("behaviors.selectToEdit", { defaultValue: "Select a behavior to edit" })}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════
// WHEN Editor
// ══════════════════════════════════════════════

function LegacyTriggerFields({ trigger, variables, onChange }: {
  trigger: TriggerConfig; variables: Variable[]; onChange: (next: TriggerConfig) => void;
}) {
  const { t } = useTranslation("editor");
  const update = (patch: Partial<TriggerConfig>) => onChange({ ...trigger, ...patch });
  if (trigger.type === "keyword" || trigger.type === "ai-keyword") {
    return <div className="space-y-3">
      <label className="block text-sm">{t("behaviors.whenFields.keyword")}</label>
      <KeywordsInput value={trigger.keywords ?? []} onChange={keywords => update({ keywords })} />
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={trigger.matchWholeWords ?? false}
          onChange={e => update({ matchWholeWords: e.target.checked })} />
        {t("audio.matchWholeWords")}
      </label>
      <label className="block text-sm">{t("entries.secondaryKeywords")}</label>
      <KeywordsInput value={trigger.secondaryKeywords ?? []} onChange={secondaryKeywords => update({ secondaryKeywords })} />
      <Select value={trigger.secondaryKeywordLogic ?? "AND_ANY"}
        options={SECONDARY_LOGIC_OPTIONS.map(({ value, hint }) => ({ value, label: hint }))}
        onValueChange={value => update({ secondaryKeywordLogic: value as TriggerConfig["secondaryKeywordLogic"] })} />
    </div>;
  }
  if (trigger.type === "variable-crossed") {
    return <div className="space-y-3">
      <label className="block text-sm">{t("behaviors.whenFields.variable")}</label>
      <Select value={trigger.variableId ?? ""} options={variables.map(v => ({ value: v.id, label: v.name }))}
        onValueChange={variableId => update({ variableId: variableId || undefined })} />
      <label className="block text-sm">{t("behaviors.whenFields.direction")}</label>
      <Select value={trigger.direction ?? ""} options={[
        { value: "drops-below", label: t("behaviors.whenFields.dropsBelow") },
        { value: "rises-above", label: t("behaviors.whenFields.risesAbove") },
      ]} onValueChange={direction => update({ direction: direction as TriggerConfig["direction"] })} />
      <label className="block text-sm">{t("behaviors.whenFields.value")}</label>
      <input className={fieldInputClass} type="number" value={trigger.threshold ?? ""}
        onChange={e => update({ threshold: e.target.value === "" ? undefined : Number(e.target.value) })} />
    </div>;
  }
  if (trigger.type === "turn-count") {
    return <div className="space-y-3">
      {(["atTurn", "everyNTurns"] as const).map(key => <label key={key} className="block space-y-1 text-sm">
        <span>{t(`audio.${key}`)}</span>
        <input type="number" min={key === "atTurn" ? 0 : 1} className={fieldInputClass} value={trigger[key] ?? ""}
          onChange={e => update({ [key]: e.target.value === "" ? undefined : Number(e.target.value) })} />
      </label>)}
      <p className="text-xs text-muted-foreground">{t("audio.turnCountHint")}</p>
    </div>;
  }
  return null;
}

export function WhenEditor({
  reaction,
  variables,
  onUpdate,
}: {
  reaction: Reaction;
  variables: Variable[];
  onUpdate: (u: Partial<Reaction>) => void;
}) {
  const { t } = useTranslation("editor");

  const whenPresets = useMemo(() => getWhenPresets(t), [t]);

  // Find best preset match (some presets share eventType, so match fields disambiguate)
  const currentPreset = useMemo(
    () => {
      const legacy = reaction.when._legacyTrigger;
      const id = legacy?.type === "variable-crossed" ? "var-crossed"
        : legacy?.type === "keyword" ? "player-keyword"
        : legacy?.type === "ai-keyword" ? "ai-keyword"
        : legacy?.type === "turn-count" ? "turn-n" : null;
      return id ? whenPresets.find(p => p.id === id) ?? null : resolveWhenPreset(whenPresets, reaction.when);
    },
    [reaction.when, whenPresets],
  );

  const presetOptions = useMemo(
    () =>
      whenPresets.map((p) => ({
        value: p.id,
        label: `${p.label}`,
        description: p.description,
        icon: <p.icon className="h-4 w-4" />,
      })),
    [whenPresets]
  );

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-muted-foreground">
          {t("behaviors.selectEvent")}
        </label>
        <Select
          value={currentPreset?.id ?? "_custom"}
          onValueChange={(val) => {
            const preset = whenPresets.find((p) => p.id === val);
            if (preset) {
              // buildWhenForPreset seeds marker fields (e.g. turnCount for
              // "Every N turns") so the selection doesn't snap back to a
              // sibling preset sharing the same eventType.
              onUpdate({ when: buildWhenForPreset(preset) });
            }
          }}
          options={[
            ...presetOptions,
            ...(currentPreset
              ? []
              : [
                  {
                    value: "_custom",
                    label: t("behaviors.customEvent", { event: reaction.when.eventType, defaultValue: "Custom: {{event}}" }),
                  },
                ]),
          ]}
        />
      </div>

      {currentPreset?.description && (
        <p className="text-xs text-muted-foreground">{currentPreset.description}</p>
      )}

      {/* Preset-specific fields */}
      {reaction.when._legacyTrigger && (
        <LegacyTriggerFields trigger={reaction.when._legacyTrigger} variables={variables}
          onChange={trigger => onUpdate({ when: { ...reaction.when, _legacyTrigger: trigger } })} />
      )}
      {!reaction.when._legacyTrigger && currentPreset?.fields &&
        currentPreset.fields.length > 0 &&
        currentPreset.fields.map((field) => {
          const matchVal = reaction.when.match?.[field.name]?.value ?? "";
          const keywordCount =
            field.type === "keyword" && typeof matchVal === "string"
              ? matchVal.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).length
              : 0;
          return (
            <div key={field.name} className="space-y-1.5">
              <label className="flex items-center gap-2 text-[13px] font-bold text-foreground">
                <span>{field.label}</span>
                {field.type === "keyword" && keywordCount > 0 && (
                  <span className="rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                    {t("entries.keywordsCount", { count: keywordCount })}
                  </span>
                )}
              </label>
              {field.type === "variable" ? (
                <Select
                  value={String(matchVal)}
                  onValueChange={(val) => {
                    // Empty value clears the filter so the reaction fires on
                    // any variable change. Without this, picking nothing would
                    // save value:"" and never match a real variableId.
                    if (!val) {
                      const newMatch = { ...reaction.when.match };
                      delete newMatch[field.name];
                      onUpdate({
                        when: {
                          ...reaction.when,
                          match:
                            Object.keys(newMatch).length > 0 ? newMatch : undefined,
                        },
                      });
                      return;
                    }
                    onUpdate({
                      when: {
                        ...reaction.when,
                        match: {
                          ...reaction.when.match,
                          [field.name]: { operator: "eq", value: val },
                        },
                      },
                    });
                  }}
                  options={variables.map((v) => ({ value: v.id, label: v.name }))}
                  placeholder={t("behaviors.selectVariable")}
                />
              ) : field.type === "keyword" ? (
                <KeywordsInput
                  value={
                    typeof matchVal === "string" && matchVal
                      ? matchVal.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
                      : []
                  }
                  onChange={(next) => {
                    const joined = next.join(", ");
                    if (!joined) {
                      const newMatch = { ...reaction.when.match };
                      delete newMatch[field.name];
                      onUpdate({
                        when: {
                          ...reaction.when,
                          match:
                            Object.keys(newMatch).length > 0
                              ? newMatch
                              : undefined,
                        },
                      });
                      return;
                    }
                    onUpdate({
                      when: {
                        ...reaction.when,
                        match: {
                          ...reaction.when.match,
                          [field.name]: { operator: "contains", value: joined },
                        },
                      },
                    });
                  }}
                  placeholder={field.placeholder}
                />
              ) : field.type === "select" ? (
                <Select
                  value={String(matchVal)}
                  onValueChange={(val) =>
                    onUpdate({
                      when: {
                        ...reaction.when,
                        match: {
                          ...reaction.when.match,
                          [field.name]: { operator: "eq", value: val },
                        },
                      },
                    })
                  }
                  options={
                    field.options?.map((o) => ({
                      value: o.value,
                      label: o.label,
                    })) ?? []
                  }
                />
              ) : field.type === "number" ? (
                // Typed as text and committed on blur: the old per-keystroke
                // Number(x) || 0 made the box impossible to clear or to take a
                // negative / decimal. A blank box reverts (these match fields
                // also mark which preset is selected).
                <DraftNumberInput
                  value={typeof matchVal === "number" ? matchVal : Number(matchVal) || 0}
                  onCommit={(num) =>
                    onUpdate({
                      when: {
                        ...reaction.when,
                        match: {
                          ...reaction.when.match,
                          [field.name]: { operator: field.operator ?? "eq", value: num },
                        },
                      },
                    })
                  }
                  placeholder={field.placeholder}
                  className={inputClass}
                />
              ) : (
                <DebouncedInput
                  type="text"
                  value={String(matchVal)}
                  onCommit={(val) => {
                    if (!val) {
                      const newMatch = { ...reaction.when.match };
                      delete newMatch[field.name];
                      onUpdate({
                        when: {
                          ...reaction.when,
                          match:
                            Object.keys(newMatch).length > 0
                              ? newMatch
                              : undefined,
                        },
                      });
                    } else {
                      const defaultOp = field.type === "text" ? "contains" : "eq";
                      onUpdate({
                        when: {
                          ...reaction.when,
                          match: {
                            ...reaction.when.match,
                            [field.name]: {
                              operator: field.operator ?? defaultOp,
                              value: val,
                            },
                          },
                        },
                      });
                    }
                  }}
                  placeholder={field.placeholder}
                  className={inputClass}
                />
              )}
            </div>
          );
        })}
    </div>
  );
}

// ══════════════════════════════════════════════
// DO Editor
// ══════════════════════════════════════════════

export function DoEditor({
  effects,
  variables,
  entries,
  audioTracks,
  allReactions,
  onChange,
}: {
  effects: ReactionEffect[];
  variables: Variable[];
  entries: WorldEntry[];
  audioTracks: AudioTrack[];
  allReactions: Reaction[];
  onChange: (effects: ReactionEffect[]) => void;
}) {
  const { t } = useTranslation("editor");
  const [showPicker, setShowPicker] = useState(false);
  const doPresets = useMemo(() => getDoPresets(t), [t]);
  const categories = useMemo(
    () => [...new Set(doPresets.map((p) => p.category))],
    [doPresets]
  );

  const addEffect = (preset: DoPreset) => {
    const defaults: Record<string, string> = {};
    for (const f of preset.fields) {
      // Variable fields start EMPTY on purpose: pre-filling the first variable
      // forces creators to clear it before they can pick another one (community
      // feedback), and an empty path is a safe no-op in the engine.
      if (f.type === "variable") defaults[f.name] = "";
      else if (f.type === "entry" && entries[0]) defaults[f.name] = entries[0].id;
      else if (f.type === "audio" && audioTracks[0]) defaults[f.name] = audioTracks[0].id;
      else if (f.type === "behavior" && allReactions[0]) defaults[f.name] = allReactions[0].id;
      else if (f.options?.[0]) defaults[f.name] = f.options[0].value;
      else defaults[f.name] = "";
    }
    onChange([...effects, preset.build(defaults)]);
    setShowPicker(false);
  };

  return (
    <div>
      {effects.length === 0 ? (
        <p className="mb-6 text-sm italic text-muted-foreground/50">
          {t("behaviors.noActionsYet")}
        </p>
      ) : (
        <div className="mb-6 space-y-3">
          {effects.map((effect, i) => (
            <DoEffectRow
              key={i}
              effect={effect}
              variables={variables}
              entries={entries}
              audioTracks={audioTracks}
              allReactions={allReactions}
              onUpdate={(updated) =>
                onChange(effects.map((e, j) => (j === i ? updated : e)))
              }
              onDelete={() => onChange(effects.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}

      {/* Add action button + dropdown */}
      <div className="relative">
        <button
          onClick={() => setShowPicker(!showPicker)}
          className="flex items-center gap-2 rounded-lg border border-border px-4 py-2 text-sm font-medium text-muted-foreground transition-all hover:border-primary/30 hover:bg-primary/5 hover:text-primary"
        >
          <Plus className="h-4 w-4" />
          {t("behaviors.addAction")}
        </button>

        {showPicker && (
          <div className="absolute left-0 top-full z-10 mt-2 max-h-[400px] w-[280px] max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border bg-popover py-2 shadow-2xl">
            {categories.map((cat) => (
              <div key={cat}>
                <div className="px-4 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {cat}
                </div>
                {doPresets.filter((p) => p.category === cat).map((p) => {
                  const Icon = p.icon;
                  return (
                    <button
                      key={p.id}
                      onClick={() => addEffect(p)}
                      className="flex w-full items-center gap-3 px-4 py-2 text-left text-sm text-foreground transition-colors hover:bg-accent hover:text-primary"
                    >
                      <Icon className="h-4 w-4" />
                      {p.label}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════
// Single DO effect row
// ══════════════════════════════════════════════

function DoEffectRow({
  effect,
  variables,
  entries,
  audioTracks,
  allReactions,
  onUpdate,
  onDelete,
}: {
  effect: ReactionEffect;
  variables: Variable[];
  entries: WorldEntry[];
  audioTracks: AudioTrack[];
  allReactions: Reaction[];
  onUpdate: (e: ReactionEffect) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("editor");
  const doPresets = useMemo(() => getDoPresets(t), [t]);

  // "Change variable" (a set on a plain, non-@ path) has its own bespoke editor
  // because its value can be a constant, another variable, OR a random source
  // (range / list / dice) — richer than the flat preset/field renderer allows.
  if (effect.type === "set" && !effect.path.startsWith("@")) {
    return (
      <ChangeVarRow
        effect={effect}
        variables={variables}
        onUpdate={onUpdate}
        onDelete={onDelete}
      />
    );
  }

  const preset = identifyPreset(effect, doPresets);
  const fields = extractFieldValues(effect, preset);

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {preset && <preset.icon className="h-4 w-4 text-emerald-500/70" />}
          <span className="text-xs font-semibold text-emerald-500/80">
            {preset?.label ?? t("behaviors.customEffect")}
          </span>
        </div>
        <button
          onClick={onDelete}
          className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex flex-col gap-3">
        {preset ? (
          preset.fields.map((field) => (
            <div key={field.name} className="space-y-1.5">
              <label className="text-[13px] font-medium text-muted-foreground">
                {field.label}
              </label>
              <FieldInput
                field={field}
                value={fields[field.name] ?? ""}
                variables={variables}
                entries={entries}
                audioTracks={audioTracks}
                allReactions={allReactions}
                onChange={(val) => {
                  const newFields = { ...fields, [field.name]: val };
                  onUpdate(preserveLegacyEffect(effect, preset.build(newFields)));
                }}
              />
            </div>
          ))
        ) : (
          <div className="font-mono text-xs text-muted-foreground">
            {effect.type === "set"
              ? `SET ${(effect as any).path} = ${JSON.stringify((effect as any).value)}`
              : `EMIT ${JSON.stringify((effect as any).event)}`}
          </div>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════
// Random pick editor (bespoke — engine-side fair rotation)
// ══════════════════════════════════════════════

// ══════════════════════════════════════════════
// Change-variable editor (value = constant / variable / random)
// ══════════════════════════════════════════════

type SetEffect = Extract<ReactionEffect, { type: "set" }>;
type RandomSpec = NonNullable<SetEffect["valueRandom"]>;
type ValueMode = "const" | "var" | "random";

const CHANGE_OPS = ["set", "add", "subtract", "multiply", "toggle", "append"] as const;

function valueModeOf(e: SetEffect): ValueMode {
  if (e.valueRandom) return "random";
  if (e.valueRef) return "var";
  return "const";
}

// Variable picker that also creates: replaces the old native <datalist>, whose
// browser-controlled popup (a) often doesn't open on click and (b) only shows
// options fuzzy-matching the current text — so a pre-filled value hid every
// other variable until it was cleared (community bug report). This one opens
// the FULL list on focus/click and only filters once the user actually types.
function VariableCombobox({
  value,
  variables,
  onCommit,
  placeholder,
}: {
  value: string;
  variables: Variable[];
  onCommit: (name: string) => void;
  placeholder?: string;
}) {
  const { t } = useTranslation("editor");
  const tx = t as (key: string, opts?: Record<string, unknown>) => string;
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(false);
  useEffect(() => { setDraft(value); }, [value]);

  const q = draft.trim().toLowerCase();
  const filtered = typed && q ? variables.filter((v) => v.name.toLowerCase().includes(q)) : variables;
  const hasExact = variables.some((v) => v.name.trim() === draft.trim());

  const commit = (name: string) => {
    setOpen(false);
    setTyped(false);
    setDraft(name);
    if (name.trim() !== value.trim()) onCommit(name); // unchanged → don't dirty the draft
  };

  return (
    <div className="relative">
      <input
        value={draft}
        onFocus={() => { setOpen(true); setTyped(false); }}
        onClick={() => setOpen(true)}
        onChange={(e) => { setDraft(e.target.value); setTyped(true); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(draft); (e.target as HTMLInputElement).blur(); }
          else if (e.key === "Escape") { setDraft(value); setTyped(false); setOpen(false); }
        }}
        onBlur={() => { if (open) commit(draft); }}
        placeholder={placeholder}
        className={cn(fieldInputClass, "pr-8")}
      />
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/50" />
      {open && (filtered.length > 0 || draft.trim()) && (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-2xl">
          {filtered.map((v) => (
            <button
              key={v.id}
              type="button"
              // mousedown (not click) so it fires before the input's blur
              onMouseDown={(e) => { e.preventDefault(); commit(v.name); }}
              className={cn(
                "flex w-full items-center px-3 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-accent",
                v.name === value && "font-medium text-primary",
              )}
            >
              {v.name}
            </button>
          ))}
          {draft.trim() && !hasExact && (
            <button
              type="button"
              onMouseDown={(e) => { e.preventDefault(); commit(draft); }}
              className={cn(
                "flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[13px] text-primary transition-colors hover:bg-accent",
                filtered.length > 0 && "border-t border-border",
              )}
            >
              <Plus className="h-3.5 w-3.5" />
              {tx("behaviors.createVariable", { name: draft.trim(), defaultValue: `Create "${draft.trim()}"` })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ChangeVarRow({
  effect,
  variables,
  onUpdate,
  onDelete,
}: {
  effect: SetEffect;
  variables: Variable[];
  onUpdate: (e: ReactionEffect) => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation("editor");
  const tx = t as (key: string, opts?: { defaultValue?: string }) => string;
  const ensureVariableByName = useEditorStore((s) => s.ensureVariableByName);
  const patch = (u: Partial<SetEffect>) => onUpdate({ ...effect, ...u });

  const mode = valueModeOf(effect);
  const targetName = variables.find((v) => v.id === effect.path)?.name ?? "";

  const isListRandom = mode === "random" && effect.valueRandom?.kind === "list";

  // Find-or-create the target variable; a list-pick target holds names (string),
  // everything else holds numbers.
  const commitTarget = (raw: string) => {
    const name = raw.trim();
    if (!name) { patch({ path: "" }); return; }
    const asString = isListRandom;
    patch({ path: ensureVariableByName(name, asString ? "string" : "number", asString ? "" : 0) });
  };

  const setMode = (m: ValueMode) => {
    if (m === "const") {
      const keep = typeof effect.value === "number" || typeof effect.value === "string" ? effect.value : 0;
      patch({ valueRef: undefined, valueRandom: undefined, value: keep });
    } else if (m === "var") {
      patch({ valueRef: variables[0]?.id ?? "", valueRandom: undefined });
    } else {
      patch({ valueRandom: { kind: "range", min: 1, max: 6 }, valueRef: undefined, operation: effect.operation ?? "set" });
    }
  };

  const ensureHistory = (base: string) =>
    ensureVariableByName(
      `${base || tx("behaviors.randomPick.historyBase", { defaultValue: "rotation" })} · ${tx("behaviors.randomPick.historySuffix", { defaultValue: "recent" })}`,
      "json",
      [],
      true, // engine-managed: hidden from the Variables list + never shown to the AI
    );

  return (
    <div className="rounded-xl border border-border bg-card p-4 text-[13px]">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-emerald-500/70" />
          <span className="text-xs font-semibold text-emerald-500/80">
            {tx("behaviors.doPresets.changeVar")}
          </span>
        </div>
        <button onClick={onDelete} className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive">
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex flex-col gap-3">
        {/* Target variable (pick or type to create) */}
        <div className="space-y-1.5">
          <label className="text-[13px] font-medium text-muted-foreground">{tx("behaviors.doFields.variable")}</label>
          <VariableCombobox
            value={targetName}
            variables={variables}
            onCommit={commitTarget}
            placeholder={tx("behaviors.randomPick.intoPlaceholder", { defaultValue: "type to create" })}
          />
        </div>

        {/* Operation — hidden for list-random (only "set" is meaningful) */}
        {!isListRandom && (
          <div className="space-y-1.5">
            <label className="text-[13px] font-medium text-muted-foreground">{tx("behaviors.doFields.operation")}</label>
            <Select
              value={effect.operation ?? "set"}
              onValueChange={(v) => patch({ operation: v as SetEffect["operation"] })}
              options={CHANGE_OPS.map((op) => ({ value: op, label: (t as TFn)(`behaviors.effectOps.${op}`) }))}
            />
          </div>
        )}

        {/* Value: constant / variable / random */}
        <div className="space-y-1.5">
          <label className="text-[13px] font-medium text-muted-foreground">{tx("behaviors.doFields.value")}</label>
          <div className="flex w-fit gap-1 rounded-lg border border-border bg-card p-1">
            {(["const", "var", "random"] as ValueMode[]).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={cn(
                  "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                  mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tx(`behaviors.valueMode.${m}`, {
                  defaultValue: m === "const" ? "Constant" : m === "var" ? "Variable" : "Random",
                })}
              </button>
            ))}
          </div>

          {mode === "const" && (
            // Raw text stays local while typing; it is parsed only when
            // committed (pause / blur), so "0." or "-" survive mid-typing
            // instead of snapping to 0.
            <DebouncedInput
              value={String(effect.value ?? "")}
              onCommit={(raw) => patch({ value: parseSmartValue(raw) })}
              placeholder="10"
              className={fieldInputClass}
            />
          )}
          {mode === "var" && (
            <Select
              value={effect.valueRef ?? ""}
              onValueChange={(v) => patch({ valueRef: v })}
              options={variables.map((v) => ({ value: v.id, label: v.name }))}
              placeholder={tx("behaviors.selectVariable")}
            />
          )}
          {mode === "random" && effect.valueRandom && (
            <RandomValueEditor
              spec={effect.valueRandom}
              variables={variables}
              targetName={targetName}
              ensureHistory={ensureHistory}
              onChange={(spec) => patch({ valueRandom: spec, operation: spec.kind === "list" ? "set" : (effect.operation ?? "set") })}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export function RandomValueEditor({
  spec,
  variables,
  targetName,
  ensureHistory,
  onChange,
}: {
  spec: RandomSpec;
  variables: Variable[];
  targetName: string;
  ensureHistory: (base: string) => string;
  onChange: (spec: RandomSpec) => void;
}) {
  const { t } = useTranslation("editor");
  const tx = t as (key: string, opts?: { defaultValue?: string }) => string;
  const [showAdv, setShowAdv] = useState(false);
  const [newCand, setNewCand] = useState("");
  const [sample, setSample] = useState<string | number | null>(null);

  const setKind = (kind: string) => {
    if (kind === "range") onChange({ kind: "range", min: 1, max: 6 });
    else if (kind === "dice") onChange({ kind: "dice", count: 1, sides: 6, modifier: 0 });
    else onChange({ kind: "list", candidates: [] });
  };

  return (
    <div className="mt-2 space-y-3 rounded-lg border border-primary/20 bg-primary/[0.03] p-3">
      <div className="flex items-center gap-2">
        <Dices className="h-3.5 w-3.5 text-primary" />
        <Select
          value={spec.kind}
          onValueChange={setKind}
          options={[
            { value: "range", label: tx("behaviors.random.range", { defaultValue: "Number in a range" }) },
            { value: "list", label: tx("behaviors.random.list", { defaultValue: "Pick from a list" }) },
            { value: "dice", label: tx("behaviors.random.dice", { defaultValue: "Dice roll" }) },
          ]}
        />
      </div>

      {spec.kind === "range" && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{tx("behaviors.random.from", { defaultValue: "from" })}</span>
          <NumField value={spec.min} onChange={(n) => onChange({ ...spec, min: n })} className="w-[92px]" />
          <span>{tx("behaviors.random.to", { defaultValue: "to" })}</span>
          <NumField value={spec.max} onChange={(n) => onChange({ ...spec, max: n })} className="w-[92px]" />
        </div>
      )}

      {spec.kind === "dice" && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <NumField min={1} value={spec.count} onChange={(n) => onChange({ ...spec, count: n })} className="w-[80px]" />
          <span>d</span>
          <NumField min={1} value={spec.sides} onChange={(n) => onChange({ ...spec, sides: n })} className="w-[80px]" />
          <span>+</span>
          <NumField value={spec.modifier ?? 0} onChange={(n) => onChange({ ...spec, modifier: n })} className="w-[80px]" />
        </div>
      )}

      {spec.kind === "list" && (() => {
        const candidates = spec.candidates ?? [];
        const cooldown = spec.cooldown ?? 0;
        const customWeights = Array.isArray(spec.weights);
        const useVar = !!spec.candidatesVar;
        const addCandidate = (raw: string) => {
          const v = raw.trim();
          if (!v || candidates.includes(v)) { setNewCand(""); return; }
          onChange({ ...spec, candidates: [...candidates, v], weights: customWeights ? [...(spec.weights ?? []), 1] : undefined });
          setNewCand("");
        };
        const removeCandidate = (i: number) =>
          onChange({ ...spec, candidates: candidates.filter((_, j) => j !== i), weights: customWeights ? (spec.weights ?? []).filter((_, j) => j !== i) : undefined });
        const setCooldown = (n: number) =>
          onChange(n > 0
            ? { ...spec, cooldown: n, historyVar: ensureHistory(targetName), onExhausted: spec.onExhausted ?? "full" }
            : { ...spec, cooldown: 0, historyVar: undefined, onExhausted: undefined });

        return (
          <div className="space-y-3">
            {useVar ? (
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">{tx("behaviors.randomPick.candidatesVarLabel", { defaultValue: "Array variable (candidates)" })}</label>
                <Select value={spec.candidatesVar ?? ""} onValueChange={(v) => onChange({ ...spec, candidatesVar: v })} options={variables.map((v) => ({ value: v.id, label: v.name }))} placeholder={tx("behaviors.selectVariable")} />
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-1.5">
                {candidates.map((c, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs">
                    {c}
                    <button onClick={() => removeCandidate(i)} className="text-muted-foreground hover:text-destructive"><X className="h-3 w-3" /></button>
                  </span>
                ))}
                <input
                  value={newCand}
                  onChange={(e) => setNewCand(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addCandidate(newCand); } }}
                  onBlur={() => addCandidate(newCand)}
                  placeholder={candidates.length === 0 ? tx("behaviors.randomPick.candFirst", { defaultValue: "type a name, press Enter" }) : "+"}
                  className="min-w-[90px] flex-1 rounded-lg border border-dashed border-border bg-card px-2.5 py-1 text-xs outline-none transition-colors focus:border-primary/50"
                />
              </div>
            )}

            <div className="space-y-1.5 rounded-lg border border-border bg-card/40 p-3">
              <label className="text-[13px] font-semibold text-foreground">
                {tx("behaviors.randomPick.cooldownTitle", { defaultValue: "Avoid repeats" })}
              </label>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <span>{tx("behaviors.randomPick.cooldownPre", { defaultValue: "The last" })}</span>
                <NumField min={0} value={cooldown} onChange={(n) => setCooldown(n)} className="w-[92px]" />
                <span>{tx("behaviors.randomPick.cooldownPost", { defaultValue: "picks won't be chosen again" })}</span>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                {cooldown > 0
                  ? tx("behaviors.randomPick.cooldownHelpOn", { defaultValue: "A \"pick\" = one time this behavior fires. Recent picks are auto-tracked for you." })
                  : tx("behaviors.randomPick.cooldownHelpOff", { defaultValue: "0 = repeats allowed (the same one can come up twice in a row). A \"pick\" = one time this behavior fires." })}
              </p>
            </div>

            <button onClick={() => setShowAdv(!showAdv)} className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showAdv && "rotate-180")} />
              {tx("behaviors.randomPick.advanced", { defaultValue: "Advanced (weights / use a variable / when exhausted)" })}
            </button>
            {showAdv && (
              <div className="space-y-3 border-t border-border pt-3">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" checked={useVar} onChange={(e) => onChange({ ...spec, candidatesVar: e.target.checked ? (variables[0]?.id ?? "") : undefined })} />
                  {tx("behaviors.randomPick.advUseVar", { defaultValue: "Use an array variable as the candidate pool instead of a fixed list" })}
                </label>
                {!useVar && (
                  <div className="space-y-1.5">
                    <span className="text-xs text-muted-foreground">{tx("behaviors.randomPick.weightsLabel", { defaultValue: "Weights" })}</span>
                    <Select
                      value={customWeights ? "custom" : "equal"}
                      onValueChange={(m) => m === "equal" ? onChange({ ...spec, weights: undefined }) : onChange({ ...spec, weights: candidates.map(() => 1) })}
                      options={[
                        { value: "equal", label: tx("behaviors.randomPick.weightsEqual", { defaultValue: "Equal" }) },
                        { value: "custom", label: tx("behaviors.randomPick.weightsCustom", { defaultValue: "Custom" }) },
                      ]}
                    />
                    {customWeights && (() => {
                      const wCount = spec.weights?.length ?? 0;
                      const mismatch = wCount !== candidates.length && candidates.length > 0;
                      return (
                        <>
                          <input
                            value={(spec.weights ?? []).join(", ")}
                            onChange={(e) => onChange({ ...spec, weights: e.target.value.split(/[,，\s]+/).map((s) => Number(s.trim())).filter((n) => !isNaN(n)) })}
                            placeholder={tx("behaviors.randomPick.weightsPlaceholder", { defaultValue: "e.g. 3, 1, 1 — order matches candidates" })}
                            className={fieldInputClass}
                          />
                          <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                            {tx("behaviors.randomPick.weightsHelp", { defaultValue: "One number per candidate, comma-separated, in the same order. Bigger = more often (3,1,1 means the first is 3× as likely as each of the others). It's relative, not a percentage." })}
                          </p>
                          {mismatch && (
                            <p className="text-[11px] leading-relaxed text-amber-500">
                              {tx("behaviors.randomPick.weightsMismatch", { defaultValue: "Weight count must match candidate count, or weights are ignored and everyone is equal." })}
                              {` (${wCount} / ${candidates.length})`}
                            </p>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}
                {cooldown > 0 && (
                  <div className="space-y-1.5">
                    <span className="text-xs text-muted-foreground">{tx("behaviors.randomPick.exhaustedLabel", { defaultValue: "When everyone is on cooldown" })}</span>
                    <Select
                      value={spec.onExhausted ?? "full"}
                      onValueChange={(v) => onChange({ ...spec, onExhausted: v as "full" | "keep" })}
                      options={[
                        { value: "full", label: tx("behaviors.randomPick.exhaustedFull", { defaultValue: "Fall back to the full set" }) },
                        { value: "keep", label: tx("behaviors.randomPick.exhaustedKeep", { defaultValue: "Keep the current value" }) },
                      ]}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* Roll-once preview — build confidence + catch weight/range mistakes */}
      <div className="flex items-center gap-2 border-t border-border/60 pt-2.5">
        <button
          onClick={() => setSample(sampleRandomSpec(spec))}
          className="rounded-lg border border-primary/30 px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
        >
          {tx("behaviors.random.roll", { defaultValue: "Roll it" })}
        </button>
        {sample !== null && (
          <span className="text-xs text-muted-foreground">
            →{" "}
            <span className="font-semibold text-foreground">
              {String(sample) || tx("behaviors.random.rollEmpty", { defaultValue: "(no candidates)" })}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════
// Field input renderer
// ══════════════════════════════════════════════

function FieldInput({
  field,
  value,
  variables,
  entries,
  audioTracks,
  allReactions,
  onChange,
}: {
  field: DoField;
  value: string;
  variables: Variable[];
  entries: WorldEntry[];
  audioTracks: AudioTrack[];
  allReactions: Reaction[];
  onChange: (val: string) => void;
}) {
  const { t } = useTranslation("editor");
  switch (field.type) {
    case "textarea":
      return (
        <DebouncedTextarea
          value={value}
          onCommit={onChange}
          placeholder={field.placeholder}
          rows={3}
          className={cn(fieldInputClass, "min-h-[80px] resize-y")}
        />
      );
    case "variable":
      return (
        <Select
          value={value}
          onValueChange={onChange}
          options={variables.map((v) => ({ value: v.id, label: v.name }))}
          placeholder={t("behaviors.selectVariable")}
        />
      );
    case "entry":
      return (
        <Select
          value={value}
          onValueChange={onChange}
          options={entries.map((e) => ({ value: e.id, label: e.name }))}
          placeholder={t("behaviors.selectEntry")}
        />
      );
    case "audio":
      return (
        <Select
          value={value}
          onValueChange={onChange}
          options={
            audioTracks.length > 0
              ? audioTracks.map((at) => ({ value: at.id, label: at.name }))
              : [{ value: "", label: t("behaviors.noAudioTracks") }]
          }
          placeholder={t("behaviors.selectTrack")}
        />
      );
    case "behavior":
      return (
        <Select
          value={value}
          onValueChange={onChange}
          options={allReactions.map((r) => ({
            value: r.id,
            label: r.name,
          }))}
          placeholder={t("behaviors.selectBehavior")}
        />
      );
    case "select":
      return (
        <Select
          value={value}
          onValueChange={onChange}
          options={
            field.options?.map((o) => ({
              value: o.value,
              label: o.label,
            })) ?? []
          }
        />
      );
    case "operand": {
      // Operand is either a literal value (常量) or another variable's value (变量),
      // encoded as "@ref:<id>" so it fits the one-string-per-field model.
      const isRef = value.startsWith("@ref:");
      const refId = isRef ? value.slice(5) : "";
      return (
        <div className="flex items-center gap-2">
          <Select
            value={isRef ? "var" : "const"}
            onValueChange={(mode) => onChange(mode === "var" ? `@ref:${variables[0]?.id ?? ""}` : "")}
            options={[
              { value: "const", label: t("behaviors.operandConstant") },
              { value: "var", label: t("behaviors.operandVariable") },
            ]}
          />
          {isRef ? (
            <Select
              value={refId}
              onValueChange={(id) => onChange(`@ref:${id}`)}
              options={variables.map((v) => ({ value: v.id, label: v.name }))}
              placeholder={t("behaviors.selectVariable")}
            />
          ) : (
            <DebouncedInput
              value={value}
              onCommit={onChange}
              placeholder={field.placeholder}
              className={fieldInputClass}
            />
          )}
        </div>
      );
    }
    case "number":
      return (
        <DebouncedInput
          type="text"
          inputMode="decimal"
          value={value}
          onCommit={onChange}
          placeholder={field.placeholder}
          className={fieldInputClass}
        />
      );
    default:
      return (
        <DebouncedInput
          value={value}
          onCommit={onChange}
          placeholder={field.placeholder}
          className={fieldInputClass}
        />
      );
  }
}
