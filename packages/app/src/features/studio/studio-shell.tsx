import { Suspense, useCallback, useMemo, useRef, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { navigateBackSafely } from "@/lib/safe-back";
import { useRouter } from "@tanstack/react-router";
import {
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewApi,
  type IDockviewPanelProps,
} from "dockview-react";
import {
  ArrowLeft,
  Save,
  Loader2,
  Play,
  Pencil,
  LayoutTemplate,
  Plus,
  RotateCcw,
  Undo2,
  Redo2,
  History,
  MoreVertical,
  Download,
  Upload,
  Package,
  Star,
} from "lucide-react";
import { feedback } from "@/lib/feedback";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useEditorStore } from "@/stores/editor";
import { useWorldsStore } from "@/stores/worlds";
import { useStudioStore, probeStreamBase } from "@/stores/studio";
import { MobileStudioShell } from "./mobile-studio-shell";
import { BundleCreator, BundleImporter, ImportBundleModal, WorldPublishModal } from "@/edition/slots";
import { useEdition } from "@/edition/edition";
import { ExportCardMenu } from "../editor/export-card-menu";
import { ChangeHistoryDialog } from "./change-history-dialog";
import { ReviewStateControl } from "../editor/review-state-control";
import type { YuminaBundle } from "@yumina/engine";
import {
  AiChatPanel,
  CanvasPanel,
  LorebookPanel,
  VariablesPanel,
  AudioPanel,
  OverviewPanel,
  CodeViewPanel,
  PlaytestPanel,
  RulesPanel,
  AssetsPanel,
  SidebarPanel,
  FirstMessagePanel,
  AddPagePickerPanel,
  BundlesPanel,
} from "./panels";
import {
  getActiveStudioGroup,
  openAddPagePicker,
  STUDIO_ADD_PAGE_PICKER_COMPONENT,
} from "./studio-page-catalog";
import { StudioGroupAddButton } from "./studio-group-add-button";
import type { ToolCall } from "./lib/types";
import { buildReviewDiffTokens } from "./lib/review-diff";

import "dockview-react/dist/styles/dockview.css";
import "./studio-theme.css";

const STUDIO_CHANGE_REVIEW_COMPONENT = "studio-change-review";

const PANEL_COMPONENTS: Record<
  string,
  React.FC<IDockviewPanelProps>
> = {
  "ai-chat": AiChatPanel,
  canvas: CanvasPanel,
  lorebook: LorebookPanel,
  variables: VariablesPanel,
  rules: RulesPanel,
  audio: AudioPanel,
  overview: OverviewPanel,
  "code-view": CodeViewPanel,
  playtest: PlaytestPanel,
  assets: AssetsPanel,
  sidebar: SidebarPanel,
  "first-message": FirstMessagePanel,
  marketplace: BundlesPanel,
  [STUDIO_ADD_PAGE_PICKER_COMPONENT]: AddPagePickerPanel,
  [STUDIO_CHANGE_REVIEW_COMPONENT]: StudioChangeReviewPanel,
};

// Panel id → i18n title key. Used to (re)apply translated tab titles after a
// dockview layout restore: `fromJSON` replays the SERIALIZED title verbatim, so
// a layout persisted before i18n was ready (or before these keys existed) would
// otherwise show raw keys like "studio.panels.lorebook" in the tabs.
const PANEL_TITLE_KEYS: Record<string, string> = {
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

// Each preset is an array of groups (columns). Panels within a group share tabs.
const LAYOUT_PRESETS = [
  {
    labelKey: "studio.layouts.writing",
    groups: [
      [{ id: "ai-chat", titleKey: "studio.panels.aiAssistant" }],
      [
        { id: "lorebook", titleKey: "studio.panels.lorebook" },
        { id: "variables", titleKey: "studio.panels.variables" },
        { id: "rules", titleKey: "studio.panels.behaviors" },
      ],
    ],
  },
  {
    labelKey: "studio.layouts.uiDesign",
    groups: [
      [{ id: "ai-chat", titleKey: "studio.panels.aiAssistant" }],
      [{ id: "canvas", titleKey: "studio.panels.canvas" }],
    ],
  },
  {
    labelKey: "studio.layouts.playTest",
    groups: [
      [
        { id: "playtest", titleKey: "studio.panels.playtest" },
        { id: "code-view", titleKey: "studio.panels.frontEndCode" },
      ],
      [{ id: "canvas", titleKey: "studio.panels.canvas" }],
    ],
  },
] as const;

const DEFAULT_LAYOUT_PRESET = LAYOUT_PRESETS[0];
const DEFAULT_AI_CHAT_WIDTH_RATIO = 0.264;
const DEFAULT_AI_CHAT_WIDTH_FALLBACK = 408;

type DesktopReviewPayload = {
  title: string;
  toolName: string;
  changed: string;
  original: string;
};

type ServerReviewPayload = DesktopReviewPayload & {
  source?: string;
};

type StudioChangeReviewParams = {
  toolCall?: ToolCall;
  agentRunId?: string;
  worldId?: string | null;
};

function getLayoutKey(worldId: string) {
  return `yumina-studio-layout-${worldId}`;
}

const LAYOUT_KEY_PREFIX = "yumina-studio-layout-";
const MAX_LAYOUT_KEYS = 20;

/** Remove excess studio layout keys from localStorage to prevent unbounded growth. */
function pruneStaleLayoutKeys(currentKey: string) {
  const layoutKeys: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k?.startsWith(LAYOUT_KEY_PREFIX) && k !== currentKey) {
      layoutKeys.push(k);
    }
  }
  if (layoutKeys.length >= MAX_LAYOUT_KEYS) {
    for (const k of layoutKeys.slice(0, layoutKeys.length - MAX_LAYOUT_KEYS + 1)) {
      localStorage.removeItem(k);
    }
  }
}

function getDefaultAiChatWidth() {
  if (typeof window === "undefined") {
    return DEFAULT_AI_CHAT_WIDTH_FALLBACK;
  }

  return Math.round(window.innerWidth * DEFAULT_AI_CHAT_WIDTH_RATIO);
}

function getLargestStudioGroup(api: DockviewApi) {
  let largest = api.activeGroup ?? api.groups[0];
  let largestArea = -1;

  for (const group of api.groups) {
    const record = group as unknown as Record<string, unknown>;
    const width = typeof record.width === "number" ? record.width : 0;
    const height = typeof record.height === "number" ? record.height : 0;
    const size = typeof record.size === "number" ? record.size : 0;
    const panelCount = Array.isArray(record.panels) ? record.panels.length : 0;
    const area = width > 0 && height > 0 ? width * height : size || panelCount;
    if (area > largestArea) {
      largest = group;
      largestArea = area;
    }
  }

  return largest;
}

function getChangeReviewStudioGroup(api: DockviewApi) {
  for (const panelId of ["lorebook", "variables", "rules"]) {
    const group = api.getPanel(panelId)?.group;
    if (group) return group;
  }

  return getLargestStudioGroup(api) ?? getActiveStudioGroup(api);
}

function parseReviewToolArgs(toolCall: ToolCall): Record<string, unknown> {
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

function summarizeReviewEntity(entity: unknown) {
  if (!entity || typeof entity !== "object") return null;
  const record = entity as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ["id", "name", "content", "description", "behaviorRules", "defaultValue", "type", "enabled", "section", "role"]) {
    if (record[key] !== undefined) summary[key] = record[key];
  }
  return Object.keys(summary).length > 0 ? summary : record;
}

function findReviewEntity(args: Record<string, unknown>, collection: unknown[] | undefined) {
  const id = typeof args.id === "string" ? args.id : null;
  const name = typeof args.name === "string" ? args.name : null;
  return collection?.find((item) => {
    if (!item || typeof item !== "object") return false;
    const record = item as Record<string, unknown>;
    return (id && record.id === id) || (name && record.name === name);
  });
}

function buildDesktopReviewPayload(toolCall: ToolCall, draftInput?: Record<string, unknown>): DesktopReviewPayload {
  const args = parseReviewToolArgs(toolCall);
  const draft = draftInput ?? useEditorStore.getState().worldDraft as unknown as Record<string, unknown>;
  const toolName = toolCall.function.name;
  const title = formatReviewValue(args.name ?? args.id ?? toolName);
  const noOriginal = "No existing version.";

  if (toolName === "write_entry") {
    const existing = findReviewEntity(args, draft.entries as unknown[]);
    return {
      title,
      toolName,
      changed: formatReviewValue(args.content ?? args),
      original: existing ? formatReviewValue((existing as Record<string, unknown>).content ?? summarizeReviewEntity(existing)) : noOriginal,
    };
  }

  if (toolName === "write_variable") {
    const existing = findReviewEntity(args, draft.variables as unknown[]);
    return {
      title,
      toolName,
      changed: formatReviewValue(args.behaviorRules ?? args.description ?? args),
      original: existing ? formatReviewValue((existing as Record<string, unknown>).behaviorRules ?? summarizeReviewEntity(existing)) : noOriginal,
    };
  }

  if (toolName === "write_behavior") {
    const existing = findReviewEntity(args, draft.reactions as unknown[]);
    return {
      title,
      toolName,
      changed: formatReviewValue(args),
      original: existing ? formatReviewValue(summarizeReviewEntity(existing)) : noOriginal,
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
    const existing = findReviewEntity(args, draft.audioTracks as unknown[]);
    return {
      title,
      toolName,
      changed: formatReviewValue(args),
      original: existing ? formatReviewValue(summarizeReviewEntity(existing)) : noOriginal,
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
      if (entity) return { id, original: summarizeReviewEntity(entity) };
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

function DesktopReviewDiff({
  original,
  changed,
}: {
  original: string;
  changed: string;
}) {
  const { t } = useTranslation("editor");
  const tokens = useMemo(() => buildReviewDiffTokens(original, changed), [changed, original]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border/70 bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2 text-[11px] font-semibold">
        <span className="inline-flex items-center gap-1 rounded-full bg-lime-400 px-2 py-1 font-semibold text-black">
          <span className="font-mono">+</span>
          {t("studio.proposal.added")}
        </span>
        <span className="inline-flex items-center gap-1 rounded-full bg-orange-300 px-2 py-1 font-semibold text-black">
          <span className="font-mono">-</span>
          {t("studio.proposal.deleted")}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="min-h-full whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs leading-7 text-muted-foreground">
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

function StudioChangeReviewPanel(props: IDockviewPanelProps<StudioChangeReviewParams>) {
  const { t } = useTranslation("editor");
  const currentDraft = useEditorStore(s => s.worldDraft);
  const params = props.params ?? {};
  const { toolCall, agentRunId, worldId } = params;
  const [serverReview, setServerReview] = useState<ServerReviewPayload | null>(null);
  const [loadingReview, setLoadingReview] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const apiBase = import.meta.env.VITE_API_URL || "";
  const expectsServerReview = !!worldId && !!agentRunId && !!toolCall?.id;

  useEffect(() => {
    if (!worldId || !agentRunId || !toolCall?.id) {
      setServerReview(null);
      setReviewError(null);
      setLoadingReview(false);
      return;
    }

    let cancelled = false;
    setLoadingReview(true);
    setReviewError(null);
    fetch(`${apiBase}/api/studio/${worldId}/agent/changes/${encodeURIComponent(agentRunId)}/${encodeURIComponent(toolCall.id)}`, {
      credentials: "include",
    })
      .then((res) => {
        if (!res.ok) throw new Error("Change data unavailable");
        return res.json();
      })
      .then(({ data }) => {
        if (cancelled) return;
        if (data && typeof data === "object") {
          setServerReview(data as ServerReviewPayload);
        } else {
          setServerReview(null);
          setReviewError(t("studio.proposal.compareSnapshotMissing"));
        }
      })
      .catch(() => {
        if (!cancelled) setReviewError(t("studio.proposal.compareSnapshotError"));
      })
      .finally(() => {
        if (!cancelled) setLoadingReview(false);
      });

    return () => {
      cancelled = true;
    };
  }, [agentRunId, apiBase, t, toolCall?.id, worldId]);

  const review = useMemo(() => {
    if (serverReview) return serverReview;
    if (expectsServerReview && !reviewError) return null;
    if (!toolCall) return null;
    return buildDesktopReviewPayload(
      toolCall,
      currentDraft as unknown as Record<string, unknown>,
    );
  }, [currentDraft, expectsServerReview, reviewError, serverReview, toolCall]);

  if (!toolCall || !review) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6 text-sm text-muted-foreground">
        {expectsServerReview && !reviewError ? t("studio.proposal.compareLoading") : t("studio.proposal.compareUnavailable")}
      </div>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border/60 bg-muted/30 px-4">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
            {t("studio.proposal.compareTitle")}
          </div>
          <div className="truncate text-sm font-semibold text-foreground">
            {review.title}
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          {loadingReview
            ? t("studio.proposal.compareLoading")
            : serverReview
              ? t("studio.proposal.compareUsingSnapshot")
              : reviewError}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-4">
        <DesktopReviewDiff original={review.original} changed={review.changed} />
      </div>
    </section>
  );
}

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
  return isMobileStudio ? <MobileStudioShell /> : <StudioDesktopShell />;
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
  const { t, i18n } = useTranslation("editor");
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
  const [showPublishModal, setShowPublishModal] = useState(false);
  const { features } = useEdition();
  const [showImportModal, setShowImportModal] = useState(false);
  const [showBundleCreator, setShowBundleCreator] = useState(false);
  const [importingBundle, setImportingBundle] = useState<YuminaBundle | null>(null);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const dockviewRef = useRef<DockviewApi | null>(null);
  const layoutChangeListenerRef = useRef<{ dispose: () => void } | null>(null);

  const applyDefaultAiChatWidth = useCallback((api: DockviewApi) => {
    const setWidth = () => {
      try {
        const aiChatPanel = api.getPanel("ai-chat");
        const aiChatGroup = aiChatPanel?.group;
        if (aiChatGroup) {
          api.getGroup(aiChatGroup.id)?.api.setSize({ width: getDefaultAiChatWidth() });
          const currentServerWorldId = useEditorStore.getState().serverWorldId;
          const key = getLayoutKey(currentServerWorldId ?? "new");
          localStorage.setItem(key, JSON.stringify(api.toJSON()));
        }
      } catch {
        // sizing may not be available immediately
      }
    };

    if (typeof window === "undefined") {
      setWidth();
      return;
    }

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(setWidth);
    });
  }, []);

  const applyDefaultStudioLayout = useCallback((api: DockviewApi) => {
    for (const p of [...api.panels]) {
      api.removePanel(p);
    }

    const chatPanel = api.addPanel({
      id: "ai-chat",
      component: "ai-chat",
      title: t("studio.panels.aiAssistant"),
    });

    const lorebookPanel = api.addPanel({
      id: "lorebook",
      component: "lorebook",
      title: t("studio.panels.lorebook"),
      position: { referencePanel: chatPanel, direction: "right" },
    });

    api.addPanel({
      id: "variables",
      component: "variables",
      title: t("studio.panels.variables"),
      position: { referencePanel: lorebookPanel, direction: "within" },
    });

    api.addPanel({
      id: "rules",
      component: "rules",
      title: t("studio.panels.behaviors"),
      position: { referencePanel: lorebookPanel, direction: "within" },
    });

    lorebookPanel.api.setActive();
    applyDefaultAiChatWidth(api);
  }, [applyDefaultAiChatWidth, t]);

  // Re-apply translated tab titles to whatever panels currently exist. Safe to
  // call repeatedly; only touches panels we have a title key for. Fixes raw keys
  // ("studio.panels.lorebook") surfacing from a stale persisted layout.
  const refreshPanelTitles = useCallback((api: DockviewApi) => {
    for (const panel of api.panels) {
      const key = PANEL_TITLE_KEYS[panel.id];
      if (key) panel.setTitle(t(key as never));
    }
  }, [t]);

  const onReady = useCallback(
    (event: DockviewReadyEvent) => {
      dockviewRef.current = event.api;
      layoutChangeListenerRef.current?.dispose();
      layoutChangeListenerRef.current = event.api.onDidLayoutChange(() => {
        try {
          const currentServerWorldId = useEditorStore.getState().serverWorldId;
          const key = getLayoutKey(currentServerWorldId ?? "new");
          const layout = event.api.toJSON();
          localStorage.setItem(key, JSON.stringify(layout));
        } catch {
          // ignore
        }
      });

      // Try to restore saved layout
      const key = getLayoutKey(serverWorldId ?? "new");
      pruneStaleLayoutKeys(key);
      const saved = localStorage.getItem(key);

      if (saved) {
        try {
          const layout = JSON.parse(saved);
          event.api.fromJSON(layout);
          // A layout persisted while the studio was mid-crash can deserialize to
          // ZERO panels — which renders as an empty shell the user can't recover
          // from. Treat that as corrupt and fall through to the default layout.
          if (event.api.panels.length === 0) throw new Error("empty layout");
          // Persisted layouts replay their serialized titles verbatim — refresh
          // from the i18n keys so restored tabs never show a raw "studio.panels.*".
          refreshPanelTitles(event.api);
          applyDefaultAiChatWidth(event.api);
          return;
        } catch {
          // fallback to default layout
        }
      }

      // Default layout: Writing preset (AI Assistant left, Lorebook + Variables + Behaviors tabbed right)
      applyDefaultStudioLayout(event.api);
      refreshPanelTitles(event.api);
    },
    [applyDefaultAiChatWidth, applyDefaultStudioLayout, refreshPanelTitles, serverWorldId]
  );

  // If i18n finishes loading after onReady (async resource race) or the user
  // switches language with Studio open, refresh the dockview tab titles so they
  // never stay stuck on a raw key.
  useEffect(() => {
    const handler = () => {
      if (dockviewRef.current) refreshPanelTitles(dockviewRef.current);
    };
    i18n.on("languageChanged", handler);
    i18n.on("loaded", handler);
    return () => {
      i18n.off("languageChanged", handler);
      i18n.off("loaded", handler);
    };
  }, [i18n, refreshPanelTitles]);

  const saveLayout = useCallback(() => {
    if (!dockviewRef.current) return;
    const key = getLayoutKey(serverWorldId ?? "new");
    try {
      const layout = dockviewRef.current.toJSON();
      localStorage.setItem(key, JSON.stringify(layout));
    } catch {
      // ignore
    }
  }, [serverWorldId]);

  const handleVariantSwitch = useCallback(
    async (targetWorldId: string) => {
      if (targetWorldId === serverWorldId || saving) return;
      saveLayout();
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
    [serverWorldId, saving, saveLayout, router],
  );

  const handleOpenMarketplace = useCallback(() => {
    const api = dockviewRef.current;
    if (!api) return;
    // Single fixed-id panel so a second click activates the existing tab
    // instead of stacking duplicates.
    const existing = api.getPanel("marketplace");
    if (existing) {
      existing.api.setActive();
      return;
    }
    const target = getLargestStudioGroup(api) ?? getActiveStudioGroup(api);
    api.addPanel({
      id: "marketplace",
      component: "marketplace",
      title: t("studio.panels.marketplace"),
      ...(target ? { position: { referenceGroup: target.id, direction: "within" as const } } : {}),
    }).api.setActive();
  }, [t]);

  const handleOpenAddPagePicker = useCallback(() => {
    if (!dockviewRef.current) return;

    let targetGroup = getActiveStudioGroup(dockviewRef.current);
    if (!targetGroup) {
      applyDefaultStudioLayout(dockviewRef.current);
      targetGroup = getActiveStudioGroup(dockviewRef.current);
    }

    if (!targetGroup) return;

    openAddPagePicker({
      containerApi: dockviewRef.current,
      groupId: targetGroup.id,
      title: t("studio.addPanel"),
    });
  }, [applyDefaultStudioLayout, t]);

  const applyPreset = useCallback(
    (groups: ReadonlyArray<ReadonlyArray<{ id: string; titleKey: string }>>) => {
      if (!dockviewRef.current) return;

      // Remove all existing panels
      for (const p of [...dockviewRef.current.panels]) {
        dockviewRef.current.removePanel(p);
      }

      // Add preset panels — each group is a column, panels within share tabs
      let firstGroupAnchor: ReturnType<DockviewApi["addPanel"]> | null = null;
      for (const group of groups) {
        let groupAnchor: ReturnType<DockviewApi["addPanel"]> | null = null;
        for (const p of group) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const title = t(p.titleKey as any) as string;
          if (!groupAnchor) {
            // First panel in this group — create new column
            let newPanel;
            if (firstGroupAnchor) {
              newPanel = dockviewRef.current.addPanel({
                id: p.id,
                component: p.id,
                title,
                position: { referencePanel: firstGroupAnchor, direction: "right" },
              });
            } else {
              newPanel = dockviewRef.current.addPanel({
                id: p.id,
                component: p.id,
                title,
              });
              firstGroupAnchor = newPanel;
            }
            groupAnchor = newPanel;
          } else {
            // Additional panel in same group — add as tab
            dockviewRef.current.addPanel({
              id: p.id,
              component: p.id,
              title,
              position: { referencePanel: groupAnchor, direction: "within" },
            });
          }
        }
        // Activate the first tab in each group
        groupAnchor?.api.setActive();
      }

      // Keep the AI chat column on the slimmer default width when a preset includes it.
      if (groups.some((group) => group.some((panel) => panel.id === "ai-chat"))) {
        applyDefaultAiChatWidth(dockviewRef.current);
      }
    },
    [applyDefaultAiChatWidth, t]
  );

  const restoreDefaultLayout = useCallback(() => {
    if (!dockviewRef.current) return;
    applyDefaultStudioLayout(dockviewRef.current);
  }, [applyDefaultStudioLayout]);

  const handleApplyLayoutPreset = useCallback(
    (preset: (typeof LAYOUT_PRESETS)[number]) => {
      if (!dockviewRef.current) return;

      if (preset === DEFAULT_LAYOUT_PRESET) {
        applyDefaultStudioLayout(dockviewRef.current);
        return;
      }

      applyPreset(preset.groups);
    },
    [applyDefaultStudioLayout, applyPreset]
  );

  const handleModeSwitch = useCallback(
    (newMode: "edit" | "playtest") => {
      if (newMode === mode) return;

      if (newMode === "playtest") {
        setMode("playtest");
        // PlaytestPanel creates its own ephemeral session on mount — no store reset needed.
        // Open playtest panel
        if (dockviewRef.current) {
          const existing = dockviewRef.current.getPanel("playtest");
          if (existing) {
            existing.api.setActive();
          } else {
            dockviewRef.current.addPanel({
              id: "playtest",
              component: "playtest",
              title: t("studio.panels.playtest"),
              // Keep this panel in the DOM when the user clicks away to another
              // tab. The default ("onlyWhenVisible") detaches the panel's DOM on
              // tab switch; the playtest panel hosts the custom-UI sandbox iframe,
              // and detaching+reattaching an iframe forces the browser to reload
              // it to a blank document — the "switch tab and 测试 goes black, must
              // refresh" bug. "always" hides it with CSS instead, so the iframe
              // (and the live playtest session) survive a tab switch.
              renderer: "always",
            });
          }
        }
      } else {
        setMode("edit");
        // Remove playtest panel
        if (dockviewRef.current) {
          const panel = dockviewRef.current.getPanel("playtest");
          if (panel) {
            dockviewRef.current.removePanel(panel);
          }
        }
      }
    },
    [mode, setMode, t]
  );

  const handleSave = useCallback(async () => {
    saveLayout();
    await saveDraft();
  }, [saveLayout, saveDraft]);

  // Publish / submit-for-review from Studio. Flush unsaved edits first, then open
  // the publish modal which drives POST /:id/status (pending_review) for a draft
  // and the held-edit submit for a published world. Works for variants too — a
  // draft variant goes through first-publish review like any other world.
  const handlePublishClick = useCallback(async () => {
    saveLayout();
    if (useEditorStore.getState().isDirty) {
      const ok = await saveDraft();
      if (!ok) return;
    }
    if (!useEditorStore.getState().serverWorldId) {
      feedback.error(t("shell.saveWorldFirst", "Save the world first"));
      return;
    }
    setShowPublishModal(true);
  }, [saveLayout, saveDraft, t]);

  const handleOpenChangeReviewTab = useCallback((toolCall: ToolCall, agentRunId?: string) => {
    const api = dockviewRef.current;
    if (!api) return;

    const args = parseReviewToolArgs(toolCall);
    const title = formatReviewValue(args.name ?? args.id ?? toolCall.function.name);
    const panelKey = (toolCall.id || title).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
    const panelId = `${STUDIO_CHANGE_REVIEW_COMPONENT}:${agentRunId ?? "local"}:${panelKey}`;
    const existing = api.getPanel(panelId);
    if (existing) {
      existing.api.setActive();
      return;
    }

    const targetGroup = getChangeReviewStudioGroup(api);
    api.addPanel<StudioChangeReviewParams>({
      id: panelId,
      component: STUDIO_CHANGE_REVIEW_COMPONENT,
      title: `${t("studio.proposal.inspect")}: ${title}`.slice(0, 80),
      params: {
        toolCall,
        agentRunId,
        worldId: serverWorldId,
      },
      ...(targetGroup ? { position: { referenceGroup: targetGroup.id, direction: "within" as const } } : {}),
    }).api.setActive();
  }, [serverWorldId, t]);

  // Ctrl+Z / Ctrl+Y keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
        if (state.isDirty && !state.saving) {
          saveLayout();
          state.saveDraft();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [saveLayout]);

  useEffect(
    () => () => {
      layoutChangeListenerRef.current?.dispose();
      layoutChangeListenerRef.current = null;
    },
    []
  );

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ toolCall?: ToolCall; agentRunId?: string }>).detail;
      if (!detail?.toolCall) return;
      handleOpenChangeReviewTab(detail.toolCall, detail.agentRunId);
    };
    window.addEventListener("yumina:studio-mobile-review", handler);
    return () => window.removeEventListener("yumina:studio-mobile-review", handler);
  }, [handleOpenChangeReviewTab]);

  const isPlaytest = mode === "playtest";

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden overscroll-none bg-background">
      {/* Toolbar — three-zone layout */}
      <div
        className={cn(
          "flex items-center gap-2 border-b px-3 py-2 transition-colors duration-200",
          isPlaytest
            ? "border-emerald-500/40 bg-emerald-950/10"
            : "border-border"
        )}
      >
        {/* LEFT: Navigation */}
        <button
          onClick={() => {
            saveLayout();
            navigateBackSafely(
              router.history,
              serverWorldId ? `/app/worlds/${encodeURIComponent(serverWorldId)}/edit` : "/app/library",
            );
          }}
          className="hover-surface rounded-lg p-1.5 text-muted-foreground"
          title={t("studio.backToEditor")}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>

        <input
          type="text"
          value={worldDraft.name}
          onChange={(e) => setField("name", e.target.value)}
          placeholder={t("shell.namePlaceholder", { defaultValue: "Untitled" })}
          readOnly={readOnlyInspect}
          className="max-w-[200px] min-w-0 truncate bg-transparent text-sm font-medium text-foreground placeholder:text-muted-foreground/40 focus:outline-none"
        />

        {/* Variant switcher */}
        {variants.length >= 2 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="group flex items-center gap-1 rounded-full border border-border/60 bg-muted/40 px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
              >
                <span className="max-w-[120px] truncate">
                  {variantLabel || variants.find((v) => v.id === serverWorldId)?.variantLabel || t("studio.variant")}
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
                const label = v.variantLabel || v.name;
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

        {/* CENTER: Mode segmented pill */}
        <div className="flex items-center rounded-lg border border-border bg-muted/50 p-0.5">
          <button
            onClick={() => handleModeSwitch("edit")}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-all duration-200",
              !isPlaytest
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Pencil className="h-3 w-3" />
            {t("studio.edit")}
          </button>
          <button
            onClick={() => handleModeSwitch("playtest")}
            className={cn(
              "flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-all duration-200",
              isPlaytest
                ? "bg-emerald-500/15 text-emerald-400 shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Play className="h-3 w-3" />
            {t("studio.play")}
          </button>
        </div>

        <div className="flex-1" />

        {/* Marketplace — prominent labeled entry to the community bundle browser.
            Intentionally the only labeled colored chip in this row so creators
            notice it without hunting through icon-only menus. */}
        {features.bundles && (
        <button
          onClick={handleOpenMarketplace}
          className="group mr-1 flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/[0.08] px-2.5 py-1 text-xs font-semibold text-primary transition-colors hover:border-primary/50 hover:bg-primary/[0.15]"
          title={t("studio.openMarketplace")}
        >
          <Package className="h-3.5 w-3.5 transition-transform group-hover:rotate-[-6deg]" />
          {t("studio.panels.marketplace")}
        </button>
        )}

        {/* RIGHT: Workspace actions */}
        <div className="flex items-center gap-1">
          {/* Layout Presets */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className="hover-surface rounded-lg p-1.5 text-muted-foreground"
                title={t("studio.layoutPresets")}
              >
                <LayoutTemplate className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-xs">{t("studio.layoutPresets")}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {LAYOUT_PRESETS.map((preset) => (
                <DropdownMenuItem
                  key={preset.labelKey}
                  onClick={() => handleApplyLayoutPreset(preset)}
                  className="text-xs"
                >
                  {t(preset.labelKey)}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={restoreDefaultLayout}
                className="text-xs gap-2"
              >
                <RotateCcw className="h-3.5 w-3.5 text-muted-foreground" />
                {t("studio.restore")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Add Panel fallback */}
          <button
            onClick={handleOpenAddPagePicker}
            className="hover-surface rounded-lg p-1.5 text-muted-foreground"
            title={t("studio.addPanel")}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>

          {/* More actions (bundle import/export) — hosted-only */}
          {features.bundles && (
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
              <DropdownMenuItem onClick={() => setShowImportModal(true)} className="text-xs gap-2">
                <Download className="h-3.5 w-3.5 text-muted-foreground" />
                {t("studio.importBundle")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowBundleCreator(true)} className="text-xs gap-2">
                <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                {t("studio.exportBundle")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          )}

          <div className="mx-1 h-4 w-px bg-border" />

          {/* Undo / Redo */}
          <button
            onClick={undo}
            disabled={!canUndo}
            className="hover-surface rounded-lg p-1.5 text-muted-foreground disabled:opacity-30"
            title={t("studio.undo")}
          >
            <Undo2 className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={redo}
            disabled={!canRedo}
            className="hover-surface rounded-lg p-1.5 text-muted-foreground disabled:opacity-30"
            title={t("studio.redo")}
          >
            <Redo2 className="h-3.5 w-3.5" />
          </button>

          {/* Change history */}
          <button
            onClick={() => setSnapshotsOpen(true)}
            className="hover-surface rounded-lg p-1.5 text-muted-foreground"
            title={t("studio.changeLog.title")}
          >
            <History className="h-3.5 w-3.5" />
          </button>

          <div className="mx-1 h-4 w-px bg-border" />

          {/* Unsaved indicator + Save */}
          {isDirty && (
            <span className="text-xs text-amber-400/70">{t("studio.unsaved")}</span>
          )}
          <button
            onClick={handleSave}
            disabled={saving || !isDirty}
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
            <ReviewStateControl onPublish={handlePublishClick} size="sm" disabled={saving || !serverWorldId} />
          )}
          {!readOnlyInspect && !features.publishing && (
            <ExportCardMenu worldId={serverWorldId} size="sm" disabled={saving || !serverWorldId} />
          )}
        </div>
      </div>

      {/* Dockview fills remaining space */}
      <div className="flex-1 min-h-0 w-full overflow-hidden overscroll-none">
        <DockviewReact
          className="dockview-theme-yumina h-full w-full"
          onReady={onReady}
          components={PANEL_COMPONENTS}
          leftHeaderActionsComponent={StudioGroupAddButton}
        />
      </div>

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
