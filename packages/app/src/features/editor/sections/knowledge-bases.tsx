import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Boxes, Monitor } from "lucide-react";
import type { Worldbook } from "@yumina/engine";
import { extractLoreSlotsFromFiles } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { EntriesSection } from "./entries";
import { LoreBindingsPanel } from "../components/lore-bindings-panel";
import { ModuleScopeChips } from "../components/module-scope-chips";
import { moduleIdOfScope, normalizeModuleScope, scopeToEntriesProp } from "../lib/module-scope";

// Stable empty ref — never inline `?? []` inside a Zustand selector.
const EMPTY_WB: Worldbook[] = [];

/**
 * 知识库 — one lorebook.
 *
 * It used to be a shelf: a sidebar of "books", each with its own switch,
 * activation badge, note, AI settings and context wiring stacked above its
 * entries. That is the SillyTavern picture — several independent lorebooks
 * that happen to share a card — and it is not what a module is. A card has
 * one lorebook. Its entries have a home: shared with every module, or one
 * module's own. Everything a module IS lives on the module page.
 *
 * So the page is the entry list, narrowed by one row of chips. "All" is the
 * order the prompt actually sends.
 */
export function KnowledgeBasesSection(_props: { compact?: boolean } = {}) {
  const { t } = useTranslation("editor");
  const worldbooks = useEditorStore((s) => s.worldDraft.worldbooks) ?? EMPTY_WB;
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const rootComponent = useEditorStore((s) => s.worldDraft.rootComponent);
  const loreUiBindings = useEditorStore((s) => s.worldDraft.loreUiBindings);
  const moduleScope = useEditorStore((s) => s.moduleScope);
  const setModuleScope = useEditorStore((s) => s.setModuleScope);
  const focusObject = useEditorStore((s) => s.focusObject);

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

  // A scope left over from a module that is gone, or from a card that had
  // modules, means "all" here rather than an empty list.
  const scope = normalizeModuleScope(moduleScope, worldbooks);
  useEffect(() => {
    if (scope !== moduleScope) setModuleScope(scope);
  }, [scope, moduleScope, setModuleScope]);
  const showChips = worldbooks.length > 0 || slotCount > 0;
  const showBindings = scope === "bindings" && slotCount > 0;
  const scopedModule = moduleIdOfScope(scope);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    let core = 0;
    let all = 0;
    for (const e of entries) {
      if (e.role === "greeting") continue;
      all++;
      if (e.worldbookId) m.set(e.worldbookId, (m.get(e.worldbookId) ?? 0) + 1);
      else core++;
    }
    return (s: string) => (s === "all" ? all : s === "core" ? core : s === "bindings" ? slotCount : m.get(s.slice("mod:".length)));
  }, [entries, slotCount]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {showChips && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
          <ModuleScopeChips
            value={scope}
            onChange={setModuleScope}
            books={worldbooks}
            counts={counts}
            bindingsCount={slotCount}
            dataTour="kb-books"
            className="min-w-0 flex-1"
          />
          {/* A module's entries are listed here; the module itself is a page
              of its own, one click away rather than a pile above the list. */}
          {scopedModule && (
            <button
              type="button"
              onClick={() => focusObject("module", scopedModule)}
              className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Boxes className="h-3 w-3 text-amber-300" />
              {t("modules.settings")}
            </button>
          )}
        </div>
      )}

      {showBindings ? (
        <>
          <div className="shrink-0 border-b border-border bg-card px-5 py-3">
            <div className="flex items-center gap-2">
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
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <EntriesSection key={`kb-${scope}`} compact scopeWorldbookId={scopeToEntriesProp(scope)} />
        </div>
      )}
    </div>
  );
}
