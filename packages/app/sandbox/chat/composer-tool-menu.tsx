// Compact composer tool menu (mobile / narrow toolbars).
//
// Problem: on a narrow composer the left toolbar has to fit the "+" actions
// button, the model pill (WIDE in mix mode — ratio bar + count + mushie
// balance) AND each installed extension's button (e.g. session-memory's
// "Context"). Two-plus pills next to the send button crowd the type bar on
// phones.
//
// Fix: when the toolbar is narrow AND at least one launchable tool exists,
// collapse the model pill + extension buttons into a single button. Tapping it
// opens a bottom-sheet SELECTOR — a clean list of features (Model + each
// settings-bearing extension). It is purely a chooser: picking a row closes the
// sheet and the normal, full interface pops up (the model picker, or the
// extension's own modal). The menu owns that open-state, so a tool's real modal
// is mounted here, NOT nested inside a transient dropdown. Wider toolbars keep
// the inline pills untouched.

import { useState, useEffect, useRef, useMemo, type RefObject, type ReactNode } from "react";
import { ChevronUp, ChevronRight, Shuffle, SlidersHorizontal, Sparkles, X } from "lucide-react";
import { useYumina } from "../sandbox-context";
import { makeChatT } from "./i18n";
import { getComposerModelSummary, MIX_COLORS, BalanceTag, useMushieBalance } from "./model-picker-modal";
import { ContributionErrorBoundary, useToolMenuContributions } from "../extensions/registry";

/**
 * True once `ref`'s unscaled layout box is narrower than `threshold` px.
 * ResizeObserver's contentRect and clientWidth share the same layout coordinate
 * space; getBoundingClientRect does not because it includes CSS zoom. Keeping
 * the measurements consistent prevents play zoom from selecting the compact
 * toolbar even when the unscaled controls have enough room.
 */
export function useIsNarrow<T extends HTMLElement>(ref: RefObject<T | null>, threshold: number): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < threshold,
  );
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (w: number) => {
      if (w > 0) setNarrow(w < threshold);
    };
    apply(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) apply(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, threshold]);
  return narrow;
}

/**
 * A uniform selection row for the tool sheet. Exported so extensions render
 * their launcher with the same chrome as the built-in Model row (see
 * sandbox/extensions/session-memory/client.tsx). Purely presentational — it
 * calls `onSelect` and nothing else; the sheet turns that into "close + open
 * the real interface".
 */
export function ToolMenuRow({
  icon,
  label,
  sublabel,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  sublabel?: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3 text-left transition-colors hover:border-white/15 hover:bg-white/[0.05]"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.05]">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-white/90">{label}</span>
        {sublabel && <span className="mt-0.5 block truncate text-[11px] text-white/40">{sublabel}</span>}
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-white/30" />
    </button>
  );
}

export function ComposerToolMenu({ onOpenModelPicker }: { onOpenModelPicker: () => void }) {
  const api = useYumina();
  const t = useMemo(() => makeChatT(api.language), [api.language]);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [openToolId, setOpenToolId] = useState<string | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const tools = useToolMenuContributions();
  const balance = useMushieBalance();
  const activeTool = tools.find((tool) => tool.id === openToolId) ?? null;

  const summary = useMemo(
    () =>
      getComposerModelSummary({
        selectedModel: api.selectedModel,
        preferredProvider: api.preferredProvider,
        mixMode: api.mixMode,
        modelPool: api.modelPool,
        language: api.language,
        localBridgeStatus: api.localBridge?.status ?? null,
      }),
    [api.selectedModel, api.preferredProvider, api.mixMode, api.modelPool, api.language, api.localBridge?.status],
  );

  // Esc closes the sheet (backdrop click is handled on the overlay element).
  useEffect(() => {
    if (!sheetOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSheetOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  const pickModel = () => {
    setSheetOpen(false);
    onOpenModelPicker();
  };
  const pickTool = (id: string) => {
    setSheetOpen(false);
    setOpenToolId(id);
  };

  return (
    <>
      {/* Compact trigger — model at a glance + a badge for how many tools are
          tucked inside. Opens the selector sheet. */}
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
        aria-label={t("toolsMenu")}
        title={t("toolsMenu")}
        // em paddings/gap (= the old px-2.5 py-1.5 gap-1.5 at 16px): Android
        // font inflation (textZoom) scales text but not rem boxes, so rem
        // padding gets eaten on scaled-up phones — em tracks the text instead.
        className="group flex min-w-0 items-center gap-[0.375em] rounded-full border border-white/[0.12] bg-white/[0.05] px-[0.625em] py-[0.375em] transition-all hover:border-white/20 hover:bg-white/[0.09]"
      >
        {summary.isMix ? (
          <>
            <Shuffle className="h-3 w-3 shrink-0 text-primary/70" />
            <span className="flex h-1.5 w-7 shrink-0 overflow-hidden rounded-full bg-white/[0.08]">
              {summary.poolPcts.map((e, i) => (
                <span
                  key={e.modelId}
                  className={MIX_COLORS[i % MIX_COLORS.length]}
                  style={{ width: `${e.pct}%` }}
                />
              ))}
            </span>
            <span className="text-[11px] font-medium text-primary/80">{summary.poolCount}</span>
          </>
        ) : (
          <>
            {summary.dotClass ? (
              <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${summary.dotClass} opacity-90`} />
            ) : (
              <SlidersHorizontal className="h-3 w-3 shrink-0 text-white/60" />
            )}
            {/* No width cap: show the full model name and let flex truncate it
                only when the toolbar genuinely runs out of room. Everything
                else in the pill is shrink-0, so the name is what gives. */}
            <span className="min-w-0 truncate text-[11px] font-medium text-white/75 transition-colors group-hover:text-white">
              {summary.label}
            </span>
          </>
        )}
        {balance != null && <BalanceTag balance={balance} language={api.language} />}
        {tools.length > 0 && (
          <span className="flex h-3.5 min-w-[0.875rem] shrink-0 items-center justify-center rounded-full bg-primary/20 px-1 text-[9px] font-semibold text-primary">
            {tools.length}
          </span>
        )}
        <ChevronUp className="h-3 w-3 shrink-0 text-white/45 transition-colors group-hover:text-white/70" />
      </button>

      {/* Selector sheet — a chooser only. Fixed to the bottom of the chat
          surface (the sandbox iframe), sliding up over the composer. */}
      {sheetOpen && (
        <div className="fixed inset-0 z-[9998]" role="dialog" aria-modal="true" aria-label={t("toolsMenu")}>
          <button
            type="button"
            aria-label={t("cancel")}
            onClick={() => setSheetOpen(false)}
            className="absolute inset-0 h-full w-full cursor-default bg-black/50 backdrop-blur-sm"
            style={{ animation: "sheetFade 0.15s ease-out" }}
          />
          <div
            ref={sheetRef}
            className="absolute inset-x-0 bottom-0 mx-auto max-w-md rounded-t-2xl border-t border-white/10 bg-[#1a1b1e]/95 shadow-2xl shadow-black/50 backdrop-blur-xl"
            style={{
              paddingBottom: "calc(1rem + env(safe-area-inset-bottom, 0px))",
              animation: "sheetUp 0.22s cubic-bezier(0.16, 1, 0.3, 1)",
            }}
          >
            <div className="flex items-center justify-between px-4 pt-3 pb-1">
              <div>
                <h2 className="text-sm font-bold text-white">{t("toolsMenu")}</h2>
                <p className="text-[11px] text-white/40">{t("toolsMenuHint")}</p>
              </div>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                aria-label={t("cancel")}
                className="play-action-btn flex h-7 w-7 items-center justify-center rounded-lg text-white/30 transition-colors hover:bg-white/5 hover:text-white/60 active:bg-white/5 active:text-white/60"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex flex-col gap-1.5 px-4 pt-2">
              {/* Model — always first. */}
              <ToolMenuRow
                icon={
                  summary.isMix ? (
                    <Shuffle className="h-4 w-4 text-primary/80" />
                  ) : (
                    <Sparkles className="h-4 w-4 text-primary/80" />
                  )
                }
                label={t("modelLabel")}
                sublabel={summary.label}
                onSelect={pickModel}
              />

              {/* One row per installed, settings-bearing extension. */}
              {tools.map((tool) => (
                <ContributionErrorBoundary key={tool.id} id={tool.id}>
                  <tool.Row onSelect={() => pickTool(tool.id)} />
                </ContributionErrorBoundary>
              ))}
            </div>
          </div>

          <style>{`
            @keyframes sheetFade { from { opacity: 0; } to { opacity: 1; } }
            @keyframes sheetUp {
              from { opacity: 0; transform: translateY(16px); }
              to { opacity: 1; transform: translateY(0); }
            }
          `}</style>
        </div>
      )}

      {/* The selected tool's REAL interface. Mounted at menu level (not inside
          the sheet) so it survives the sheet closing. */}
      {activeTool && (
        <ContributionErrorBoundary id={`${activeTool.id}:modal`}>
          <activeTool.Modal open onClose={() => setOpenToolId(null)} />
        </ContributionErrorBoundary>
      )}
    </>
  );
}
