import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Monitor, ArrowRight, FileText } from "lucide-react";
import { deriveSectionDefaults, estimateTokens, extractLoreSlotsFromFiles, type WorldEntry } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { DebouncedInput, DebouncedTextarea } from "./debounced-field";
import { ConditionEditor } from "./condition-editor";
import { formatConditionLabel, normalizeLoreUiBindingsList } from "../lib/lore-ui-bindings";

function createUiBoundEntry(slotId: string, position: number): WorldEntry {
  const defaults = deriveSectionDefaults("system-presets");
  return {
    id: crypto.randomUUID(),
    name: slotId,
    content: "",
    role: "lore",
    alwaysSend: false,
    keywords: [],
    conditions: [],
    conditionLogic: "all",
    enabled: true,
    matchWholeWords: false,
    secondaryKeywords: [],
    secondaryKeywordLogic: "AND_ANY",
    preventRecursion: false,
    excludeRecursion: false,
    position,
    section: "system-presets",
    tags: [],
    depth: defaults.depth,
    variableBound: false,
  };
}

export function LoreBindingsPanel({ inline = false }: { inline?: boolean } = {}) {
  const { t } = useTranslation("editor");
  const rootComponent = useEditorStore((s) => s.worldDraft.rootComponent);
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const loreUiBindingsRaw = useEditorStore((s) => s.worldDraft.loreUiBindings);
  const setField = useEditorStore((s) => s.setField);
  const variables = useEditorStore((s) => s.worldDraft.variables);

  const bindings = useMemo(
    () => normalizeLoreUiBindingsList(loreUiBindingsRaw),
    [loreUiBindingsRaw],
  );
  const updateEntry = useEditorStore((s) => s.updateEntry);
  const setActiveSection = useEditorStore((s) => s.setActiveSection);
  const setCustomUiTab = useEditorStore((s) => s.setCustomUiTab);

  const slots = useMemo(() => {
    let scanned: { slotId: string; file: string; line: number }[] = [];
    try {
      scanned = extractLoreSlotsFromFiles(rootComponent?.files ?? {});
    } catch {
      scanned = [];
    }
    // Include slots that already have a saved binding but aren't currently
    // scannable (e.g. the TSX was edited away, or an imported card) so the
    // creator never loses sight of a binding that still drives the AI prompt.
    const known = new Set(scanned.map((s) => s.slotId));
    const bindingOnly = bindings
      .filter((b) => b.slotId && !known.has(b.slotId))
      .map((b) => ({ slotId: b.slotId, file: t("components.bindingsSavedSlot"), line: 0 }));
    return [...scanned, ...bindingOnly];
  }, [rootComponent?.files, bindings, t]);

  const slotKey = useMemo(
    () => slots.map((s) => s.slotId).sort().join("|"),
    [slots],
  );
  const ensuredRef = useRef<string>("");

  useEffect(() => {
    if (!slotKey) return;
    if (ensuredRef.current === slotKey) return;
    ensuredRef.current = slotKey;

    const draft = useEditorStore.getState().worldDraft;
    const currentEntries = draft.entries ?? [];
    const currentBindings = normalizeLoreUiBindingsList(draft.loreUiBindings);

    let nextEntries = [...currentEntries];
    let nextBindings = [...currentBindings];
    let changed = false;

    const maxPos = nextEntries.reduce((m, e) => Math.max(m, e.position ?? 0), 0);
    let nextPos = maxPos + 1;

    for (const slot of slots) {
      const binding = nextBindings.find((b) => b.slotId === slot.slotId);
      if (!binding) {
        const entry = createUiBoundEntry(slot.slotId, nextPos++);
        nextEntries.push(entry);
        nextBindings.push({
          slotId: slot.slotId,
          entryId: entry.id,
          conditions: [],
          conditionLogic: "all",
        });
        changed = true;
        continue;
      }
      if (!binding.entryId || !nextEntries.some((e) => e.id === binding.entryId)) {
        const entry = createUiBoundEntry(slot.slotId, nextPos++);
        nextBindings = nextBindings.map((b) =>
          b.slotId === slot.slotId
            ? { ...b, entryId: entry.id, conditions: b.conditions ?? [], conditionLogic: b.conditionLogic ?? "all" }
            : b,
        );
        nextEntries.push(entry);
        changed = true;
      }
    }

    if (!changed) return;

    setField("entries", nextEntries);
    setField("loreUiBindings", nextBindings);
  }, [slotKey, slots, setField]);

  if (slots.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/20 p-8 text-center">
        <Monitor className="mx-auto h-8 w-8 text-muted-foreground/40" />
        <p className="mt-3 text-sm text-muted-foreground">{t("components.bindingsEmpty")}</p>
        <p className="mt-2 font-mono text-xs text-muted-foreground/70">
          {"{show && <LoreSlot id=\"secret-lore\" />}"}
        </p>
        <button
          type="button"
          onClick={() => {
            setActiveSection("components");
            setCustomUiTab("code");
          }}
          className="mt-4 text-xs font-medium text-primary hover:underline"
        >
          {t("components.bindingsGoToCode")}
        </button>
      </div>
    );
  }

  return (
    <div className={inline ? "space-y-5 pb-4" : "mx-auto max-w-3xl space-y-6 pb-8"}>
      <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("components.bindingsHint")}
        </p>
      </div>

      {slots.map((slot) => {
        const binding = bindings.find((b) => b.slotId === slot.slotId);
        const entry = binding?.entryId
          ? entries.find((e) => e.id === binding.entryId)
          : undefined;
        const conditionCount = entry?.conditions?.length ?? 0;
        const firstCondition = conditionCount > 0 && entry
          ? formatConditionLabel(entry.conditions[0]!, variables)
          : t("conditionEditor.noConditions");

        return (
          <article
            key={`${slot.file}:${slot.slotId}`}
            className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm"
          >
            <header className="border-b border-border/70 bg-muted/30 px-4 py-3">
              {/* 前端控件 ──→ 词条 : the binding at a glance */}
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500/12 px-2.5 py-1 font-mono text-xs font-semibold text-emerald-600 dark:text-emerald-300">
                  <Monitor className="h-3.5 w-3.5" />
                  {slot.slotId}
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground/60" />
                <span className="inline-flex min-w-0 items-center gap-1.5 rounded-lg bg-background px-2.5 py-1 text-xs font-semibold text-foreground ring-1 ring-border">
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{entry?.name || slot.slotId}</span>
                </span>
                <span className="ml-auto shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                  ~{estimateTokens(entry?.content ?? "")} tok
                </span>
              </div>
              <div className="mt-1.5 text-[11px] text-muted-foreground">
                {t("components.bindingsActivationSummary")}
                <span className="ml-1.5 font-mono opacity-60">
                  {slot.line > 0 ? `${slot.file}:${slot.line}` : slot.file}
                </span>
              </div>
            </header>

            {entry ? (
              <div className="space-y-4 p-4">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                    {t("entries.name")}
                  </label>
                  <DebouncedInput
                    type="text"
                    value={entry.name}
                    onCommit={(name) => updateEntry(entry.id, { name })}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:border-primary focus:outline-none"
                  />
                </div>

                <div>
                  <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                    {t("entries.content")}
                  </label>
                  <DebouncedTextarea
                    value={entry.content}
                    onCommit={(content) => updateEntry(entry.id, { content })}
                    syncKey={entry.id}
                    rows={8}
                    className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm leading-relaxed text-foreground focus:border-primary focus:outline-none"
                    placeholder={t("entries.entryPlaceholder")}
                  />
                </div>

                <details className="rounded-xl border border-border/70 bg-muted/20 px-3 py-2">
                  <summary className="cursor-pointer list-none">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-foreground">
                          {t("entries.whenConditions")}
                        </p>
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {conditionCount > 1
                            ? `${firstCondition} +${conditionCount - 1}`
                            : firstCondition}
                        </p>
                      </div>
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {conditionCount}
                      </span>
                    </div>
                  </summary>
                  <div className="mt-3 border-t border-border/70 pt-3">
                    <p className="mb-2 text-[11px] text-muted-foreground">
                      {t("components.bindingsOptionalConditions")}
                    </p>
                    <ConditionEditor
                      conditions={entry.conditions ?? []}
                      variables={variables}
                      onChange={(conditions) => updateEntry(entry.id, { conditions })}
                    />
                  </div>
                </details>
              </div>
            ) : (
              <div className="p-4 text-sm text-muted-foreground">
                {t("components.bindingsCreating")}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
