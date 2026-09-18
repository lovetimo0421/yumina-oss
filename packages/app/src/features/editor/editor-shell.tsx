import { useStoryNavigation } from "@/hooks/use-story-navigation";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRouter } from "@tanstack/react-router";
import { useAuthGuard } from "@/hooks/use-auth-guard";
import { navigateBackSafely } from "@/lib/safe-back";
import { useHistoryEntryState } from "@/hooks/use-history-entry-state";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Save,
  Loader2,
  FileText,
  BookOpen,
  Variable,
  LayoutGrid,
  Music,
  FolderOpen,
  Play,
  Wand2,
  MoreVertical,
  MessageCircle,
  Sparkles,
  Zap,
  GraduationCap,
  History,
  Package,
  SlidersHorizontal,
} from "lucide-react";
import { feedback } from "@/lib/feedback";
import { useTransientFlag } from "@/hooks/use-transient-flag";
import { cn } from "@/lib/utils";
import { DOCS_URLS } from "@/lib/docs-urls";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEditorStore, type EditorSection } from "@/stores/editor";
import { useWorldsStore } from "@/stores/worlds";
import { saveEditorMode, saveGlobalEditorMode } from "./quick-create-editor";
import { VariantTabBar } from "./variant-tab-bar";
import { ReviewStateControl } from "./review-state-control";
import { GuestEditorReadOnly } from "./components/guest-editor-readonly";
import { FirstMessageSection } from "./sections/first-message";
import { KnowledgeBasesSection } from "./sections/knowledge-bases";
import { VariablesSection } from "./sections/variables";
import { BehaviorsSection } from "./sections/behaviors-section";
import { ComponentsSection } from "./sections/components";
import { AudioSection } from "./sections/audio";
import { AssetsSection } from "./sections/assets";
import { OverviewSection } from "./sections/overview";
import { BundlesSection, GenerationEditorSection, WorldPublishModal } from "@/edition/slots";
import { useEdition } from "@/edition/edition";
import { ExportCardMenu } from "./export-card-menu";
import { UpdateNotifyDialog } from "./update-notify-dialog";
import { isEditorTourDone } from "./tour/tour-state";
import { importWithChunkRecovery } from "@/lib/stale-chunk-reload";
const EditorTour = lazy(() => importWithChunkRecovery(() => import("./tour/editor-tour")).then(m => ({ default: m.EditorTour })));
const VersionHistoryDialog = lazy(() => importWithChunkRecovery(() => import("./version-history-dialog")).then(m => ({ default: m.VersionHistoryDialog })));
import { useUiStore } from "@/stores/ui";

const apiBase = import.meta.env.VITE_API_URL || "";

const SECTION_KEYS: { id: EditorSection; labelKey: string; icon: typeof FileText }[] =
  [
    { id: "first-message", labelKey: "sections.firstMessage", icon: MessageCircle },
    { id: "entries", labelKey: "sections.lorebook", icon: BookOpen },
    { id: "variables", labelKey: "sections.variables", icon: Variable },
    { id: "rules", labelKey: "sections.behaviors", icon: Zap },
    { id: "components", labelKey: "sections.customUI", icon: LayoutGrid },
    { id: "audio", labelKey: "sections.audio", icon: Music },
    { id: "generation", labelKey: "sections.aiGeneration", icon: Sparkles },
    { id: "assets", labelKey: "sections.assets", icon: FolderOpen },
    { id: "overview", labelKey: "sections.overview", icon: FileText },
    { id: "bundles", labelKey: "sections.bundles", icon: Package },
  ];

// Sidebar grouping — order here determines vertical order in the nav.
// Bundles is intentionally absent — it lives as a standalone "marketplace"
// card at the sidebar bottom (separate visual treatment from regular sections).
const SECTION_GROUPS: { groupKey: string; ids: EditorSection[] }[] = [
  { groupKey: "content", ids: ["first-message", "entries", "variables", "rules"] },
  { groupKey: "creation", ids: ["generation"] },
  { groupKey: "presentation", ids: ["components", "audio", "assets"] },
  { groupKey: "publish", ids: ["overview"] },
];

const SECTION_COMPONENTS: Record<EditorSection, React.FC> = {
  "first-message": FirstMessageSection,
  entries: KnowledgeBasesSection,
  variables: VariablesSection,
  rules: BehaviorsSection,
  components: ComponentsSection,
  audio: AudioSection,
  assets: AssetsSection,
  generation: GenerationEditorSection,
  overview: OverviewSection,
  bundles: BundlesSection,
};

function isEditorSection(value: unknown): value is EditorSection {
  return typeof value === "string" && value in SECTION_COMPONENTS;
}

function useIsMobileEditor() {
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

interface EditorShellProps {
  onBack?: () => void;
  onSwitchToSimple?: () => void;
}

export function EditorShell({ onBack, onSwitchToSimple }: EditorShellProps) {
  const { t } = useTranslation(["editor", "common"]);
  const router = useRouter();
  const navigateToStory = useStoryNavigation();
  const worldDraft = useEditorStore(s => s.worldDraft);
  const serverWorldId = useEditorStore(s => s.serverWorldId);
  const isDirty = useEditorStore(s => s.isDirty);
  const saving = useEditorStore(s => s.saving);
  // R3: the Save button says "Saved" for a moment instead of a toast.
  const lastSavedAt = useEditorStore(s => s.lastSavedAt);
  const justSaved = useTransientFlag(lastSavedAt);
  const activeSection = useEditorStore(s => s.activeSection);
  const setActiveSection = useEditorStore(s => s.setActiveSection);
  const [historySection, setHistorySection] = useHistoryEntryState<EditorSection>(
    "editor:active-section",
    "entries",
    isEditorSection,
  );
  const setField = useEditorStore(s => s.setField);
  const saveDraft = useEditorStore(s => s.saveDraft);
  const pendingEdit = useEditorStore(s => s.pendingEdit);
  const variants = useEditorStore(s => s.variants);
  const readOnlyInspect = useEditorStore(s => s.readOnlyInspect);
  const guestMode = useEditorStore(s => s.guestMode);
  // Edition gates: publishing/review, hub translations (variant bar), bundles.
  const { features } = useEdition();
  const { requireAuth } = useAuthGuard();
  const [showUpdateNotify, setShowUpdateNotify] = useState(false);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const isMobileEditor = useIsMobileEditor();
  // First-visit guided tour — separate step lists per layout (the mobile shell
  // shares no anchors with desktop); never in admin inspect mode.
  // Auto-pop ONLY on a fresh, never-saved draft (the create flow): the tour's
  // hands-on steps create real entries/variables/behaviors, and on an existing
  // card those would autosave into the draft (published cards: into a held
  // pending edit). Existing creators reach the tour via ⋮ → replay instead.
  const [showTour, setShowTour] = useState(
    () => !isEditorTourDone() && !useEditorStore.getState().serverWorldId
  );
  const tourActive = showTour && !readOnlyInspect && !guestMode;

  useEffect(() => {
    setActiveSection(historySection);
  }, [historySection, setActiveSection]);

  const selectSection = (section: EditorSection) => {
    setHistorySection(section);
    setActiveSection(section);
  };

  // A 副 (non-primary same-language variant) doesn't own the outward Overview —
  // only the 主 of each language is the hub-facing public face — but it IS a real,
  // distinct world that must be publishable / submittable for review on its own.
  const currentVariant = variants.find((v) => v.id === serverWorldId);
  const isNonPrimaryVariant = !!currentVariant && currentVariant.isPrimaryVariant === false;
  // Publish / submit-for-review is available for ANY owned variant (incl. 副) so a
  // draft variant can go through first-publish review. Decoupled from primary —
  // only the Overview section stays 主-only (see visibleSections).
  const canPublishHere = !readOnlyInspect;

  // 副 hide Overview (the outward, hub-facing metadata) — but keep every other
  // section + the publish/submit path. Editions without platform image
  // generation (the open-source build) drop the "AI generation" section too;
  // its group disappears with it (see visibleGroups).
  const visibleSections = useMemo(
    () =>
      SECTION_KEYS.filter(
        (s) =>
          (s.id !== "overview" || !isNonPrimaryVariant)
          && (s.id !== "generation" || features.imageGeneration),
      ),
    [isNonPrimaryVariant, features.imageGeneration],
  );

  // Group → visible sections (drops empty groups for non-primary variants)
  const visibleGroups = useMemo(() => {
    const visibleIds = new Set(visibleSections.map((s) => s.id));
    return SECTION_GROUPS
      .map((group) => ({
        groupKey: group.groupKey,
        sections: group.ids
          .filter((id) => visibleIds.has(id))
          .map((id) => SECTION_KEYS.find((s) => s.id === id)!)
          .filter(Boolean),
      }))
      .filter((g) => g.sections.length > 0);
  }, [visibleSections]);

  // Per-section content counts shown as sidebar badges.
  // Returns null when a count would be misleading (e.g. Overview is metadata, Assets lives in a separate store).
  const sectionCounts = useMemo<Partial<Record<EditorSection, number>>>(() => {
    const greetingCount = worldDraft.entries.filter((e) => e.role === "greeting").length;
    const entryCount = worldDraft.entries.length - greetingCount;
    const reactionCount = (worldDraft.reactions ?? []).length;
    const componentFiles = worldDraft.rootComponent?.files
      ? Object.keys(worldDraft.rootComponent.files).length
      : 0;
    return {
      "first-message": greetingCount,
      entries: entryCount,
      variables: worldDraft.variables.length,
      rules: worldDraft.rules.length + reactionCount,
      components: componentFiles,
      audio: worldDraft.audioTracks.length,
    };
  }, [
    worldDraft.entries,
    worldDraft.variables,
    worldDraft.rules,
    worldDraft.reactions,
    worldDraft.rootComponent,
    worldDraft.audioTracks,
  ]);

  // Fallback to "entries" if activeSection is invalid or hidden for this variant
  const safeSection =
    activeSection in SECTION_COMPONENTS && visibleSections.some((s) => s.id === activeSection)
      ? activeSection
      : "entries";
  const ActiveComponent = SECTION_COMPONENTS[safeSection];

  const ensureServerWorldId = async (): Promise<string | null> => {
    let id = serverWorldId;
    if (!id) {
      // First save needs *some* name. If the creator hasn't typed one yet,
      // drop in a placeholder silently so Studio/Play don't get blocked.
      if (!useEditorStore.getState().worldDraft.name) {
        useEditorStore.getState().setField("name", t("shell.untitledWorld"));
      }
      await saveDraft();
      id = useEditorStore.getState().serverWorldId;
    }
    // saveDraft already fired its own failure pill with a Retry; a second pill
    // here only replaces it (one visible at a time) with vaguer copy.
    return id ?? null;
  };

  const playFailed = () => {
    feedback.error(t("shell.failedStartPlay"), {
      label: t("common:action.retry"),
      onClick: () => void handlePlayWorld(),
    });
  };

  const handleEnterStudio = async () => {
    if (guestMode) { requireAuth("create worlds"); return; }
    try {
      const id = await ensureServerWorldId();
      if (id) {
        router.navigate({
          to: "/app/studio/$worldId",
          params: { worldId: id },
        });
      }
    } catch (err) {
      console.error("Enter Studio failed:", err);
      feedback.error(t("shell.failedEnterStudio"));
    }
  };

  // Annotated so the Retry action below can reference the handler it lives in.
  const handlePlayWorld: () => Promise<void> = async () => {
    if (guestMode) { requireAuth("create worlds"); return; }
    try {
      const worldId = await ensureServerWorldId();
      if (!worldId) return;

      // Flush unsaved edits before navigating to play so the player sees the
      // current editor state, not the last persisted snapshot. Mirrors
      // playtest-panel.tsx:69-76 — without this, Edit → Play shows stale
      // content and creators think the Play button is "broken."
      if (useEditorStore.getState().isDirty) {
        // saveDraft reports its own failure — don't stack a second pill.
        if (!(await saveDraft())) return;
      }

      // Match library play flow: reuse existing session for this world when available.
      const listRes = await fetch(`${apiBase}/api/sessions`, {
        credentials: "include",
      });
      if (listRes.ok) {
        const { data: sessions } = await listRes.json();
        const existing = sessions.find(
          (session: { id: string; worldId: string }) => session.worldId === worldId
        );
        if (existing) {
          useUiStore.getState().recordRecentPlayedWorld({
            id: worldId,
            name: worldDraft.name || "Untitled World",
            thumbnailUrl: null,
          });
          navigateToStory(existing.id);
          return;
        }
      }

      const res = await fetch(`${apiBase}/api/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ worldId }),
      });
      if (!res.ok) {
        playFailed();
        return;
      }
      const { data } = await res.json();
      useUiStore.getState().recordRecentPlayedWorld({
        id: worldId,
        name: worldDraft.name || "Untitled World",
        thumbnailUrl: null,
      });
      navigateToStory(data.id);
    } catch (err) {
      console.error("Play from editor failed:", err);
      playFailed();
    }
  };

  const handleSave = async () => {
    if (guestMode) { requireAuth("create worlds"); return; }
    const success = await saveDraft();
    // Offer the "notify your players" dialog only when the card is actually
    // LIVE (status === "published"). worldIsPublished alone is wrong here: the
    // publish modal optimistically flips it while the card is still
    // pending_review, and a save during review must not prompt a player
    // notification (the server would reject it anyway).
    if (success && useEditorStore.getState().worldStatus === "published") {
      setShowUpdateNotify(true);
    }
  };

  const handlePublishClick = async () => {
    if (guestMode) { requireAuth("publish worlds"); return; }
    try {
      // Flush unsaved edits before publishing so the listing reflects the
      // current editor state, mirroring the Play handler above.
      if (useEditorStore.getState().isDirty) {
        // saveDraft reports its own failure — don't stack a second pill.
        if (!(await saveDraft())) return;
      }
      const id = await ensureServerWorldId();
      if (!id) return;
      setShowPublishModal(true);
    } catch (err) {
      // Nothing in this block throws on its own (saveDraft and
      // ensureServerWorldId both resolve falsy and report themselves), so this
      // is a last-resort log rather than a second pill.
      console.error("Open publish modal failed:", err);
    }
  };

  // Keyboard shortcuts: Ctrl+S (save), Ctrl+Z (undo), Ctrl+Y (redo)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (useEditorStore.getState().guestMode) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z") {
        e.preventDefault();
        useEditorStore.getState().undo();
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === "y" || (e.shiftKey && e.key === "z") || (e.shiftKey && e.key === "Z"))
      ) {
        e.preventDefault();
        useEditorStore.getState().redo();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        const state = useEditorStore.getState();
        if (!state.saving) {
          state.saveDraft().then((ok) => {
            if (ok && useEditorStore.getState().worldStatus === "published") {
              setShowUpdateNotify(true);
            }
          });
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (isMobileEditor) {
    return (
      <div className="editor-shell-mobile flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <div className="shrink-0 border-b border-border bg-background/95 px-3 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
          <div className="flex items-center gap-2">
            <button
              onClick={() =>
                onBack
                  ? onBack()
                  : navigateBackSafely(
                      router.history,
                      serverWorldId ? `/app/library?worldId=${encodeURIComponent(serverWorldId)}` : "/app/library",
                    )
              }
              className="hover-surface inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground"
              aria-label={t("action.back", { defaultValue: "Back" })}
            >
              <ArrowLeft className="h-4 w-4" />
            </button>

            <div className="flex min-w-0 flex-1 items-center gap-2">
              <input
                type="text"
                value={worldDraft.name}
                onChange={(e) => setField("name", e.target.value)}
                placeholder={t("shell.namePlaceholder")}
                readOnly={guestMode}
                aria-readonly={guestMode}
                tabIndex={guestMode ? -1 : undefined}
                autoFocus={!guestMode && !worldDraft.name}
                className={cn(
                  "min-w-0 flex-1 bg-transparent text-base font-semibold text-foreground placeholder:text-muted-foreground/35 focus:outline-none",
                  guestMode && "cursor-not-allowed opacity-60",
                )}
              />
              {features.hub && <VariantTabBar compact />}
            </div>

            {!readOnlyInspect && (
              <button
                onClick={handleSave}
                disabled={saving}
                title={t("shell.saveTooltip")}
                data-tour="m-save"
                className="relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-gold px-3 text-xs font-semibold text-black transition-opacity disabled:opacity-40"
              >
                {saving ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : justSaved ? (
                  <Check className="h-3.5 w-3.5" />
                ) : (
                  <Save className="h-3.5 w-3.5" />
                )}
                {justSaved && !saving ? t("shell.saved") : t("shell.save")}
                {isDirty && !saving && (
                  <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-background bg-amber-500" />
                )}
              </button>
            )}
            {readOnlyInspect && (
              <span className="inline-flex h-9 shrink-0 items-center rounded-xl border border-amber-400/40 bg-amber-400/10 px-2.5 text-[11px] font-semibold text-amber-300">
                🔍 Preview
              </span>
            )}
          </div>
        </div>

        <div className="shrink-0 border-b border-border bg-card/20 px-3 py-2">
          <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button data-tour="m-section-menu" className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-xl border border-border bg-card/70 px-2.5 text-left">
                {(() => {
                  const section = visibleSections.find((s) => s.id === safeSection) ?? visibleSections[0];
                  const Icon = section?.icon ?? FileText;
                  return (
                    <>
                      <Icon className="h-4 w-4 shrink-0 text-primary" />
                      <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
                        {section ? t(section.labelKey as any) : t("sections.lorebook")}
                      </span>
                      <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </>
                  );
                })()}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-52">
              {visibleSections.map((section) => (
                <DropdownMenuItem
                  key={section.id}
                  onClick={() => selectSection(section.id)}
                  data-tour-section-m={section.id}
                  className="gap-2"
                >
                  <section.icon className={cn("h-4 w-4", safeSection === section.id ? "text-primary" : "text-muted-foreground")} />
                  <span className="flex-1">{t(section.labelKey as any)}</span>
                  {safeSection === section.id && <Check className="h-4 w-4 text-primary" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Publish + review state in one control (also the publish entry on mobile) */}
          {!readOnlyInspect && features.publishing && (
            <span data-tour="publish-control" className="inline-flex shrink-0">
              <ReviewStateControl onPublish={handlePublishClick} size="sm" disabled={saving} />
            </span>
          )}
          {!readOnlyInspect && !features.publishing && (
            <ExportCardMenu worldId={serverWorldId} worldName={worldDraft.name} size="sm" disabled={saving} />
          )}

          {!readOnlyInspect && (
            <button
              onClick={handleEnterStudio}
              disabled={saving || (!serverWorldId && !worldDraft.name)}
              title={t("shell.enterStudio")}
              data-tour="m-studio"
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-primary/10 px-2.5 text-xs font-semibold text-primary transition-colors hover:bg-primary/20 disabled:opacity-40"
            >
              <Wand2 className="h-3.5 w-3.5" />
              <span className="hidden min-[390px]:inline">{t("shell.enterStudio")}</span>
            </button>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="hover-surface inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground"
                title={t("shell.moreActions")}
                aria-label={t("shell.moreActions")}
              >
                <MoreVertical className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {!readOnlyInspect && (
                <DropdownMenuItem onClick={handlePlayWorld} disabled={saving || (!serverWorldId && !worldDraft.name)}>
                  <Play className="mr-2 h-4 w-4" />
                  {t("shell.play")}
                </DropdownMenuItem>
              )}
              {/* Versions need a saved world; the item explains itself rather
                  than firing a pill at a click that can't work. */}
              <DropdownMenuItem
                disabled={!serverWorldId}
                title={!serverWorldId ? t("versionHistory.needsServerSave") : undefined}
                onClick={() => setShowVersionHistory(true)}
              >
                <History className="mr-2 h-4 w-4" />
                {t("versionHistory.menuItem")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowTour(true)}>
                <Sparkles className="mr-2 h-4 w-4" />
                {t("tour.replay")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => window.open(DOCS_URLS.welcome, "_blank", "noopener,noreferrer")}>
                <GraduationCap className="mr-2 h-4 w-4" />
                {t("shell.creatorGuide")}
              </DropdownMenuItem>
              {onSwitchToSimple && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      const store = useEditorStore.getState();
                      store.setField("editorMode", "simple");
                      const id = store.serverWorldId;
                      if (id) saveEditorMode(id, "simple");
                      saveGlobalEditorMode("simple");
                      onSwitchToSimple();
                    }}
                  >
                    {t("quickCreate.simpleMode")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-2 pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
          <div className="min-h-full overflow-hidden rounded-2xl border border-border bg-background shadow-xl shadow-black/20">
            <GuestEditorReadOnly
              guestMode={guestMode}
              className="min-h-full"
              contentClassName="flex flex-col overflow-hidden"
            >
              <ActiveComponent />
            </GuestEditorReadOnly>
          </div>
        </div>

        {showUpdateNotify && serverWorldId && (
          <UpdateNotifyDialog
            worldId={serverWorldId}
            worldName={worldDraft.name || "Untitled World"}
            held={!!pendingEdit}
            onClose={() => setShowUpdateNotify(false)}
          />
        )}
        <Suspense fallback={null}>
          {showVersionHistory && serverWorldId && (
            <VersionHistoryDialog
              worldId={serverWorldId}
              onClose={() => setShowVersionHistory(false)}
            />
          )}
        </Suspense>
        <Suspense fallback={null}>
          {showPublishModal && serverWorldId && (
            <WorldPublishModal
              initialWorldId={serverWorldId}
              onClose={() => setShowPublishModal(false)}
              onPublished={() => {
                useEditorStore.setState({ worldIsPublished: true });
                // Refresh the worlds list AND the editor's own status so the
                // review-state control reflects the new lifecycle status (e.g.
                // draft → pending_review) even when this row isn't in the list
                // (direct load / non-representative language variant).
                useEditorStore.getState().refreshWorldStatus();
                useWorldsStore.getState().invalidate();
                useWorldsStore.getState().fetchWorlds();
              }}
            />
          )}
        </Suspense>

        {/* First-visit guided tour (Mushie) — mobile step list */}
        <Suspense fallback={null}>
          {tourActive && <EditorTour mobile onClose={() => setShowTour(false)} />}
        </Suspense>
      </div>
    );
  }

  return (
    <div className="editor-shell-root flex h-full flex-col overflow-hidden">
      {/* Header */}
      <div className="editor-shell-header shrink-0 border-b border-border px-3 py-3 md:px-4">
        <div className="editor-shell-header-main flex items-start gap-3 md:items-center">
          <button
            onClick={() =>
              onBack
                ? onBack()
                : navigateBackSafely(
                    router.history,
                    serverWorldId ? `/app/library?worldId=${encodeURIComponent(serverWorldId)}` : "/app/library",
                  )
            }
            className="hover-surface rounded-lg p-1.5 text-muted-foreground"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>

          <div className="flex-1 min-w-0">
            <input
              type="text"
              value={worldDraft.name}
              onChange={(e) => setField("name", e.target.value)}
              placeholder={t("shell.namePlaceholder")}
              readOnly={guestMode}
              aria-readonly={guestMode}
              tabIndex={guestMode ? -1 : undefined}
              autoFocus={!guestMode && !worldDraft.name}
              className={cn(
                "w-full bg-transparent text-lg font-semibold text-foreground placeholder:text-muted-foreground/30 focus:outline-none",
                guestMode && "cursor-not-allowed opacity-60",
              )}
            />
          </div>

          <div className="editor-shell-header-actions editor-shell-header-actions--advanced flex items-center gap-2">
            {/* More actions: mode switch, version history, import/export */}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="editor-shell-more-button flex h-9 w-9 items-center justify-center rounded-lg border border-border/70 bg-card/70 text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground"
                  title={t("shell.moreActions")}
                >
                  <MoreVertical className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                {onSwitchToSimple && (
                  <DropdownMenuItem
                    onClick={() => {
                      const store = useEditorStore.getState();
                      store.setField("editorMode", "simple");
                      const id = store.serverWorldId;
                      if (id) saveEditorMode(id, "simple");
                      saveGlobalEditorMode("simple");
                      onSwitchToSimple();
                    }}
                  >
                    <SlidersHorizontal className="mr-2 h-4 w-4" />
                    {t("shell.switchSimple")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  disabled={!serverWorldId}
                  title={!serverWorldId ? t("versionHistory.needsServerSave") : undefined}
                  onClick={() => setShowVersionHistory(true)}
                >
                  <History className="mr-2 h-4 w-4" />
                  {t("shell.versionHistoryMenu")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setShowTour(true)}>
                  <Sparkles className="mr-2 h-4 w-4" />
                  {t("tour.replay")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Creator Guide — promoted to top bar, sits next to ⋮ as a quiet "help" link */}
            <a
              href={DOCS_URLS.welcome}
              target="_blank"
              rel="noopener noreferrer"
              title={t("shell.creatorGuide")}
              className="editor-shell-guide-button flex items-center gap-1.5 rounded-lg border border-border/70 bg-card/70 px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:border-border hover:bg-accent hover:text-foreground"
            >
              <GraduationCap className="h-4 w-4" />
              <span className="hidden md:inline">{t("shell.creatorGuide")}</span>
            </a>

            {/* Vertical divider — separates auxiliary controls from Studio+Save */}
            <span
              aria-hidden
              className="mx-2.5 h-7 w-px bg-gradient-to-b from-border/40 via-border to-border/40"
            />

            {/* Enter Studio — light gold tint, sits where Play used to */}
            {!readOnlyInspect && (
              <button
                onClick={handleEnterStudio}
                disabled={saving}
                data-tour="studio"
                className="editor-shell-studio-button group flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-3.5 py-2 text-sm font-semibold text-primary transition-colors hover:border-primary/50 hover:bg-primary/20 disabled:opacity-40"
              >
                <Wand2 className="h-3.5 w-3.5 transition-transform group-hover:rotate-[-8deg]" />
                {t("shell.enterStudio")}
              </button>
            )}

            {!readOnlyInspect && (
              <>
                {/* Save — primary action */}
                <button
                  onClick={handleSave}
                  disabled={saving}
                  title={t("shell.saveTooltip")}
                  data-tour="save"
                  className="editor-shell-save-button relative flex items-center gap-2 rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-black shadow-[0_1px_0_0_rgba(255,255,255,0.12)_inset] transition-all hover:brightness-110 disabled:opacity-40"
                >
                  {saving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : justSaved ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Save className="h-3.5 w-3.5" />
                  )}
                  {justSaved && !saving ? t("shell.saved") : t("shell.save")}
                  {isDirty && !saving && (
                    <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-amber-500" />
                  )}
                </button>

                {/* Publish + review state in one control: green "Publish update"
                    when live & clean; otherwise the button itself shows the
                    review state (not live / changes to submit / in review /
                    rejected) and opens a popover with the matching action. */}
                {canPublishHere && features.publishing && (
                  <span data-tour="publish-control" className="inline-flex">
                    <ReviewStateControl onPublish={handlePublishClick} size="md" disabled={saving} />
                  </span>
                )}
                {canPublishHere && !features.publishing && (
                  <ExportCardMenu worldId={serverWorldId} worldName={worldDraft.name} size="md" disabled={saving} />
                )}
              </>
            )}

            {readOnlyInspect && (
              <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-1.5 text-xs font-semibold text-amber-300">
                🔍 Admin Preview
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Variant tab bar — between header and body */}
      {features.hub && <VariantTabBar />}

      {/* Body: sidebar + content */}
      <div className="editor-shell-body flex flex-1 overflow-hidden">
        {/* Left sidebar — section nav */}
        <aside className="editor-shell-sidebar flex w-[240px] shrink-0 flex-col overflow-hidden border-r border-border">
          {/* Grouped section tabs */}
          <nav className="editor-shell-nav mt-2 flex flex-1 flex-col overflow-y-auto p-3">
            {visibleGroups.map((group, groupIdx) => (
              <div key={group.groupKey} data-tour-group={group.groupKey} className={cn(groupIdx > 0 && "mt-4")}>
                <div className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground/50">
                  {t(`shell.groups.${group.groupKey}` as any)}
                </div>
                <div className="flex flex-col gap-0.5">
                  {group.sections.map((section) => {
                    const count = sectionCounts[section.id];
                    const isActive = safeSection === section.id;
                    return (
                      <button
                        key={section.id}
                        onClick={() => selectSection(section.id)}
                        data-tour-section={section.id}
                        className={cn(
                          "group/nav flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                          isActive
                            ? "active-surface font-semibold text-foreground"
                            : "font-medium text-muted-foreground hover-surface"
                        )}
                      >
                        <section.icon
                          className={cn(
                            "h-4 w-4 shrink-0",
                            isActive ? "text-primary" : "text-muted-foreground"
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate text-left">
                          {t(section.labelKey as any)}
                        </span>
                        {typeof count === "number" && count > 0 && (
                          <span
                            className={cn(
                              "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold tabular-nums transition-colors",
                              isActive
                                ? "bg-primary/15 text-primary"
                                : "bg-muted/40 text-muted-foreground/70 group-hover/nav:bg-muted/60"
                            )}
                          >
                            {count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          {/* Bundle marketplace — standalone card, not a regular nav item.
              Visually separated by a divider so it reads as a different mode
              ("browse community content" vs "edit this world"). */}
          {features.bundles && (
          <div className="editor-shell-marketplace-wrap border-t border-border p-3">
            <button
              onClick={() => selectSection("bundles")}
              className={cn(
                "group flex w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition-all",
                safeSection === "bundles"
                  ? "border-primary/50 bg-primary/[0.08] shadow-[0_0_15px_hsl(var(--primary)/0.10)]"
                  : "border-border/60 bg-card/40 hover:border-primary/30 hover:bg-primary/[0.04]"
              )}
            >
              <div
                className={cn(
                  "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors",
                  safeSection === "bundles"
                    ? "bg-primary/20 text-primary"
                    : "bg-muted/40 text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary"
                )}
              >
                <Package className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div
                  className={cn(
                    "text-sm font-bold",
                    safeSection === "bundles" ? "text-primary" : "text-foreground"
                  )}
                >
                  {t("shell.marketplaceTitle")}
                </div>
                <div className="text-[10px] text-muted-foreground/60">
                  {t("shell.marketplaceSubtitle")}
                </div>
              </div>
            </button>
          </div>
          )}

          {/* PLAY — primary call-to-action, restored to bottom-left of the sidebar
              with the original gold solid look. Hidden in admin inspect mode
              because admin isn't the creator and the play API will 403. */}
          {!readOnlyInspect && (
          <div className="editor-shell-play-wrap border-t border-border p-5">
            <button
              onClick={handlePlayWorld}
              disabled={saving}
              className="group relative flex w-full items-center justify-center gap-3 overflow-hidden rounded-2xl bg-gold py-4 text-lg font-black text-black shadow-[0_0_20px_rgba(201,162,94,0.3)] transition-all hover:-translate-y-0.5 hover:shadow-[0_0_30px_rgba(201,162,94,0.4)] disabled:opacity-40"
            >
              <div className="absolute inset-0 translate-x-[-100%] bg-gradient-to-r from-transparent via-white/20 to-transparent transition-transform duration-700 ease-in-out group-hover:translate-x-[100%]" />
              <Play className="relative z-10 h-6 w-6 fill-current transition-transform group-hover:scale-110" />
              <span className="relative z-10 tracking-widest">{t("shell.play")}</span>
            </button>
          </div>
          )}
        </aside>

        {/* Content — elevated workspace canvas */}
        <div className="editor-shell-content flex-1 overflow-hidden p-3 md:p-6 lg:p-8">
          <div className="editor-shell-surface flex h-full flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl shadow-black/20">
            <div className="editor-shell-section-surface relative flex flex-1 flex-col overflow-hidden">
              <GuestEditorReadOnly
                guestMode={guestMode}
                className="flex-1 overflow-hidden"
                contentClassName="flex flex-col overflow-hidden"
              >
                <ActiveComponent />
              </GuestEditorReadOnly>
            </div>
          </div>
        </div>
      </div>

      {/* Update notification dialog — shown after saving a published world */}
      {showUpdateNotify && serverWorldId && (
        <UpdateNotifyDialog
          worldId={serverWorldId}
          worldName={worldDraft.name || "Untitled World"}
          held={!!pendingEdit}
          onClose={() => setShowUpdateNotify(false)}
        />
      )}

      {/* Version history dialog */}
      <Suspense fallback={null}>
        {showVersionHistory && serverWorldId && (
          <VersionHistoryDialog
            worldId={serverWorldId}
            onClose={() => setShowVersionHistory(false)}
          />
        )}
      </Suspense>

      {/* Publish-to-Discover modal — preselects this world so the creator
          lands on the metadata sections immediately. */}
      <Suspense fallback={null}>
        {showPublishModal && serverWorldId && (
          <WorldPublishModal
            initialWorldId={serverWorldId}
            onClose={() => setShowPublishModal(false)}
            onPublished={() => {
              useEditorStore.setState({ worldIsPublished: true });
            }}
          />
        )}
      </Suspense>

      {/* First-visit guided tour (Mushie) */}
      <Suspense fallback={null}>
        {tourActive && <EditorTour onClose={() => setShowTour(false)} />}
      </Suspense>
    </div>
  );
}
