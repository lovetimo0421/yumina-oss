/**
 * Studio on a phone.
 *
 * There is no canvas here — a 390px screen has no room for the board — so
 * this is not the "visual" surface with the board missing; it is Studio in
 * the shape a phone wants. One screen at a time, the creation assistant one
 * tap away at all times, and the card's own panels behind a bottom bar:
 *
 *   助手 · 开场白 · 设定 · 试玩 · 更多
 *
 * The assistant is the first tab and where a card opens on a phone: it can
 * write any part of the card, so on a small screen it is the fastest way to
 * work, and the panels are there to read and touch up what it wrote. A change
 * the assistant proposes opens full-screen for review and goes back to the
 * conversation on close.
 *
 * The 画布 pill, the split workspace and the pane headers of the earlier
 * phone shell are gone: they described a desktop that is not here.
 */
import { isPlaceholderCardName } from "@/lib/world-templates";
import { STUDIO_ASK_EVENT, type StudioAskDetail } from "./lib/block-ask";
import { VariantTranslateBanner } from "@/features/editor/variant-translate-banner";
import { LANGUAGE_SHORT, currentVariantTrigger, variantRowLabels } from "@/lib/languages";
import { changeReviewTitle, type ReviewPart } from "./components/change-review";
import { ChangeReviewBody } from "./components/change-review-view";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { importWithChunkRecovery } from "@/lib/stale-chunk-reload";
import { DOCS_URLS } from "@/lib/docs-urls";
import { useTranslation } from "react-i18next";
import { navigateBackSafely } from "@/lib/safe-back";
import type { IDockviewPanelProps } from "dockview-react";
import {
  ArrowLeft,
  BookOpen,
  Check,
  ChevronDown,
  Download,
  GraduationCap,
  History,
  LayoutGrid,
  Loader2,
  MessageCircle,
  MoreVertical,
  Package,
  Play,
  Redo2,
  Save,
  SlidersHorizontal,
  Sparkles,
  Star,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { generatedInterfaceUnsaved, useEditorStore } from "@/stores/editor";
import { useWorldsStore } from "@/stores/worlds";
import { useStudioStore } from "@/stores/studio";
import type { YuminaBundle } from "@yumina/engine";
import { BundleCreator, BundleImporter, ImportBundleModal, WorldPublishModal } from "@/edition/slots";
import { useEdition } from "@/edition/edition";
import { ExportCardMenu } from "../editor/export-card-menu";
import { ReviewStateControl } from "../editor/review-state-control";
import { feedback } from "@/lib/feedback";
import { AudioSection } from "../editor/sections/audio";
import { SceneImagesSection } from "../editor/sections/scene-images";
import { BehaviorsSection } from "../editor/sections/behaviors-section";
import { EntriesSection } from "../editor/sections/entries";
import { VariablesSection } from "../editor/sections/variables";
import {
  AiChatPanel,
  AssetsPanel,
  AudioPanel,
  SceneImagesPanel,
  BackgroundsPanel,
  MechanicPacksPanel,
  BundlesPanel,
  CanvasPanel,
  CodeViewPanel,
  FrontendPage,
  FirstMessagePanel,
  GenerationAtelierPanel,
  LorebookPanel,
  ModulesPanel,
  OverviewPanel,
  PlaytestPanel,
  RulesPanel,
  SidebarPanel,
  VariablesPanel,
} from "./panels";
import { ModulesSection } from "@/features/editor/sections/modules";
import { PANEL_MENU_GROUPS } from "./studio-page-catalog";
import type { ToolCall } from "./lib/types";
import { buildReviewDiffTokens } from "./lib/review-diff";
import { LEARNING_OPEN_EVENT, LEARNING_PANEL_EVENT } from "./learn/learning-catalog";
import { takeRequestedPanel } from "@/lib/studio-entry";
import { ownsTypingUndo } from "./lib/text-entry-target";
import { rememberEditorChoice, type EditorChoice } from "@/features/editor/lib/editor-mode";
import { VisualSurfaceSwitch } from "@/features/editor/visual-surface-switch";

const VersionHistoryDialog = lazy(() => importWithChunkRecovery(() => import("../editor/version-history-dialog")).then(m => ({ default: m.VersionHistoryDialog })));

type MobileStudioPanelId =
  | "ai-chat"
  | "lorebook"
  | "modules"
  | "variables"
  | "rules"
  | "first-message"
  | "assets"
  | "audio"
  | "scene-images"
  | "backgrounds"
  | "packs"
  | "canvas"
  | "frontend"
  | "code-view"
  | "overview"
  | "playtest"
  | "sidebar"
  | "marketplace"
  | "generation";

/** The bottom bar, in order. Everything else is behind 更多. */
const TAB_PANELS = ["ai-chat", "first-message", "lorebook", "playtest"] as const;
type TabPanelId = (typeof TAB_PANELS)[number];

const TAB_LABEL_KEYS: Record<TabPanelId, string> = {
  "ai-chat": "studio.mobile.tabAssistant",
  "first-message": "studio.mobile.tabOpening",
  lorebook: "studio.mobile.tabLorebook",
  playtest: "studio.mobile.tabPlaytest",
};

const TAB_ICONS: Record<TabPanelId, typeof Sparkles> = {
  "ai-chat": Sparkles,
  "first-message": MessageCircle,
  lorebook: BookOpen,
  playtest: Play,
};

type MobileReviewPayload = {
  title: string;
  toolName: string;
  changed: string;
  original: string;
  parts?: ReviewPart[];
};

type MobileServerReviewPayload = MobileReviewPayload & {
  source?: string;
};

const MOBILE_PANEL_COMPONENTS: Record<MobileStudioPanelId, React.FC<IDockviewPanelProps>> = {
  "ai-chat": AiChatPanel,
  lorebook: LorebookPanel,
  modules: ModulesPanel,
  variables: VariablesPanel,
  rules: RulesPanel,
  "first-message": FirstMessagePanel,
  assets: AssetsPanel,
  audio: AudioPanel,
  "scene-images": SceneImagesPanel,
  backgrounds: BackgroundsPanel,
  packs: MechanicPacksPanel,
  canvas: CanvasPanel,
  "frontend": FrontendPage,
  "code-view": CodeViewPanel,
  overview: OverviewPanel,
  playtest: PlaytestPanel,
  sidebar: SidebarPanel,
  marketplace: BundlesPanel,
  generation: GenerationAtelierPanel,
};

const MOBILE_PANEL_LABEL_KEYS: Record<MobileStudioPanelId, string> = {
  "ai-chat": "studio.panels.aiAssistant",
  lorebook: "studio.panels.lorebook",
  modules: "studio.panels.modules",
  variables: "studio.panels.variables",
  rules: "studio.panels.behaviors",
  "first-message": "studio.panels.firstMessage",
  assets: "studio.panels.assets",
  audio: "studio.panels.audio",
  "scene-images": "studio.panels.sceneImages",
  backgrounds: "studio.panels.backgrounds",
  packs: "studio.panels.packs",
  canvas: "studio.panels.canvas",
  "frontend": "studio.stage.tabFrontend",
  "code-view": "studio.panels.frontEndCode",
  overview: "studio.panels.overview",
  playtest: "studio.panels.playtest",
  sidebar: "studio.panels.previewControls",
  marketplace: "studio.panels.marketplace",
  generation: "studio.panels.aiGeneration",
};

const MOBILE_PANEL_IDS = new Set<MobileStudioPanelId>(Object.keys(MOBILE_PANEL_COMPONENTS) as MobileStudioPanelId[]);

function isMobileStudioPanelId(id: string): id is MobileStudioPanelId {
  return MOBILE_PANEL_IDS.has(id as MobileStudioPanelId);
}

function isTabPanel(id: MobileStudioPanelId): id is TabPanelId {
  return (TAB_PANELS as readonly string[]).includes(id);
}

/** Where they left off on this card. The key and the `activePanel` field are
 *  the earlier phone shell's, so a card opened before this layout keeps its
 *  panel; the split-workspace fields it also wrote are ignored. */
function getMobileLayoutKey(worldId: string) {
  return `yumina-studio-mobile-layout-${worldId}`;
}

const DEFAULT_PANEL: MobileStudioPanelId = "ai-chat";

function loadActivePanel(worldId: string | null): MobileStudioPanelId {
  if (typeof window === "undefined") return DEFAULT_PANEL;
  try {
    const saved = localStorage.getItem(getMobileLayoutKey(worldId ?? "new"));
    if (!saved) return DEFAULT_PANEL;
    const parsed = JSON.parse(saved) as { activePanel?: unknown };
    return typeof parsed.activePanel === "string" && isMobileStudioPanelId(parsed.activePanel)
      ? parsed.activePanel
      : DEFAULT_PANEL;
  } catch {
    return DEFAULT_PANEL;
  }
}

function saveActivePanel(worldId: string | null, activePanel: MobileStudioPanelId) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(getMobileLayoutKey(worldId ?? "new"), JSON.stringify({ activePanel }));
  } catch {
    // Layout persistence is a convenience; editor data is saved separately.
  }
}

/** "Undo (Ctrl+Z)" → "Undo": the trailing shortcut, in any locale's brackets. */
function withoutShortcut(label: string): string {
  return label.replace(/\s*[(（][^()（）]*[)）]\s*$/, "");
}

function parseToolArgs(toolCall: ToolCall): Record<string, unknown> {
  try {
    return JSON.parse(toolCall.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function formatReviewValue(value: unknown) {
  if (typeof value === "string") return value.trim() || "(empty)";
  if (value === undefined || value === null) return "(empty)";
  return JSON.stringify(value, null, 2);
}

function summarizeEntity(entity: unknown) {
  if (!entity || typeof entity !== "object") return null;
  const record = entity as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ["id", "name", "content", "description", "behaviorRules", "defaultValue", "type", "enabled", "section", "role"]) {
    if (record[key] !== undefined) summary[key] = record[key];
  }
  return Object.keys(summary).length > 0 ? summary : record;
}

function findExistingEntity(args: Record<string, unknown>, collection: unknown[] | undefined) {
  const id = typeof args.id === "string" ? args.id : null;
  const name = typeof args.name === "string" ? args.name : null;
  return collection?.find((item) => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    return (id && record.id === id) || (name && record.name === name);
  });
}

function buildMobileReviewPayload(toolCall: ToolCall): MobileReviewPayload {
  const args = parseToolArgs(toolCall);
  const draft = useEditorStore.getState().worldDraft as unknown as Record<string, unknown>;
  const toolName = toolCall.function.name;
  const title = formatReviewValue(args.name ?? args.id ?? toolName);
  const noOriginal = "No existing version.";

  if (toolName === "write_entry") {
    const existing = findExistingEntity(args, draft.entries as unknown[]);
    return {
      title,
      toolName,
      changed: formatReviewValue(args.content ?? args),
      original: existing ? formatReviewValue((existing as Record<string, unknown>).content ?? summarizeEntity(existing)) : noOriginal,
    };
  }

  if (toolName === "write_variable") {
    const existing = findExistingEntity(args, draft.variables as unknown[]);
    return {
      title,
      toolName,
      changed: formatReviewValue(args.behaviorRules ?? args.description ?? args),
      original: existing ? formatReviewValue((existing as Record<string, unknown>).behaviorRules ?? summarizeEntity(existing)) : noOriginal,
    };
  }

  if (toolName === "write_behavior") {
    const existing = findExistingEntity(args, draft.reactions as unknown[]);
    return {
      title,
      toolName,
      changed: formatReviewValue(args),
      original: existing ? formatReviewValue(summarizeEntity(existing)) : noOriginal,
    };
  }

  if (toolName === "write_custom_ui") {
    const files = (draft.rootComponent as Record<string, unknown> | undefined)?.files as Record<string, string> | undefined;
    const id = typeof args.id === "string" ? args.id : "index.tsx";
    return {
      title: id,
      toolName,
      changed: formatReviewValue(args.tsxCode ?? args),
      original: files?.[id] ? formatReviewValue(files[id]) : noOriginal,
    };
  }

  if (toolName === "edit_custom_ui") {
    return {
      title,
      toolName,
      changed: formatReviewValue(args.new_code ?? args),
      original: formatReviewValue(args.old_code ?? noOriginal),
    };
  }

  if (toolName === "write_audio") {
    const existing = findExistingEntity(args, draft.audioTracks as unknown[]);
    return {
      title,
      toolName,
      changed: formatReviewValue(args),
      original: existing ? formatReviewValue(summarizeEntity(existing)) : noOriginal,
    };
  }

  if (toolName === "write_scene_image") {
    const existing = findExistingEntity(args, draft.sceneImages as unknown[]);
    return {
      title,
      toolName,
      changed: formatReviewValue(args),
      original: existing ? formatReviewValue(summarizeEntity(existing)) : noOriginal,
    };
  }

  if (toolName === "delete_entities") {
    const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === "string") : [];
    const collections = [
      ...(draft.entries as unknown[] | undefined ?? []),
      ...(draft.variables as unknown[] | undefined ?? []),
      ...(draft.reactions as unknown[] | undefined ?? []),
      ...(draft.rules as unknown[] | undefined ?? []),
      ...(draft.audioTracks as unknown[] | undefined ?? []),
      ...(draft.sceneImages as unknown[] | undefined ?? []),
    ];
    const files = (draft.rootComponent as Record<string, unknown> | undefined)?.files as Record<string, string> | undefined;
    const originals = ids.map((id) => {
      const entity = collections.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).id === id);
      if (entity) return { id, original: summarizeEntity(entity) };
      if (files?.[id]) return { id, original: files[id] };
      return { id, original: "Not found in current draft." };
    });
    return {
      title: ids.join(", ") || toolName,
      toolName,
      changed: "This action deletes the listed item(s).",
      original: formatReviewValue(originals),
    };
  }

  return {
    title,
    toolName,
    changed: formatReviewValue(args),
    original: noOriginal,
  };
}

function MobilePanelRenderer({ panelId }: { panelId: MobileStudioPanelId }) {
  if (panelId === "lorebook") {
    return <EntriesSection compact mobileListMode />;
  }
  if (panelId === "modules") {
    return <ModulesSection compact />;
  }
  if (panelId === "variables") {
    return <VariablesSection compact mobileListMode />;
  }
  if (panelId === "rules") {
    return <BehaviorsSection compact mobileListMode />;
  }
  if (panelId === "audio") {
    return <AudioSection compact mobileListMode />;
  }
  if (panelId === "scene-images") {
    return <SceneImagesSection compact mobileListMode />;
  }

  const Component = MOBILE_PANEL_COMPONENTS[panelId];
  return <Component {...({} as IDockviewPanelProps)} />;
}

/** 更多: every panel that is not on the bar, grouped like the desktop menu.
 *  A sheet from the bottom, under the thumb that opened it. */
function MorePanelsSheet({
  open,
  currentPanel,
  onClose,
  onSelect,
}: {
  open: boolean;
  currentPanel: MobileStudioPanelId;
  onClose: () => void;
  onSelect: (panelId: MobileStudioPanelId) => void;
}) {
  const { t } = useTranslation("editor");

  const groups = useMemo(() => (
    PANEL_MENU_GROUPS.map(group => ({
      labelKey: group.labelKey,
      items: group.items.filter((item): item is typeof item & { id: MobileStudioPanelId } =>
        isMobileStudioPanelId(item.id) && !isTabPanel(item.id)),
    })).filter(group => group.items.length > 0)
  ), []);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end modal-backdrop"
      onClick={onClose}
    >
      <div
        className="flex max-h-[calc(100dvh-env(safe-area-inset-top)-3rem)] w-full flex-col overflow-hidden rounded-t-3xl border-t border-border bg-background shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-center justify-between px-5 pb-2 pt-4">
          <div className="text-sm font-semibold text-foreground">{t("studio.mobile.choosePanel")}</div>
          <button
            type="button"
            onClick={onClose}
            className="hover-surface inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground"
            aria-label={t("action.close", { ns: "common", defaultValue: "Close" })}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-1">
          {groups.map(group => (
            <div key={group.labelKey} className="space-y-2">
              <div className="px-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/60">
                {t(group.labelKey as never)}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {group.items.map(item => {
                  const Icon = item.icon;
                  const active = item.id === currentPanel;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onSelect(item.id)}
                      className={cn(
                        "flex min-h-12 items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition",
                        active
                          ? "border-primary/60 bg-primary/10 text-foreground"
                          : "border-border/60 bg-card/40 text-muted-foreground active:bg-accent",
                      )}
                    >
                      <Icon className={cn("h-4 w-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">{t(item.labelKey as never)}</span>
                      {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function MobileReviewDiff({
  original,
  changed,
}: {
  original: string;
  changed: string;
}) {
  const { t } = useTranslation("editor");
  const tokens = useMemo(() => buildReviewDiffTokens(original, changed), [changed, original]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2 text-[11px] font-semibold">
        <span className="inline-flex items-center gap-1 rounded-full bg-lime-400 px-2 py-1 font-semibold text-black">
          <span className="font-mono">+</span>
          {t("studio.mobile.addedText")}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-orange-300 px-2 py-1 font-semibold text-black">
          <span className="font-mono">-</span>
          {t("studio.mobile.deletedText")}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-background">
        <div className="min-h-full whitespace-pre-wrap break-words px-3 py-3 font-mono text-[11px] leading-6 text-muted-foreground">
          {tokens.map((token, index) => (
            <span
              key={`${token.type}-${index}`}
              className={cn(
                token.type === "added" && "rounded-sm bg-lime-400 px-0.5 font-semibold text-black",
                token.type === "removed" && "rounded-sm bg-orange-300 px-0.5 font-semibold text-black line-through decoration-black/80",
              )}
            >
              {token.text}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/** A proposed change, full-screen. Close goes back to the conversation. */
function MobileReviewFrame({
  review,
  loading,
  onBackToAgent,
}: {
  review: MobileReviewPayload;
  loading?: boolean;
  onBackToAgent: () => void;
}) {
  const { t } = useTranslation("editor");

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 px-2">
        <button
          type="button"
          onClick={onBackToAgent}
          className="hover-surface inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground"
          title={t("studio.mobile.backToAgent")}
          aria-label={t("studio.mobile.backToAgent")}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
            {t("studio.mobile.reviewMode")}
          </div>
          <div className="truncate text-xs font-semibold text-foreground">
            {review.title}
          </div>
        </div>
      </div>
      {loading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-background p-6 text-xs text-muted-foreground">
          {t("studio.proposal.compareLoading")}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <ChangeReviewBody
            parts={review.parts}
            original={review.original}
            changed={review.changed}
            renderDiff={(original, changed) => <MobileReviewDiff original={original} changed={changed} />}
          />
        </div>
      )}
    </section>
  );
}

export function MobileStudioShell() {
  const { t } = useTranslation("editor");
  const { t: tLearning } = useTranslation("learning");
  const router = useRouter();
  const worldDraft = useEditorStore(s => s.worldDraft);
  const serverWorldId = useEditorStore(s => s.serverWorldId);
  const isDirty = useEditorStore(s => s.isDirty || s.layoutDirty);
  const saving = useEditorStore(s => s.saving);
  const saveDraft = useEditorStore(s => s.saveDraft);
  const setField = useEditorStore(s => s.setField);
  const canUndo = useEditorStore(s => s.canUndo);
  const canRedo = useEditorStore(s => s.canRedo);
  const undo = useEditorStore(s => s.undo);
  const redo = useEditorStore(s => s.redo);
  const variants = useEditorStore(s => s.variants);
  const variantsLoading = useEditorStore(s => s.variantsLoading);
  const variantLabel = useEditorStore(s => s.variantLabel);
  const readOnlyInspect = useEditorStore(s => s.readOnlyInspect);
  const mode = useStudioStore(s => s.mode);
  const setMode = useStudioStore(s => s.setMode);
  const [activePanel, setActivePanel] = useState<MobileStudioPanelId>(() => loadActivePanel(serverWorldId));
  const [moreOpen, setMoreOpen] = useState(false);
  const [reviewPayload, setReviewPayload] = useState<MobileReviewPayload | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [showBundleCreator, setShowBundleCreator] = useState(false);
  const [importingBundle, setImportingBundle] = useState<YuminaBundle | null>(null);
  const apiBase = import.meta.env.VITE_API_URL || "";

  // One place every panel change goes through: the studio store's mode
  // follows the playtest tab, and a change under review is dismissed.
  const showPanel = useCallback((panelId: MobileStudioPanelId) => {
    setActivePanel(panelId);
    setMode(panelId === "playtest" ? "playtest" : "edit");
    setMoreOpen(false);
    setReviewPayload(null);
    setReviewLoading(false);
  }, [setMode]);

  useEffect(() => {
    setMoreOpen(false);
    setReviewPayload(null);
    setReviewLoading(false);
    setShowVersionHistory(false);
    // A hand-off from outside Studio — a starter card opens on its screen.
    // Taken once the card is loaded: the remembered panel is re-read per card
    // and would overwrite a panel chosen before it.
    if (!serverWorldId) return;
    const wanted = takeRequestedPanel(isMobileStudioPanelId);
    setActivePanel(wanted && isMobileStudioPanelId(wanted) ? wanted : loadActivePanel(serverWorldId));
  }, [serverWorldId]);

  useEffect(() => {
    saveActivePanel(serverWorldId, activePanel);
  }, [activePanel, serverWorldId]);

  // The assistant can start a playtest of its own; the screen follows it.
  useEffect(() => {
    if (mode === "playtest" && activePanel !== "playtest") {
      setActivePanel("playtest");
      setReviewPayload(null);
      setReviewLoading(false);
    }
  }, [mode, activePanel]);

  const [showPublishModal, setShowPublishModal] = useState(false);
  const { features } = useEdition();
  const handleSave = useCallback(async () => {
    await saveDraft();
  }, [saveDraft]);

  // Publish / submit-for-review from the phone — same flow as the classic
  // editor + desktop Studio. A draft variant goes through first-publish review.
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
    [router, saving, serverWorldId],
  );

  useEffect(() => {
    const open = (event: Event) => {
      const { panelId: requested, canvasTarget } = (event as CustomEvent<{ panelId: string; canvasTarget?: string }>).detail;
      const panelId = requested === "blueprint" ? "lorebook" : requested;
      if (!isMobileStudioPanelId(panelId)) return;
      showPanel(panelId);
      // The canvas highlights the setting node; the phone has a list instead.
      // Open the entry the guide is talking about, so nobody has to guess
      // which row hides the text box.
      if (canvasTarget === "setting") {
        const entry = useEditorStore.getState().worldDraft.entries.find(item => item.role !== "greeting" && !item.presetId);
        if (entry) useEditorStore.getState().focusObject("entry", entry.id);
      }
    };
    window.addEventListener(LEARNING_PANEL_EVENT, open);
    return () => window.removeEventListener(LEARNING_PANEL_EVENT, open);
  }, [showPanel]);

  const openAgentWorkspace = useCallback(() => showPanel("ai-chat"), [showPanel]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ toolCall?: ToolCall; agentRunId?: string }>).detail;
      if (!detail?.toolCall) return;
      const agentRunId = detail.agentRunId;
      const toolCallId = detail.toolCall.id;
      const canLoadServerReview = !!serverWorldId && !!agentRunId && !!toolCallId;
      const toolCall = detail.toolCall;
      const titleFor = (parts?: ReviewPart[]) =>
        changeReviewTitle(toolCall, t as never, { parts, draft: useEditorStore.getState().worldDraft as never });
      const fallbackReview = { ...buildMobileReviewPayload(toolCall), title: titleFor() };
      setReviewPayload(fallbackReview);
      setReviewLoading(canLoadServerReview);
      setMoreOpen(false);
      if (!canLoadServerReview) return;

      fetch(`${apiBase}/api/studio/${serverWorldId}/agent/changes/${encodeURIComponent(agentRunId!)}/${encodeURIComponent(toolCallId)}`, {
        credentials: "include",
      })
        .then((res) => {
          if (!res.ok) throw new Error("Change data unavailable");
          return res.json();
        })
        .then(({ data }) => {
          if (data && typeof data === "object") {
            const payload = data as MobileServerReviewPayload;
            setReviewPayload({ ...payload, title: titleFor(payload.parts) });
          }
        })
        .catch(() => {})
        .finally(() => setReviewLoading(false));
    };
    window.addEventListener("yumina:studio-mobile-review", handler);
    return () => window.removeEventListener("yumina:studio-mobile-review", handler);
  }, [apiBase, serverWorldId, t]);

  // A request written for the assistant elsewhere (「让创作助手翻译成 English」)
  // has to land in a visible composer. On a phone the assistant is a panel
  // that mounts only when shown, so show it, then hand the request over again
  // once it is there to receive it.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<StudioAskDetail & { replayed?: boolean }>).detail;
      if (!detail?.prompt || detail.replayed) return;
      showPanel("ai-chat");
      window.setTimeout(() => {
        window.dispatchEvent(new CustomEvent(STUDIO_ASK_EVENT, { detail: { ...detail, replayed: true } }));
      }, 400);
    };
    window.addEventListener(STUDIO_ASK_EVENT, handler);
    return () => window.removeEventListener(STUDIO_ASK_EVENT, handler);
  }, [showPanel]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // Undo/redo leave text fields to their own undo — see studio-shell.
      const typing = event.isComposing || ownsTypingUndo(event.target);
      if (!typing && (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === "z") {
        event.preventDefault();
        useEditorStore.getState().undo();
      }
      if (
        !typing &&
        (event.ctrlKey || event.metaKey) &&
        (event.key === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))
      ) {
        event.preventDefault();
        useEditorStore.getState().redo();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        const state = useEditorStore.getState();
        if (state.isDirty && !state.saving) state.saveDraft();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const isPlaytest = mode === "playtest";
  const reviewing = reviewPayload !== null;
  const moreActive = !reviewing && !isTabPanel(activePanel);

  // Off on the Studio pill (→ 完整) or 简单模式 in ⋮ (→ 简单): the same /edit
  // route, which renders whichever editor this card's mode now says. The
  // choice is remembered first, or /edit would send them straight back here.
  const leaveStudio = (choice: Exclude<EditorChoice, "visual">) => {
    if (!serverWorldId) {
      navigateBackSafely(router.history, "/app/library");
      return;
    }
    if (choice === "simple") setField("editorMode", "simple");
    rememberEditorChoice(serverWorldId, choice);
    void router.navigate({
      to: "/app/worlds/$worldId/edit",
      params: { worldId: serverWorldId },
    });
  };
  const switchToSimple = () => leaveStudio("simple");

  const backToLibrary = () => {
    // The library with this card selected, like the desktop canvas's back
    // arrow. The card's own address on the way out, not history-back.
    if (serverWorldId) {
      void router.navigate({ to: "/app/library", search: { worldId: serverWorldId } });
    } else {
      navigateBackSafely(router.history, "/app/library");
    }
  };

  return (
    <div className="mobile-studio-shell flex h-full min-h-0 w-full flex-col overflow-hidden overscroll-none bg-background">
      <header
        className={cn(
          "flex shrink-0 flex-col gap-1 border-b px-2 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] transition-colors",
          isPlaytest ? "border-emerald-500/40 bg-emerald-950/10" : "border-border bg-background/95",
        )}
      >
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={backToLibrary}
            className="hover-surface inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground"
            title={t("studio.backToLibrary")}
            aria-label={t("studio.backToLibrary")}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          {/* Studio, on — the same pill as the 完整 editor's, which turns it
              on. Off is the way back to 完整; 简单模式 is in ⋮. */}
          <VisualSurfaceSwitch
            on
            surface="studio"
            className="mr-auto h-9 rounded-xl"
            onToggle={() => leaveStudio("classic")}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="hover-surface inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground"
                title={t("studio.moreActions")}
                aria-label={t("studio.moreActions")}
              >
                <MoreVertical className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {/* The desktop strings carry their shortcut; a phone has no Ctrl. */}
              <DropdownMenuItem onClick={undo} disabled={!canUndo} className="min-h-11 gap-2 text-xs">
                <Undo2 className="h-3.5 w-3.5 text-muted-foreground" />
                {withoutShortcut(t("studio.undo"))}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={redo} disabled={!canRedo} className="min-h-11 gap-2 text-xs">
                <Redo2 className="h-3.5 w-3.5 text-muted-foreground" />
                {withoutShortcut(t("studio.redo"))}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => window.dispatchEvent(new Event(LEARNING_OPEN_EVENT))}
                className="min-h-11 gap-2 text-xs"
                data-learning="help"
              >
                <GraduationCap className="h-3.5 w-3.5 text-muted-foreground" />
                {tLearning("help")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => window.open(DOCS_URLS.canvas, "_blank", "noopener,noreferrer")}
                className="min-h-11 gap-2 text-xs"
                data-studio-docs=""
              >
                <BookOpen className="h-3.5 w-3.5 text-muted-foreground" />
                {t("shell.creatorGuide")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setShowVersionHistory(true)}
                disabled={!serverWorldId || readOnlyInspect}
                className="min-h-11 gap-2 text-xs"
              >
                <History className="h-3.5 w-3.5 text-muted-foreground" />
                {t("versionHistory.menuItem")}
              </DropdownMenuItem>
              {features.bundles && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => showPanel("marketplace")} className="min-h-11 gap-2 text-xs">
                    <Package className="h-3.5 w-3.5 text-muted-foreground" />
                    {t("studio.panels.marketplace")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setShowImportModal(true)} className="min-h-11 gap-2 text-xs">
                    <Download className="h-3.5 w-3.5 text-muted-foreground" />
                    {t("studio.importBundle")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setShowBundleCreator(true)} className="min-h-11 gap-2 text-xs">
                    <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                    {t("studio.exportBundle")}
                  </DropdownMenuItem>
                </>
              )}
              {serverWorldId && !readOnlyInspect && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={switchToSimple} className="min-h-11 gap-2 text-xs" data-editor-menu-mode="simple">
                    <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
                    {t("shell.menuSimpleMode")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {!readOnlyInspect && (
            <button
              type="button"
              onClick={handleSave}
              data-onboarding="save"
              disabled={saving || !isDirty}
              className="relative inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-semibold text-primary-foreground transition-opacity disabled:opacity-40"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              <span className="max-[399px]:sr-only">{t("studio.save")}</span>
              {isDirty && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-background bg-amber-300" />}
            </button>
          )}
          {/* Publish + review state in one control (green when live & clean;
              otherwise shows the state + opens a popover with the action). */}
          {!readOnlyInspect && features.publishing && (
            <ReviewStateControl onPublish={handlePublishClick} size="sm" disabled={saving || !serverWorldId} />
          )}
          {!readOnlyInspect && !features.publishing && (
            <ExportCardMenu worldId={serverWorldId} size="sm" disabled={saving || !serverWorldId} />
          )}
        </div>
        <div className="flex min-w-0 items-center gap-1 px-1">
          <input
            type="text"
            data-onboarding="name"
            value={isPlaceholderCardName(worldDraft.name) ? "" : worldDraft.name}
            onChange={(e) => setField("name", e.target.value)}
            placeholder={t("shell.namePlaceholder", { defaultValue: "Untitled" })}
            readOnly={readOnlyInspect}
            className={cn(
              "h-9 w-full min-w-0 truncate rounded-lg bg-transparent px-1.5 text-base font-semibold text-foreground placeholder:text-amber-200/55 focus:outline-none",
              isPlaceholderCardName(worldDraft.name) && !readOnlyInspect && "ring-1 ring-amber-400/40",
            )}
          />
          {variants.length >= 2 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-8 max-w-[6rem] shrink-0 items-center gap-1 rounded-full border border-border/70 px-2 text-[11px] font-medium text-muted-foreground"
                >
                  <span className="truncate">
                    {currentVariantTrigger(variants, serverWorldId, variantLabel, t("studio.variant"))}
                  </span>
                  {variantsLoading ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" /> : <ChevronDown className="h-3 w-3 shrink-0" />}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                {variants.map((variant) => {
                  const isActive = variant.id === serverWorldId;
                  const sameLangCount = variants.filter((x) => (x.language ?? "") === (variant.language ?? "")).length;
                  const showStar = variant.isPrimaryVariant && sameLangCount >= 2;
                  // Show 设为主 for any same-language 副 (discoverable); a draft one
                  // is muted + guides to publish first.
                  const canPromote = variant.isPrimaryVariant === false && sameLangCount >= 2;
                  const promoteReady = canPromote && variant.status === "published";
                  return (
                    <DropdownMenuItem
                      key={variant.id}
                      onClick={() => handleVariantSwitch(variant.id)}
                      disabled={isActive || saving}
                      className={cn("flex items-center gap-2 text-xs", isActive && "bg-primary/10")}
                    >
                      <span className="min-w-0 flex-1 truncate">{variantRowLabels(variants).get(variant.id) ?? (variant.variantLabel || variant.name)}</span>
                      {variant.language && (
                        <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
                          {LANGUAGE_SHORT[variant.language] ?? variant.language.toUpperCase()}
                        </span>
                      )}
                      {showStar && <Star className="h-3.5 w-3.5 shrink-0 fill-[#C9A25E] text-[#C9A25E]" aria-label={t("variantBar.primaryBadge", "主")} />}
                      {/* Only a published version can be promoted. The button
                          stays visible but disabled, labelled "(publish
                          first)", so the reason sits on the control. */}
                      {canPromote && (
                        <button
                          type="button"
                          disabled={!promoteReady}
                          onClick={(e) => {
                            e.stopPropagation();
                            void useEditorStore.getState().setPrimary(variant.id);
                          }}
                          title={promoteReady ? t("variantBar.setPrimary", "Set as primary") : t("variantBar.setPrimaryDraft", "Set as primary (publish first)")}
                          className={cn(
                            "shrink-0 rounded-full p-1 transition-colors",
                            promoteReady
                              ? "text-muted-foreground/60 active:bg-[#C9A25E]/15 active:text-[#C9A25E]"
                              : "cursor-not-allowed text-muted-foreground/30",
                          )}
                        >
                          <Star className="h-3.5 w-3.5" />
                        </button>
                      )}
                      {isActive && <Check className="h-3.5 w-3.5 text-primary" />}
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </header>

      <VariantTranslateBanner />

      <main className="min-h-0 flex-1 overflow-hidden">
        {reviewing && reviewPayload ? (
          <MobileReviewFrame
            review={reviewPayload}
            loading={reviewLoading}
            onBackToAgent={openAgentWorkspace}
          />
        ) : (
          <MobilePanelRenderer panelId={activePanel} />
        )}
      </main>

      <nav
        className="grid shrink-0 grid-cols-5 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
        aria-label={t("studio.mobile.quickActions")}
      >
        {TAB_PANELS.map((panelId) => {
          const Icon = TAB_ICONS[panelId];
          const active = !reviewing && activePanel === panelId;
          const assistant = panelId === "ai-chat";
          return (
            <button
              key={panelId}
              type="button"
              aria-pressed={active}
              data-onboarding={assistant ? "assistant" : panelId === "playtest" ? "playtest" : undefined}
              onClick={() => showPanel(panelId)}
              className={cn(
                "flex min-h-[3.5rem] flex-col items-center justify-center gap-1 text-[10px] font-semibold transition-colors",
                active ? "text-primary" : "text-muted-foreground active:text-foreground",
              )}
            >
              <span
                className={cn(
                  "inline-flex h-7 w-11 items-center justify-center rounded-full transition-colors",
                  active && "bg-primary/15",
                  // The assistant is the tab to find: gold even when it is not
                  // the one open.
                  assistant && !active && "text-primary/80",
                )}
              >
                <Icon className={cn("h-[18px] w-[18px]", assistant && active && "fill-primary/20")} />
              </span>
              <span className="leading-none">{t(TAB_LABEL_KEYS[panelId] as never)}</span>
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={moreActive}
          aria-haspopup="dialog"
          onClick={() => setMoreOpen(true)}
          className={cn(
            "flex min-h-[3.5rem] flex-col items-center justify-center gap-1 text-[10px] font-semibold transition-colors",
            moreActive ? "text-primary" : "text-muted-foreground active:text-foreground",
          )}
        >
          <span className={cn("inline-flex h-7 w-11 items-center justify-center rounded-full transition-colors", moreActive && "bg-primary/15")}>
            <LayoutGrid className="h-[18px] w-[18px]" />
          </span>
          {/* When a panel from the sheet is open, the tab says which one. */}
          <span className="max-w-full truncate px-1 leading-none">
            {moreActive ? t(MOBILE_PANEL_LABEL_KEYS[activePanel] as never) : t("studio.mobile.tabMore")}
          </span>
        </button>
      </nav>

      <MorePanelsSheet
        open={moreOpen}
        currentPanel={activePanel}
        onClose={() => setMoreOpen(false)}
        onSelect={showPanel}
      />
      {showBundleCreator && (
        <BundleCreator onClose={() => setShowBundleCreator(false)} />
      )}
      <Suspense fallback={null}>
        {showVersionHistory && serverWorldId && !readOnlyInspect && (
          <VersionHistoryDialog
            key={serverWorldId}
            worldId={serverWorldId}
            onClose={() => setShowVersionHistory(false)}
          />
        )}
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
      {importingBundle && (
        <BundleImporter
          bundle={importingBundle}
          onClose={() => setImportingBundle(null)}
        />
      )}
    </div>
  );
}
