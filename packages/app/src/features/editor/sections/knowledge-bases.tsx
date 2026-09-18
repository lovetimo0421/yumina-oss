import { useState, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, BookOpen, Library, Power, PanelLeftClose, PanelLeftOpen, Pencil, Check, Monitor, ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import type { Worldbook, Condition } from "@yumina/engine";
import { extractLoreSlotsFromFiles, getUiBoundEntryIds } from "@yumina/engine";
import { normalizeLoreUiBindingsList } from "../lib/lore-ui-bindings";
import { ConditionEditor } from "../components/condition-editor";
import { DebouncedInput } from "../components/debounced-field";
import { EntriesSection } from "./entries";
import { LoreBindingsPanel } from "../components/lore-bindings-panel";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";

// Sentinel `selected` value for the frontend-bindings view (distinct from a worldbook id).
const BINDINGS_KEY = "__bindings__";
// Sentinel for the cross-book "all entries" view: every book's entries merged in
// their actual send order, draggable across books.
const ALL_KEY = "__all__";

// Stable empty refs — never inline `?? []` inside a Zustand selector.
const EMPTY_WB: Worldbook[] = [];

const OPS: Record<Condition["operator"], string> = {
  eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", contains: "∋",
};

/** A book's activation counts as "configured" once a real gating rule is set
 *  (conditions with ≥1 condition, or greeting with ≥1 opening). always/manual =
 *  default/unset, so the activation editor opens by default for those. */
function isActivationConfigured(wb: Worldbook): boolean {
  if (wb.activation.mode === "conditions") return wb.activation.conditions.length > 0;
  if (wb.activation.mode === "greeting") return wb.activation.greetingIds.length > 0;
  return false;
}

/**
 * 知识库 — a card holds MULTIPLE independent knowledge bases ("books"). Each book
 * is a full lorebook (its own entries) that can be enabled/disabled as a whole and
 * (optionally) auto-activated by variable conditions / frontend / openings.
 * Entries live inside a book. The "Main" book = entries with no worldbookId, always on.
 */
export function KnowledgeBasesSection(_props: { compact?: boolean } = {}) {
  const { t } = useTranslation("editor");
  const worldbooks = useEditorStore((s) => s.worldDraft.worldbooks) ?? EMPTY_WB;
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const variables = useEditorStore((s) => s.worldDraft.variables);
  const rootComponent = useEditorStore((s) => s.worldDraft.rootComponent);
  const loreUiBindings = useEditorStore((s) => s.worldDraft.loreUiBindings);
  const addWorldbook = useEditorStore((s) => s.addWorldbook);
  const updateWorldbook = useEditorStore((s) => s.updateWorldbook);
  const removeWorldbook = useEditorStore((s) => s.removeWorldbook);

  // Frontend lore controls the card wires up: scanned from the TSX
  // (`<LoreSlot>` / `<LoreButton>` / `<LoreGroup>`) OR already-saved bindings.
  // The bindings view only matters when the card actually wires the frontend.
  const slotCount = useMemo(() => {
    let scanned = 0;
    try {
      scanned = extractLoreSlotsFromFiles(rootComponent?.files ?? {}).length;
    } catch {
      scanned = 0;
    }
    const bound = Array.isArray(loreUiBindings) ? loreUiBindings.length : 0;
    return Math.max(scanned, bound);
  }, [rootComponent?.files, loreUiBindings]);

  // null = the always-on Main book; BINDINGS_KEY = frontend-bindings view; else a book id.
  const [selected, setSelected] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.innerWidth < 768);
  // Which book card is in inline-rename mode
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Activation editor collapse override: null = follow default (open until a real
  // gating rule is set). Reset whenever the selected book changes.
  const [activationOpen, setActivationOpen] = useState<boolean | null>(null);

  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, []);

  useEffect(() => { setActivationOpen(null); }, [selected]);

  const showBindings = selected === BINDINGS_KEY;
  const showAll = selected === ALL_KEY;
  const selectedBook = selected && !showBindings && !showAll ? worldbooks.find((w) => w.id === selected) : null;
  const showMain = !showBindings && !showAll && (!selected || !selectedBook);

  const greetings = entries.filter((e) => e.role === "greeting");
  // Frontend-bound entries live in their own dedicated "Frontend lore" book
  // (counted via slotCount), so exclude them from the Main/worldbook counts.
  const uiBoundIds = useMemo(
    () => getUiBoundEntryIds(normalizeLoreUiBindingsList(loreUiBindings)),
    [loreUiBindings],
  );
  const nonGreeting = entries.filter((e) => e.role !== "greeting" && !uiBoundIds.has(e.id));
  const mainCount = nonGreeting.filter((e) => !e.worldbookId).length;
  const countOf = (id: string) => nonGreeting.filter((e) => e.worldbookId === id).length;

  function createBook() {
    const before = useEditorStore.getState().worldDraft.worldbooks ?? [];
    addWorldbook(t("kb.newBookName", { n: before.length + 1 }));
    const after = useEditorStore.getState().worldDraft.worldbooks ?? [];
    const created = after[after.length - 1];
    if (created) setSelected(created.id);
  }

  function setMode(wb: Worldbook, mode: "always" | "manual" | "conditions" | "greeting") {
    if (mode === "conditions") {
      const prev = wb.activation.mode === "conditions" ? wb.activation : null;
      updateWorldbook(wb.id, {
        activation: { mode: "conditions", conditions: prev?.conditions ?? [], conditionLogic: prev?.conditionLogic ?? "all" },
      });
    } else if (mode === "greeting") {
      const prev = wb.activation.mode === "greeting" ? wb.activation : null;
      updateWorldbook(wb.id, {
        activation: { mode: "greeting", greetingIds: prev?.greetingIds ?? [] },
      });
    } else {
      updateWorldbook(wb.id, { activation: { mode } });
    }
  }

  function toggleGreetingId(wb: Worldbook, gid: string) {
    const prev = wb.activation.mode === "greeting" ? wb.activation.greetingIds : [];
    const next = prev.includes(gid) ? prev.filter((x) => x !== gid) : [...prev, gid];
    updateWorldbook(wb.id, { activation: { mode: "greeting", greetingIds: next } });
  }

  function bookBadge(wb: Worldbook) {
    if (wb.enabled === false) return { txt: t("kb.disabled"), cls: "bg-white/5 text-muted-foreground" };
    if (wb.activation.mode === "always") return { txt: t("kb.badgeAlways"), cls: "bg-emerald-500/15 text-emerald-400" };
    if (wb.activation.mode === "manual") return { txt: t("kb.badgeManual"), cls: "bg-white/5 text-muted-foreground" };
    if (wb.activation.mode === "greeting") {
      const n = wb.activation.greetingIds.length;
      return { txt: n > 0 ? `${t("kb.badgeGreeting")} ×${n}` : t("kb.badgeGreeting"), cls: "bg-violet-500/15 text-violet-300" };
    }
    const cs = wb.activation.conditions;
    const txt = cs.length
      ? cs.map((c) => `${varName(c.variableId)} ${OPS[c.operator]} ${String(c.value)}`).join(" · ")
      : t("kb.badgeConditions");
    return { txt: `${t("kb.badgePrefixVar")} ${txt}`, cls: "bg-sky-500/15 text-sky-300" };
  }
  const varName = (id: string) => variables.find((v) => v.id === id)?.name ?? id;

  const seg = "rounded-md px-3 py-1.5 text-xs font-semibold transition-colors";
  const segOn = "bg-primary text-primary-foreground";
  const segOff = "text-muted-foreground hover:text-foreground";

  function Switch({ on, onClick, title }: { on: boolean; onClick: () => void; title?: string }) {
    return (
      <button
        type="button"
        title={title}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
        className={cn("relative h-[18px] w-[32px] shrink-0 rounded-full transition-colors", on ? "bg-emerald-500" : "bg-muted-foreground/30")}
      >
        <span className={cn("absolute top-[2px] h-[14px] w-[14px] rounded-full bg-white transition-all", on ? "left-[16px]" : "left-[2px]")} />
      </button>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">

      {/* ── Mobile only: horizontal scrollable book tab bar ── */}
      {isMobile && (
        <div
          data-tour="kb-books"
          className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border bg-card px-3 py-2"
          style={{ scrollbarWidth: "none" } as React.CSSProperties}
        >
          {/* All-entries tab — cross-book ordering (only meaningful with extra books) */}
          {worldbooks.length > 0 && (
            <button
              type="button"
              onClick={() => setSelected(ALL_KEY)}
              className={cn(
                "shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-bold transition-colors",
                showAll
                  ? "border-amber-400 bg-amber-500/10 text-amber-300"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t("kb.allEntries")}
            </button>
          )}

          {/* Main book tab */}
          <button
            type="button"
            onClick={() => setSelected(null)}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-bold transition-colors",
              showMain
                ? "border-primary bg-primary/10 text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t("kb.mainBook")}
          </button>

          {/* Frontend-bindings tab (only when the card declares LoreSlots) */}
          {slotCount > 0 && (
            <button
              type="button"
              onClick={() => setSelected(BINDINGS_KEY)}
              className={cn(
                "flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-bold transition-colors",
                showBindings
                  ? "border-emerald-400 bg-emerald-500/10 text-emerald-400"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Monitor className="h-3 w-3" />
              {t("kb.bindingsTab")}
            </button>
          )}

          {/* Worldbook tabs */}
          {worldbooks.map((wb) => (
            <button
              key={wb.id}
              type="button"
              onClick={() => setSelected(wb.id)}
              className={cn(
                "shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-bold transition-colors",
                selected === wb.id
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
                wb.enabled === false && "opacity-50",
              )}
            >
              {wb.name || t("kb.untitledBook")}
            </button>
          ))}

          {/* New book button */}
          <button
            type="button"
            onClick={createBook}
            className="shrink-0 whitespace-nowrap rounded-full border border-dashed border-border px-3 py-1 text-xs font-bold text-muted-foreground transition-colors hover:border-primary hover:text-primary"
          >
            <Plus className="mr-1 inline h-3 w-3" />
            {t("kb.newBook")}
          </button>
        </div>
      )}

      {/* ── Main content: sidebar (desktop) + entries panel (both) ── */}
      <div className="flex min-h-0 flex-1">

        {/* Desktop only: Collapsed hint strip */}
        {!isMobile && !sidebarOpen && (
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            title={t("kb.expandSidebar")}
            data-tour="kb-books"
            className="flex w-10 shrink-0 flex-col items-center gap-3 border-r border-border bg-card/40 py-3 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PanelLeftOpen className="h-4 w-4" />
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-bold text-primary select-none">
              {worldbooks.length + 1}
            </span>
            <div className="mt-auto flex flex-col items-center gap-1.5 pb-1">
              <div className="h-2 w-2 rounded-full bg-emerald-400/70" title={t("kb.mainBook")} />
              {slotCount > 0 && (
                <span title={t("kb.bindingsTab")} className="flex items-center justify-center">
                  <Monitor className="h-3 w-3 text-emerald-400/80" />
                </span>
              )}
              {worldbooks.map((wb) => (
                <div
                  key={wb.id}
                  className={cn("h-2 w-2 rounded-full", wb.enabled === false ? "bg-muted-foreground/30" : "bg-sky-300/70")}
                  title={wb.name}
                />
              ))}
            </div>
          </button>
        )}

        {/* Desktop only: Book list sidebar */}
        {!isMobile && (
          <div data-tour={sidebarOpen ? "kb-books" : undefined} className={cn("flex shrink-0 flex-col border-r border-border bg-card/40 transition-all duration-200", sidebarOpen ? "w-[244px]" : "w-0 overflow-hidden border-r-0")}>
            <div className="flex items-center justify-between px-3 pb-2 pt-3">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t("kb.listTitle")}
              </span>
              <span className="text-xs text-primary">{t("kb.bookCount", { count: worldbooks.length + 1 })}</span>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
              {/* All entries — the cross-book ordering view. Only shown once the
                  card actually has extra books; with just Main it IS the main list. */}
              {worldbooks.length > 0 && (
                <button
                  type="button"
                  onClick={() => setSelected(ALL_KEY)}
                  className={cn(
                    "w-full rounded-xl border p-3 text-left transition-colors",
                    showAll ? "border-amber-400 bg-gradient-to-b from-amber-500/10 to-transparent" : "border-border bg-card hover:border-muted-foreground/30",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Library className="h-4 w-4 shrink-0 text-amber-300" />
                    <span className="flex-1 truncate text-sm font-bold text-foreground">{t("kb.allEntries")}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5">
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300">{t("kb.allBadge")}</span>
                    <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-muted-foreground">{t("kb.entryCount", { count: nonGreeting.length })}</span>
                  </div>
                </button>
              )}

              {/* Main book */}
              <button
                type="button"
                onClick={() => setSelected(null)}
                className={cn(
                  "w-full rounded-xl border p-3 text-left transition-colors",
                  showMain ? "border-primary bg-gradient-to-b from-primary/10 to-transparent" : "border-border bg-card hover:border-muted-foreground/30",
                )}
              >
                <div className="flex items-center gap-2">
                  <BookOpen className="h-4 w-4 shrink-0 text-emerald-400" />
                  <span className="flex-1 truncate text-sm font-bold text-foreground">{t("kb.mainBook")}</span>
                </div>
                <div className="mt-2 flex items-center gap-1.5">
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">{t("kb.badgeAlways")}</span>
                  <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-muted-foreground">{t("kb.entryCount", { count: mainCount })}</span>
                </div>
              </button>

              {/* Frontend bindings — a first-class lore module driven by the card's UI controls */}
              {slotCount > 0 && (
                <button
                  type="button"
                  onClick={() => setSelected(BINDINGS_KEY)}
                  className={cn(
                    "w-full rounded-xl border p-3 text-left transition-colors",
                    showBindings ? "border-emerald-400 bg-gradient-to-b from-emerald-500/10 to-transparent" : "border-border bg-card hover:border-muted-foreground/30",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Monitor className="h-4 w-4 shrink-0 text-emerald-400" />
                    <span className="flex-1 truncate text-sm font-bold text-foreground">{t("kb.bindingsTab")}</span>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5">
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">{t("kb.bindingsBadge")}</span>
                    <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-muted-foreground">{t("kb.controlCount", { count: slotCount })}</span>
                  </div>
                </button>
              )}

              {worldbooks.map((wb) => {
                const badge = bookBadge(wb);
                const isOn = wb.enabled !== false;
                const sel = selected === wb.id;
                const isRenaming = renamingId === wb.id;
                return (
                  <div
                    key={wb.id}
                    className={cn(
                      "group/book rounded-xl border transition-colors",
                      sel ? "border-primary bg-gradient-to-b from-primary/10 to-transparent" : "border-border bg-card hover:border-muted-foreground/30",
                      !isOn && "opacity-55",
                    )}
                  >
                    {/* Main row — click to select */}
                    <button
                      type="button"
                      onClick={() => setSelected(wb.id)}
                      className="w-full p-3 text-left"
                    >
                      <div className="flex items-center gap-2">
                        <BookOpen className="h-4 w-4 shrink-0 text-sky-300" />
                        {isRenaming ? (
                          <input
                            autoFocus
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                updateWorldbook(wb.id, { name: renameValue.trim() || wb.name });
                                setRenamingId(null);
                              }
                              if (e.key === "Escape") setRenamingId(null);
                              e.stopPropagation();
                            }}
                            onClick={(e) => e.stopPropagation()}
                            className="flex-1 rounded border border-primary/50 bg-background px-1 py-0.5 text-sm font-bold text-foreground focus:outline-none"
                          />
                        ) : (
                          <span className="flex-1 truncate text-sm font-bold text-foreground">{wb.name || t("kb.untitledBook")}</span>
                        )}
                        <Switch on={isOn} title={t("kb.toggleEnable")} onClick={() => updateWorldbook(wb.id, { enabled: !isOn })} />
                      </div>
                      <div className="mt-2 flex items-center gap-1.5">
                        <span className={cn("max-w-[10rem] truncate rounded-full px-2 py-0.5 text-[10px] font-semibold", badge.cls)}>{badge.txt}</span>
                        <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-muted-foreground">{t("kb.entryCount", { count: countOf(wb.id) })}</span>
                      </div>
                    </button>
                    {/* Hover action row — rename / delete */}
                    <div className="hidden group-hover/book:flex items-center justify-end gap-1 border-t border-border/50 px-3 py-1.5">
                      {isRenaming ? (
                        <button
                          type="button"
                          onClick={() => { updateWorldbook(wb.id, { name: renameValue.trim() || wb.name }); setRenamingId(null); }}
                          className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-semibold text-emerald-400 hover:bg-emerald-500/10"
                        >
                          <Check className="h-3 w-3" /> {t("kb.confirmRename")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setRenameValue(wb.name); setRenamingId(wb.id); }}
                          className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          <Pencil className="h-3 w-3" /> {t("kb.rename")}
                        </button>
                      )}
                      <TwoTapDeleteButton
                        onConfirm={() => { removeWorldbook(wb.id); if (selected === wb.id) setSelected(null); }}
                        className="flex items-center gap-1 rounded px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                        armedChildren={<><Trash2 className="h-3 w-3" /> {t("twoTapConfirm")}</>}
                      >
                        <Trash2 className="h-3 w-3" /> {t("kb.removeBook")}
                      </TwoTapDeleteButton>
                    </div>
                  </div>
                );
              })}

              <button
                type="button"
                onClick={createBook}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-2.5 text-xs font-bold text-muted-foreground transition-colors hover:border-primary hover:text-primary"
              >
                <Plus className="h-3.5 w-3.5" /> {t("kb.newBook")}
              </button>
            </div>
            <div className="border-t border-border px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
              <Library className="mr-1 inline h-3 w-3 text-primary" />
              {t("kb.listHint")}
            </div>
          </div>
        )}

        {/* ── Entries panel (desktop + mobile) ── */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {showBindings ? (
            <>
              <div className="shrink-0 border-b border-border bg-card px-5 py-3">
                <div className="flex items-center gap-2">
                  {!isMobile && (
                    <button
                      type="button"
                      onClick={() => setSidebarOpen((v) => !v)}
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      title={sidebarOpen ? t("kb.collapseSidebar") : t("kb.expandSidebar")}
                    >
                      {sidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
                    </button>
                  )}
                  <Monitor className="h-5 w-5 text-emerald-400" />
                  <h2 className="text-base font-extrabold text-foreground">{t("kb.bindingsTab")}</h2>
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-400">{t("kb.controlCount", { count: slotCount })}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t("kb.bindingsPanelDesc")}</p>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
                <LoreBindingsPanel inline />
              </div>
            </>
          ) : showAll ? (
            <>
              <div className="shrink-0 border-b border-border bg-card px-5 py-3">
                <div className="flex items-center gap-2">
                  {!isMobile && (
                    <button
                      type="button"
                      onClick={() => setSidebarOpen((v) => !v)}
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      title={sidebarOpen ? t("kb.collapseSidebar") : t("kb.expandSidebar")}
                    >
                      {sidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
                    </button>
                  )}
                  <Library className="h-5 w-5 text-amber-300" />
                  <h2 className="text-base font-extrabold text-foreground">{t("kb.allEntries")}</h2>
                  <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-300">{t("kb.entryCount", { count: nonGreeting.length })}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t("kb.allDesc")}</p>
              </div>
              <div className="flex min-h-0 flex-1 flex-col">
                <EntriesSection key="kb-all" compact />
              </div>
            </>
          ) : showMain ? (
            <>
              <div className="shrink-0 border-b border-border bg-card px-5 py-3">
                <div className="flex items-center gap-2">
                  {!isMobile && (
                    <button
                      type="button"
                      onClick={() => setSidebarOpen((v) => !v)}
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      title={sidebarOpen ? t("kb.collapseSidebar") : t("kb.expandSidebar")}
                    >
                      {sidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
                    </button>
                  )}
                  <BookOpen className="h-5 w-5 text-emerald-400" />
                  <h2 className="text-base font-extrabold text-foreground">{t("kb.mainBook")}</h2>
                  <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-400">{t("kb.badgeAlways")}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t("kb.mainBookDesc")}</p>
              </div>
              <div className="flex min-h-0 flex-1 flex-col">
                <EntriesSection key="kb-main" compact scopeWorldbookId={null} />
              </div>
            </>
          ) : selectedBook ? (
            <>
              <div className="shrink-0 overflow-y-auto border-b border-border bg-card px-5 py-3" style={{ maxHeight: "55%" }}>
                <div className="flex items-center gap-3">
                  {!isMobile && (
                    <button
                      type="button"
                      onClick={() => setSidebarOpen((v) => !v)}
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      title={sidebarOpen ? t("kb.collapseSidebar") : t("kb.expandSidebar")}
                    >
                      {sidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
                    </button>
                  )}
                  <BookOpen className="h-5 w-5 shrink-0 text-sky-300" />
                  <DebouncedInput
                    value={selectedBook.name}
                    onCommit={(v) => updateWorldbook(selectedBook.id, { name: v })}
                    placeholder={t("kb.namePlaceholder")}
                    className="flex-1 rounded-lg border border-transparent bg-transparent px-1 py-1 text-base font-extrabold text-foreground hover:border-border focus:border-primary/50 focus:bg-background focus:outline-none"
                  />
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Power className="h-3.5 w-3.5" />{t("kb.enableLabel")}
                    <Switch on={selectedBook.enabled !== false} onClick={() => updateWorldbook(selectedBook.id, { enabled: !(selectedBook.enabled !== false) })} />
                  </div>
                  <TwoTapDeleteButton
                    onConfirm={() => { removeWorldbook(selectedBook.id); setSelected(null); }}
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    title={t("kb.removeBook")}
                    armedTitle={t("twoTapConfirm")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </TwoTapDeleteButton>
                </div>

                {/* activation editor — collapsible. Opens by default until a real
                    gating rule is set, then collapses to a one-line summary badge
                    (the same badge shown in the book list). */}
                {(() => {
                  const actOpen = activationOpen ?? !isActivationConfigured(selectedBook);
                  const actBadge = bookBadge(selectedBook);
                  return (
                <div className="mt-3 overflow-hidden rounded-lg border border-border bg-background/60">
                  <button
                    type="button"
                    onClick={() => setActivationOpen(!actOpen)}
                    className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-white/[0.03]"
                  >
                    {actOpen
                      ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("kb.activationTitle")}</span>
                    {!actOpen && (
                      <span className={cn("max-w-[12rem] truncate rounded-full px-2 py-0.5 text-[10px] font-semibold", actBadge.cls)}>{actBadge.txt}</span>
                    )}
                    <span className="ml-auto text-[10px] font-normal normal-case text-muted-foreground opacity-70">{t("kb.activationOptional")}</span>
                  </button>

                  {actOpen && (
                  <div className="px-3 pb-3">
                  <div className="flex w-fit flex-wrap gap-1 rounded-lg bg-card p-1">
                    {([
                      ["always", t("kb.modeAlways")],
                      ["conditions", t("kb.modeConditions")],
                      ["greeting", t("kb.modeGreeting")],
                    ] as const).map(([m, label]) => (
                      <button key={m} type="button" onClick={() => setMode(selectedBook, m)}
                        className={cn(seg, selectedBook.activation.mode === m ? segOn : segOff)}>{label}</button>
                    ))}
                  </div>

                  {selectedBook.activation.mode === "conditions" ? (
                    <div className="mt-3 space-y-2 rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {t("kb.logicLabel")}
                        {(["all", "any"] as const).map((lg) => (
                          <button key={lg} type="button"
                            onClick={() => updateWorldbook(selectedBook.id, { activation: { mode: "conditions", conditions: selectedBook.activation.mode === "conditions" ? selectedBook.activation.conditions : [], conditionLogic: lg } })}
                            className={cn("rounded px-2 py-0.5 font-semibold uppercase",
                              (selectedBook.activation.mode === "conditions" ? selectedBook.activation.conditionLogic : "all") === lg ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground")}>
                            {t(`kb.logic_${lg}`)}
                          </button>
                        ))}
                      </div>
                      <ConditionEditor
                        conditions={selectedBook.activation.mode === "conditions" ? selectedBook.activation.conditions : []}
                        variables={variables}
                        onChange={(conditions) => updateWorldbook(selectedBook.id, { activation: { mode: "conditions", conditions, conditionLogic: selectedBook.activation.mode === "conditions" ? selectedBook.activation.conditionLogic : "all" } })}
                      />
                      {variables.length === 0 && <p className="text-xs text-amber-500/80">{t("kb.noVars")}</p>}
                    </div>
                  ) : selectedBook.activation.mode === "greeting" ? (
                    <div className="mt-3 space-y-2 rounded-lg border border-violet-500/20 bg-violet-500/5 p-3">
                      <p className="text-xs text-muted-foreground">{t("kb.modeGreetingHint")}</p>
                      <div className="text-[11px] font-semibold text-muted-foreground">{t("kb.greetingPickerTitle")}</div>
                      {greetings.length === 0 ? (
                        <p className="text-xs text-amber-500/80">{t("kb.greetingNone")}</p>
                      ) : (
                        <div className="space-y-1">
                          {greetings.map((g, i) => {
                            const active = selectedBook.activation.mode === "greeting" && selectedBook.activation.greetingIds.includes(g.id);
                            return (
                              <label key={g.id} className="flex cursor-pointer items-start gap-2 rounded-md p-1.5 hover:bg-white/5">
                                <input
                                  type="checkbox"
                                  checked={active}
                                  onChange={() => toggleGreetingId(selectedBook, g.id)}
                                  className="mt-0.5 shrink-0 accent-violet-400"
                                />
                                <span className="min-w-0 flex-1 truncate text-xs text-foreground">
                                  <span className="mr-1.5 font-bold text-violet-300">#{i + 1}</span>
                                  {g.content.slice(0, 80) || "(空)"}
                                  {g.content.length > 80 && "…"}
                                </span>
                              </label>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {selectedBook.activation.mode === "manual" ? t("kb.manualHint") : t("kb.alwaysHint")}
                    </p>
                  )}
                  </div>
                  )}
                </div>
                  );
                })()}
              </div>
              <div className="flex min-h-0 flex-1 flex-col">
                <EntriesSection key={`kb-${selectedBook.id}`} compact scopeWorldbookId={selectedBook.id} />
              </div>
            </>
          ) : null}
        </div>

      </div>
    </div>
  );
}
