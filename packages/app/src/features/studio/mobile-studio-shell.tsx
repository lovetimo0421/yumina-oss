import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { navigateBackSafely } from "@/lib/safe-back";
import type { IDockviewPanelProps } from "dockview-react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  GripHorizontal,
  Layers2,
  Loader2,
  Maximize2,
  MessageSquare,
  MoreVertical,
  Package,
  Play,
  Redo2,
  RotateCcw,
  Save,
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
import { useEditorStore } from "@/stores/editor";
import { useWorldsStore } from "@/stores/worlds";
import { useStudioStore } from "@/stores/studio";
import type { YuminaBundle } from "@yumina/engine";
import { BundleCreator, BundleImporter, ImportBundleModal, WorldPublishModal } from "@/edition/slots";
import { useEdition } from "@/edition/edition";
import { ExportCardMenu } from "../editor/export-card-menu";
import { ReviewStateControl } from "../editor/review-state-control";
import { feedback } from "@/lib/feedback";
import { AudioSection } from "../editor/sections/audio";
import { BehaviorsSection } from "../editor/sections/behaviors-section";
import { EntriesSection } from "../editor/sections/entries";
import { VariablesSection } from "../editor/sections/variables";
import {
  AiChatPanel,
  AssetsPanel,
  AudioPanel,
  BundlesPanel,
  CanvasPanel,
  CodeViewPanel,
  FirstMessagePanel,
  LorebookPanel,
  OverviewPanel,
  PlaytestPanel,
  RulesPanel,
  SidebarPanel,
  VariablesPanel,
} from "./panels";
import { PANEL_MENU_GROUPS, type StudioPanelMenuItem } from "./studio-page-catalog";
import type { ToolCall } from "./lib/types";
import { buildReviewDiffTokens } from "./lib/review-diff";


type MobilePane = "active" | "top" | "bottom";
type MobileWorkspaceMode = "single" | "split" | "review";

type MobileStudioPanelId =
  | "ai-chat"
  | "lorebook"
  | "variables"
  | "rules"
  | "first-message"
  | "assets"
  | "audio"
  | "canvas"
  | "code-view"
  | "overview"
  | "playtest"
  | "sidebar"
  | "marketplace";

type MobileLayoutState = {
  mode: MobileWorkspaceMode;
  activePanel: MobileStudioPanelId;
  topPanel: MobileStudioPanelId;
  bottomPanel: MobileStudioPanelId;
  splitPercent: number;
};

const DEFAULT_MOBILE_LAYOUT: MobileLayoutState = {
  mode: "single",
  activePanel: "ai-chat",
  topPanel: "ai-chat",
  bottomPanel: "lorebook",
  splitPercent: 50,
};

type MobileReviewPayload = {
  title: string;
  toolName: string;
  changed: string;
  original: string;
};

type MobileServerReviewPayload = MobileReviewPayload & {
  source?: string;
};

const MOBILE_PANEL_COMPONENTS: Record<MobileStudioPanelId, React.FC<IDockviewPanelProps>> = {
  "ai-chat": AiChatPanel,
  lorebook: LorebookPanel,
  variables: VariablesPanel,
  rules: RulesPanel,
  "first-message": FirstMessagePanel,
  assets: AssetsPanel,
  audio: AudioPanel,
  canvas: CanvasPanel,
  "code-view": CodeViewPanel,
  overview: OverviewPanel,
  playtest: PlaytestPanel,
  sidebar: SidebarPanel,
  marketplace: BundlesPanel,
};

const MOBILE_PANEL_LABEL_KEYS: Record<MobileStudioPanelId, string> = {
  "ai-chat": "studio.panels.aiAssistant",
  lorebook: "studio.panels.lorebook",
  variables: "studio.panels.variables",
  rules: "studio.panels.behaviors",
  "first-message": "studio.panels.firstMessage",
  assets: "studio.panels.assets",
  audio: "studio.panels.audio",
  canvas: "studio.panels.canvas",
  "code-view": "studio.panels.frontEndCode",
  overview: "studio.panels.overview",
  playtest: "studio.panels.playtest",
  sidebar: "studio.panels.previewControls",
  marketplace: "studio.panels.marketplace",
};

const MOBILE_PANEL_IDS = new Set<MobileStudioPanelId>(Object.keys(MOBILE_PANEL_COMPONENTS) as MobileStudioPanelId[]);
const MIN_SPLIT_PERCENT = 28;
const MAX_SPLIT_PERCENT = 72;

function getMobileLayoutKey(worldId: string) {
  return `yumina-studio-mobile-layout-${worldId}`;
}

function isMobileStudioPanelId(id: string): id is MobileStudioPanelId {
  return MOBILE_PANEL_IDS.has(id as MobileStudioPanelId);
}

function clampSplitPercent(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_MOBILE_LAYOUT.splitPercent;
  return Math.max(MIN_SPLIT_PERCENT, Math.min(MAX_SPLIT_PERCENT, Math.round(value)));
}

function isMobileWorkspaceMode(mode: unknown): mode is MobileWorkspaceMode {
  return mode === "single" || mode === "split" || mode === "review";
}

function loadMobileLayout(worldId: string | null): MobileLayoutState {
  if (typeof window === "undefined") return DEFAULT_MOBILE_LAYOUT;

  try {
    const saved = localStorage.getItem(getMobileLayoutKey(worldId ?? "new"));
    if (!saved) return DEFAULT_MOBILE_LAYOUT;
    const parsed = JSON.parse(saved) as Partial<MobileLayoutState>;
    return {
      mode: isMobileWorkspaceMode(parsed.mode) ? parsed.mode : DEFAULT_MOBILE_LAYOUT.mode,
      activePanel: parsed.activePanel && isMobileStudioPanelId(parsed.activePanel) ? parsed.activePanel : DEFAULT_MOBILE_LAYOUT.activePanel,
      topPanel: parsed.topPanel && isMobileStudioPanelId(parsed.topPanel) ? parsed.topPanel : DEFAULT_MOBILE_LAYOUT.topPanel,
      bottomPanel: parsed.bottomPanel && isMobileStudioPanelId(parsed.bottomPanel) ? parsed.bottomPanel : DEFAULT_MOBILE_LAYOUT.bottomPanel,
      splitPercent: clampSplitPercent(parsed.splitPercent ?? DEFAULT_MOBILE_LAYOUT.splitPercent),
    };
  } catch {
    return DEFAULT_MOBILE_LAYOUT;
  }
}

function saveMobileLayout(worldId: string | null, layout: MobileLayoutState) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(getMobileLayoutKey(worldId ?? "new"), JSON.stringify({
      ...layout,
      mode: layout.mode === "review" ? "single" : layout.mode,
    }));
  } catch {
    // Layout persistence is a convenience; editor data is saved separately.
  }
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

  if (toolName === "delete_entities") {
    const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === "string") : [];
    const collections = [
      ...(draft.entries as unknown[] | undefined ?? []),
      ...(draft.variables as unknown[] | undefined ?? []),
      ...(draft.reactions as unknown[] | undefined ?? []),
      ...(draft.rules as unknown[] | undefined ?? []),
      ...(draft.audioTracks as unknown[] | undefined ?? []),
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
  if (panelId === "variables") {
    return <VariablesSection compact mobileListMode />;
  }
  if (panelId === "rules") {
    return <BehaviorsSection compact mobileListMode />;
  }
  if (panelId === "audio") {
    return <AudioSection compact mobileListMode />;
  }

  const Component = MOBILE_PANEL_COMPONENTS[panelId];
  return <Component {...({} as IDockviewPanelProps)} />;
}

function MobilePaneFrame({
  pane,
  panelId,
  focused,
  onPickPanel,
  onFocus,
}: {
  pane: MobilePane;
  panelId: MobileStudioPanelId;
  focused: boolean;
  onPickPanel: (pane: MobilePane) => void;
  onFocus: (pane: MobilePane) => void;
}) {
  const { t } = useTranslation("editor");
  const paneLabel = pane === "active"
    ? t("studio.mobile.workspacePane")
    : pane === "top"
      ? t("studio.mobile.topPane")
      : t("studio.mobile.bottomPane");
  const panelLabel = t(MOBILE_PANEL_LABEL_KEYS[panelId] as never);

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border/70 bg-background shadow-[0_18px_45px_rgba(0,0,0,0.18)]">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-muted/30 px-2">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
            {paneLabel}
          </div>
          <div className="truncate text-xs font-semibold text-foreground">
            {panelLabel}
          </div>
        </div>
        <button
          type="button"
          onClick={() => onPickPanel(pane)}
          className="inline-flex h-8 items-center gap-1 rounded-full border border-border/70 bg-background/80 px-2 text-[11px] font-medium text-muted-foreground transition hover:border-primary/60 hover:text-foreground"
        >
          <Layers2 className="h-3.5 w-3.5" />
          {t("studio.mobile.switchPanel")}
        </button>
        <button
          type="button"
          onClick={() => onFocus(pane)}
          className={cn(
            "inline-flex h-8 w-8 items-center justify-center rounded-full border transition",
            focused
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border/70 bg-background/80 text-muted-foreground hover:border-primary/60 hover:text-foreground",
          )}
          title={pane === "active" ? t("studio.mobile.openSplit") : focused ? t("studio.mobile.backToSplit") : t("studio.mobile.focusPane")}
        >
          {focused ? <X className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <MobilePanelRenderer panelId={panelId} />
      </div>
    </section>
  );
}

function MobilePanelPicker({
  open,
  pane,
  currentPanel,
  onClose,
  onSelect,
}: {
  open: boolean;
  pane: MobilePane | null;
  currentPanel: MobileStudioPanelId;
  onClose: () => void;
  onSelect: (panelId: MobileStudioPanelId) => void;
}) {
  const { t } = useTranslation("editor");

  const groups = useMemo(() => {
    const baseGroups = PANEL_MENU_GROUPS.map(group => ({
      labelKey: group.labelKey,
      items: group.items.filter(item => isMobileStudioPanelId(item.id) && item.id !== "ai-chat"),
    })).filter(group => group.items.length > 0);

    return [
      {
        labelKey: "studio.mobile.quickActions",
        items: [
          {
            id: "ai-chat",
            labelKey: "studio.panels.aiAssistant",
            icon: MessageSquare,
          },
          {
            id: "playtest",
            labelKey: "studio.panels.playtest",
            icon: Play,
          },
        ] satisfies StudioPanelMenuItem[],
      },
      ...baseGroups,
    ];
  }, []);

  if (!open || !pane) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center bg-black/55 px-2 pt-[calc(env(safe-area-inset-top)+0.75rem)] pb-[calc(env(safe-area-inset-bottom)+0.75rem)] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom)-1.5rem)] w-full overflow-hidden rounded-3xl border border-border/80 bg-background shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
          <div>
            <div className="text-sm font-semibold text-foreground">{t("studio.mobile.choosePanel")}</div>
            <div className="text-xs text-muted-foreground">
              {pane === "active"
                ? t("studio.mobile.workspacePane")
                : pane === "top"
                  ? t("studio.mobile.topPane")
                  : t("studio.mobile.bottomPane")}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/70 text-muted-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[calc(100dvh-env(safe-area-inset-top)-env(safe-area-inset-bottom)-5.75rem)] space-y-3 overflow-y-auto px-4 py-3">
          {groups.map(group => (
            <div key={group.labelKey} className="space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
                {t(group.labelKey as never)}
              </div>
              <div className="grid grid-cols-2 gap-2">
                {group.items.map(item => {
                  const Icon = item.icon;
                  const id = item.id as MobileStudioPanelId;
                  const active = id === currentPanel;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onSelect(id)}
                      className={cn(
                        "flex min-h-12 items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left transition",
                        active
                          ? "border-primary/70 bg-primary/10 text-foreground"
                          : "border-border/70 bg-muted/20 text-muted-foreground hover:border-primary/50 hover:text-foreground",
                      )}
                    >
                      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-background/80">
                        <Icon className="h-4 w-4" />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                        {t(item.labelKey as never)}
                      </span>
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

function MobileReviewFrame({
  review,
  loading,
  onBackToAgent,
  onOpenSplit,
}: {
  review: MobileReviewPayload;
  loading?: boolean;
  onBackToAgent: () => void;
  onOpenSplit: () => void;
}) {
  const { t } = useTranslation("editor");

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border/70 bg-background shadow-[0_18px_45px_rgba(0,0,0,0.18)]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/60 bg-muted/30 px-3">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
            {t("studio.mobile.reviewMode")}
          </div>
          <div className="truncate text-xs font-semibold text-foreground">
            {review.title}
          </div>
        </div>
        <button
          type="button"
          onClick={onOpenSplit}
          className="inline-flex h-8 items-center gap-1 rounded-full border border-border/70 bg-background/80 px-2 text-[11px] font-medium text-muted-foreground transition hover:border-primary/60 hover:text-foreground"
        >
          <Layers2 className="h-3.5 w-3.5" />
          {t("studio.mobile.openSplit")}
        </button>
        <button
          type="button"
          onClick={onBackToAgent}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border/70 bg-background/80 text-muted-foreground transition hover:border-primary/60 hover:text-foreground"
          title={t("studio.mobile.backToAgent")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {loading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-background p-6 text-xs text-muted-foreground">
          {t("studio.proposal.compareLoading")}
        </div>
      ) : (
        <MobileReviewDiff original={review.original} changed={review.changed} />
      )}
    </section>
  );
}

export function MobileStudioShell() {
  const { t } = useTranslation("editor");
  const router = useRouter();
  const worldDraft = useEditorStore(s => s.worldDraft);
  const serverWorldId = useEditorStore(s => s.serverWorldId);
  const isDirty = useEditorStore(s => s.isDirty);
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
  const [layout, setLayout] = useState<MobileLayoutState>(() => loadMobileLayout(serverWorldId));
  const [focusedPane, setFocusedPane] = useState<MobilePane | null>(null);
  const [pickerPane, setPickerPane] = useState<MobilePane | null>(null);
  const [reviewPayload, setReviewPayload] = useState<MobileReviewPayload | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showBundleCreator, setShowBundleCreator] = useState(false);
  const [importingBundle, setImportingBundle] = useState<YuminaBundle | null>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{ pointerId: number } | null>(null);
  const apiBase = import.meta.env.VITE_API_URL || "";

  useEffect(() => {
    setLayout(loadMobileLayout(serverWorldId));
    setFocusedPane(null);
    setPickerPane(null);
    setReviewPayload(null);
    setReviewLoading(false);
  }, [serverWorldId]);

  useEffect(() => {
    saveMobileLayout(serverWorldId, layout);
  }, [layout, serverWorldId]);

  const updateLayout = useCallback((updates: Partial<MobileLayoutState>) => {
    setLayout(current => ({
      ...current,
      ...updates,
      splitPercent: clampSplitPercent(updates.splitPercent ?? current.splitPercent),
    }));
  }, []);

  const [showPublishModal, setShowPublishModal] = useState(false);
  const { features } = useEdition();
  const handleSave = useCallback(async () => {
    saveMobileLayout(serverWorldId, layout);
    await saveDraft();
  }, [layout, saveDraft, serverWorldId]);

  // Publish / submit-for-review from mobile Studio — same flow as the classic
  // editor + desktop Studio. A draft variant goes through first-publish review.
  const handlePublishClick = useCallback(async () => {
    saveMobileLayout(serverWorldId, layout);
    if (useEditorStore.getState().isDirty) {
      const ok = await saveDraft();
      if (!ok) return;
    }
    if (!useEditorStore.getState().serverWorldId) {
      feedback.error(t("shell.saveWorldFirst", "Save the world first"));
      return;
    }
    setShowPublishModal(true);
  }, [layout, saveDraft, serverWorldId, t]);

  const handleVariantSwitch = useCallback(
    async (targetWorldId: string) => {
      if (targetWorldId === serverWorldId || saving) return;
      saveMobileLayout(serverWorldId, layout);
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
    [layout, router, saving, serverWorldId],
  );

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (focusedPane) return;
    dragStateRef.current = { pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [focusedPane]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragStateRef.current || dragStateRef.current.pointerId !== event.pointerId) return;
    const rect = splitContainerRef.current?.getBoundingClientRect();
    if (!rect || rect.height <= 0) return;
    const nextPercent = ((event.clientY - rect.top) / rect.height) * 100;
    updateLayout({ splitPercent: nextPercent });
  }, [updateLayout]);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (dragStateRef.current?.pointerId === event.pointerId) {
      dragStateRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const selectPanelForPicker = useCallback((panelId: MobileStudioPanelId) => {
    if (!pickerPane) return;
    updateLayout(
      pickerPane === "active"
        ? { activePanel: panelId, mode: "single" }
        : pickerPane === "top"
          ? { topPanel: panelId, mode: "split" }
          : { bottomPanel: panelId, mode: "split" },
    );
    if (panelId === "playtest") setMode("playtest");
    if (panelId !== "playtest" && mode === "playtest") setMode("edit");
    setReviewPayload(null);
    setReviewLoading(false);
    setPickerPane(null);
  }, [mode, pickerPane, setMode, updateLayout]);

  const resetSplit = useCallback(() => {
    updateLayout({ splitPercent: DEFAULT_MOBILE_LAYOUT.splitPercent, mode: "split" });
    setFocusedPane(null);
  }, [updateLayout]);

  const openSingleWorkspace = useCallback(() => {
    updateLayout({ mode: "single", activePanel: layout.activePanel === "playtest" && mode !== "playtest" ? "ai-chat" : layout.activePanel });
    setFocusedPane(null);
    setReviewPayload(null);
    setReviewLoading(false);
  }, [layout.activePanel, mode, updateLayout]);

  const openAgentWorkspace = useCallback(() => {
    updateLayout({ mode: "single", activePanel: "ai-chat" });
    setFocusedPane(null);
    setReviewPayload(null);
    setReviewLoading(false);
  }, [updateLayout]);

  const openSplitWorkspace = useCallback(() => {
    updateLayout({ mode: "split" });
    setFocusedPane(null);
    setReviewPayload(null);
    setReviewLoading(false);
  }, [updateLayout]);

  const openMarketplace = useCallback(() => {
    updateLayout({ mode: "single", activePanel: "marketplace" });
    setFocusedPane(null);
    setReviewPayload(null);
    setReviewLoading(false);
  }, [updateLayout]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ toolCall?: ToolCall; agentRunId?: string }>).detail;
      if (!detail?.toolCall) return;
      const agentRunId = detail.agentRunId;
      const toolCallId = detail.toolCall.id;
      const canLoadServerReview = !!serverWorldId && !!agentRunId && !!toolCallId;
      const fallbackReview = buildMobileReviewPayload(detail.toolCall);
      setReviewPayload(fallbackReview);
      setReviewLoading(canLoadServerReview);
      setFocusedPane(null);
      updateLayout({ mode: "review" });
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
            setReviewPayload(data as MobileServerReviewPayload);
          }
        })
        .catch(() => {})
        .finally(() => setReviewLoading(false));
    };
    window.addEventListener("yumina:studio-mobile-review", handler);
    return () => window.removeEventListener("yumina:studio-mobile-review", handler);
  }, [apiBase, serverWorldId, updateLayout]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key === "z") {
        event.preventDefault();
        useEditorStore.getState().undo();
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        (event.key === "y" || (event.shiftKey && event.key.toLowerCase() === "z"))
      ) {
        event.preventDefault();
        useEditorStore.getState().redo();
      }
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        const state = useEditorStore.getState();
        if (state.isDirty && !state.saving) {
          saveMobileLayout(serverWorldId, layout);
          state.saveDraft();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [layout, serverWorldId]);

  const isPlaytest = mode === "playtest";
  const workspaceMode = reviewPayload ? "review" : layout.mode;
  const activePanel = layout.activePanel;
  const topPanel = layout.topPanel;
  const bottomPanel = layout.bottomPanel;
  const focusedPanel = focusedPane === "top" ? topPanel : focusedPane === "bottom" ? bottomPanel : null;
  const pickerCurrentPanel = pickerPane === "active" ? activePanel : pickerPane === "top" ? topPanel : bottomPanel;

  return (
    <div className="mobile-studio-shell flex h-[100dvh] min-h-0 w-full flex-col overflow-hidden overscroll-none bg-background">
      <div
        className={cn(
          "shrink-0 border-b px-3 pb-2 pt-[calc(env(safe-area-inset-top)+0.5rem)] transition-colors",
          isPlaytest ? "border-emerald-500/40 bg-emerald-950/10" : "border-border bg-background/95",
        )}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              saveMobileLayout(serverWorldId, layout);
              navigateBackSafely(
                router.history,
                serverWorldId ? `/app/worlds/${encodeURIComponent(serverWorldId)}/edit` : "/app/library",
              );
            }}
            className="hover-surface inline-flex h-9 w-9 items-center justify-center rounded-xl text-muted-foreground"
            title={t("studio.backToEditor")}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>

          <div className="min-w-0 flex-1">
            <input
              type="text"
              value={worldDraft.name}
              onChange={(e) => setField("name", e.target.value)}
              placeholder={t("shell.namePlaceholder", { defaultValue: "Untitled" })}
              readOnly={readOnlyInspect}
              className="w-full min-w-0 truncate bg-transparent text-sm font-semibold text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
            />
            {variants.length >= 2 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="mt-0.5 inline-flex max-w-full items-center gap-1 rounded-full text-[11px] font-medium text-muted-foreground"
                  >
                    <span className="truncate">
                      {variantLabel || variants.find((variant) => variant.id === serverWorldId)?.variantLabel || t("studio.variant")}
                    </span>
                    {variantsLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronDown className="h-3 w-3" />}
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
                        <span className="min-w-0 flex-1 truncate">{variant.variantLabel || variant.name}</span>
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

          <button
            type="button"
            onClick={undo}
            disabled={!canUndo}
            className="hover-surface inline-flex h-9 w-8 items-center justify-center rounded-xl text-muted-foreground disabled:opacity-30"
            title={t("studio.undo")}
          >
            <Undo2 className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={!canRedo}
            className="hover-surface inline-flex h-9 w-8 items-center justify-center rounded-xl text-muted-foreground disabled:opacity-30"
            title={t("studio.redo")}
          >
            <Redo2 className="h-4 w-4" />
          </button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="hover-surface inline-flex h-9 w-8 items-center justify-center rounded-xl text-muted-foreground"
                title={t("studio.moreActions")}
              >
                <MoreVertical className="h-4 w-4" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={openSingleWorkspace} className="gap-2 text-xs">
                <Maximize2 className="h-3.5 w-3.5 text-muted-foreground" />
                {t("studio.mobile.singleWorkspaceAction")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={openSplitWorkspace} className="gap-2 text-xs">
                <Layers2 className="h-3.5 w-3.5 text-muted-foreground" />
                {t("studio.mobile.splitWorkspaceAction")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={resetSplit} className="gap-2 text-xs">
                <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
                {t("studio.mobile.resetSplit")}
              </DropdownMenuItem>
              {features.bundles && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setShowImportModal(true)} className="gap-2 text-xs">
                    <Download className="h-3.5 w-3.5 text-muted-foreground" />
                    {t("studio.importBundle")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setShowBundleCreator(true)} className="gap-2 text-xs">
                    <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                    {t("studio.exportBundle")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !isDirty}
            className="relative inline-flex h-9 items-center gap-1.5 rounded-xl bg-primary px-3 text-xs font-semibold text-primary-foreground transition-opacity disabled:opacity-40"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {t("studio.save")}
            {isDirty && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-background bg-amber-300" />}
          </button>
          {/* Publish + review state in one control (green when live & clean;
              otherwise shows the state + opens a popover with the action). */}
          {!readOnlyInspect && features.publishing && (
            <ReviewStateControl onPublish={handlePublishClick} size="sm" disabled={saving || !serverWorldId} />
          )}
          {!readOnlyInspect && !features.publishing && (
            <ExportCardMenu worldId={serverWorldId} size="sm" disabled={saving || !serverWorldId} />
          )}
        </div>

        {/* Marketplace CTA — slim primary-tinted row mirrors the simple editor's
            "browse community bundles" card. Hidden once marketplace is the
            active panel so the row doesn't shout at users already there. */}
        {features.bundles && activePanel !== "marketplace" && topPanel !== "marketplace" && bottomPanel !== "marketplace" && (
          <button
            type="button"
            onClick={openMarketplace}
            className="mt-2 flex w-full items-center gap-2 rounded-xl border border-primary/30 bg-primary/[0.08] px-3 py-1.5 text-xs font-semibold text-primary transition-colors hover:border-primary/50 hover:bg-primary/[0.15]"
          >
            <Package className="h-3.5 w-3.5 shrink-0" />
            <span className="flex-1 truncate text-left">{t("studio.panels.marketplace")}</span>
            <span className="hidden truncate text-[10px] font-normal text-primary/70 min-[360px]:inline">
              {t("studio.openMarketplace")}
            </span>
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-primary/70" />
          </button>
        )}

      </div>

      <div ref={splitContainerRef} className="min-h-0 flex-1 overflow-hidden p-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)]">
        {workspaceMode === "review" && reviewPayload ? (
          <MobileReviewFrame
            review={reviewPayload}
            loading={reviewLoading}
            onBackToAgent={openAgentWorkspace}
            onOpenSplit={openSplitWorkspace}
          />
        ) : workspaceMode === "single" ? (
          <MobilePaneFrame
            pane="active"
            panelId={activePanel}
            focused={false}
            onPickPanel={setPickerPane}
            onFocus={openSplitWorkspace}
          />
        ) : focusedPanel ? (
          <MobilePaneFrame
            pane={focusedPane ?? "top"}
            panelId={focusedPanel}
            focused
            onPickPanel={setPickerPane}
            onFocus={() => setFocusedPane(null)}
          />
        ) : (
          <div
            className="grid h-full min-h-0 gap-0"
            style={{
              gridTemplateRows: `${layout.splitPercent}% 28px minmax(0, 1fr)`,
            }}
          >
            <MobilePaneFrame
              pane="top"
              panelId={topPanel}
              focused={false}
              onPickPanel={setPickerPane}
              onFocus={setFocusedPane}
            />
            <button
              type="button"
              className="flex touch-none items-center justify-center text-muted-foreground/70"
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onDoubleClick={resetSplit}
              aria-label={t("studio.mobile.resizeHandle")}
            >
              <span className="flex h-5 w-24 items-center justify-center rounded-full border border-border/60 bg-muted/70 shadow-sm">
                <GripHorizontal className="h-4 w-4" />
              </span>
            </button>
            <MobilePaneFrame
              pane="bottom"
              panelId={bottomPanel}
              focused={false}
              onPickPanel={setPickerPane}
              onFocus={setFocusedPane}
            />
          </div>
        )}
      </div>

      <MobilePanelPicker
        open={pickerPane !== null}
        pane={pickerPane}
        currentPanel={pickerCurrentPanel}
        onClose={() => setPickerPane(null)}
        onSelect={selectPanelForPicker}
      />

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
