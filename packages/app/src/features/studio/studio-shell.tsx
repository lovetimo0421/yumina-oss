import { ConnectAiDialog } from "./components/connect-ai-dialog";
import { VariantTranslateBanner } from "@/features/editor/variant-translate-banner";
import { LANGUAGE_LABELS, LANGUAGE_SHORT, currentVariantTrigger, variantRowLabels } from "@/lib/languages";
import { changeReviewTitle } from "./components/change-review";
import { StudioChangeReviewPanel } from "./components/studio-change-review-panel";
import { Suspense, useCallback, useMemo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import {
  ArrowLeft,
  Save,
  Loader2,
  Play,
  History,
  MoreVertical,
  Bot,
  Download,
  Upload,
  Star,
  Workflow,
  Smartphone,
  Sparkles,
  Square,
  SlidersHorizontal,
  Undo2,
  Redo2,
} from "lucide-react";
import { feedback } from "@/lib/feedback";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { navigateBackSafely } from "@/lib/safe-back";
import { generatedInterfaceUnsaved, useEditorStore } from "@/stores/editor";
import { useWorldsStore } from "@/stores/worlds";
import { useStudioStore, probeStreamBase } from "@/stores/studio";
import { isPlaceholderCardName } from "@/lib/world-templates";
import { PublishChecklist } from "./publish-checklist";
import { markPlaytested } from "./lib/playtested";
import { MobileStudioShell } from "./mobile-studio-shell";
import { VisualSurfaceSwitch } from "@/features/editor/visual-surface-switch";
import { rememberEditorChoice } from "@/features/editor/lib/editor-mode";
import { isScreenFirst } from "@/lib/editor-surface";
import { BlueprintStage } from "./blueprint-stage";
import { StudioLearningCenter } from "./learn/studio-learning";
import { LearningWorkspaceProvider } from "./learn/learning-workspace";
import { BundleCreator, BundleImporter, ImportBundleModal, WorldPublishModal } from "@/edition/slots";
import { useEdition } from "@/edition/edition";
import { ExportCardMenu } from "../editor/export-card-menu";
import { ChangeHistoryDialog } from "./change-history-dialog";
import { ReviewStateControl } from "../editor/review-state-control";
import type { YuminaBundle } from "@yumina/engine";
import type { ToolCall } from "./lib/types";

import "dockview-react/dist/styles/dockview.css";
import "./studio-theme.css";
import { captureHubEvent } from "@/lib/analytics";
import { ownsTypingUndo } from "./lib/text-entry-target";
import { stepBack } from "./lib/studio-back";

function useIsMobileStudio() {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia("(max-width: 767px)").matches;
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia("(max-width: 767px)");
    const handleChange = () => setIsMobile(mediaQuery.matches);
    handleChange();
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  return isMobile;
}

export function StudioShell() {
  const isMobileStudio = useIsMobileStudio();
  useStreamBaseProbe();
  return <LearningWorkspaceProvider>{isMobileStudio ? <MobileStudioShell /> : <StudioDesktopShell />}<StudioLearningCenter /></LearningWorkspaceProvider>;
}

/**
 * Settle direct-origin reachability off the send path.
 *
 * The agent stream prefers a DNS-only origin to dodge Cloudflare's ~100s cut.
 * Networks that can't reach it (mainland China) used to discover that inline —
 * 10 dead seconds on every send, and a failure that stuck for 15 minutes, so
 * turning on a VPN appeared to do nothing. Probing here means the send path
 * already has the answer, and re-probing when the tab regains focus or the
 * connection returns picks a network change up within seconds.
 */
function useStreamBaseProbe() {
  useEffect(() => {
    void probeStreamBase();
    const refresh = () => {
      if (document.visibilityState === "visible") void probeStreamBase();
    };
    // `online` is coarse (it fires for the adapter, not for reachability), so
    // force past the TTL: the network demonstrably just changed.
    const onOnline = () => void probeStreamBase({ force: true });
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", onOnline);
    };
  }, []);
}

function StudioDesktopShell() {
  const { t } = useTranslation("editor");
  const router = useRouter();
  const worldDraft = useEditorStore(s => s.worldDraft);
  const serverWorldId = useEditorStore(s => s.serverWorldId);
  const isDirty = useEditorStore(s => s.isDirty);
  const layoutDirty = useEditorStore(s => s.layoutDirty);
  const saving = useEditorStore(s => s.saving);
  const saveDraft = useEditorStore(s => s.saveDraft);
  const setField = useEditorStore(s => s.setField);
  const variants = useEditorStore(s => s.variants);
  const variantsLoading = useEditorStore(s => s.variantsLoading);
  const variantLabel = useEditorStore(s => s.variantLabel);
  // Rows name the card and, where two share a title, their language — two
  // identical 「QA0926 猫咪咖啡馆」 rows were the whole menu before.
  const variantRows = useMemo(() => variantRowLabels(variants), [variants]);
  const readOnlyInspect = useEditorStore(s => s.readOnlyInspect);
  const canUndo = useEditorStore(s => s.canUndo);
  const canRedo = useEditorStore(s => s.canRedo);
  const mode = useStudioStore(s => s.mode);
  // One line of the publish checklist: this card has been played here.
  useEffect(() => { if (mode === "playtest") markPlaytested(useEditorStore.getState().serverWorldId); }, [mode]);
  const setMode = useStudioStore(s => s.setMode);
  const stagePage = useStudioStore(s => s.stagePage);
  const setStagePage = useStudioStore(s => s.setStagePage);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const { features } = useEdition();
  const [showImportModal, setShowImportModal] = useState(false);
  const [showBundleCreator, setShowBundleCreator] = useState(false);
  const [importingBundle, setImportingBundle] = useState<YuminaBundle | null>(null);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [outsideAiOpen, setOutsideAiOpen] = useState(false);

  const renderReviewPanel = useCallback(
    (detail: { toolCall: unknown; agentRunId?: string }, key: string) => {
      const toolCall = detail.toolCall as ToolCall;
      const title = changeReviewTitle(toolCall, t as never, { draft: useEditorStore.getState().worldDraft as never });
      return {
        title: `${t("studio.proposal.inspect")}: ${title}`.slice(0, 80),
        node: (
          <StudioChangeReviewPanel
            key={key}
            params={{
              toolCall,
              agentRunId: detail.agentRunId,
              worldId: useEditorStore.getState().serverWorldId,
            }}
          />
        ),
      };
    },
    [t],
  );

  const leaveVisualSurface = useCallback(() => {
    // Remembered before navigating, or /edit reads "visual" and sends them
    // straight back to the canvas they just left.
    rememberEditorChoice(serverWorldId, "classic");
    if (serverWorldId) {
      void router.navigate({ to: "/app/worlds/$worldId/edit", params: { worldId: serverWorldId } });
    } else {
      navigateBackSafely(router.history, "/app/library");
    }
  }, [serverWorldId, router]);

  // 简单模式 in the ⋮ menu: the same /edit route, which renders the simple editor
  // once this card's mode says so. The field goes into the draft too, so the
  // unsaved-changes dialog's save-and-switch carries it to the server.
  const leaveToSimple = useCallback(() => {
    if (!serverWorldId) return;
    useEditorStore.getState().setField("editorMode", "simple");
    rememberEditorChoice(serverWorldId, "simple");
    void router.navigate({ to: "/app/worlds/$worldId/edit", params: { worldId: serverWorldId } });
  }, [serverWorldId, router]);

  const handleVariantSwitch = useCallback(
    async (targetWorldId: string) => {
      if (targetWorldId === serverWorldId || saving) return;
        const store = useEditorStore.getState();
      if (store.isDirty) {
        const saved = await store.saveDraft();
        if (!saved) return;
      }
      router.navigate({
        to: "/app/studio/$worldId",
        params: { worldId: targetWorldId },
      });
    },
    [serverWorldId, saving, router],
  );

  // The stage docks the playtest itself from the mode; nothing else to open.
  const handleModeSwitch = useCallback(
    (newMode: "edit" | "playtest") => {
      if (newMode !== mode) setMode(newMode);
    },
    [mode, setMode]
  );

  const handleSave = useCallback(async () => {
    captureHubEvent("studio_blueprint_saved", { world_id: useEditorStore.getState().serverWorldId ?? "", trigger: "manual" });
    await saveDraft();
  }, [saveDraft]);

  // Publish / submit-for-review from Studio. Flush unsaved edits first, then open
  // the publish modal which drives POST /:id/status (pending_review) for a draft
  // and the held-edit submit for a published world. Works for variants too — a
  // draft variant goes through first-publish review like any other world.
  const handlePublishClick = useCallback(async () => {
    if (useEditorStore.getState().isDirty || generatedInterfaceUnsaved(useEditorStore.getState())) {
      const ok = await saveDraft();
      if (!ok) return;
    }
    if (!useEditorStore.getState().serverWorldId) {
      feedback.error(t("shell.saveWorldFirst", "Save the world first"));
      return;
    }
    setShowPublishModal(true);
  }, [saveDraft, t]);

  // Ctrl+Z / Ctrl+Y keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Save works from anywhere; undo/redo do not. In the AI composer or a
      // search box Ctrl+Z is the field's own undo, and taking it here reverted
      // a card edit instead of the typing.
      const typing = e.isComposing || ownsTypingUndo(e.target);
      if (!typing && (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z") {
        e.preventDefault();
        useEditorStore.getState().undo();
      }
      if (
        !typing &&
        (e.ctrlKey || e.metaKey) &&
        (e.key === "y" || (e.shiftKey && e.key === "z") || (e.shiftKey && e.key === "Z"))
      ) {
        e.preventDefault();
        useEditorStore.getState().redo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        const state = useEditorStore.getState();
        if (state.isDirty && !state.saving) {
          state.saveDraft();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const isPlaytest = mode === "playtest";

  return (
    <div className="studio-desk flex h-full min-h-0 w-full flex-col overflow-hidden overscroll-none bg-background">
      {/* Toolbar — three-zone layout */}
      <div
        // Named so the player view can take it out of the tab order while it
        // covers it: hidden behind a fullscreen layer but still focusable is
        // how a keyboard ends up somewhere the eye cannot follow.
        data-studio-topbar=""
        className={cn(
          "flex shrink-0 items-center gap-2 whitespace-nowrap border-b px-3 py-2 transition-colors duration-200",
          isPlaytest
            ? "border-emerald-500/40 bg-emerald-950/10"
            : "border-border"
        )}
      >
        {/* LEFT: Navigation */}
        <button
          onClick={() => {
            // One step back: a page over the board closes first (see
            // lib/studio-back). Only from the bare board does it leave.
            if (stepBack()) return;
            // Straight to the library rather than back through history, and
            // no longer to /edit: that route sends them right back here now,
            // and history-back lands wherever the author happened to come
            // from, which right after a create is the template picker with
            // their card nowhere in sight. The way to the 完整 editor is
            // the 画布 switch beside this arrow.
            if (serverWorldId) {
              void router.navigate({ to: "/app/library", search: { worldId: serverWorldId } });
            } else {
              // No id yet, so there is no card to point at — the guarded back
              // is the only thing that knows where they came from.
              navigateBackSafely(router.history, "/app/library");
            }
          }}
          className="hover-surface shrink-0 rounded-lg p-1.5 text-muted-foreground"
          data-testid="ui-exit"
          title={t("studio.back")}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>

        {/* 画布, on. The simple and 完整 editors carry the same pill in the
            same place, off; turning it off here goes to 完整. */}
        <div className="relative shrink-0">
          <VisualSurfaceSwitch on onToggle={leaveVisualSurface} />
        </div>

        <input
          type="text"
          data-onboarding="name"
          // A template's name (「角色聊天」) or the untitled default reads as
          // an empty field asking for one, outlined: nothing in the editor
          // used to say the card still needed a name of its own.
          value={isPlaceholderCardName(worldDraft.name) ? "" : worldDraft.name}
          onChange={(e) => setField("name", e.target.value)}
          placeholder={t("shell.namePlaceholder", { defaultValue: "Untitled" })}
          readOnly={readOnlyInspect}
          className={cn(
            "w-[clamp(96px,18vw,200px)] min-w-0 truncate rounded-md bg-transparent px-1.5 py-0.5 text-sm font-medium text-foreground placeholder:text-amber-200/55 focus:outline-none",
            isPlaceholderCardName(worldDraft.name) && !readOnlyInspect && "ring-1 ring-amber-400/40",
          )}
        />

        {/* Variant switcher */}
        {variants.length >= 2 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="group flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
              >
                <span className="max-w-[160px] truncate">
                  {currentVariantTrigger(variants, serverWorldId, variantLabel, t("studio.variant"))}
                </span>
                {variantsLoading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <svg className="h-3 w-3 transition-transform group-data-[state=open]:rotate-180" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              {variants.map((v) => {
                const isActive = v.id === serverWorldId;
                const label = variantRows.get(v.id) ?? (v.variantLabel || v.name);
                // 主/副: a language with 2+ variants shows the ★ on its 主, and a
                // 「设为主」 action on the published 副 (only a published version may
                // become the public face).
                const sameLangCount = variants.filter((x) => (x.language ?? "") === (v.language ?? "")).length;
                const showStar = v.isPrimaryVariant && sameLangCount >= 2;
                // Show 设为主 for any same-language 副 so the path is discoverable;
                // a draft one is muted + guides to publish first (only a published
                // version can be the public hub face).
                const canPromote = v.isPrimaryVariant === false && sameLangCount >= 2;
                const promoteReady = canPromote && v.status === "published";
                return (
                  <DropdownMenuItem
                    key={v.id}
                    onClick={() => handleVariantSwitch(v.id)}
                    disabled={isActive || saving}
                    className={cn(
                      "flex items-center gap-2 text-xs",
                      isActive && "bg-primary/10",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{label}</span>
                    {showStar && <Star className="h-3 w-3 shrink-0 fill-[#C9A25E] text-[#C9A25E]" aria-label={t("variantBar.primaryBadge", "主")} />}
                    {v.language && (
                      <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground" title={LANGUAGE_LABELS[v.language] ?? v.language}>
                        {LANGUAGE_SHORT[v.language] ?? v.language.toUpperCase()}
                      </span>
                    )}
                    {/* Only a published version can be promoted. The button stays
                        visible but disabled, labelled "(publish first)", so the
                        reason sits on the control instead of in a pill. */}
                    {canPromote && (
                      <button
                        type="button"
                        disabled={!promoteReady}
                        onClick={(e) => {
                          e.stopPropagation();
                          void useEditorStore.getState().setPrimary(v.id);
                        }}
                        title={promoteReady ? t("variantBar.setPrimary", "Set as primary") : t("variantBar.setPrimaryDraft", "Set as primary (publish first)")}
                        className={cn(
                          "shrink-0 rounded-full p-1 transition-colors",
                          promoteReady
                            ? "text-muted-foreground/60 hover:bg-[#C9A25E]/15 hover:text-[#C9A25E]"
                            : "cursor-not-allowed text-muted-foreground/30",
                        )}
                      >
                        <Star className="h-3 w-3" />
                      </button>
                    )}
                    {isActive && (
                      <svg className="h-3 w-3 shrink-0 text-primary" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
                    )}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <div className="flex-1" />

        {/* CENTER: the big switch — which part of the card you are working
            on. Running the card is not one of them: 试玩 stands with 保存 and
            发布 on the right. The guide lives in the canvas's own row: it
            teaches the page, it is not a page. */}
          <div className="flex shrink-0 items-center gap-2">
            <div role="tablist" className="flex items-center rounded-lg border border-border bg-muted/50 p-0.5">
              {([
                ["blueprint", Workflow, "studio.stage.tabBlueprint", undefined],
                ["frontend", Smartphone, "studio.stage.tabFrontend", "player-page"],
                ["generation", Sparkles, "studio.stage.tabGeneration", "generation"],
              ] as const).map(([page, Icon, label, onboarding]) => {
                if (page === "generation" && !features.imageGeneration) return null;
                // A playtest runs beside the canvas, so the canvas is the page.
                const on = isPlaytest ? page === "blueprint" : stagePage === page;
                return (
                  <button
                    key={page}
                    type="button"
                    role="tab"
                    aria-selected={on}
                    data-stage-page={page}
                    data-onboarding={onboarding}
                    onClick={() => { if (isPlaytest && page !== "blueprint") handleModeSwitch("edit"); setStagePage(page); }}
                    className={cn(
                      "flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-all duration-200",
                      on ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {t(label)}
                  </button>
                );
              })}
            </div>
          </div>

        <div className="flex-1" />

        {/* RIGHT: Workspace actions */}
        <div className="flex shrink-0 items-center gap-1">
          {/* The keys work everywhere, but a creator who has never heard of
              them needs to see that a step can be taken back. */}
          {!readOnlyInspect && !isPlaytest && <>
            <button type="button" onClick={() => useEditorStore.getState().undo()} disabled={!canUndo} data-studio-undo
              className="hover-surface rounded-lg p-1.5 text-muted-foreground disabled:pointer-events-none disabled:opacity-30" title={t("studio.undo")} aria-label={t("studio.undo")}>
              <Undo2 className="h-3.5 w-3.5" />
            </button>
            <button type="button" onClick={() => useEditorStore.getState().redo()} disabled={!canRedo}
              className="hover-surface rounded-lg p-1.5 text-muted-foreground disabled:pointer-events-none disabled:opacity-30" title={t("studio.redo")} aria-label={t("studio.redo")}>
              <Redo2 className="h-3.5 w-3.5" />
            </button>
          </>}
          {!readOnlyInspect && !isPlaytest && features.bundles && (
            <button type="button" onClick={() => setOutsideAiOpen(true)} data-studio-connect-ai
              className="hover-surface flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground">
              <Bot className="h-3.5 w-3.5" />{t("studio.connectAi.menu")}
            </button>
          )}
          {/* More actions: bundle import/export (hosted-only), 简单模式 */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="hover-surface rounded-lg p-1.5 text-muted-foreground"
                title={t("studio.moreActions")}
              >
                <MoreVertical className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setSnapshotsOpen(true)} className="text-xs gap-2" data-learn="history">
                <History className="h-3.5 w-3.5 text-muted-foreground" />
                {t("studio.changeLog.title")}
              </DropdownMenuItem>
              {serverWorldId && (
                <DropdownMenuItem onClick={() => setOutsideAiOpen(true)} className="text-xs gap-2" data-studio-menu="outside-ai">
                  <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                  {t("studio.connectAi.menu")}
                </DropdownMenuItem>
              )}
              {(features.bundles || serverWorldId) && <DropdownMenuSeparator />}
              {features.bundles && (
                <>
                  <DropdownMenuItem onClick={() => setShowImportModal(true)} className="text-xs gap-2">
                    <Download className="h-3.5 w-3.5 text-muted-foreground" />
                    {t("studio.importBundle")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setShowBundleCreator(true)} className="text-xs gap-2">
                    <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                    {t("studio.exportBundle")}
                  </DropdownMenuItem>
                </>
              )}
              {features.bundles && serverWorldId && <DropdownMenuSeparator />}
              {serverWorldId && (
                <DropdownMenuItem onClick={leaveToSimple} className="text-xs gap-2" data-editor-menu-mode="simple">
                  <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                  {t("shell.menuSimpleMode")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>


          {/* 试玩: running the card, beside saving and publishing it. */}
          <button
            type="button"
            onClick={() => { setStagePage(isPlaytest && isScreenFirst() ? "frontend" : "blueprint"); handleModeSwitch(isPlaytest ? "edit" : "playtest"); }}
            data-onboarding="playtest-switch"
            aria-pressed={isPlaytest}
            className={cn(
              "mr-1 flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all duration-200",
              isPlaytest
                ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                : "border-emerald-500/30 text-emerald-300/90 hover:border-emerald-500/50 hover:bg-emerald-500/10",
            )}
          >
            {isPlaytest ? <Square className="h-3 w-3 fill-current" /> : <Play className="h-3 w-3" />}
            {t(isPlaytest ? "studio.stopPlay" : "studio.play")}
          </button>
          {/* Save. Enabled for a tidied canvas too (`layoutDirty`), which
              saves the arrangement without counting as a card change. */}
          <button
            onClick={handleSave}
            data-onboarding="save"
            disabled={saving || (!isDirty && !layoutDirty)}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-opacity disabled:opacity-40"
          >
            {saving ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Save className="h-3 w-3" />
            )}
            {t("studio.save")}
          </button>
          {/* Publish + review state in one control — the only review entry point
              in Studio. Green "Publish update" when live & clean; otherwise the
              button shows the state (not live / changes to submit / in review /
              rejected) and opens a popover with the matching action. */}
          {!readOnlyInspect && features.publishing && (
            <span data-learn="publish" className="contents"><ReviewStateControl onPublish={handlePublishClick} size="sm" disabled={saving || !serverWorldId} draftExtra={(close) => <PublishChecklist onDone={close} />} /></span>
          )}
          {!readOnlyInspect && !features.publishing && (
            <ExportCardMenu worldId={serverWorldId} size="sm" disabled={saving || !serverWorldId} />
          )}
        </div>
      </div>

      <VariantTranslateBanner />

      {/* The workstation: the stage (canvas floor + floating docks) by
          default, classic dockview panels one toggle away. */}
      <BlueprintStage renderReviewPanel={renderReviewPanel} />

      {/* Bundle modals */}
      {showBundleCreator && (
        <BundleCreator onClose={() => setShowBundleCreator(false)} />
      )}
      <Suspense fallback={null}>
        {showImportModal && (
          <ImportBundleModal
            onClose={() => setShowImportModal(false)}
            onImportBundle={(bundle) => {
              setShowImportModal(false);
              setImportingBundle(bundle);
            }}
          />
        )}
      </Suspense>
      {importingBundle && (
        <BundleImporter
          bundle={importingBundle}
          onClose={() => setImportingBundle(null)}
        />
      )}
      <ConnectAiDialog worldId={serverWorldId} open={outsideAiOpen} onClose={() => setOutsideAiOpen(false)} />
      {snapshotsOpen && serverWorldId && (
        <ChangeHistoryDialog worldId={serverWorldId} onClose={() => setSnapshotsOpen(false)} />
      )}
      <Suspense fallback={null}>
        {showPublishModal && serverWorldId && (
          <WorldPublishModal
            initialWorldId={serverWorldId}
            onClose={() => setShowPublishModal(false)}
            onPublished={() => {
              useEditorStore.setState({ worldIsPublished: true });
              useEditorStore.getState().refreshWorldStatus();
              useWorldsStore.getState().invalidate();
              useWorldsStore.getState().fetchWorlds();
            }}
          />
        )}
      </Suspense>
    </div>
  );
}
