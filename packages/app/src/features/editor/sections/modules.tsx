import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Boxes, ExternalLink, PanelLeftClose, PanelLeftOpen, Plus, Trash2 } from "lucide-react";
import type { Worldbook } from "@yumina/engine";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import { ModuleConsole } from "../components/module/module-console";
import { ModuleMemoryChip, ModuleMemoryLine } from "../components/module/module-memory-line";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";
import { DebouncedInput } from "../components/debounced-field";
import { DraftNumberInput } from "../components/condition-editor";
import { ModuleActivationEditor } from "../components/module-activation-editor";
import { ModuleContents } from "../components/module-contents";
import { ModuleNoteField } from "../components/module-note-field";
import { ShareModuleButton } from "@/edition/slots";
import { moduleActivationBadge } from "../lib/module-badge";
import { DOCS_URLS } from "@/lib/docs-urls";

// Stable empty ref — never inline `?? []` inside a Zustand selector.
const EMPTY_WB: Worldbook[] = [];

// Same breakpoint + matchMedia approach as the editor shell's mobile check
// (not exported from there), instead of a resize listener firing per pixel.
const MOBILE_QUERY = "(max-width: 767px)";
function useIsMobileModules() {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches,
  );
  useEffect(() => {
    if (typeof window === "undefined") return;
    const mq = window.matchMedia(MOBILE_QUERY);
    const handler = () => setIsMobile(mq.matches);
    handler();
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return isMobile;
}

// Row components live at module scope: defined inside the section's render
// they were a new component type every render, so React remounted every row
// (and the switch inside it) on each keystroke anywhere on the page.
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

function ModuleListItem({
  wb,
  selected,
  badge,
  ownCount,
  sharedCount,
  onSelect,
  onToggle,
}: {
  wb: Worldbook;
  selected: boolean;
  badge: { txt: string; cls: string };
  ownCount: number;
  sharedCount: number;
  onSelect: (id: string) => void;
  onToggle: (wb: Worldbook) => void;
}) {
  const { t } = useTranslation("editor");
  const isOn = wb.enabled !== false;
  const station = wb.station?.kind;
  // A div, not a button: the row holds the enable switch, and a button
  // inside a button is invalid HTML that React warns about on every render.
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(wb.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(wb.id);
        }
      }}
      className={cn(
        "w-full cursor-pointer rounded-xl border p-3 text-left transition-colors",
        selected ? "border-primary bg-gradient-to-b from-primary/10 to-transparent" : "border-border bg-card hover:border-muted-foreground/30",
        !isOn && "opacity-55",
      )}
    >
      <div className="flex items-center gap-2">
        <Boxes className="h-4 w-4 shrink-0 text-amber-300" />
        <span className="min-w-0 flex-1 truncate text-sm font-bold text-foreground">{wb.name || t("modules.untitled")}</span>
        {(station === "narrator" || station === "worker") && (
          <span className={cn("shrink-0 rounded px-1 py-px text-[9px] font-bold", station === "worker" ? "bg-violet-500/20 text-violet-300" : "bg-amber-500/20 text-amber-300")}>
            {t(station === "worker" ? "modules.worker" : "modules.takesOver")}
          </span>
        )}
        <Switch on={isOn} onClick={() => onToggle(wb)} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className={cn("max-w-[11rem] truncate rounded-full px-2 py-0.5 text-[10px] font-semibold", badge.cls)}>{badge.txt}</span>
        <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {t("blueprint.frame.membersSplit", { own: ownCount, shared: sharedCount })}
        </span>
        <ModuleMemoryChip book={wb} />
      </div>
    </div>
  );
}

/** The card, drawn the way a module is drawn. Same shape, same memory chip,
 *  same click — because it is one. */
function CardListItem({
  selected,
  cardName,
  sharedCount,
  onSelect,
}: {
  selected: boolean;
  cardName: string;
  sharedCount: number;
  onSelect: () => void;
}) {
  const { t } = useTranslation("editor");
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
      className={cn(
        "w-full cursor-pointer rounded-xl border p-3 text-left transition-colors",
        selected ? "border-primary bg-gradient-to-b from-primary/10 to-transparent" : "border-border bg-card hover:border-muted-foreground/30",
      )}
    >
      <div className="flex items-center gap-2">
        <Boxes className="h-4 w-4 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate text-sm font-bold text-foreground">{cardName || t("modules.theCard")}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400">{t("modules.badge.always")}</span>
        <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">
          {/* Just the count: "shared in" describes being inside something
              else, and nothing is shared in to the card. */}
          {t("blueprint.frame.members", { count: sharedCount })}
        </span>
        <ModuleMemoryChip book={null} />
      </div>
    </div>
  );
}

/**
 * 模块 — the page a module lives on.
 *
 * A module is a world of its own inside the card: its own entries, variables
 * and behaviours, its own rule for when it opens, and — when it narrates —
 * its own AI, memory and context. None of that had a page. It was bolted to
 * the top of a lorebook's entry list, where it read as "settings for one of
 * several lorebooks", and the lorebook page read as a shelf of books.
 *
 * So: one page, one module at a time, four things in a fixed order — what it
 * is called, when it opens, what is inside, what its AI is. The lorebook,
 * variables and behaviours pages went back to being one list each, narrowed
 * by a chip row that this page hands its module to when it jumps.
 *
 * The card is the first module, always, and the page opens on it. It is not a
 * special case bolted on: the card is where openings, lore, variables and
 * behaviours live until somebody moves them, it is what every other module's
 * content is shared into, and `resolveInputs` already addresses it as "core".
 * Saying "no modules yet" to someone whose card is full of them was the page
 * describing a data structure instead of their card.
 */
export function ModulesSection({ compact }: { compact?: boolean } = {}) {
  const { t } = useTranslation("editor");
  const worldbooks = useEditorStore((s) => s.worldDraft.worldbooks) ?? EMPTY_WB;
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const variables = useEditorStore((s) => s.worldDraft.variables);
  const reactions = useEditorStore((s) => s.worldDraft.reactions);
  const cardName = useEditorStore((s) => s.worldDraft.name);
  const historyLimit = useEditorStore((s) => s.worldDraft.settings?.historyLimit);
  const setField = useEditorStore((s) => s.setField);
  const setSettings = useEditorStore((s) => s.setSettings);
  const addWorldbook = useEditorStore((s) => s.addWorldbook);
  const updateWorldbook = useEditorStore((s) => s.updateWorldbook);
  const removeWorldbook = useEditorStore((s) => s.removeWorldbook);
  const pendingFocus = useEditorStore((s) => s.pendingFocus);
  const clearPendingFocus = useEditorStore((s) => s.clearPendingFocus);

  /** "card" is the card itself — the module everything starts in. */
  const CARD = "card";
  const [selectedId, setSelectedId] = useState<string>(CARD);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const isMobile = useIsMobileModules();

  // Another page (the canvas, a chip) asked for a specific module.
  useEffect(() => {
    if (pendingFocus?.kind !== "module") return;
    setSelectedId(pendingFocus.id);
    clearPendingFocus();
  }, [pendingFocus, clearPendingFocus]);

  // A deleted module falls back to the card rather than to nothing: there is
  // always something to show, because there is always the card.
  const selected = selectedId === CARD ? null : worldbooks.find((w) => w.id === selectedId) ?? null;
  const onCard = selectedId === CARD;
  useEffect(() => {
    if (!onCard && !selected) setSelectedId(CARD);
  }, [onCard, selected]);

  const varName = (id: string) => variables.find((v) => v.id === id)?.name ?? id;
  const counts = useMemo(() => {
    const own = new Map<string, number>();
    let shared = 0;
    const bump = (wb: string | undefined) => {
      if (wb) own.set(wb, (own.get(wb) ?? 0) + 1);
      else shared++;
    };
    for (const e of entries) if (e.role !== "greeting") bump(e.worldbookId);
    for (const v of variables) if (!v.internal) bump(v.worldbookId);
    for (const r of reactions ?? []) bump(r.worldbookId);
    return { own, shared };
  }, [entries, variables, reactions]);

  function createModule() {
    const before = useEditorStore.getState().worldDraft.worldbooks ?? [];
    addWorldbook(t("modules.newModuleName", { n: before.length + 1 }));
    const after = useEditorStore.getState().worldDraft.worldbooks ?? [];
    const created = after[after.length - 1];
    if (created) setSelectedId(created.id);
  }

  const selectCard = () => setSelectedId(CARD);
  const toggleModule = (wb: Worldbook) => updateWorldbook(wb.id, { enabled: wb.enabled === false });

  function badgeText(wb: Worldbook): { txt: string; cls: string } {
    const b = moduleActivationBadge(wb, varName);
    const label = t(`modules.badge.${b.kind}` as never) as string;
    switch (b.kind) {
      case "disabled": return { txt: label, cls: "bg-white/5 text-muted-foreground" };
      case "always": return { txt: label, cls: "bg-emerald-500/15 text-emerald-400" };
      case "manual": return { txt: label, cls: "bg-white/5 text-muted-foreground" };
      case "greeting": return { txt: b.count ? `${label} ×${b.count}` : label, cls: "bg-violet-500/15 text-violet-300" };
      case "keywords": return { txt: b.detail ?? label, cls: "bg-amber-500/15 text-amber-300" };
      default: return { txt: b.detail ? `${t("modules.badge.when")} ${b.detail}` : label, cls: "bg-sky-500/15 text-sky-300" };
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Mobile: the list is a row of pills above the page. */}
      {isMobile && (
        <div
          className="flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border bg-card px-3 py-2"
          style={{ scrollbarWidth: "none" } as React.CSSProperties}
        >
          <button
            type="button"
            onClick={() => setSelectedId(CARD)}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-bold transition-colors",
              onCard ? "border-primary bg-primary/10 text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {cardName || t("modules.theCard")}
          </button>
          {worldbooks.map((wb) => (
            <button
              key={wb.id}
              type="button"
              onClick={() => setSelectedId(wb.id)}
              className={cn(
                "shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-bold transition-colors",
                selected?.id === wb.id ? "border-primary bg-primary/10 text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
                wb.enabled === false && "opacity-50",
              )}
            >
              {wb.name || t("modules.untitled")}
            </button>
          ))}
          <button
            type="button"
            onClick={createModule}
            className="shrink-0 whitespace-nowrap rounded-full border border-dashed border-border px-3 py-1 text-xs font-bold text-muted-foreground transition-colors hover:border-primary hover:text-primary"
          >
            <Plus className="mr-1 inline h-3 w-3" />
            {t("modules.newModule")}
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* Desktop: the list. */}
        {!isMobile && !sidebarOpen && (
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="flex w-10 shrink-0 flex-col items-center gap-3 border-r border-border bg-card/40 py-3 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <PanelLeftOpen className="h-4 w-4" />
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-bold text-primary select-none">
              {worldbooks.length + 1}
            </span>
          </button>
        )}
        {!isMobile && (
          <div className={cn("flex shrink-0 flex-col border-r border-border bg-card/40 transition-all duration-200", sidebarOpen ? "w-[260px]" : "w-0 overflow-hidden border-r-0")}>
            <div className="flex items-center justify-between px-3 pb-1 pt-3">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("modules.listTitle")}</span>
              <span className="text-xs text-primary">{t("modules.count", { count: worldbooks.length + 1 })}</span>
            </div>
            {/* One sentence, because "module" is a word the creator has to be
                handed once. The rest is a link, not a wall of text. */}
            <p className="px-3 pb-2 text-[10px] leading-relaxed text-muted-foreground/70">
              {t("modules.whatIsThis")}{" "}
              <a
                href={DOCS_URLS.modules}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-0.5 text-primary/80 hover:text-primary"
              >
                {t("modules.learnMore")}
                <ExternalLink className="h-2.5 w-2.5" />
              </a>
            </p>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-3">
              <CardListItem selected={onCard} cardName={cardName} sharedCount={counts.shared} onSelect={selectCard} />
              {worldbooks.map((wb) => (
                <ModuleListItem
                  key={wb.id}
                  wb={wb}
                  selected={selected?.id === wb.id}
                  badge={badgeText(wb)}
                  ownCount={counts.own.get(wb.id) ?? 0}
                  sharedCount={counts.shared}
                  onSelect={setSelectedId}
                  onToggle={toggleModule}
                />
              ))}
              <button
                type="button"
                onClick={createModule}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border px-3 py-2.5 text-xs font-bold text-muted-foreground transition-colors hover:border-primary hover:text-primary"
              >
                <Plus className="h-3.5 w-3.5" /> {t("modules.newModule")}
              </button>
            </div>
          </div>
        )}

        {/* The page. */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {onCard ? (
            <div className={cn("min-h-0 flex-1 overflow-y-auto", compact ? "px-4 py-3" : "px-6 py-4")}>
              <div className="mx-auto max-w-3xl space-y-5">
                <div className="flex items-center gap-3">
                  {!isMobile && (
                    <button
                      type="button"
                      onClick={() => setSidebarOpen((v) => !v)}
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      {sidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
                    </button>
                  )}
                  <Boxes className="h-5 w-5 shrink-0 text-primary" />
                  <DebouncedInput
                    value={cardName}
                    onCommit={(v) => setField("name", v)}
                    placeholder={t("modules.namePlaceholder")}
                    className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1 py-1 text-base font-extrabold text-foreground hover:border-border focus:border-primary/50 focus:bg-background focus:outline-none"
                  />
                </div>

                {/* No activation section: the card is what is on when nothing
                    else is, which is not a setting anyone can change. */}
                <p className="-mt-3 pl-1 text-[11px] leading-relaxed text-muted-foreground">{t("modules.cardAlwaysOn")}</p>

                <section className="space-y-2">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("modules.contents")}</h3>
                  <ModuleContents book={null} />
                </section>

                <section className="space-y-2">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("modules.cardAi")}</h3>
                  <div className="space-y-3 rounded-lg border border-border px-2.5 py-2">
                    <ModuleMemoryLine book={null} />
                    {/* The card's context window. It also lives in the lorebook
                        page's settings; it belongs here too, because "how much
                        does this AI read" is the same question the module page
                        answers for every other module. */}
                    <label className="flex items-center justify-between gap-2 border-t border-border/50 pt-2 text-[11px] text-muted-foreground">
                      <span className="min-w-0 flex-1 font-semibold text-foreground">{t("blueprint.station.historyLimit")}</span>
                      <span className="flex shrink-0 items-center gap-1">
                        <select
                          value={historyLimit ? "latest" : "all"}
                          onChange={(e) => setSettings("historyLimit", e.target.value === "latest" ? (historyLimit ?? 20) : undefined)}
                          className="rounded border border-border bg-background px-1 py-0.5 text-[11px] text-foreground"
                        >
                          <option value="all">{t("blueprint.insp.historyAll")}</option>
                          <option value="latest">{t("blueprint.insp.historyLatest")}</option>
                        </select>
                        {historyLimit ? (
                          // Local text, committed on blur: clearing the box used
                          // to snap it straight back to 20 mid-edit.
                          <DraftNumberInput
                            inputMode="numeric"
                            value={historyLimit}
                            onCommit={(n) => setSettings("historyLimit", Math.min(Math.max(Math.round(n), 1), 500))}
                            className="w-16 rounded border border-border bg-background px-1 py-0.5 text-[11px] text-foreground"
                          />
                        ) : null}
                      </span>
                    </label>
                    <p className="text-[10px] leading-relaxed text-muted-foreground">{t(historyLimit ? "entries.historyLimitHint" : "entries.historyLimitHintAll")}</p>
                  </div>
                </section>
              </div>
            </div>
          ) : !selected ? null : (
            <div className={cn("min-h-0 flex-1 overflow-y-auto", compact ? "px-4 py-3" : "px-6 py-4")}>
              <div className="mx-auto max-w-3xl space-y-5">
                {/* Name row: what it is called, on or off, share, delete. */}
                <div className="flex items-center gap-3">
                  {!isMobile && (
                    <button
                      type="button"
                      onClick={() => setSidebarOpen((v) => !v)}
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      {sidebarOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
                    </button>
                  )}
                  <Boxes className="h-5 w-5 shrink-0 text-amber-300" />
                  <DebouncedInput
                    value={selected.name}
                    onCommit={(v) => updateWorldbook(selected.id, { name: v })}
                    placeholder={t("modules.namePlaceholder")}
                    className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-1 py-1 text-base font-extrabold text-foreground hover:border-border focus:border-primary/50 focus:bg-background focus:outline-none"
                  />
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    {t("modules.enable")}
                    <Switch on={selected.enabled !== false} onClick={() => updateWorldbook(selected.id, { enabled: !(selected.enabled !== false) })} />
                  </label>
                  <ShareModuleButton book={selected} className="px-2 py-1.5" />
                  <TwoTapDeleteButton
                    onConfirm={() => { removeWorldbook(selected.id); setSelectedId(CARD); }}
                    className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                    title={t("modules.delete")}
                    armedTitle={t("twoTapConfirm")}
                  >
                    <Trash2 className="h-4 w-4" />
                  </TwoTapDeleteButton>
                </div>
                <div className="-mt-3 pl-1">
                  <ModuleNoteField book={selected} onChange={(note) => updateWorldbook(selected.id, { note })} />
                </div>

                <section className="space-y-2">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("modules.whenOpen")}</h3>
                  <ModuleActivationEditor
                    book={selected}
                    onChange={(activation) => updateWorldbook(selected.id, { activation })}
                  />
                </section>

                <section className="space-y-2">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("modules.contents")}</h3>
                  <ModuleContents book={selected} />
                </section>

                <section className="space-y-2">
                  <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{t("modules.ai")}</h3>
                  {/* Said before the switch, not after it. A plain module has
                      a memory too — the card's — and the page used to leave
                      that to be inferred from the absence of a control. */}
                  <ModuleMemoryLine book={selected} className="rounded-lg border border-border px-2.5 py-2" />
                  <ModuleConsole
                    book={selected}
                    otherBooks={worldbooks.filter((b) => b.id !== selected.id)}
                    onChange={(patch) => updateWorldbook(selected.id, patch)}
                    summary={false}
                  />
                </section>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
