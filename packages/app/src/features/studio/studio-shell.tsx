import { ConnectAiDialog } from "./components/connect-ai-dialog";
import { ConnectAiButton } from "./components/connect-ai-button";
import { CollabBar } from "@/features/collab/collab-bar";
import { VariantTranslateBanner } from "@/features/editor/variant-translate-banner";
import { VariantTabBar } from "@/features/editor/variant-tab-bar";
import { changeReviewTitle } from "./components/change-review";
import { StudioChangeReviewPanel } from "./components/studio-change-review-panel";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useRouter } from "@tanstack/react-router";
import {
  ArrowLeft,
  Play,
  History,
  GraduationCap,
  BookOpen,
  MoreVertical,
  Download,
  Upload,
  Workflow,
  Smartphone,
  Sparkles,
  Square,
  SlidersHorizontal,
  Undo2,
  Redo2,
} from "lucide-react";
import { LEARNING_OPEN_EVENT } from "./learn/learning-catalog";
import { feedback } from "@/lib/feedback";
import { DOCS_URLS } from "@/lib/docs-urls";
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
import { useAuthGuard } from "@/hooks/use-auth-guard";
import { useWorldsStore } from "@/stores/worlds";
import { useUiStore } from "@/stores/ui";
import { useStudioStore, probeStreamBase } from "@/stores/studio";
import { isPlaceholderCardName } from "@/lib/world-templates";
import { PublishChecklist } from "./publish-checklist";
import { markPlaytested } from "./lib/playtested";
import { MobileStudioShell } from "./mobile-studio-shell";
import { rememberEditorChoice } from "@/features/editor/lib/editor-mode";
import { setCardEditorMode } from "@/features/editor/lib/card-editor-mode";
import { isScreenFirst } from "@/lib/editor-surface";
import { BlueprintStage } from "./blueprint-stage";
import { StudioLearningCenter } from "./learn/studio-learning";
import { LearningWorkspaceProvider } from "./learn/learning-workspace";
import { BundleCreator, BundleImporter, CreditIndicator, ImportBundleModal, WorldPublishModal } from "@/edition/slots";
import { useEdition } from "@/edition/edition";
import { HOSTED_ROUTES } from "@/edition/routes";
import { ExportCardMenu } from "../editor/export-card-menu";
import { ChangeHistoryDialog } from "./change-history-dialog";
import { ReviewStateControl } from "../editor/review-state-control";
import type { YuminaBundle } from "@yumina/engine";
import type { ToolCall } from "./lib/types";

import "dockview-react/dist/styles/dockview.css";
import "./studio-theme.css";
import { captureHubEvent } from "@/lib/analytics";
import { ownsTypingUndo } from "./lib/text-entry-target";
import { STUDIO_OPEN_AI_CHANGES_EVENT, STUDIO_OPEN_VERSIONS_EVENT, stepBack } from "./lib/studio-back";
import { SaveStatus } from "@/features/editor/save-status";
import { TemplateBlanksChip } from "./components/template-blanks-chip";

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

/** A signed-out visitor looking at the canvas on the create page: there is no
 *  saved card to go back to or to open in the classic editor, so the page that
 *  shows them the board decides where those two lead. */
export interface GuestStudioExits {
  onBack: () => void;
  onLeaveCanvas: () => void;
}

export function StudioShell({ guest }: { guest?: GuestStudioExits } = {}) {
  const isMobileStudio = useIsMobileStudio();
  useStreamBaseProbe();
  return <LearningWorkspaceProvider>{isMobileStudio ? <MobileStudioShell guest={guest} /> : <StudioDesktopShell guest={guest} />}<StudioLearningCenter /></LearningWorkspaceProvider>;
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

/** The canvas has the whole window: the site's left rail (Create, Discover,
 *  Community…) goes while it is open, and the top bar's back arrow is the one
 *  way out. */
function useCanvasTakesTheWindow() {
  useEffect(() => {
    useUiStore.getState().setStudioTakeover(true);
    return () => useUiStore.getState().setStudioTakeover(false);
  }, []);
}

function StudioDesktopShell({ guest }: { guest?: GuestStudioExits }) {
  useCanvasTakesTheWindow();
  const { t } = useTranslation("editor");
  const { t: tc } = useTranslation("common");
  const { t: tLearning } = useTranslation("learning");
  // On a card someone shared with them: publishing needs the creator's leave,
  // and taking a copy of the card stays the creator's call.
  const cardAccess = useEditorStore(s => s.access);
  // An editor the creator let publish may submit updates of a card that is
  // already live; putting a card out for the first time stays the creator's.
  const cardStatus = useEditorStore(s => s.worldStatus);
  const canPublishCard = !cardAccess || cardAccess.role === "owner" || (cardAccess.canPublish && cardStatus === "published");
  const ownsCard = !cardAccess || cardAccess.role === "owner";
  // A viewer (or an admin inspecting) has nothing to save, so no "saved" either.
  const viewOnly = useEditorStore(s => s.readOnlyInspect);
  const router = useRouter();
  const worldDraft = useEditorStore(s => s.worldDraft);
  const serverWorldId = useEditorStore(s => s.serverWorldId);
  const saving = useEditorStore(s => s.saving);
  const saveDraft = useEditorStore(s => s.saveDraft);
  const setField = useEditorStore(s => s.setField);
  const { requireAuth } = useAuthGuard();
  // A guest sees the board the way an inspector does: nothing they can change.
  const readOnlyInspect = useEditorStore(s => s.readOnlyInspect || s.guestMode);
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
  useEffect(() => {
    const open = () => setSnapshotsOpen(true);
    window.addEventListener(STUDIO_OPEN_AI_CHANGES_EVENT, open);
    return () => window.removeEventListener(STUDIO_OPEN_AI_CHANGES_EVENT, open);
  }, []);
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

  // 简单模式 in the ⋮ menu: the same /edit route, which renders the simple editor
  // once this card's mode says so. The field goes into the draft too, so the
  // unsaved-changes dialog's save-and-switch carries it to the server.
  const leaveToSimple = useCallback(() => {
    if (!serverWorldId) return;
    setCardEditorMode("simple");
    rememberEditorChoice(serverWorldId, "simple");
    void router.navigate({ to: "/app/worlds/$worldId/edit", params: { worldId: serverWorldId } });
  }, [serverWorldId, router]);

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
        {/* LEFT: Navigation. The site's rail is gone on the canvas, so its
            mark comes along: one click home to Discover (the library where
            the edition has no hub). */}
        <Link
          to={features.hub ? HOSTED_ROUTES.hub : "/app/library"}
          preload="intent"
          aria-label={features.hub ? tc("nav.discover") : tc("nav.library")}
          title={features.hub ? tc("nav.discover") : tc("nav.library")}
          data-testid="studio-home"
          className="hover-surface flex shrink-0 items-center rounded-lg p-1"
        >
          <img src="/logo.png" alt="" className="h-6 w-6 object-contain" />
        </Link>
        <button
          onClick={() => {
            // One step back: a page over the board closes first (see
            // lib/studio-back). Only from the bare board does it leave.
            if (stepBack()) return;
            if (guest) { guest.onBack(); return; }
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

        {/* No 画布 switch: on a computer the canvas is the editor (a block
            opens its own form with a click), so there is nothing to leave to. */}
        {/* As wide as the name, so the language chip sits right after it; a
            hidden copy of the text sets the width (an input cannot). */}
        <span className="inline-grid min-w-[96px] max-w-[300px] shrink">
          <span aria-hidden className="invisible col-start-1 row-start-1 overflow-hidden whitespace-pre px-2 py-1 text-sm font-medium">{(worldDraft.name || t("shell.untitledWorld", { defaultValue: "Untitled World" })) + " "}</span>
          <input
            type="text"
            data-onboarding="name"
            // The card's own name, numbered when it was made (Untitled World,
            // Untitled World 1, …) so drafts tell apart in the library. Still
            // a placeholder until renamed: a click selects it all, ready to
            // type over, and publishing asks for a real one.
            value={worldDraft.name ?? ""}
            onChange={(e) => setField("name", e.target.value)}
            onFocus={(e) => { if (isPlaceholderCardName(worldDraft.name)) e.currentTarget.select(); }}
            placeholder={t("shell.untitledWorld", { defaultValue: "Untitled World" })}
            title={t("shell.namePlaceholder")}
            readOnly={readOnlyInspect}
            className="col-start-1 row-start-1 w-full min-w-0 truncate rounded-md border border-transparent bg-transparent px-2 py-1 text-sm font-medium text-foreground placeholder:text-muted-foreground/50 transition-colors hover:border-border/70 focus:border-border focus:bg-background/40 focus:outline-none"
          />
        </span>

        {/* Variants — the same menu as the full editor's bar: switch, add a
            language, rename, delete, set the primary. */}
        <VariantTabBar header readOnly={readOnlyInspect} destination="/app/studio/$worldId" />

        {/* The card's own controls, beside its name: whether it is saved, a
            step back or forward, and its menu (history, help, packs). They
            sat among the people and publishing on the right, where the ✓
            read as part of 试玩. */}
        <div className="ml-1 flex shrink-0 items-center gap-0.5">
            {/* Saved / saving / offline: the card saves itself. Counts a
                tidied canvas too (`layoutDirty`). */}
            {!viewOnly && <SaveStatus onSave={handleSave} iconOnly data-onboarding="save" />}
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
                {/* One way to history: 版本历史, which links on to the
                    assistant's own change log. 改动记录 here and 版本历史 in
                    面板 were two doors, each saying the other was the real one. */}
                <DropdownMenuItem disabled={!serverWorldId} onClick={() => window.dispatchEvent(new Event(STUDIO_OPEN_VERSIONS_EVENT))} className="text-xs gap-2" data-learn="history">
                  <History className="h-3.5 w-3.5 text-muted-foreground" />
                  {t("studio.versionHistory")}
                </DropdownMenuItem>
                {/* The lessons, beside the written guide: they had a toolbar slot of their own on every visit. */}
                <DropdownMenuItem onClick={() => window.dispatchEvent(new Event(LEARNING_OPEN_EVENT))} className="text-xs gap-2" data-learning="help">
                  <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
                  {tLearning("help")}
                </DropdownMenuItem>
                <DropdownMenuItem asChild className="text-xs gap-2">
                  <a href={DOCS_URLS.canvas} target="_blank" rel="noopener noreferrer" data-studio-docs="">
                    <GraduationCap className="h-3.5 w-3.5 text-muted-foreground" />
                    {t("shell.creatorGuide")}
                  </a>
                </DropdownMenuItem>
                {(features.bundles || serverWorldId) && <DropdownMenuSeparator />}
                {features.bundles && (
                  <>
                    <DropdownMenuItem onClick={() => setShowImportModal(true)} className="text-xs gap-2">
                      <Download className="h-3.5 w-3.5 text-muted-foreground" />
                      {t("studio.importBundle")}
                    </DropdownMenuItem>
                    {/* A resource pack is the author's to hand out. */}
                    {ownsCard && (
                      <DropdownMenuItem onClick={() => setShowBundleCreator(true)} className="text-xs gap-2">
                        <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                        {t("studio.exportBundle")}
                      </DropdownMenuItem>
                    )}
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
        </div>

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

        {/* RIGHT: who works on the card (outside AIs, people), then shipping
            it. Only the publish control is outlined: one strong thing. */}
        <div className="flex shrink-0 items-center gap-1.5">
          {/* 连接你的 AI: marks, no words. The bar was a dozen words wide
              before the newcomer found 试玩, so this adds none; it also says
              which AI is signed in and when one is writing to this card.
              Connecting an outside AI is the author's call (it acts as them). */}
          {serverWorldId && !readOnlyInspect && ownsCard && <ConnectAiButton onOpen={() => setOutsideAiOpen(true)} refreshKey={outsideAiOpen} />}
          <CollabBar />
          <span aria-hidden className="mx-1.5 h-5 w-px bg-border/70" />
          <TemplateBlanksChip />


          {/* 试玩: running the card, beside saving and publishing it. */}
          <button
            type="button"
            onClick={() => {
              // Playtesting needs a saved card, which a guest cannot have yet.
              if (guest && !isPlaytest) { requireAuth("create worlds"); return; }
              setStagePage(isPlaytest && isScreenFirst() ? "frontend" : "blueprint"); handleModeSwitch(isPlaytest ? "edit" : "playtest");
            }}
            data-onboarding="playtest-switch"
            aria-pressed={isPlaytest}
            className={cn(
              "flex h-8 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors duration-200",
              isPlaytest
                ? "bg-emerald-500/15 text-emerald-300"
                : "text-emerald-300/90 hover:bg-emerald-500/10 hover:text-emerald-300",
            )}
          >
            {isPlaytest ? <Square className="h-3 w-3 fill-current" /> : <Play className="h-3 w-3" />}
            {t(isPlaytest ? "studio.stopPlay" : "studio.play")}
          </button>
          {/* Publish + review state in one control — the only review entry point
              in Studio. Green "Publish update" when live & clean; otherwise the
              button shows the state (not live / changes to submit / in review /
              rejected) and opens a popover with the matching action. */}
          {!readOnlyInspect && canPublishCard && features.publishing && (
            <span data-learn="publish" className="contents"><ReviewStateControl onPublish={handlePublishClick} size="sm" disabled={saving || !serverWorldId} draftExtra={(close) => <PublishChecklist onDone={close} />} /></span>
          )}
          {!readOnlyInspect && ownsCard && !features.publishing && (
            <ExportCardMenu worldId={serverWorldId} size="sm" disabled={saving || !serverWorldId} />
          )}
          {/* The balance, as on the rest of the site: the site's bar is not shown here. */}
          {!guest && <span className="ml-1"><CreditIndicator /></span>}
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
