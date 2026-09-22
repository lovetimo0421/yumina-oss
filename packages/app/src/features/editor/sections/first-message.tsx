import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, MessageCircle, BookOpen } from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  horizontalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/utils";
import { DOCS_URLS } from "@/lib/docs-urls";
import { useEditorStore } from "@/stores/editor";
import { estimateTokens } from "@yumina/engine";
import { DebouncedTextarea } from "../components/debounced-field";
import { ImageInsertButton, useImageInsert } from "../components/image-insert";

const EMPTY_WB: import("@yumina/engine").Worldbook[] = [];

export function FirstMessageSection({ compact }: { compact?: boolean } = {}) {
  const { t } = useTranslation("editor");
  const worldDraft = useEditorStore(s => s.worldDraft);
  const variables = useEditorStore(s => s.worldDraft.variables);
  const worldbooks = useEditorStore(s => s.worldDraft.worldbooks) ?? EMPTY_WB;
  const addEntry = useEditorStore(s => s.addEntry);
  const updateEntry = useEditorStore(s => s.updateEntry);
  const removeEntry = useEditorStore(s => s.removeEntry);
  const reorderEntries = useEditorStore(s => s.reorderEntries);
  const setActiveSection = useEditorStore(s => s.setActiveSection);

  const greetings = worldDraft.entries
    .filter((e) => e.role === "greeting")
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  const [activeIndex, setActiveIndex] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Drag-reorder the numbered greeting tabs. Greetings sort by `position`
  // among themselves only, so passing just the greeting ids renumbers them
  // without touching any lorebook entry's hand-set position.
  function handleReorderGreetings(newGreetingIds: string[]) {
    const activeId = greetings[clampedIndex]?.id;
    reorderEntries(newGreetingIds);
    // Keep the same greeting selected after the order changes.
    if (activeId) {
      const next = newGreetingIds.indexOf(activeId);
      if (next >= 0) setActiveIndex(next);
    }
  }

  function handleTabDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = greetings.map((g) => g.id);
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    handleReorderGreetings(arrayMove(ids, oldIndex, newIndex));
    setConfirmDelete(false);
  }

  // Clamp activeIndex to valid range
  const clampedIndex = greetings.length === 0 ? 0 : Math.min(activeIndex, greetings.length - 1);
  const activeGreeting = greetings[clampedIndex];
  // Pictures land in the opening text at the caret: the toolbar button,
  // a dropped file or a pasted image all go through the asset library.
  const contentRef = useRef<HTMLDivElement>(null);
  const imageInsert = useImageInsert(() => contentRef.current?.querySelector("textarea") ?? null);

  function handleCreate() {
    addEntry("greeting", "system-presets");
    const entries = useEditorStore.getState().worldDraft.entries;
    const newEntry = entries[entries.length - 1];
    if (newEntry) {
      const greetingCount = entries.filter((e) => e.role === "greeting").length;
      updateEntry(newEntry.id, {
        name: `Greeting ${greetingCount}`,
        role: "greeting",
        apiRole: "assistant",
        alwaysSend: true,
        enabled: true,
        tags: ["First Message"],
      });
    }
    // Switch to the new tab (greetings.length is pre-add, which equals the new last index)
    setActiveIndex(greetings.length);
    setConfirmDelete(false);
  }

  function handleDelete() {
    if (!activeGreeting) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    removeEntry(activeGreeting.id);
    setConfirmDelete(false);
    // Adjust index
    if (clampedIndex >= greetings.length - 1) {
      setActiveIndex(Math.max(0, clampedIndex - 1));
    }
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className={cn("mx-auto w-full max-w-3xl px-6", compact ? "py-4" : "py-10")}>
        {compact ? (
          greetings.length > 0 ? (
            <div className="mb-4 flex justify-end">
              <button
                onClick={handleCreate}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Plus className="h-3 w-3" /> {t("firstMessage.addGreeting")}
              </button>
            </div>
          ) : null
        ) : (
          <div className="mb-8 flex items-start justify-between">
            <div>
              <h1 className="text-[22px] font-bold tracking-tight text-foreground">
                {t("firstMessage.title")}
              </h1>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {t("firstMessage.description")}{" "}
                <a href={DOCS_URLS.beginnerGuide} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t("firstMessage.learnMore")}</a>
              </p>
            </div>
            {greetings.length > 0 && (
              <button
                onClick={handleCreate}
                className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground shadow-[0_0_15px_hsl(var(--primary)/0.3)] transition-colors hover:bg-primary/90"
              >
                <Plus className="h-3.5 w-3.5" /> {t("firstMessage.addGreeting")}
              </button>
            )}
          </div>
        )}

        {greetings.length > 0 ? (
          <div className="space-y-6">
            {/* Tab row — drag to reorder */}
            {greetings.length > 1 && (
              <div className="space-y-1.5">
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleTabDragEnd}
                >
                  <SortableContext
                    items={greetings.map((g) => g.id)}
                    strategy={horizontalListSortingStrategy}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      {greetings.map((g, i) => (
                        <SortableGreetingTab
                          key={g.id}
                          id={g.id}
                          label={i + 1}
                          active={i === clampedIndex}
                          onSelect={() => { setActiveIndex(i); setConfirmDelete(false); }}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
                <p className="text-[11px] text-muted-foreground/40">{t("firstMessage.dragHint")}</p>
              </div>
            )}

            {/* Content textarea */}
            {activeGreeting && (
              <div ref={contentRef} className="space-y-3" data-tour="fm-content">
                <DebouncedTextarea
                  value={activeGreeting.content}
                  onCommit={(content) => updateEntry(activeGreeting.id, { content })}
                  syncKey={activeGreeting.id}
                  rows={12}
                  placeholder={t("firstMessage.placeholder")}
                  {...imageInsert.dropProps}
                  className={cn(
                    "min-h-[240px] w-full resize-y rounded-xl border border-border bg-card px-4 py-4 font-mono text-sm leading-relaxed text-foreground shadow-inner transition-all placeholder:text-muted-foreground/30 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50",
                    imageInsert.dragOver && "border-primary/60 ring-2 ring-primary/40",
                  )}
                />
                {imageInsert.overlays}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-3">
                    <ImageInsertButton insert={imageInsert} />
                    <p className="text-xs text-muted-foreground/50">
                      {t("firstMessage.macros")} <code className="rounded bg-accent px-1 py-0.5 text-[11px]">{"{{user}}"}</code>{" "}
                      <code className="rounded bg-accent px-1 py-0.5 text-[11px]">{"{{char}}"}</code>
                    </p>
                  </div>
                  <p className="text-xs text-muted-foreground/40">
                    ~{estimateTokens(activeGreeting.content).toLocaleString()} {estimateTokens(activeGreeting.content) === 1 ? "token" : "tokens"}
                  </p>
                </div>
              </div>
            )}

            {/* Bound knowledge bases for this opening — read-only indicator */}
            {activeGreeting && worldbooks.length > 0 && (() => {
              const bound = worldbooks.filter(
                (wb) => wb.activation.mode === "greeting" && wb.activation.greetingIds.includes(activeGreeting.id),
              );
              if (bound.length === 0) return null;
              return (
                <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-violet-500/20 bg-violet-500/5 px-3 py-2.5">
                  <BookOpen className="h-3.5 w-3.5 shrink-0 text-violet-400" />
                  <span className="text-[11px] font-semibold text-violet-300">{t("kb.badgeGreeting")}:</span>
                  {bound.map((wb) => (
                    <span key={wb.id} className="rounded-full bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-300">
                      {wb.name || t("kb.untitledBook")}
                    </span>
                  ))}
                </div>
              );
            })()}

            {/* Initial variables for this opening — "scenario / route preset" */}
            {activeGreeting && variables.length > 0 && (() => {
              // Read-only mirror of this opening's seeded values. The single edit
              // entry point is the Variables → opening-values matrix; both bind to
              // the same greeting.initialVariables, so this stays in sync live.
              const seeded = Object.entries(activeGreeting.initialVariables ?? {});
              const fmt = (varId: string, value: number | string | boolean) => {
                const v = variables.find((x) => x.id === varId);
                const display =
                  v?.type === "boolean"
                    ? value
                      ? t("firstMessage.true")
                      : t("firstMessage.false")
                    : String(value);
                return { name: v?.name ?? varId, display };
              };
              return (
                <div className="space-y-2.5 rounded-xl border border-border bg-card/50 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-sm font-semibold text-foreground">{t("firstMessage.initialVarsTitle")}</h3>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t("firstMessage.initialVarsReadonlyHint")}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveSection("variables")}
                      className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
                    >
                      {t("firstMessage.editInVariables")} →
                    </button>
                  </div>
                  {seeded.length === 0 ? (
                    <p className="text-xs text-muted-foreground/60">{t("firstMessage.noInitialVars")}</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {seeded.map(([varId, value]) => {
                        const { name, display } = fmt(varId, value as number | string | boolean);
                        return (
                          <span key={varId} className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-xs">
                            <span className="text-muted-foreground">{name}</span>
                            <span className="text-muted-foreground/40">=</span>
                            <span className="font-medium text-foreground">{display}</span>
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Delete */}
            {activeGreeting && (
              <div className="border-t border-border pt-6">
                <button
                  onClick={handleDelete}
                  onBlur={() => setConfirmDelete(false)}
                  className={cn(
                    "flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
                    confirmDelete
                      ? "bg-destructive text-destructive-foreground"
                      : "text-destructive hover:bg-destructive/10"
                  )}
                >
                  <Trash2 className="h-4 w-4" />
                  {confirmDelete ? t("firstMessage.confirmDelete") : t("firstMessage.deleteGreeting")}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-card/50 px-8 py-16 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
              <MessageCircle className="h-7 w-7 text-primary" />
            </div>
            <h2 className="mb-2 text-lg font-bold text-foreground">{t("firstMessage.noFirstMessage")}</h2>
            <p className="mb-6 max-w-sm text-sm text-muted-foreground">
              {t("firstMessage.noFirstMessageDesc")}
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={handleCreate}
                data-tour="fm-empty-cta"
                className="flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-[0_0_15px_hsl(var(--primary)/0.3)] transition-colors hover:bg-primary/90"
              >
                <Plus className="h-4 w-4" /> {t("firstMessage.createFirstMessage")}
              </button>
              <a href={DOCS_URLS.beginnerGuide} target="_blank" rel="noopener noreferrer" className="text-xs text-primary hover:underline">{t("firstMessage.learnMore")}</a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SortableGreetingTab({
  id,
  label,
  active,
  onSelect,
}: {
  id: string;
  label: number;
  active: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  return (
    <button
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      onClick={onSelect}
      {...attributes}
      {...listeners}
      className={cn(
        "flex h-8 min-w-[32px] cursor-grab touch-none items-center justify-center rounded-lg px-3 text-sm font-medium transition-all active:cursor-grabbing",
        isDragging && "z-10 opacity-80 shadow-md",
        active
          ? "bg-primary text-primary-foreground shadow-sm"
          : "border border-border bg-card text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground"
      )}
    >
      {label}
    </button>
  );
}
