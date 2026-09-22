import { useStoryNavigation } from "@/hooks/use-story-navigation";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Save,
  Loader2,
  Plus,
  Trash2,
  ArrowLeft,
  Play,
  Pause,
  MessageCircle,
  FileText,
  User,
  Wand2,
  MoreVertical,
  Upload,
  Download,
  GraduationCap,
  Camera,
  X,
  ImageIcon,
  Globe,
  History,
  Users,
  Sparkles,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Compass,
  Maximize2,
  Music,
  Layers,
  Box,
  BookOpen,
  FileCode,
  Lock,
  AlertCircle,
  Check,
} from "lucide-react";
import { feedback } from "@/lib/feedback";
import { FieldError } from "@/components/ui/field-error";
import { useTransientFlag } from "@/hooks/use-transient-flag";
import { useRouter } from "@tanstack/react-router";
import { useAuthGuard } from "@/hooks/use-auth-guard";
import { cn } from "@/lib/utils";
import { DOCS_URLS } from "@/lib/docs-urls";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEditorStore } from "@/stores/editor";
import { MAX_WORLD_DESCRIPTION } from "@yumina/shared";
import type { WorldEntry } from "@yumina/engine";
import { useUiStore } from "@/stores/ui";
import {
  getAssetUploadErrorMessage,
  uploadAssetWithPresignedUrl,
} from "@/lib/asset-upload";

import { BundleCreator, BundleImporter, ImportBundleModal, WorldPublishModal } from "@/edition/slots";
import { getEditionInfo, useEdition } from "@/edition/edition";
import { ExportCardMenu } from "./export-card-menu";
import { UpdateNotifyDialog } from "./update-notify-dialog";
import { ReviewStateControl } from "./review-state-control";
import { GuestEditorReadOnly } from "./components/guest-editor-readonly";
import { BundlesSection } from "@/edition/slots";
import { AssetPicker } from "./asset-picker";
import { EntryPortraitField } from "./components/entry-portrait-field";
import { resolveAssetUrl } from "@/lib/asset-url";
import { useTemplateContentPlaceholder } from "./template-placeholders";
import {
  GENDER_VALUES,
  type GenderValue,
  getGenderFromContent,
  setGenderInContent,
} from "./lib/gender-line";
import { TwoTapDeleteButton } from "@/components/ui/two-tap-delete-button";
import {
  classifyFiles,
  setUserRoot,
  uninstallBundle,
  migrateLegacySimpleCss,
  bundleDisplayName,
  USER_ROOT_PATH,
  DEFAULT_USER_ROOT_TSX,
  recomposeIndex,
} from "./visual-layer-helpers";
import { importWithChunkRecovery } from "@/lib/stale-chunk-reload";
const VersionHistoryDialog = lazy(() =>
  importWithChunkRecovery(() => import("./version-history-dialog")).then((m) => ({
    default: m.VersionHistoryDialog,
  }))
);
import type { YuminaBundle } from "@yumina/engine";

const apiBase = import.meta.env.VITE_API_URL || "";

/* ─── Editor mode persistence ─── */

const EDITOR_MODE_KEY = "yumina-editor-mode";

export function saveEditorMode(worldId: string, mode: "simple" | "advanced") {
  try {
    const data = JSON.parse(localStorage.getItem(EDITOR_MODE_KEY) || "{}");
    data[worldId] = mode;
    localStorage.setItem(EDITOR_MODE_KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

export function getEditorMode(worldId: string): "simple" | "advanced" | null {
  try {
    const data = JSON.parse(localStorage.getItem(EDITOR_MODE_KEY) || "{}");
    return data[worldId] ?? null;
  } catch {
    return null;
  }
}

const GLOBAL_MODE_KEY = "yumina-editor-mode-global";

export function getGlobalEditorMode(): "simple" | "advanced" | null {
  try {
    const val = localStorage.getItem(GLOBAL_MODE_KEY);
    return val === "simple" || val === "advanced" ? val : null;
  } catch {
    return null;
  }
}

export function saveGlobalEditorMode(mode: "simple" | "advanced") {
  try {
    localStorage.setItem(GLOBAL_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

/* ─── Tag conventions ─── */

const TAG_WORLDVIEW = "chat:worldview";
const TAG_DIALOGUE_STYLE = "chat:dialogue-style";
const CHAT_TAGGED = [TAG_WORLDVIEW, TAG_DIALOGUE_STYLE];

function hasTag(tags: string[] | undefined, tag: string): boolean {
  return Array.isArray(tags) && tags.includes(tag);
}

function findTaggedEntry(entries: WorldEntry[], tag: string): WorldEntry | undefined {
  return entries.find((e) => !e.presetId && hasTag(e.tags, tag));
}

/* ─── Gender: stored as a "<Label>: <Value>" line at the top of the character
 * entry's content so the AI actually sees it (the PromptBuilder doesn't render
 * tags into the prompt). Written in the CARD's language — an English card gets
 * "Gender: Female", not "性别：女"; see lib/gender-line.ts for the format and
 * the legacy-Chinese parsing story. Group/ensemble ("群像") was dropped —
 * every character is added individually now. */

/* ─── Simple CSS storage ─── */
/* The simple editor exposes one CSS textarea. It's stored as a TSX file inside
 * rootComponent.files["_simple-css.tsx"], and the entry file is rewritten to
 * mount it. The marker comment is how we recognise "this entry was set up by
 * the simple editor" — when the user customises it in advanced mode and
 * removes the marker, we leave the entry alone and just write the CSS file. */

/* v1 CSS-injection helpers were removed in favour of the unified Visual
 * Layer card; legacy `_simple-css.tsx` files are auto-migrated to
 * `__user-root.tsx` on load (see migrateLegacySimpleCss in
 * visual-layer-helpers.ts). */

/* ─── Accent palette ─── */
type Accent = "cyan" | "fuchsia" | "amber" | "emerald" | "rose" | "violet";

const ACCENT_CLASSES: Record<
  Accent,
  { ring: string; iconBg: string; iconText: string; numberText: string; glow: string; focusRing: string }
> = {
  cyan: {
    ring: "hover:border-cyan-400/40 focus-within:border-cyan-400/60",
    iconBg: "bg-cyan-500/15",
    iconText: "text-cyan-300",
    numberText: "text-cyan-400/70",
    glow: "from-cyan-500/[0.04]",
    focusRing: "focus:ring-cyan-400/30",
  },
  fuchsia: {
    ring: "hover:border-fuchsia-400/40 focus-within:border-fuchsia-400/60",
    iconBg: "bg-fuchsia-500/15",
    iconText: "text-fuchsia-300",
    numberText: "text-fuchsia-400/70",
    glow: "from-fuchsia-500/[0.05]",
    focusRing: "focus:ring-fuchsia-400/30",
  },
  amber: {
    ring: "hover:border-amber-400/40 focus-within:border-amber-400/60",
    iconBg: "bg-amber-500/15",
    iconText: "text-amber-300",
    numberText: "text-amber-400/70",
    glow: "from-amber-500/[0.04]",
    focusRing: "focus:ring-amber-400/30",
  },
  emerald: {
    ring: "hover:border-emerald-400/40 focus-within:border-emerald-400/60",
    iconBg: "bg-emerald-500/15",
    iconText: "text-emerald-300",
    numberText: "text-emerald-400/70",
    glow: "from-emerald-500/[0.04]",
    focusRing: "focus:ring-emerald-400/30",
  },
  rose: {
    ring: "hover:border-rose-400/40 focus-within:border-rose-400/60",
    iconBg: "bg-rose-500/15",
    iconText: "text-rose-300",
    numberText: "text-rose-400/70",
    glow: "from-rose-500/[0.04]",
    focusRing: "focus:ring-rose-400/30",
  },
  violet: {
    ring: "hover:border-violet-400/40 focus-within:border-violet-400/60",
    iconBg: "bg-violet-500/15",
    iconText: "text-violet-300",
    numberText: "text-violet-400/70",
    glow: "from-violet-500/[0.05]",
    focusRing: "focus:ring-violet-400/30",
  },
};

/* ─── Responsive ─── */
function useIsMobileSimpleEditor() {
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

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   QuickCreateEditor
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

export function QuickCreateEditor({
  onOpenFullEditor,
  onBack,
}: {
  onOpenFullEditor: () => void;
  onBack: () => void;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string) => string };
  const router = useRouter();
  const navigateToStory = useStoryNavigation();
  const worldDraft = useEditorStore((s) => s.worldDraft);
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const saving = useEditorStore((s) => s.saving);
  const isDirty = useEditorStore((s) => s.isDirty);
  // R3: the Save button says "Saved" for a moment instead of a toast.
  const lastSavedAt = useEditorStore((s) => s.lastSavedAt);
  const justSaved = useTransientFlag(lastSavedAt);
  const setField = useEditorStore((s) => s.setField);
  const saveDraft = useEditorStore((s) => s.saveDraft);
  const pendingEdit = useEditorStore((s) => s.pendingEdit);
  const guestMode = useEditorStore((s) => s.guestMode);
  const { requireAuth } = useAuthGuard();
  const isMobileEditor = useIsMobileSimpleEditor();

  const [showBundleCreator, setShowBundleCreator] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [importingBundle, setImportingBundle] = useState<YuminaBundle | null>(null);
  const [showUpdateNotify, setShowUpdateNotify] = useState(false);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [showPublishModal, setShowPublishModal] = useState(false);
  const initRef = useRef(false);

  // Any owned variant (incl. a 副) can be published / submitted for review — a
  // draft variant must have a review path. (Was gated by tab position, which hid
  // the publish button for every non-first variant.)
  const { features } = useEdition();
  const canPublishHere = features.publishing;
  const bundlesEnabled = features.bundles;

  // Archetype: heuristic from entries. Toggle is exposed in the UI as a small switch.
  const derivedArchetype = useMemo<"chat" | "world">(() => {
    const charCount = worldDraft.entries.filter(
      (e) => !e.presetId && e.role === "character"
    ).length;
    return charCount >= 2 ? "world" : "chat";
  }, [worldDraft.entries]);

  const archetype: "chat" | "world" = derivedArchetype;

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    // Don't auto-create a greeting — the greeting card has its own empty state.
  }, []);

  const ensureServerWorldId = async (): Promise<string | null> => {
    let id = serverWorldId;
    if (!id) {
      await saveDraft();
      id = useEditorStore.getState().serverWorldId;
    }
    // saveDraft already fired its own failure pill with a Retry; a second pill
    // here only replaces it (one visible at a time) with vaguer copy.
    return id ?? null;
  };

  // Annotated so playFailed below can point Retry back at this handler.
  const handlePlayWorld: () => Promise<void> = async () => {
    if (guestMode) { requireAuth("create worlds"); return; }
    try {
      const id = await ensureServerWorldId();
      if (!id) return;
      if (useEditorStore.getState().isDirty) {
        // saveDraft reports its own failure — don't stack a second pill.
        if (!(await saveDraft())) return;
      }
      const listRes = await fetch(`${apiBase}/api/sessions`, { credentials: "include" });
      if (listRes.ok) {
        const { data: sessions } = await listRes.json();
        const existing = sessions.find((s: { id: string; worldId: string }) => s.worldId === id);
        if (existing) {
          useUiStore.getState().recordRecentPlayedWorld({
            id,
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
        body: JSON.stringify({ worldId: id }),
      });
      if (!res.ok) {
        playFailed();
        return;
      }
      const { data } = await res.json();
      useUiStore.getState().recordRecentPlayedWorld({
        id,
        name: worldDraft.name || "Untitled World",
        thumbnailUrl: null,
      });
      navigateToStory(data.id);
    } catch (err) {
      console.error(err);
      playFailed();
    }
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
      if (id) router.navigate({ to: "/app/studio/$worldId", params: { worldId: id } });
    } catch (err) {
      console.error(err);
      feedback.error(t("shell.failedEnterStudio"));
    }
  };

  const handleSave = async () => {
    if (guestMode) { requireAuth("create worlds"); return; }
    setField("editorMode", "simple");
    const success = await saveDraft();
    if (success) {
      const id = useEditorStore.getState().serverWorldId;
      if (id) saveEditorMode(id, "simple");
      // Only prompt "notify players" when the card is actually live —
      // worldIsPublished is optimistically true during pending_review.
      if (useEditorStore.getState().worldStatus === "published") {
        setShowUpdateNotify(true);
      }
    }
  };

  const handlePublishClick = async () => {
    if (guestMode) { requireAuth("publish worlds"); return; }
    try {
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

  // Versions need a saved world. The menu items below are disabled until then
  // and carry the reason in their tooltip, so a click can never fail.
  const handleOpenVersionHistory = () => setShowVersionHistory(true);

  const handleOpenBundleImport = () => {
    if (guestMode) { requireAuth("create worlds"); return; }
    setShowImportModal(true);
  };

  const handleOpenBundleCreator = () => {
    if (guestMode) { requireAuth("create worlds"); return; }
    setShowBundleCreator(true);
  };

  const handleSwitchToAdvanced = () => {
    const store = useEditorStore.getState();
    store.setField("editorMode", "advanced");
    const id = store.serverWorldId;
    if (id) saveEditorMode(id, "advanced");
    saveGlobalEditorMode("advanced");
    onOpenFullEditor();
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (useEditorStore.getState().guestMode) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === "z") {
        e.preventDefault();
        useEditorStore.getState().undo();
        return;
      }
      if (
        (e.ctrlKey || e.metaKey) &&
        (e.key === "y" || (e.shiftKey && (e.key === "z" || e.key === "Z")))
      ) {
        e.preventDefault();
        useEditorStore.getState().redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        const state = useEditorStore.getState();
        if (!state.saving) {
          state.setField("editorMode", "simple");
          state.saveDraft().then((ok) => {
            if (ok) {
              const wid = useEditorStore.getState().serverWorldId;
              if (wid) saveEditorMode(wid, "simple");
              if (useEditorStore.getState().worldStatus === "published") {
                setShowUpdateNotify(true);
              }
            }
          });
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  /* ━━━ Mobile layout ━━━ */
  if (isMobileEditor) {
    return (
      <div className="editor-shell-mobile flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <div className="shrink-0 border-b border-border bg-background/95 px-3 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)]">
          <div className="flex items-center gap-2">
            <button
              onClick={onBack}
              className="hover-surface inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground"
              aria-label={t("entries.back")}
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <input
              type="text"
              value={worldDraft.name}
              onChange={(e) => setField("name", e.target.value)}
              placeholder={t("quickCreate.namePlaceholder")}
              readOnly={guestMode}
              aria-readonly={guestMode}
              tabIndex={guestMode ? -1 : undefined}
              autoFocus={!guestMode && !worldDraft.name}
              className={cn(
                "min-w-0 flex-1 bg-transparent text-base font-semibold text-foreground placeholder:text-muted-foreground/35 focus:outline-none",
                guestMode && "cursor-not-allowed opacity-60",
              )}
            />
            <button
              onClick={handleSave}
              disabled={saving}
              title="Save (Ctrl+S)"
              className="relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-gold px-3 text-xs font-semibold text-black transition-opacity disabled:opacity-40"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : justSaved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
              {justSaved && !saving ? t("shell.saved") : t("shell.save")}
              {isDirty && !saving && (
                <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-background bg-amber-500" />
              )}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={handleEnterStudio}
              disabled={saving || (!serverWorldId && !worldDraft.name)}
              className="inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-xl bg-primary/10 px-2.5 text-xs font-semibold text-primary disabled:opacity-40"
            >
              <Wand2 className="h-3.5 w-3.5" /> {t("shell.enterStudio")}
            </button>
            {canPublishHere && (
              <ReviewStateControl
                onPublish={handlePublishClick}
                size="sm"
                disabled={saving || (!serverWorldId && !worldDraft.name)}
                className="h-9"
              />
            )}
            {!canPublishHere && (
              <ExportCardMenu worldId={serverWorldId} worldName={worldDraft.name} size="sm" disabled={saving} />
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="hover-surface inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground"
                  aria-label={t("shell.moreActions")}
                >
                  <MoreVertical className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onClick={handlePlayWorld} disabled={saving || (!serverWorldId && !worldDraft.name)}>
                  <Play className="mr-2 h-4 w-4" />
                  {t("shell.play")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={handleOpenVersionHistory}
                  disabled={!serverWorldId}
                  title={!serverWorldId ? t("versionHistory.needsServerSave") : undefined}
                >
                  <History className="mr-2 h-4 w-4" />
                  {t("versionHistory.menuItem")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {bundlesEnabled && (
                  <>
                    <DropdownMenuItem onClick={handleOpenBundleImport}>
                      <Download className="mr-2 h-4 w-4" />
                      {t("shell.importBundle")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleOpenBundleCreator}>
                      <Upload className="mr-2 h-4 w-4" />
                      {t("shell.exportBundle")}
                    </DropdownMenuItem>
                  </>
                )}
                <DropdownMenuItem onClick={() => window.open(DOCS_URLS.welcome, "_blank", "noopener,noreferrer")}>
                  <GraduationCap className="mr-2 h-4 w-4" />
                  {t("shell.creatorGuide")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleSwitchToAdvanced}>
                  {t("quickCreate.advancedMode")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <main className="min-h-0 flex-1 overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+0.75rem)]">
          <GuestEditorReadOnly guestMode={guestMode} className="min-h-full">
            <ScrollBody archetype={archetype} onOpenFullEditor={handleSwitchToAdvanced} />
          </GuestEditorReadOnly>
        </main>

        {mountedDialogs(
          showBundleCreator, setShowBundleCreator,
          showImportModal, setShowImportModal,
          importingBundle, setImportingBundle,
          showUpdateNotify, setShowUpdateNotify,
          showVersionHistory, setShowVersionHistory,
          showPublishModal, setShowPublishModal,
          serverWorldId, worldDraft.name, !!pendingEdit
        )}
      </div>
    );
  }

  /* ━━━ Desktop layout ━━━ */
  return (
    <div className="editor-shell-root flex h-full flex-col overflow-hidden">
      {/* Header */}
      <header className="editor-shell-header shrink-0 border-b border-border bg-background/80 px-3 py-3 backdrop-blur md:px-4">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="hover-surface rounded-lg p-1.5 text-muted-foreground">
            <ArrowLeft className="h-4 w-4" />
          </button>
          <input
            type="text"
            value={worldDraft.name}
            onChange={(e) => setField("name", e.target.value)}
            placeholder={t("quickCreate.namePlaceholder")}
            readOnly={guestMode}
            aria-readonly={guestMode}
            tabIndex={guestMode ? -1 : undefined}
            autoFocus={!guestMode && !worldDraft.name}
            className={cn(
              "min-w-0 flex-1 bg-transparent text-lg font-semibold text-foreground placeholder:text-muted-foreground/30 focus:outline-none",
              guestMode && "cursor-not-allowed opacity-60",
            )}
          />
          <div className="flex items-center gap-2">
            <div className="flex shrink-0 items-center rounded-lg border border-border bg-card p-0.5">
              <span
                aria-pressed="true"
                className="cursor-default select-none rounded-md bg-gold/15 px-3 py-1 text-xs font-semibold text-gold"
              >
                {t("quickCreate.simpleMode")}
              </span>
              <button
                onClick={handleSwitchToAdvanced}
                className="rounded-md px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                {t("quickCreate.advancedMode")}
              </button>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="hover-surface rounded-lg p-1.5 text-muted-foreground" title={t("shell.moreActions")}>
                  <MoreVertical className="h-4 w-4" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  onClick={handleOpenVersionHistory}
                  disabled={!serverWorldId}
                  title={!serverWorldId ? t("versionHistory.needsServerSave") : undefined}
                >
                  <History className="mr-2 h-4 w-4" />
                  {t("shell.versionHistoryMenu")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {bundlesEnabled && (
                  <>
                    <DropdownMenuItem onClick={handleOpenBundleImport}>
                      <Download className="mr-2 h-4 w-4" />
                      {t("shell.importBundle")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleOpenBundleCreator}>
                      <Upload className="mr-2 h-4 w-4" />
                      {t("shell.exportBundle")}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              onClick={handleEnterStudio}
              disabled={saving || (!serverWorldId && !worldDraft.name)}
              className="flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-sm font-medium text-primary transition-colors hover:bg-primary/20 disabled:opacity-40"
            >
              <Wand2 className="h-3.5 w-3.5" />
              {t("shell.enterStudio")}
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              title="Save (Ctrl+S)"
              className="relative flex items-center gap-2 rounded-lg bg-gold px-4 py-2 text-sm font-semibold text-black transition-opacity disabled:opacity-40"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : justSaved ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
              {justSaved && !saving ? t("shell.saved") : t("shell.save")}
              {isDirty && !saving && (
                <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-amber-500" />
              )}
            </button>
            {canPublishHere && (
              <ReviewStateControl onPublish={handlePublishClick} size="md" disabled={saving} />
            )}
            {!canPublishHere && (
              <ExportCardMenu worldId={serverWorldId} worldName={worldDraft.name} size="md" disabled={saving} />
            )}
          </div>
        </div>
      </header>

      {/* Body: scroll + right rail */}
      <div className="flex flex-1 overflow-hidden">
        <main
          className="flex-1 overflow-y-auto"
          style={{
            backgroundImage:
              "radial-gradient(1200px 600px at 50% -200px, rgba(167,139,250,0.06), transparent 60%), radial-gradient(800px 400px at 50% 100%, rgba(251,191,36,0.04), transparent 60%)",
          }}
        >
          <GuestEditorReadOnly guestMode={guestMode} className="min-h-full">
            <ScrollBody archetype={archetype} onOpenFullEditor={handleSwitchToAdvanced} />
          </GuestEditorReadOnly>
        </main>
        <aside className="hidden w-[220px] shrink-0 flex-col border-l border-border bg-background/40 lg:flex">
          <div className="flex-1 p-4">
            <div className="mb-3 text-[10px] font-bold uppercase tracking-[0.12em] text-muted-foreground/50">
              {t("simple.nav.jumpTo")}
            </div>
            <JumpAnchor n="1" label={t("simple.nav.cover")} accent="cyan" />
            <JumpAnchor n="2" label={t("simple.nav.character")} accent="fuchsia" />
            {archetype === "chat" && (
              <>
                <JumpAnchor n="3" label={t("simple.nav.worldview")} accent="cyan" />
                <JumpAnchor n="4" label={t("simple.nav.dialogueStyle")} accent="violet" />
              </>
            )}
            <JumpAnchor n={archetype === "chat" ? "5" : "3"} label={t("simple.nav.settings")} accent="amber" />
            <JumpAnchor n={archetype === "chat" ? "6" : "4"} label={t("simple.nav.greeting")} accent="emerald" />
            <JumpAnchor n={archetype === "chat" ? "7" : "5"} label={t("simple.nav.description")} accent="rose" />
          </div>
          <div className="border-t border-border p-4">
            <a
              href={DOCS_URLS.welcome}
              target="_blank"
              rel="noopener noreferrer"
              className="mb-3 flex items-center justify-center gap-2 rounded-lg border border-border bg-card py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <GraduationCap className="h-3.5 w-3.5" />
              {t("shell.creatorGuide")}
            </a>
            <button
              onClick={handlePlayWorld}
              disabled={saving || (!serverWorldId && !worldDraft.name)}
              className="group relative flex w-full items-center justify-center gap-3 overflow-hidden rounded-2xl bg-gold py-4 text-lg font-black text-black shadow-[0_0_20px_rgba(201,162,94,0.3)] transition-all hover:-translate-y-0.5 hover:shadow-[0_0_30px_rgba(201,162,94,0.4)] disabled:opacity-40"
            >
              <div className="absolute inset-0 translate-x-[-100%] bg-gradient-to-r from-transparent via-white/20 to-transparent transition-transform duration-700 ease-in-out group-hover:translate-x-[100%]" />
              <Play className="relative z-10 h-5 w-5 fill-current" />
              <span className="relative z-10 tracking-widest">{t("shell.play")}</span>
            </button>
          </div>
        </aside>
      </div>

      {mountedDialogs(
        showBundleCreator, setShowBundleCreator,
        showImportModal, setShowImportModal,
        importingBundle, setImportingBundle,
        showUpdateNotify, setShowUpdateNotify,
        showVersionHistory, setShowVersionHistory,
        showPublishModal, setShowPublishModal,
        serverWorldId, worldDraft.name, !!pendingEdit
      )}
    </div>
  );
}

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   ScrollBody — the single-page form, shared between mobile + desktop
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

function ScrollBody({ archetype, onOpenFullEditor }: { archetype: "chat" | "world"; onOpenFullEditor: () => void }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string) => string };
  const isChat = archetype === "chat";
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 md:px-6 md:py-10">
      <ArchetypeLabel archetype={archetype} />

      <CoverSection />
      <CharactersSection />
      {isChat && <WorldviewSection />}
      {isChat && <DialogueStyleSection />}
      <SettingsSection archetype={archetype} />
      <GreetingSection archetype={archetype} />
      <DescriptionSection archetype={archetype} />
      <AdvancedPromoCard onOpenFullEditor={onOpenFullEditor} />
      <MoreDisclosure onOpenFullEditor={onOpenFullEditor} />

      <div className="pt-2 pb-12 text-center text-xs text-muted-foreground/50">{t("simple.endMarker")}</div>
    </div>
  );
}

/* ─── Archetype label (passive — no toggle) ─── */
function ArchetypeLabel({ archetype }: { archetype: "chat" | "world" }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string) => string };
  const Icon = archetype === "chat" ? MessageCircle : Users;
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border/60 bg-card/30 px-4 py-2 text-xs text-muted-foreground">
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="truncate">
        {archetype === "chat" ? t("simple.archetype.chat") : t("simple.archetype.world")}
      </span>
    </div>
  );
}

/* ─── Cover ─── */
function CoverSection() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string) => string };
  const worldDraft = useEditorStore((s) => s.worldDraft);
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const saveDraft = useEditorStore((s) => s.saveDraft);
  const setField = useEditorStore((s) => s.setField);
  const guestMode = useEditorStore((s) => s.guestMode);
  const { requireAuth } = useAuthGuard();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const ensureWorldId = async (): Promise<string | null> => {
    let id = serverWorldId;
    if (!id) {
      await saveDraft();
      id = useEditorStore.getState().serverWorldId;
    }
    if (!id) {
      setError(t("simple.needWorldName"));
      return null;
    }
    return id;
  };

  const handleUpload = async (file: File) => {
    if (guestMode) { requireAuth("create worlds"); return; }
    setUploading(true);
    setError(null);
    try {
      const id = await ensureWorldId();
      if (!id) return;
      const data = await uploadAssetWithPresignedUrl<{ thumbnailUrl: string }>({
        file,
        preferredType: "image",
        prepareUrl: `${apiBase}/api/worlds/${id}/thumbnail`,
        registerUrl: `${apiBase}/api/worlds/${id}/thumbnail/confirm`,
        registerBody: ({ key }) => ({ key }),
      });
      // The thumbnail swaps in place — nothing to announce.
      setField("avatar", data.thumbnailUrl);
    } catch (err) {
      setError(getAssetUploadErrorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  return (
    <Card n={1} icon={Camera} title={t("simple.cover.title")} hint={t("simple.cover.hint")} accent="cyan" optional>
      <div className="flex items-center gap-5">
        <button
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="group relative flex h-32 w-32 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-cyan-400/40"
        >
          {worldDraft.avatar ? (
            <img src={worldDraft.avatar} alt="" className="h-full w-full object-cover" />
          ) : (
            <ImageIcon className="h-8 w-8 text-muted-foreground/30 transition-transform group-hover:scale-110" />
          )}
          {uploading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50">
              <Loader2 className="h-6 w-6 animate-spin text-white" />
            </div>
          )}
          <div className="touch-reveal pointer-events-none absolute inset-0 flex items-end justify-center bg-gradient-to-t from-black/60 to-transparent pb-2 opacity-0 transition-opacity group-hover:opacity-100">
            <span className="text-[10px] font-semibold text-white">{t("simple.cover.clickToUpload")}</span>
          </div>
        </button>
        <div className="flex-1 space-y-2">
          <p
            className="text-xs leading-relaxed text-muted-foreground [&_strong]:font-semibold [&_strong]:text-foreground"
            dangerouslySetInnerHTML={{ __html: t("simple.cover.aspectHint") }}
          />
          <button
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:border-cyan-400/40 hover:bg-cyan-500/5 disabled:opacity-40"
          >
            <Camera className="h-3.5 w-3.5" />
            {worldDraft.avatar ? t("simple.cover.replace") : t("simple.cover.upload")}
          </button>
          <FieldError id="simple-cover-error" message={error} />
        </div>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleUpload(f);
          e.target.value = "";
        }}
      />
    </Card>
  );
}

/* ─── Character helpers ─── */

function findCharacterEntries(entries: WorldEntry[]) {
  return entries
    .filter((e) => !e.presetId && e.role === "character")
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

function useEnsureCharacter() {
  const addEntry = useEditorStore((s) => s.addEntry);
  const updateEntry = useEditorStore((s) => s.updateEntry);
  return useCallback(() => {
    addEntry("character", "system-presets");
    const entries = useEditorStore.getState().worldDraft.entries;
    const created = entries[entries.length - 1];
    if (created) {
      updateEntry(created.id, {
        name: "",
        role: "character",
        alwaysSend: true,
        enabled: true,
        tags: ["Character"],
      });
    }
    return created;
  }, [addEntry, updateEntry]);
}

/* ─── Characters section: unified list view (chat + world) ─── */
function CharactersSection() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string, opts?: Record<string, unknown>) => string };
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const removeEntry = useEditorStore((s) => s.removeEntry);
  const ensureChar = useEnsureCharacter();
  const characters = useMemo(() => findCharacterEntries(entries), [entries]);

  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (characters.length > 0 && openIds.size === 0) {
      setOpenIds(new Set([characters[0]!.id]));
    }
  }, [characters, openIds.size]);

  const toggleOpen = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleAdd = () => {
    const created = ensureChar();
    if (created) setOpenIds(new Set([created.id]));
  };

  const isEmpty = characters.length === 0;
  const isSingle = characters.length === 1;

  return (
    <Card
      n={2}
      icon={isSingle ? User : Users}
      title={t("simple.character.title")}
      hint={
        isEmpty
          ? t("simple.character.hintEmpty")
          : isSingle
          ? t("simple.character.hintSingle")
          : t("simple.character.hintMulti")
      }
      accent="fuchsia"
    >
      <div className="space-y-3">
        {characters.map((c, idx) => {
          const open = openIds.has(c.id);
          return (
            <div key={c.id} className="overflow-hidden rounded-xl border border-border bg-background/40">
              <button
                onClick={() => toggleOpen(c.id)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/30"
              >
                <GripVertical className="h-3.5 w-3.5 text-muted-foreground/30" />
                <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-fuchsia-500/15 text-xs font-bold text-fuchsia-300">
                  {idx + 1}
                </div>
                <span className="flex-1 truncate text-sm font-semibold">
                  {c.name || (
                    <span className="text-muted-foreground/50">
                      {t("simple.character.unnamed", { n: idx + 1 })}
                    </span>
                  )}
                </span>
                {c.alwaysSend === false && c.keywords && c.keywords.length > 0 && (
                  <span className="rounded bg-muted/30 px-1.5 py-0.5 text-[9px] font-semibold text-muted-foreground">
                    {t("simple.badge.keywordTriggered")}
                  </span>
                )}
                <ChevronDown
                  className={cn(
                    "h-4 w-4 text-muted-foreground transition-transform",
                    open && "rotate-180"
                  )}
                />
              </button>
              {open && (
                <div className="border-t border-border/60 p-4">
                  <CharacterForm
                    entryId={c.id}
                    showDelete={characters.length > 0}
                    onDelete={() => removeEntry(c.id)}
                  />
                </div>
              )}
            </div>
          );
        })}
        {isEmpty && (
          <p className="rounded-xl border border-dashed border-border bg-card/30 px-4 py-6 text-center text-xs text-muted-foreground">
            {t("simple.character.emptyHint")}
          </p>
        )}
        <button
          onClick={handleAdd}
          className="group flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/30 py-3 text-xs font-semibold text-muted-foreground transition-all hover:border-fuchsia-400/40 hover:bg-fuchsia-500/[0.04] hover:text-fuchsia-300"
        >
          <Plus className="h-3.5 w-3.5 transition-transform group-hover:rotate-90" />
          {t("simple.character.add")}
        </button>
      </div>
    </Card>
  );
}

/* ─── Character form (bound to a real entry) ─── */
function CharacterForm({
  entryId,
  showDelete,
  onDelete,
}: {
  entryId: string;
  showDelete?: boolean;
  onDelete?: () => void;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t, i18n } = useTranslation("editor") as unknown as {
    t: (key: string) => string;
    i18n: { language: string };
  };
  const entry = useEditorStore((s) =>
    s.worldDraft.entries.find((e) => e.id === entryId)
  );
  const updateEntry = useEditorStore((s) => s.updateEntry);
  // The gender line is written INTO the card's content, so it follows the
  // card's language (UI locale only as a fallback for unsaved drafts).
  const cardLanguage = useEditorStore((s) => s.language);

  const placeholder = useTemplateContentPlaceholder(entry ?? { tags: undefined });
  if (!entry) return null;
  const gender = getGenderFromContent(entry.content);

  const genderLabels: Record<GenderValue, string> = {
    female: t("simple.character.genderFemale"),
    male: t("simple.character.genderMale"),
    other: t("simple.character.genderOther"),
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <EntryPortraitField
          variant="avatar"
          value={entry.portrait}
          onChange={(portrait) => updateEntry(entryId, { portrait })}
        />
        <div className="flex-1">
          <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            {t("simple.character.name")}
          </label>
          <input
            type="text"
            value={entry.name}
            onChange={(e) => updateEntry(entryId, { name: e.target.value })}
            placeholder={t("simple.character.namePlaceholder")}
            className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-fuchsia-400/30"
          />
        </div>
        {showDelete && (
          <TwoTapDeleteButton
            onConfirm={() => onDelete?.()}
            className="shrink-0 rounded-lg p-2 text-muted-foreground/30 transition-colors hover:bg-destructive/10 hover:text-destructive"
            title={t("simple.character.delete")}
            armedTitle={t("twoTapConfirm")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </TwoTapDeleteButton>
        )}
      </div>

      <div>
        <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          {t("simple.character.gender")}
        </label>
        <div className="flex flex-wrap gap-2">
          {GENDER_VALUES.map((g) => (
            <button
              key={g}
              onClick={() =>
                updateEntry(entryId, {
                  content: setGenderInContent(entry.content, gender === g ? null : g, cardLanguage, i18n.language),
                })
              }
              className={cn(
                "rounded-lg border px-3 py-1.5 text-xs font-semibold transition-all",
                gender === g
                  ? "border-fuchsia-400/60 bg-fuchsia-500/15 text-fuchsia-200 shadow-[0_0_0_1px_rgba(232,121,249,0.2)]"
                  : "border-border bg-card text-muted-foreground hover:border-fuchsia-400/30 hover:text-foreground"
              )}
            >
              {genderLabels[g]}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
          {t("simple.character.persona")}
        </label>
        <textarea
          value={entry.content}
          onChange={(e) => updateEntry(entryId, { content: e.target.value })}
          rows={8}
          placeholder={placeholder || t("simple.character.personaFallback")}
          className="w-full resize-none rounded-xl border border-border bg-background/60 px-4 py-3 text-sm leading-relaxed placeholder:whitespace-pre-line placeholder:text-muted-foreground/35 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-fuchsia-400/30"
        />
      </div>
    </div>
  );
}

/* ─── Tagged single-textarea section (used by Worldview + DialogueStyle) ─── */
function TaggedSingleSection({
  tag,
  defaultName,
  role,
  n,
  icon,
  title,
  hint,
  accent,
  placeholder,
  rows = 8,
}: {
  tag: string;
  defaultName: string;
  role: "system" | "scenario" | "style" | "lore";
  n: number;
  icon: typeof FileText;
  title: string;
  hint?: string;
  accent: Accent;
  placeholder: string;
  rows?: number;
}) {
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const addEntry = useEditorStore((s) => s.addEntry);
  const updateEntry = useEditorStore((s) => s.updateEntry);

  const existing = useMemo(() => findTaggedEntry(entries, tag), [entries, tag]);
  const templatePlaceholder = useTemplateContentPlaceholder(existing ?? { tags: undefined });

  const handleChange = useCallback(
    (value: string) => {
      let id = findTaggedEntry(useEditorStore.getState().worldDraft.entries, tag)?.id;
      if (!id) {
        addEntry(role as "system", "system-presets");
        const all = useEditorStore.getState().worldDraft.entries;
        const created = all[all.length - 1];
        if (!created) return;
        id = created.id;
        updateEntry(id, {
          name: defaultName,
          role,
          alwaysSend: true,
          enabled: true,
          tags: [tag],
        });
      }
      updateEntry(id, { content: value, enabled: value.trim().length > 0 });
    },
    [tag, defaultName, role, addEntry, updateEntry]
  );

  const value = existing?.content ?? "";
  const focusRing = ACCENT_CLASSES[accent].focusRing;
  const effectivePlaceholder = templatePlaceholder || placeholder;

  return (
    <Card n={n} icon={icon} title={title} hint={hint} accent={accent} optional>
      <textarea
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        rows={rows}
        placeholder={effectivePlaceholder}
        className={cn(
          "w-full resize-y rounded-xl border border-border bg-background/60 px-4 py-3 text-sm leading-relaxed placeholder:whitespace-pre-line placeholder:text-muted-foreground/35 focus:border-transparent focus:outline-none focus:ring-2",
          focusRing
        )}
      />
    </Card>
  );
}

function WorldviewSection() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string) => string };
  return (
    <TaggedSingleSection
      tag={TAG_WORLDVIEW}
      defaultName={t("simple.worldview.defaultName")}
      role="scenario"
      n={3}
      icon={Globe}
      title={t("simple.worldview.title")}
      hint={t("simple.worldview.hint")}
      accent="cyan"
      rows={7}
      placeholder={t("simple.worldview.fallback")}
    />
  );
}

function DialogueStyleSection() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string) => string };
  return (
    <TaggedSingleSection
      tag={TAG_DIALOGUE_STYLE}
      defaultName={t("simple.dialogueStyle.defaultName")}
      role="style"
      n={4}
      icon={Sparkles}
      title={t("simple.dialogueStyle.title")}
      hint={t("simple.dialogueStyle.hint")}
      accent="violet"
      rows={9}
      placeholder={t("simple.dialogueStyle.fallback")}
    />
  );
}

/* ─── Settings section: list view of all non-greeting, non-character entries.
 *
 * This is what unifies simple ↔ advanced: instead of "the editor only reads a
 * single simple:story tag", we list every entry that isn't a greeting or a
 * character so creators see — and can edit — the same data both sides do.
 * World-simulation template seeds 8 such entries (核心设定/历史/势力/etc.);
 * they all show up here as collapsible cards. */
function SettingsSection({ archetype }: { archetype: "chat" | "world" }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string) => string };
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const addEntry = useEditorStore((s) => s.addEntry);
  const updateEntry = useEditorStore((s) => s.updateEntry);
  const removeEntry = useEditorStore((s) => s.removeEntry);

  const settingEntries = useMemo(
    () =>
      entries
        .filter(
          (e) =>
            !e.presetId &&
            e.role !== "greeting" &&
            e.role !== "character" &&
            e.section !== "examples" &&
            // In chat archetype, hide entries already surfaced as dedicated
            // sections (Worldview / DialogueStyle) so the Settings card only
            // shows the truly miscellaneous ones.
            !CHAT_TAGGED.some((tag) => hasTag(e.tags, tag))
        )
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    [entries]
  );

  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());

  // Auto-open the first entry on mount so users see content immediately,
  // not a stack of collapsed bars.
  useEffect(() => {
    if (settingEntries.length > 0 && openIds.size === 0) {
      setOpenIds(new Set([settingEntries[0]!.id]));
    }
  }, [settingEntries, openIds.size]);

  const toggleOpen = (id: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const handleAdd = () => {
    addEntry("system", "system-presets");
    const all = useEditorStore.getState().worldDraft.entries;
    const created = all[all.length - 1];
    if (created) {
      updateEntry(created.id, {
        name: t("simple.settings.newName"),
        role: "system",
        alwaysSend: true,
        enabled: true,
      });
      setOpenIds(new Set([created.id]));
    }
  };

  const isEmpty = settingEntries.length === 0;
  const isChat = archetype === "chat";
  const cardNumber = isChat ? 5 : 3;

  return (
    <Card
      n={cardNumber}
      icon={Sparkles}
      title={t("simple.settings.title")}
      hint={isChat ? t("simple.settings.hintChat") : t("simple.settings.hintWorld")}
      accent="amber"
      optional={isChat}
    >
      <div className="space-y-3">
        {settingEntries.map((entry, idx) => (
          <SettingEntryCard
            key={entry.id}
            entry={entry}
            idx={idx}
            open={openIds.has(entry.id)}
            onToggle={() => toggleOpen(entry.id)}
            onUpdate={(updates) => updateEntry(entry.id, updates)}
            onRemove={() => removeEntry(entry.id)}
          />
        ))}
        {isEmpty && (
          <p className="rounded-xl border border-dashed border-border bg-card/30 px-4 py-6 text-center text-xs text-muted-foreground">
            {t("simple.settings.emptyHint")}
          </p>
        )}
        <button
          onClick={handleAdd}
          className="group flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/30 py-3 text-xs font-semibold text-muted-foreground transition-all hover:border-amber-400/40 hover:bg-amber-500/[0.04] hover:text-amber-300"
        >
          <Plus className="h-3.5 w-3.5 transition-transform group-hover:rotate-90" />
          {t("simple.settings.add")}
        </button>
      </div>
    </Card>
  );
}

/* ─── Greeting section: numbered tabs, one per opening.
 *
 * The runtime has always supported multiple openings (PromptBuilder emits one
 * swipe per enabled greeting entry, each carrying its own initialVariables and
 * activeGreetingId, and worldbooks can activate on a specific greeting id) —
 * only this simple-mode card was single-greeting, which forced creators with
 * branching routes into advanced mode. Tabs here write the exact same
 * role="greeting" entries the advanced First Message section edits, so the two
 * views stay interchangeable. Reorder matters: greeting #1 is the one players
 * land on before they swipe. ─── */
function GreetingSection({ archetype }: { archetype: "chat" | "world" }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string, opts?: Record<string, unknown>) => string };
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const addEntry = useEditorStore((s) => s.addEntry);
  const updateEntry = useEditorStore((s) => s.updateEntry);
  const removeEntry = useEditorStore((s) => s.removeEntry);
  const reorderEntries = useEditorStore((s) => s.reorderEntries);

  const greetings = useMemo(
    () =>
      entries
        .filter((e) => e.role === "greeting")
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    [entries]
  );

  const [activeIndex, setActiveIndex] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Greetings can vanish under us (delete, variant switch, import) — never
  // index past the end.
  const clampedIndex = greetings.length === 0 ? 0 : Math.min(activeIndex, greetings.length - 1);
  const active = greetings[clampedIndex];

  /** Append a greeting entry, returning its id. Shared by "+" and first-type. */
  const createGreeting = useCallback((): string | undefined => {
    addEntry("greeting", "system-presets");
    const all = useEditorStore.getState().worldDraft.entries;
    const created = all[all.length - 1];
    if (!created) return undefined;
    const count = all.filter((e) => e.role === "greeting").length;
    updateEntry(created.id, {
      name: `Greeting ${count}`,
      role: "greeting",
      apiRole: "assistant",
      alwaysSend: true,
      enabled: true,
      tags: ["First Message"],
    });
    return created.id;
  }, [addEntry, updateEntry]);

  const handleChange = useCallback(
    (value: string) => {
      const id = active?.id ?? createGreeting();
      if (!id) return;
      updateEntry(id, { content: value });
    },
    [active?.id, createGreeting, updateEntry]
  );

  function handleAdd() {
    if (!createGreeting()) return;
    // greetings.length is pre-add, which equals the new entry's index.
    setActiveIndex(greetings.length);
    setConfirmDelete(false);
  }

  function handleDelete() {
    if (!active) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    removeEntry(active.id);
    setConfirmDelete(false);
    if (clampedIndex >= greetings.length - 1) setActiveIndex(Math.max(0, clampedIndex - 1));
  }

  /** Move the active opening one slot left/right. Order decides which one
   *  players see first, so simple mode needs it too — no drag, just arrows. */
  function move(delta: number) {
    const to = clampedIndex + delta;
    if (!active || to < 0 || to >= greetings.length) return;
    const ids = greetings.map((g) => g.id);
    const [moved] = ids.splice(clampedIndex, 1);
    ids.splice(to, 0, moved!);
    reorderEntries(ids);
    setActiveIndex(to);
    setConfirmDelete(false);
  }

  const isChat = archetype === "chat";
  const placeholder = isChat
    ? t("simple.greeting.placeholderChat")
    : t("simple.greeting.placeholderWorld");

  const cardNumber = isChat ? 6 : 4;
  // With zero greetings we still render tab "1" — typing into the textarea
  // materialises it, matching the card's original empty state.
  const tabCount = Math.max(1, greetings.length);
  const multi = greetings.length > 1;

  return (
    <Card
      n={cardNumber}
      icon={MessageCircle}
      title={t("simple.greeting.title")}
      hint={t("simple.greeting.hint")}
      accent="emerald"
    >
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {Array.from({ length: tabCount }, (_, i) => (
          <button
            key={greetings[i]?.id ?? "placeholder"}
            onClick={() => {
              setActiveIndex(i);
              setConfirmDelete(false);
            }}
            className={cn(
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-all",
              i === clampedIndex
                ? "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-400/30"
                : "bg-card/40 text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            {t("simple.greeting.tab", { n: i + 1 })}
            {i === 0 && multi && (
              <span className="rounded bg-emerald-500/15 px-1 py-px text-[9px] font-semibold uppercase tracking-wider text-emerald-300/80">
                {t("simple.greeting.defaultBadge")}
              </span>
            )}
          </button>
        ))}
        <button
          onClick={handleAdd}
          className="group flex items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-all hover:border-emerald-400/40 hover:bg-emerald-500/[0.04] hover:text-emerald-300"
        >
          <Plus className="h-3.5 w-3.5 transition-transform group-hover:rotate-90" />
          {t("simple.greeting.add")}
        </button>
      </div>

      <textarea
        value={active?.content ?? ""}
        onChange={(e) => handleChange(e.target.value)}
        rows={9}
        placeholder={placeholder}
        className={cn(
          "w-full resize-y rounded-xl border border-border bg-background/60 px-4 py-3 font-mono text-sm leading-relaxed placeholder:whitespace-pre-line placeholder:text-muted-foreground/35 focus:border-transparent focus:outline-none focus:ring-2",
          ACCENT_CLASSES.emerald.focusRing
        )}
      />
      <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground/70">
        <span className="flex items-center gap-1.5">
          <code className="rounded bg-accent px-1.5 py-0.5 font-mono text-foreground">{"{{user}}"}</code>
          {t("simple.greeting.macroUser")}
        </span>
        <span className="flex items-center gap-1.5">
          <code className="rounded bg-accent px-1.5 py-0.5 font-mono text-foreground">{"{{char}}"}</code>
          {t("simple.greeting.macroChar")}
        </span>
        <span className="ml-auto rounded-md bg-emerald-500/10 px-2 py-0.5 text-emerald-300">
          {t("simple.greeting.lengthHint")}
        </span>
      </div>

      {multi && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            onClick={() => move(-1)}
            disabled={clampedIndex === 0}
            title={t("simple.greeting.moveUp")}
            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            {t("simple.greeting.moveUp")}
          </button>
          <button
            onClick={() => move(1)}
            disabled={clampedIndex === greetings.length - 1}
            title={t("simple.greeting.moveDown")}
            className="flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
          >
            {t("simple.greeting.moveDown")}
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={handleDelete}
            onBlur={() => setConfirmDelete(false)}
            className={cn(
              "ml-auto flex items-center gap-1 rounded-lg border px-2 py-1 text-[11px] font-semibold transition-colors",
              confirmDelete
                ? "border-red-400/40 bg-red-500/10 text-red-300"
                : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            <Trash2 className="h-3.5 w-3.5" />
            {confirmDelete
              ? t("simple.greeting.deleteConfirm")
              : t("simple.greeting.delete", { n: clampedIndex + 1 })}
          </button>
        </div>
      )}

      {multi && (
        <p className="mt-3 rounded-lg border border-dashed border-border bg-card/30 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          {t("simple.greeting.multiHint")}
          <br />
          {t("simple.greeting.advancedHint")}
        </p>
      )}
    </Card>
  );
}

/* ─── Description ─── */
function DescriptionSection({ archetype }: { archetype: "chat" | "world" }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string, opts?: Record<string, unknown>) => string };
  const description = useEditorStore((s) => s.worldDraft.description);
  const setField = useEditorStore((s) => s.setField);
  const isChat = archetype === "chat";
  const cardNumber = isChat ? 7 : 5;

  return (
    <Card
      n={cardNumber}
      icon={FileText}
      title={t("simple.description.title")}
      hint={t("simple.description.hint")}
      accent="rose"
      optional
    >
      <textarea
        value={description ?? ""}
        onChange={(e) => setField("description", e.target.value)}
        rows={4}
        // Was hard-capped at 200 here while the API/DB accept
        // MAX_WORLD_DESCRIPTION — simple mode was the only thing enforcing it.
        maxLength={MAX_WORLD_DESCRIPTION}
        placeholder={
          isChat
            ? t("simple.description.placeholderChat")
            : t("simple.description.placeholderWorld")
        }
        className={cn(
          "w-full resize-none rounded-xl border border-border bg-background/60 px-4 py-3 text-sm leading-relaxed placeholder:text-muted-foreground/35 focus:border-transparent focus:outline-none focus:ring-2",
          ACCENT_CLASSES.rose.focusRing
        )}
      />
      <p className="mt-2 text-xs text-muted-foreground/60">
        {t("simple.description.markdownSupported", {
          count: (description ?? "").length,
          max: MAX_WORLD_DESCRIPTION,
        })}
      </p>
    </Card>
  );
}

/* ─── Advanced-mode promo: the simple editor covers the basics; this card
 * sells what the full toolkit unlocks (variables like 好感度/恐惧, behaviors,
 * per-opening lorebooks, custom UI) plus the Studio AI assistant that can
 * write or polish the whole card. Placed after the content cards so it reads
 * as "done with the basics? here's the next level", not as a detour. ─── */
function AdvancedPromoCard({ onOpenFullEditor }: { onOpenFullEditor: () => void }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string) => string };
  const router = useRouter();
  const guestMode = useEditorStore((s) => s.guestMode);
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const saveDraft = useEditorStore((s) => s.saveDraft);
  const { requireAuth } = useAuthGuard();
  const [studioError, setStudioError] = useState<string | null>(null);

  const bullets = [
    { icon: Layers, text: t("simple.advancedPromo.bulletVariables") },
    { icon: Sparkles, text: t("simple.advancedPromo.bulletBehaviors") },
    { icon: BookOpen, text: t("simple.advancedPromo.bulletLorebooks") },
    { icon: FileCode, text: t("simple.advancedPromo.bulletCustomUi") },
  ];

  const handleSwitch = () => {
    // Persist the preference, then hand off to the route's switch callback —
    // the mode is route-local state, so setting the store field alone does
    // nothing once the page has resolved its mode.
    const store = useEditorStore.getState();
    store.setField("editorMode", "advanced");
    saveGlobalEditorMode("advanced");
    onOpenFullEditor();
  };

  const handleStudio = async () => {
    if (guestMode) { requireAuth("create worlds"); return; }
    setStudioError(null);
    let id = serverWorldId;
    if (!id) {
      await saveDraft();
      id = useEditorStore.getState().serverWorldId;
    }
    if (!id) {
      setStudioError(t("simple.needWorldName"));
      return;
    }
    router.navigate({ to: "/app/studio/$worldId", params: { worldId: id } });
  };

  return (
    <div className="relative overflow-hidden rounded-2xl border border-primary/25 bg-gradient-to-br from-primary/[0.08] via-card/60 to-card/60 backdrop-blur-sm">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-primary/[0.12] to-transparent" />
      <div className="relative p-5 md:p-6">
        <div className="mb-1 flex items-center gap-2.5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Wand2 className="h-4 w-4" />
          </div>
          <h2 className="text-base font-bold text-foreground">{t("simple.advancedPromo.title")}</h2>
        </div>
        <ul className="mb-5 grid gap-2 sm:grid-cols-2">
          {bullets.map(({ icon: Icon, text }) => (
            <li key={text} className="flex items-start gap-2 rounded-lg bg-card/40 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/70" />
              {text}
            </li>
          ))}
        </ul>
        {/* Studio leads: for most simple-mode creators "describe it, AI builds
            it" converts far better than hand-editing in advanced mode. */}
        <div className="mb-4 rounded-xl border border-primary/20 bg-primary/[0.06] p-3.5">
          <p className="mb-2.5 text-xs leading-relaxed text-foreground/90">
            <Sparkles className="mr-1 inline h-3.5 w-3.5 align-[-2px] text-primary" />
            {t("simple.advancedPromo.studioHint")}
          </p>
          <button
            onClick={handleStudio}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-xs font-bold text-primary-foreground transition-all hover:brightness-110"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {t("simple.advancedPromo.studioButton")}
          </button>
          <FieldError id="simple-studio-error" message={studioError} />
          <p className="mt-2.5 text-[11px] leading-relaxed text-muted-foreground/70">
            💰 {t("simple.advancedPromo.reimburseNote")}
          </p>
        </div>
        <button
          onClick={handleSwitch}
          className="flex items-center gap-1.5 rounded-lg border border-primary/30 px-4 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/10"
        >
          {t("simple.advancedPromo.switchButton")}
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/* ─── More disclosure: marketplace first, then gallery, language ─── */
function MoreDisclosure({ onOpenFullEditor }: { onOpenFullEditor: () => void }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string) => string };
  const galleryImages = useEditorStore((s) => s.galleryImages);
  const setGalleryImages = useEditorStore((s) => s.setGalleryImages);
  const language = useEditorStore((s) => s.language);
  const setLanguage = useEditorStore((s) => s.setLanguage);
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const saveDraft = useEditorStore((s) => s.saveDraft);
  const guestMode = useEditorStore((s) => s.guestMode);
  const { requireAuth } = useAuthGuard();

  const [uploading, setUploading] = useState(false);
  const [removingIdx, setRemovingIdx] = useState<number | null>(null);
  const [galleryError, setGalleryError] = useState<string | null>(null);
  const galleryRef = useRef<HTMLInputElement>(null);

  const ensureWorldId = async (): Promise<string | null> => {
    let id = serverWorldId;
    if (!id) {
      await saveDraft();
      id = useEditorStore.getState().serverWorldId;
    }
    if (!id) {
      setGalleryError(t("simple.needWorldName"));
      return null;
    }
    return id;
  };

  const handleGalleryUpload = async (file: File) => {
    if (guestMode) { requireAuth("create worlds"); return; }
    setUploading(true);
    setGalleryError(null);
    try {
      const id = await ensureWorldId();
      if (!id) return;
      const data = await uploadAssetWithPresignedUrl<{ url: string; galleryImages: string[] }>({
        file,
        preferredType: "image",
        prepareUrl: `${apiBase}/api/worlds/${id}/gallery/upload-url`,
        registerUrl: `${apiBase}/api/worlds/${id}/gallery/confirm`,
        registerBody: ({ key }) => ({ key }),
      });
      // The new tile appears in the grid below — nothing to announce.
      setGalleryImages([...galleryImages, data.url]);
    } catch (err) {
      setGalleryError(getAssetUploadErrorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const handleGalleryRemove = async (i: number) => {
    if (!serverWorldId) return;
    setRemovingIdx(i);
    setGalleryError(null);
    try {
      const res = await fetch(`${apiBase}/api/worlds/${serverWorldId}/gallery/${i}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) {
        setGalleryError(t("simple.removeFailed"));
        return;
      }
      // The tile leaves the grid — that is the confirmation.
      setGalleryImages(galleryImages.filter((_, idx) => idx !== i));
    } catch {
      setGalleryError(t("simple.removeFailed"));
    } finally {
      setRemovingIdx(null);
    }
  };

  return (
    <details className="group rounded-2xl border border-dashed border-border bg-card/30 px-5 py-4 open:bg-card/40">
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-muted-foreground hover:text-foreground">
        <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90" />
        {t("simple.more.summary")}
      </summary>
      <div className="mt-4 space-y-6">
        {/* Marketplace — collapsed by default (heavy to render); hosted-only. */}
        {getEditionInfo().features.bundles && (
        <details className="group/mkt overflow-hidden rounded-2xl border border-primary/25 bg-card/60">
          <summary className="flex cursor-pointer items-center gap-3 border-b border-border/60 bg-primary/[0.04] px-4 py-2.5 hover:bg-primary/[0.06]">
            <ChevronRight className="h-4 w-4 text-primary transition-transform group-open/mkt:rotate-90" />
            <Compass className="h-4 w-4 text-primary" />
            <span className="text-sm font-bold text-foreground">{t("simple.more.marketplace.title")}</span>
            <span className="ml-auto truncate text-[11px] text-muted-foreground">
              {t("simple.more.marketplace.hint")}
            </span>
          </summary>
          <div className="max-h-[420px] overflow-y-auto">
            <BundlesSection />
          </div>
        </details>
        )}

        <VisualLayerSection />
        <SimpleBgmCard />

        {/* Gallery */}
        <div className="rounded-xl border border-border bg-card/40 p-4">
          <div className="mb-3 flex items-center gap-2">
            <ImageIcon className="h-4 w-4 text-muted-foreground" />
            <h4 className="text-sm font-semibold">{t("simple.more.gallery.title")}</h4>
            <span className="text-[11px] text-muted-foreground/60">{t("simple.more.gallery.hint")}</span>
          </div>
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
            {galleryImages.map((url, i) => (
              <div key={i} className="group relative aspect-video overflow-hidden rounded-lg border border-border bg-card">
                <img src={url} alt="" className="h-full w-full object-cover" />
                <TwoTapDeleteButton
                  onConfirm={() => handleGalleryRemove(i)}
                  disabled={removingIdx === i}
                  className="touch-reveal absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:bg-red-600 active:bg-red-600 group-hover:opacity-100 disabled:opacity-50 [@media(hover:none)]:h-9 [@media(hover:none)]:w-9"
                  armedClassName="opacity-100 bg-red-600"
                  armedTitle={t("twoTapConfirm")}
                >
                  {removingIdx === i ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                </TwoTapDeleteButton>
              </div>
            ))}
            <button
              onClick={() => galleryRef.current?.click()}
              disabled={uploading}
              className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-border transition-colors hover:border-primary/30 hover:bg-primary/5 disabled:opacity-40"
            >
              {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Plus className="h-5 w-5 text-muted-foreground/40" />}
            </button>
          </div>
          <input
            ref={galleryRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleGalleryUpload(f);
              e.target.value = "";
            }}
          />
          <FieldError id="simple-gallery-error" message={galleryError} />
        </div>

        {/* Language */}
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card/40 p-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
            <Globe className="h-4 w-4 text-primary" />
          </div>
          <div className="flex-1">
            <h4 className="text-sm font-semibold">{t("simple.more.language.title")}</h4>
            <p className="mt-0.5 text-[11px] text-muted-foreground/60">{t("simple.more.language.hint")}</p>
          </div>
          <select
            value={language ?? ""}
            onChange={(e) => setLanguage(e.target.value || null)}
            className="rounded-lg border border-border bg-card px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">—</option>
            <option value="en">English</option>
            <option value="zh">中文</option>
            <option value="ja">日本語</option>
            <option value="ko">한국어</option>
            <option value="es">Español</option>
            <option value="fr">Français</option>
            <option value="de">Deutsch</option>
            <option value="pt">Português</option>
            <option value="ru">Русский</option>
          </select>
        </div>

        <p className="text-center text-[11px] text-muted-foreground/60">
          <button
            type="button"
            onClick={() => {
              // Same handoff as AdvancedPromoCard — the route owns the mode,
              // so store writes alone never flipped the editor (old bug).
              const store = useEditorStore.getState();
              store.setField("editorMode", "advanced");
              saveGlobalEditorMode("advanced");
              onOpenFullEditor();
            }}
            className="text-primary hover:underline"
          >
            {t("simple.more.switchToAdvanced")}
          </button>
        </p>
      </div>
    </details>
  );
}

/* ─── A single entry row in the settings list ─── */
function SettingEntryCard({
  entry,
  idx,
  open,
  onToggle,
  onUpdate,
  onRemove,
}: {
  entry: WorldEntry;
  idx: number;
  open: boolean;
  onToggle: () => void;
  onUpdate: (updates: Partial<WorldEntry>) => void;
  onRemove: () => void;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string, opts?: Record<string, unknown>) => string };
  const templatePlaceholder = useTemplateContentPlaceholder(entry);
  const keywordTriggered = entry.alwaysSend === false && (entry.keywords?.length ?? 0) > 0;
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-background/40">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-accent/30"
      >
        <GripVertical className="h-3.5 w-3.5 text-muted-foreground/30" />
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/15 text-xs font-bold text-amber-300">
          {idx + 1}
        </div>
        <span className="flex-1 truncate text-sm font-semibold">
          {entry.name || (
            <span className="text-muted-foreground/50">
              {t("simple.settings.unnamed", { n: idx + 1 })}
            </span>
          )}
        </span>
        {keywordTriggered && (
          <span
            title={entry.keywords?.join(", ") ?? ""}
            className="rounded bg-muted/30 px-1.5 py-0.5 text-[9px] font-semibold text-muted-foreground"
          >
            {t("simple.badge.keywordTriggered")}
          </span>
        )}
        <ChevronDown
          className={cn(
            "h-4 w-4 text-muted-foreground transition-transform",
            open && "rotate-180"
          )}
        />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border/60 p-4">
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              {t("simple.settings.entryTitle")}
            </label>
            <input
              type="text"
              value={entry.name}
              onChange={(e) => onUpdate({ name: e.target.value })}
              placeholder={t("simple.settings.entryTitlePlaceholder")}
              className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-amber-400/30"
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
              {t("simple.settings.entryContent")}
            </label>
            <textarea
              value={entry.content}
              onChange={(e) => onUpdate({ content: e.target.value })}
              rows={8}
              placeholder={templatePlaceholder || t("simple.settings.entryContentFallback")}
              className="w-full resize-none rounded-lg border border-border bg-background/60 px-3 py-2 text-sm leading-relaxed placeholder:whitespace-pre-line placeholder:text-muted-foreground/35 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-amber-400/30"
            />
          </div>
          {keywordTriggered && (
            <p className="rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2 text-[11px] text-amber-200/70">
              {t("simple.settings.keywordHint", { keywords: entry.keywords?.join(" / ") ?? "" })}
            </p>
          )}
          <div className="flex justify-end">
            <TwoTapDeleteButton
              onConfirm={onRemove}
              className="rounded-lg p-1.5 text-muted-foreground/30 transition-colors hover:bg-destructive/10 hover:text-destructive"
              title={t("simple.settings.deleteEntry")}
              armedTitle={t("twoTapConfirm")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </TwoTapDeleteButton>
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Visual Layer card · lists every file in rootComponent.files ─── */
function VisualLayerSection() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string, opts?: Record<string, unknown>) => string };
  const rootComponent = useEditorStore((s) => s.worldDraft.rootComponent);
  const updateRootComponent = useEditorStore((s) => s.updateRootComponent);

  // One-time legacy migration: if the world still has the old `_simple-css.tsx`
  // shim from the previous simple editor, fold it into `__user-root.tsx`.
  // Runs lazily on mount; idempotent (no-op once the file is gone).
  const migrationDoneRef = useRef(false);
  useEffect(() => {
    if (migrationDoneRef.current) return;
    if (!rootComponent?.files) return;
    if (!("_simple-css.tsx" in rootComponent.files)) {
      migrationDoneRef.current = true;
      return;
    }
    const migrated = migrateLegacySimpleCss(rootComponent.files);
    if (migrated !== rootComponent.files) {
      updateRootComponent({ files: migrated });
    }
    migrationDoneRef.current = true;
  }, [rootComponent?.files, updateRootComponent]);

  const files = rootComponent?.files ?? {};
  const classification = useMemo(() => classifyFiles(files), [files]);

  const handleFileChange = (path: string, content: string) => {
    if (!rootComponent) return;
    if (path === USER_ROOT_PATH) {
      updateRootComponent({ files: setUserRoot(files, content) });
    } else {
      const next = { ...files, [path]: content };
      updateRootComponent({ files: next });
    }
  };

  const handleAddFile = (filename: string) => {
    if (!rootComponent) return;
    if (filename === USER_ROOT_PATH) {
      updateRootComponent({ files: setUserRoot(files, DEFAULT_USER_ROOT_TSX) });
      return;
    }
    // AddFilePrompt already refuses a duplicate name inline and disables its
    // confirm button, so this is only a belt-and-braces guard.
    if (filename in files) return;
    const stub =
      `export default function ${prettyComponentName(filename)}() {\n  return null;\n}\n`;
    const next = { ...files, [filename]: stub };
    // Recompose in case the new file is __user-root or under _bundles/
    updateRootComponent({ files: recomposeIndex(next) });
  };

  const handleDeleteFile = (path: string) => {
    if (!rootComponent) return;
    if (path === USER_ROOT_PATH) {
      updateRootComponent({ files: setUserRoot(files, "") });
      return;
    }
    const next: Record<string, string> = {};
    for (const [p, c] of Object.entries(files)) if (p !== path) next[p] = c;
    updateRootComponent({ files: recomposeIndex(next) });
  };

  const handleUninstallBundle = (slug: string) => {
    if (!rootComponent) return;
    updateRootComponent({ files: uninstallBundle(files, slug) });
  };

  const [showAddFile, setShowAddFile] = useState(false);
  const totalFiles =
    (classification.userRoot ? 1 : 0) +
    (classification.composerIndex ? 1 : 0) +
    classification.otherFiles.length +
    [...classification.bundleFiles.values()].reduce((s, arr) => s + arr.length, 0);

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card/60">
      {/* Card header */}
      <div className="flex items-start gap-3.5 border-b border-border/60 bg-violet-500/[0.04] px-5 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-violet-500/15 text-violet-300">
          <Layers className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-foreground">{t("simple.more.visual.title")}</h4>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground/70">
            {t("simple.more.visual.hint")}
          </p>
        </div>
        <span className="shrink-0 rounded-md bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {totalFiles}
        </span>
      </div>

      <div className="space-y-2 p-4">
        {/* User-root file (promoted) */}
        {classification.userRoot ? (
          <FileEditorCard
            path={USER_ROOT_PATH}
            content={files[USER_ROOT_PATH]!}
            accent="violet"
            highlight
            subtitleKey="simple.more.visual.userRootSubtitle"
            onChange={(c) => handleFileChange(USER_ROOT_PATH, c)}
            onDelete={() => handleDeleteFile(USER_ROOT_PATH)}
          />
        ) : (
          <button
            onClick={() => handleAddFile(USER_ROOT_PATH)}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-violet-400/30 bg-violet-500/[0.04] py-3 text-xs font-semibold text-violet-300 hover:border-violet-400/50 hover:bg-violet-500/[0.08]"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("simple.more.visual.createUserRoot")}
          </button>
        )}

        {/* Each bundle as a group */}
        {classification.bundleFolders.map((slug) => (
          <BundleGroupCard
            key={slug}
            slug={slug}
            filePaths={classification.bundleFiles.get(slug)!}
            files={files}
            onFileChange={handleFileChange}
            onUninstall={() => handleUninstallBundle(slug)}
          />
        ))}

        {/* Other top-level user-created files */}
        {classification.otherFiles.map((p) => (
          <FileEditorCard
            key={p}
            path={p}
            content={files[p]!}
            accent="amber"
            onChange={(c) => handleFileChange(p, c)}
            onDelete={() => handleDeleteFile(p)}
          />
        ))}

        {/* Composer index.tsx — read-only banner */}
        {classification.composerIndex && (
          <ComposerNote content={files["index.tsx"]!} />
        )}

        {/* Add file button + dialog */}
        {showAddFile ? (
          <AddFilePrompt
            onCancel={() => setShowAddFile(false)}
            onConfirm={(name) => {
              setShowAddFile(false);
              handleAddFile(name);
            }}
            existing={new Set(Object.keys(files))}
          />
        ) : (
          <button
            onClick={() => setShowAddFile(true)}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/30 py-2.5 text-xs font-semibold text-muted-foreground hover:border-primary/40 hover:bg-primary/[0.04] hover:text-primary"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("simple.more.visual.addFile")}
          </button>
        )}
      </div>
    </div>
  );
}

function prettyComponentName(filename: string): string {
  const base = filename.split("/").slice(-1)[0]?.replace(/\.tsx$/, "") ?? "Component";
  return base.replace(/[^a-zA-Z0-9]/g, "") || "Component";
}

/* ─── Single file editor card ─── */
function FileEditorCard({
  path,
  content,
  accent,
  highlight,
  subtitleKey,
  onChange,
  onDelete,
  readOnly,
}: {
  path: string;
  content: string;
  accent: "violet" | "fuchsia" | "amber";
  highlight?: boolean;
  subtitleKey?: string;
  onChange: (content: string) => void;
  onDelete?: () => void;
  readOnly?: boolean;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string, opts?: Record<string, unknown>) => string };
  const lines = content.split("\n").length;
  const [expanded, setExpanded] = useState(highlight && content.length < 2000);
  const filename = path.split("/").slice(-1)[0]!;
  const accentClasses = {
    violet: { iconBg: "bg-violet-500/15", iconText: "text-violet-300", focus: "focus:ring-violet-400/30", border: highlight ? "border-violet-400/30" : "border-border" },
    fuchsia: { iconBg: "bg-fuchsia-500/15", iconText: "text-fuchsia-300", focus: "focus:ring-fuchsia-400/30", border: "border-border" },
    amber: { iconBg: "bg-amber-500/15", iconText: "text-amber-300", focus: "focus:ring-amber-400/30", border: "border-border" },
  }[accent];

  return (
    <div className={cn("overflow-hidden rounded-xl border bg-background/40", accentClasses.border)}>
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-accent/30"
      >
        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-transform", expanded && "rotate-90")} />
        <div className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded-lg", accentClasses.iconBg, accentClasses.iconText)}>
          <FileCode className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm font-semibold">{filename}</div>
          <div className="truncate text-[11px] text-muted-foreground/60">
            {lines} {t("simple.more.visual.lines")} · {content.length.toLocaleString()} {t("simple.more.visual.chars")}
            {subtitleKey && ` · ${t(subtitleKey)}`}
          </div>
        </div>
        {readOnly && <Lock className="h-3.5 w-3.5 text-muted-foreground/40" />}
        {onDelete && !readOnly && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(t("simple.more.visual.confirmDelete", { name: filename }))) onDelete();
            }}
            className="shrink-0 rounded-md p-1 text-muted-foreground/30 hover:bg-destructive/10 hover:text-destructive"
            title={t("simple.character.delete")}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border/60 bg-background/30 p-3">
          <textarea
            value={content}
            onChange={(e) => onChange(e.target.value)}
            rows={Math.min(Math.max(lines + 1, 6), 24)}
            spellCheck={false}
            readOnly={readOnly}
            className={cn(
              "w-full resize-y rounded-lg border border-border bg-background/60 px-3 py-2 font-mono text-[12px] leading-relaxed focus:border-transparent focus:outline-none focus:ring-2",
              accentClasses.focus,
              readOnly && "opacity-70"
            )}
          />
        </div>
      )}
    </div>
  );
}

/* ─── A bundle (a folder under _bundles/<slug>/) ─── */
function BundleGroupCard({
  slug,
  filePaths,
  files,
  onFileChange,
  onUninstall,
}: {
  slug: string;
  filePaths: string[];
  files: Record<string, string>;
  onFileChange: (path: string, content: string) => void;
  onUninstall: () => void;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string, opts?: Record<string, unknown>) => string };
  const [expanded, setExpanded] = useState(false);
  const totalChars = filePaths.reduce((sum, p) => sum + (files[p]?.length ?? 0), 0);
  const display = bundleDisplayName(slug);

  return (
    <div className="overflow-hidden rounded-xl border border-fuchsia-400/25 bg-fuchsia-500/[0.02]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-fuchsia-500/[0.05]"
      >
        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-fuchsia-300/50 transition-transform", expanded && "rotate-90")} />
        <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-fuchsia-500/15 text-fuchsia-300">
          <Box className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{display}</div>
          <div className="truncate font-mono text-[11px] text-muted-foreground/60">
            _bundles/{slug}/ · {filePaths.length} {t("simple.more.visual.files")} · {totalChars.toLocaleString()} {t("simple.more.visual.chars")}
          </div>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (confirm(t("simple.more.visual.confirmUninstall", { name: display }))) onUninstall();
          }}
          className="shrink-0 rounded-md p-1 text-muted-foreground/30 hover:bg-destructive/10 hover:text-destructive"
          title={t("simple.more.visual.uninstall")}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-fuchsia-400/15 bg-background/30 p-3">
          {filePaths.map((p) => (
            <FileEditorCard
              key={p}
              path={p}
              content={files[p]!}
              accent="fuchsia"
              onChange={(c) => onFileChange(p, c)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Composer index.tsx · read-only ─── */
function ComposerNote({ content }: { content: string }) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string) => string };
  const [show, setShow] = useState(false);
  return (
    <div className="rounded-xl border border-dashed border-border bg-card/20 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
        <span className="flex-1 font-mono text-[11px] text-muted-foreground">
          index.tsx · {t("simple.more.visual.composerNote")}
        </span>
        <button onClick={() => setShow(!show)} className="text-[11px] text-muted-foreground/70 hover:text-foreground">
          {show ? t("simple.more.visual.composerHide") : t("simple.more.visual.composerShow")}
        </button>
      </div>
      {show && (
        <pre className="mt-2 max-h-48 overflow-auto rounded-md border border-border bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {content}
        </pre>
      )}
    </div>
  );
}

/* ─── Add-file inline prompt ─── */
function AddFilePrompt({
  onCancel,
  onConfirm,
  existing,
}: {
  onCancel: () => void;
  onConfirm: (name: string) => void;
  existing: Set<string>;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string) => string };
  const [name, setName] = useState("");

  const sanitize = (raw: string): string => {
    let n = raw.trim();
    if (!n) return "";
    if (!n.endsWith(".tsx") && !n.endsWith(".ts")) n = `${n}.tsx`;
    return n;
  };

  const confirm = () => {
    const sanitized = sanitize(name);
    if (!sanitized) return;
    if (existing.has(sanitized)) return;
    onConfirm(sanitized);
  };

  const sanitized = sanitize(name);
  const conflict = sanitized && existing.has(sanitized);

  return (
    <div className="rounded-xl border border-primary/30 bg-primary/[0.04] p-3">
      <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
        {t("simple.more.visual.newFileName")}
      </label>
      <input
        autoFocus
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (e.key === "Enter") confirm();
          if (e.key === "Escape") onCancel();
        }}
        placeholder="my-component.tsx"
        className="w-full rounded-lg border border-border bg-background/60 px-3 py-2 font-mono text-sm focus:border-transparent focus:outline-none focus:ring-2 focus:ring-primary/30"
      />
      {conflict && (
        <p className="mt-1.5 text-[11px] text-destructive">{t("simple.more.visual.fileExists")}</p>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {t("simple.more.visual.cancel")}
        </button>
        <button
          onClick={confirm}
          disabled={!sanitized || !!conflict}
          className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground disabled:opacity-40"
        >
          {t("simple.more.visual.create")}
        </button>
      </div>
    </div>
  );
}

/* ─── Simple BGM card ─── */
function SimpleBgmCard() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string, opts?: Record<string, unknown>) => string };
  const audioTracks = useEditorStore((s) => s.worldDraft.audioTracks ?? []);
  const bgmPlaylist = useEditorStore((s) => s.worldDraft.bgmPlaylist);
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const saveDraft = useEditorStore((s) => s.saveDraft);
  const addAudioTrack = useEditorStore((s) => s.addAudioTrack);
  const updateAudioTrack = useEditorStore((s) => s.updateAudioTrack);
  const removeAudioTrack = useEditorStore((s) => s.removeAudioTrack);
  const setBgmPlaylist = useEditorStore((s) => s.setBgmPlaylist);
  const updateBgmPlaylist = useEditorStore((s) => s.updateBgmPlaylist);

  const bgmTracks = audioTracks.filter((t) => t.type === "bgm");
  const primary = bgmTracks[0];
  const extra = Math.max(0, bgmTracks.length - 1);

  const [picking, setPicking] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ensureWorldId = async (): Promise<string | null> => {
    let id = serverWorldId;
    if (!id) {
      await saveDraft();
      id = useEditorStore.getState().serverWorldId;
    }
    if (!id) {
      setError(t("simple.needWorldNameSaved"));
      return null;
    }
    setError(null);
    return id;
  };

  const handleSelect = (assetRef: string) => {
    setPicking(false);
    if (primary) {
      updateAudioTrack(primary.id, { url: assetRef });
      // Make sure this track is in the playlist (in case it was orphaned).
      if (!bgmPlaylist?.tracks?.includes(primary.id)) {
        updateBgmPlaylist({
          tracks: [primary.id, ...(bgmPlaylist?.tracks ?? []).filter((t) => t !== primary.id)],
          autoPlay: bgmPlaylist?.autoPlay ?? true,
          waitForFirstMessage: bgmPlaylist?.waitForFirstMessage ?? false,
        });
      }
      return;
    }
    addAudioTrack();
    const created = useEditorStore.getState().worldDraft.audioTracks?.slice(-1)[0];
    if (!created) return;
    updateAudioTrack(created.id, {
      name: t("simple.more.bgm.title"),
      type: "bgm",
      url: assetRef,
      loop: true,
      volume: 1,
    });
    // First-time upload — seed a playlist so it actually plays on session start.
    // The runtime checks bgmPlaylist.autoPlay (chat.ts:347); without a playlist
    // the track just sits in audioTracks unused.
    const existingPl = useEditorStore.getState().worldDraft.bgmPlaylist;
    if (existingPl) {
      setBgmPlaylist({
        ...existingPl,
        tracks: [created.id, ...existingPl.tracks.filter((t) => t !== created.id)],
        autoPlay: existingPl.autoPlay,
      });
    } else {
      setBgmPlaylist({
        tracks: [created.id],
        playMode: "loop",
        autoPlay: true,
        waitForFirstMessage: false,
        gapSeconds: 0,
      });
    }
  };

  const togglePlay = async () => {
    if (!primary?.url) return;
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
      return;
    }
    try {
      const resolved = primary.url.startsWith("@asset:")
        ? await resolveAssetUrl(primary.url)
        : primary.url;
      el.src = resolved;
      el.currentTime = 0;
      await el.play();
      setPlaying(true);
    } catch {
      setPlaying(false);
    }
  };

  return (
    <div className="rounded-xl border border-emerald-400/25 bg-card/40 p-4">
      <div className="mb-3 flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-300">
          <Music className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-foreground">{t("simple.more.bgm.title")}</h4>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground/70">
            {t("simple.more.bgm.hint")}
          </p>
        </div>
      </div>

      {primary ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3 rounded-lg border border-border bg-background/60 px-3 py-2">
            <button
              onClick={togglePlay}
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
              title={playing ? t("simple.more.bgm.pause") : t("simple.more.bgm.preview")}
            >
              {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 fill-current" />}
            </button>
            <input
              type="text"
              value={primary.name}
              onChange={(e) => updateAudioTrack(primary.id, { name: e.target.value })}
              placeholder={t("simple.more.bgm.namePlaceholder")}
              className="min-w-0 flex-1 bg-transparent text-sm font-medium text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
            />
            <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={primary.loop ?? true}
                onChange={(e) => updateAudioTrack(primary.id, { loop: e.target.checked })}
                className="h-3.5 w-3.5 rounded border-border bg-card text-emerald-400 focus:ring-emerald-400/30"
              />
              {t("simple.more.bgm.loop")}
            </label>
            <button
              onClick={async () => {
                const id = await ensureWorldId();
                if (id) setPicking(true);
              }}
              className="shrink-0 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-medium text-muted-foreground hover:border-emerald-400/40 hover:text-foreground"
            >
              {t("simple.more.bgm.replace")}
            </button>
            <TwoTapDeleteButton
              onConfirm={() => {
                // Clean up the playlist entry too — otherwise the runtime
                // tries to start a playlist that points at a deleted track.
                const pl = useEditorStore.getState().worldDraft.bgmPlaylist;
                if (pl) {
                  const remaining = pl.tracks.filter((tid) => tid !== primary.id);
                  if (remaining.length === 0) {
                    setBgmPlaylist(undefined);
                  } else {
                    setBgmPlaylist({ ...pl, tracks: remaining });
                  }
                }
                removeAudioTrack(primary.id);
                setPlaying(false);
              }}
              className="shrink-0 rounded-md p-1.5 text-muted-foreground/40 hover:bg-destructive/10 hover:text-destructive"
              title={t("simple.more.bgm.remove")}
              armedTitle={t("twoTapConfirm")}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </TwoTapDeleteButton>
          </div>
          {primary.url && (
            <audio
              ref={audioRef}
              onEnded={() => setPlaying(false)}
              preload="none"
              className="hidden"
            />
          )}
          {extra > 0 && (
            <p className="text-[11px] text-muted-foreground/60">
              {t("simple.more.bgm.moreInAdvanced", { count: extra })}
            </p>
          )}
        </div>
      ) : (
        <button
          onClick={async () => {
            const id = await ensureWorldId();
            if (id) setPicking(true);
          }}
          className="group flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card/30 py-3 text-xs font-semibold text-muted-foreground transition-all hover:border-emerald-400/40 hover:bg-emerald-500/[0.04] hover:text-emerald-300"
        >
          <Plus className="h-3.5 w-3.5 transition-transform group-hover:rotate-90" />
          {t("simple.more.bgm.upload")}
        </button>
      )}

      <FieldError id="simple-bgm-error" message={error} />

      {picking && serverWorldId && (
        <AssetPicker
          worldId={serverWorldId}
          filterType="audio"
          onSelect={handleSelect}
          onClose={() => setPicking(false)}
        />
      )}
    </div>
  );
}

/* ─── Card shell ─── */
function Card({
  n,
  icon: Icon,
  title,
  hint,
  accent,
  optional,
  children,
}: {
  n: number;
  icon: typeof FileText;
  title: string;
  hint?: string;
  accent: Accent;
  optional?: boolean;
  children: React.ReactNode;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { t } = useTranslation("editor") as { t: (key: string) => string };
  const a = ACCENT_CLASSES[accent];
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-border bg-card/60 backdrop-blur-sm transition-all",
        a.ring
      )}
    >
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-0 h-32 bg-gradient-to-b to-transparent opacity-60",
          a.glow
        )}
      />
      <div className="relative p-5 md:p-6">
        <div className="mb-4 flex items-start gap-3.5">
          <div
            className={cn(
              "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl",
              a.iconBg,
              a.iconText
            )}
          >
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className={cn("text-[10px] font-bold tracking-[0.14em]", a.numberText)}>
                0{n}
              </span>
              <h2 className="text-base font-bold text-foreground">{title}</h2>
              {optional ? (
                <span className="rounded bg-muted/30 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {t("simple.badge.optional")}
                </span>
              ) : (
                <span className="rounded bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-400">
                  {t("simple.badge.required")}
                </span>
              )}
            </div>
            {hint && <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">{hint}</p>}
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

/* InspirationStrip removed — the merged Story textarea no longer exists; the
 * Settings card list takes its place, and each entry has its own placeholder. */

/* ─── Jump anchor (right rail) ─── */
function JumpAnchor({ n, label, accent }: { n: string; label: string; accent: Accent }) {
  const a = ACCENT_CLASSES[accent];
  return (
    <button className="group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
      <span
        className={cn(
          "flex h-5 w-5 items-center justify-center rounded-md text-[10px] font-bold",
          a.iconBg,
          a.iconText
        )}
      >
        {n}
      </span>
      <span>{label}</span>
    </button>
  );
}

/* ─── Dialogs (factored to avoid duplicating between mobile + desktop) ─── */
function mountedDialogs(
  showBundleCreator: boolean,
  setShowBundleCreator: (v: boolean) => void,
  showImportModal: boolean,
  setShowImportModal: (v: boolean) => void,
  importingBundle: YuminaBundle | null,
  setImportingBundle: (v: YuminaBundle | null) => void,
  showUpdateNotify: boolean,
  setShowUpdateNotify: (v: boolean) => void,
  showVersionHistory: boolean,
  setShowVersionHistory: (v: boolean) => void,
  showPublishModal: boolean,
  setShowPublishModal: (v: boolean) => void,
  serverWorldId: string | null,
  worldName: string,
  hasPendingEdit: boolean,
) {
  return (
    <>
      {showBundleCreator && <BundleCreator onClose={() => setShowBundleCreator(false)} />}
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
        <BundleImporter bundle={importingBundle} onClose={() => setImportingBundle(null)} />
      )}
      {showUpdateNotify && serverWorldId && (
        <UpdateNotifyDialog
          worldId={serverWorldId}
          worldName={worldName || "Untitled World"}
          held={hasPendingEdit}
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
              useEditorStore.getState().refreshWorldStatus();
            }}
          />
        )}
      </Suspense>
    </>
  );
}

// Keep imports happy (used inside future expand-textarea feature)
void Maximize2;
