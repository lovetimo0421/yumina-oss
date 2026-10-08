import { useExternalWrites } from "./lib/use-external-writes";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { STUDIO_ASK_EVENT } from "./lib/block-ask";
import { STUDIO_BACK_EVENT } from "./lib/studio-back";
import type { IDockviewPanelProps } from "dockview-react";
import {
  BookOpen,
  Boxes,
  Code,
  Images,
  MessageCircle,
  MessageSquare,
  Music,
  Image as ImageIcon,
  Package,
  Settings,
  ListTree,
  Variable as VariableIcon,
  X,
  Zap,
  ChevronDown,
  PanelsTopLeft,
  Sparkles,
  History,
  Languages,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useStudioStore } from "@/stores/studio";
import { useEditorStore, type EditorSection } from "@/stores/editor";
import { ComponentsSection } from "@/features/editor/sections/components";
import { VariantTabBar } from "@/features/editor/variant-tab-bar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
  AiChatPanel,
  AssetsPanel,
  BundlesPanel,
  LorebookPanel,
  ModulesPanel,
  VariablesPanel,
  RulesPanel,
  FirstMessagePanel,
  AudioPanel,
  SceneImagesPanel,
  BackgroundsPanel,
  MechanicPacksPanel,
  CodeViewPanel,
  OverviewPanel,
  PlaytestPanel,
  GenerationAtelierPanel,
} from "./panels";
import { BlueprintCanvasCore } from "./panels/blueprint-panel";
import { FrontendPage } from "./panels/inspector/frontend-page";
import { GenerationAtelier } from "@/edition/slots";
import { useEdition } from "@/edition/edition";
import { setPendingCodeJump } from "@/lib/code-jump";
import { StageTree } from "./stage-tree";
import { LEARNING_CANVAS_EVENT, LEARNING_PANEL_EVENT, lessonById } from "./learn/learning-catalog";
import { useLearningWorkspace } from "./learn/learning-workspace";
import { StudioDocsButton, StudioLearningButton } from "./learn/learning-button";
import { LoreTokenMeter } from "./lore-token-meter";
import { DockWorkspace, type DockTool } from "./dock-tools";
import { AiPresenceLayer } from "./ai-presence";
import { useAgentPresence } from "./lib/agent-presence";
import { getStageInspectorLayout, STAGE_INSPECTOR_DEFAULT_WIDTH, STAGE_INSPECTOR_OVERLAY_INSET } from "./lib/stage-inspector-layout";
import { readLocalPref, writeLocalPref } from "./lib/local-pref";
import { takeRequestedPanel } from "@/lib/studio-entry";
import { isScreenFirst } from "@/lib/editor-surface";
const VersionHistoryDialog = lazy(() => import("@/features/editor/version-history-dialog").then(m => ({ default: m.VersionHistoryDialog })));

function ComponentsPanel() {
  return <div className="h-full min-h-0 overflow-auto"><ComponentsSection /></div>;
}

function VariantsPanel() {
  const { t } = useTranslation("editor");
  const secondary = useEditorStore(s => s.variants.find(v => v.id === s.serverWorldId)?.isPrimaryVariant === false);
  return <div className="flex h-full min-h-0 flex-col"><VariantTabBar compact destination="/app/studio/$worldId" /><div className="min-h-0 flex-1">{secondary ? <p className="max-w-xl p-6 text-sm leading-relaxed text-muted-foreground">{t("studio.workspace.primaryMetadata")}</p> : <OverviewPanel {...STUB_PANEL_PROPS} />}</div></div>;
}

// The stage, fourth form. First everything floated over an edge-to-edge canvas
// (five glass docks, each with its own inset arithmetic) — 乱. Then the frame
// held still, but paid for it in width: a 232px tree column and a 420–640px
// right column with three tabs left a 1600px screen under half a canvas.
//
// This form removes the tabs by removing the reason for them. The right column
// showed AI, preview, and playtest as siblings, which they never were: two of
// them are looking AT the card and one is talking ABOUT it. Looking at the card
// is now a CENTRE page — 蓝图 | 前端 — and the right column has one identity,
// so it needs no tab strip to explain itself. The tree, an index rather than a
// workspace, floats over the canvas when summoned instead of permanently
// narrowing it.
//
// The single-compile rule survives: exactly one of {interface block, frontend
// page, playtest} runs the card's TSX at a time.

/** Classic editors reachable from a canvas drill. All ignore dockview props. */
const DRAWER_PANELS: Record<string, { component: React.FC<IDockviewPanelProps>; titleKey: string; icon: typeof Zap }> = {
  lorebook: { component: LorebookPanel, titleKey: "studio.panels.lorebook", icon: BookOpen },
  modules: { component: ModulesPanel, titleKey: "studio.panels.modules", icon: Boxes },
  variables: { component: VariablesPanel, titleKey: "studio.panels.variables", icon: VariableIcon },
  rules: { component: RulesPanel, titleKey: "studio.panels.behaviors", icon: Zap },
  "first-message": { component: FirstMessagePanel, titleKey: "studio.panels.firstMessage", icon: MessageCircle },
  audio: { component: AudioPanel, titleKey: "studio.panels.audio", icon: Music },
  "scene-images": { component: SceneImagesPanel, titleKey: "studio.panels.sceneImages", icon: ImageIcon },
  backgrounds: { component: BackgroundsPanel, titleKey: "studio.panels.backgrounds", icon: ImageIcon },
  packs: { component: MechanicPacksPanel, titleKey: "studio.panels.packs", icon: Zap },
  "code-view": { component: CodeViewPanel, titleKey: "studio.panels.frontEndCode", icon: Code },
  // The card can be finished on the stage: its identity, its assets and the
  // marketplace all reach the same drawer instead of forcing a mode switch.
  overview: { component: OverviewPanel, titleKey: "studio.panels.overview", icon: Settings },
  assets: { component: AssetsPanel, titleKey: "studio.panels.assets", icon: Images },
  marketplace: { component: BundlesPanel, titleKey: "studio.panels.marketplace", icon: Package },
  components: { component: ComponentsPanel, titleKey: "studio.panels.interfaceCode", icon: PanelsTopLeft },
  generation: { component: GenerationAtelierPanel, titleKey: "sections.aiGeneration", icon: Sparkles },
  variants: { component: VariantsPanel, titleKey: "studio.workspace.variants", icon: Languages },
};

const SECTION_PANEL: Record<EditorSection, string> = {
  entries: "lorebook", variables: "variables", rules: "rules", modules: "modules",
  "first-message": "first-message", components: "components", audio: "audio", "scene-images": "scene-images", backgrounds: "backgrounds", packs: "packs", assets: "assets",
  generation: "generation", overview: "overview", bundles: "marketplace", apps: "marketplace",
};

const STUB_PANEL_PROPS = {} as IDockviewPanelProps;

type StageDrawer =
  | { kind: "panel"; panelId: string }
  | { kind: "review"; title: string; node: React.ReactNode; key: string };

/** Window width at which the interface editor keeps its full layout with the
 *  assistant open beside it. */
// The editor opens on the desktop page: nav (104) + page rail (132) + its
// side column (~352) + a 1024px page at its 60% floor (~660) + the assistant
// (~400). Below that the assistant would squeeze the page into a scroller.
const UI_EDITOR_ROOMY_WIDTH = 1680;

export function BlueprintStage({
  renderReviewPanel,
}: {
  /** Shell-owned renderer for AI change-review proposals (keeps the review
   *  component and its params typing in studio-shell). */
  renderReviewPanel: (detail: { toolCall: unknown; agentRunId?: string }, key: string) => { title: string; node: React.ReactNode };
}) {
  const { t } = useTranslation("editor");
  const mode = useStudioStore((s) => s.mode);
  const isPlaytest = mode === "playtest";
  const learning = useLearningWorkspace();
  const teaching = learning.step !== null;
  const serverWorldId = useEditorStore(s => s.serverWorldId);
  const readOnly = useEditorStore(s => s.readOnlyInspect || s.guestMode);
  const secondaryVariant = useEditorStore(s => s.variants.find(v => v.id === s.serverWorldId)?.isPrimaryVariant === false);
  const [showVersions, setShowVersions] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const saved = Number(readLocalPref("yumina-stage-inspector-width"));
    return saved >= 280 && saved <= 520 ? saved : STAGE_INSPECTOR_DEFAULT_WIDTH;
  });
  const [resizing, setResizing] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  // The stage mounts inside the dock's main panel, after this component's
  // own first commit — so it is measured when the element arrives, not once.
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const attachStage = useCallback((el: HTMLDivElement | null) => { stageRef.current = el; setStageEl(el); }, []);
  const [stageWidth, setStageWidth] = useState(0);
  const inspectorLayout = getStageInspectorLayout(stageWidth, inspectorWidth);
  useLayoutEffect(() => {
    const stage = stageEl;
    if (!stage) return;
    const measure = () => {
      const width = stage.getBoundingClientRect().width;
      setStageWidth(current => Math.abs(current - width) < 1 ? current : width);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [stageEl]);
  useEffect(() => {
    if (!resizing) return;
    const move = (event: PointerEvent) => {
      const bounds = stageRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const layout = getStageInspectorLayout(bounds.width, inspectorWidth);
      const right = bounds.right - (layout.overlay ? STAGE_INSPECTOR_OVERLAY_INSET : 0);
      const next = Math.round(Math.max(layout.minWidth, Math.min(layout.maxWidth, right - event.clientX)));
      setInspectorWidth(next);
      writeLocalPref("yumina-stage-inspector-width", String(next));
    };
    const end = () => setResizing(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end); };
  }, [resizing, inspectorWidth]);

  // The assistant is open on arrival, docked on the right — it is how most
  // creators start. Its button, or ×, puts it away.
  const [aiOpen, setAiOpen] = useState(() => !readOnly);
  // The assistant panel mounts the first time it
  // opens (then stays parked, listening). A job sent before that — the ask
  // bar, the first question, a block's ✦ — reached no listener. It is held
  // here and sent again once the panel is on the page.
  const assistantMountedRef = useRef(false);
  const heldForAssistant = useRef<Event[]>([]);
  const holdForAssistant = useCallback((event: Event) => {
    if (assistantMountedRef.current || (event as Event & { redelivered?: boolean }).redelivered) return;
    const detail = (event as CustomEvent).detail;
    const copy = new CustomEvent(event.type, { detail }) as CustomEvent & { redelivered?: boolean };
    copy.redelivered = true;
    heldForAssistant.current.push(copy);
  }, []);

  // Opt-IN, under its own key. The old key's absence meant "open", which was
  // right while the tree held its own column and wrong now that it covers the
  // canvas — an overlay that greets you closed is an overlay you asked for.
  const [treeOpen, setTreeOpen] = useState(() => readLocalPref("yumina-stage-tree-v2") === "open");
  const toggleTree = useCallback(() => {
    setTreeOpen((v) => {
      writeLocalPref("yumina-stage-tree-v2", v ? "closed" : "open");
      return !v;
    });
  }, []);
  /** Something is selected on the canvas, so the right column is showing it
   *  rather than the assistant. */
  const [inspectorOpen, setInspectorOpen] = useState(false);
  /** The slot the canvas portals that editor into. */
  const [inspectorHost, setInspectorHost] = useState<HTMLDivElement | null>(null);
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null);
  const [drawer, setDrawer] = useState<StageDrawer | null>(null);
  /** Which page the centre shows. The blueprint stays mounted underneath the
   *  frontend page so its layout, selection and undo history survive a look at
   *  the card — the same reason the drill drawer overlays rather than swaps. */
  // In the studio store: the shell's top bar is the switch, this draws it.
  const centre = useStudioStore((s) => s.stagePage);
  const { features } = useEdition();
  const setCentre = useStudioStore((s) => s.setStagePage);
  // Prototype (?screen=1): the card opens on the player's screen, and a
  // playtest is shown the way Slides presents — across the whole frame.
  const [screenFirst] = useState(isScreenFirst);
  useEffect(() => { useStudioStore.getState().setStagePage(screenFirst ? "frontend" : "blueprint"); }, [screenFirst]);
  // The top bar's switch changes the page from outside: a drill-down page or
  // the floating index belongs to the page being left.
  useEffect(() => {
    setDrawer((d) => d?.kind === "panel" ? null : d);
    if (centre !== "blueprint") setTreeOpen(false);
    // The interface editor needs its page rail and side column (it folds them
    // into a sheet below ~880px of its own width). On a laptop the assistant
    // beside it takes exactly that room, so stepping into the player's screen
    // puts the assistant away; its button brings it back.
    if (centre === "frontend" && typeof window !== "undefined" && window.innerWidth < UI_EDITOR_ROOMY_WIDTH) setAiOpen(false);
  }, [centre]);
  const routingSection = useRef(false);

  const toggleAi = useCallback(() => {
    setAiOpen(open => !open);
  }, []);
  /** A block's ✦ fills the assistant's composer. If the assistant is closed,
   *  that lands somewhere the creator cannot see and the click reads as a
   *  no-op — so the same event that writes the sentence also reveals it.
   *  Opening it here rather than in `askForBlock` keeps visibility owned by
   *  the component that decides what the right rail shows. */
  useEffect(() => {
    const reveal = (event: Event) => {
      window.dispatchEvent(new Event("yumina:studio-canvas-clear-selection"));
      holdForAssistant(event);
      setAiOpen(true);
    };
    window.addEventListener(STUDIO_ASK_EVENT, reveal);
    return () => window.removeEventListener(STUDIO_ASK_EVENT, reveal);
  }, []);

  const openDrill = useCallback((panelId: string) => {
    const store = useEditorStore.getState();
    if (panelId === "overview" && store.variants.find(v => v.id === store.serverWorldId)?.isPrimaryVariant === false) panelId = "variants";
    // The blueprint's frontend block used to drill into a 620px builder strip.
    // The card's own screen is a first-class page now, so that gesture lands
    // where a person looking at their frontend expects to be.
    if (panelId === "frontend") {
      setDrawer(null);
      setCentre("frontend");
      setTreeOpen(false);
      return;
    }
    // AI generation is the page beside the board — pictures and sound — not
    // a drawer. It took the player-interface tab's place: that page was the
    // interface block drawn a second time, and generation is a job that needs
    // a whole page (wait, several results, listen, pick).
    if (panelId === "generation") {
      if (!features.imageGeneration) return;
      setDrawer(null);
      setCentre("generation");
      setTreeOpen(false);
      return;
    }
    if (DRAWER_PANELS[panelId]) {
      const section = (Object.entries(SECTION_PANEL) as [EditorSection, string][]).find(([, id]) => id === panelId)?.[0];
      if (section && store.activeSection !== section) {
        routingSection.current = true;
        store.setActiveSection(section);
        routingSection.current = false;
      }
      setDrawer({ kind: "panel", panelId });
      setTreeOpen(false);
    }
  }, [features.imageGeneration]);

  // Reused full editors navigate through the editor store. Honor those
  // requests without making every form know about the Studio shell.
  useEffect(() => useEditorStore.subscribe((state, previous) => {
    if (routingSection.current || state.worldDraft.id !== previous.worldDraft.id) return;
    if (state.activeSection !== previous.activeSection || (state.pendingFocus && state.pendingFocus !== previous.pendingFocus)) {
      openDrill(SECTION_PANEL[state.activeSection]);
    }
  }), [openDrill]);

  useEffect(() => {
    const showCanvas = () => { setDrawer(null); setCentre("blueprint"); };
    window.addEventListener("yumina:studio-canvas-focus", showCanvas);
    return () => window.removeEventListener("yumina:studio-canvas-focus", showCanvas);
  }, []);

  // A hand-off from another surface (the classic editor's "arrange it like
  // a slide deck" banner): the sender stores which panel it wants open,
  // because an event fired before this component mounts would just be lost.
  useEffect(() => {
    const open = (event: Event) => {
      const { panelId, canvasTarget } = (event as CustomEvent<{ panelId: string; canvasTarget?: string }>).detail;
      useStudioStore.getState().setMode(panelId === "playtest" ? "playtest" : "edit");
      if (canvasTarget || panelId === "blueprint" || panelId === "ai-chat" || panelId === "playtest") {
        setDrawer(null); setCentre("blueprint");
        setTreeOpen(false);
        if (canvasTarget) {
          // Route the workspace before asking its canvas to resolve a target.
          // Its fallback drawer must not be overwritten by this handler.
          window.dispatchEvent(new CustomEvent(LEARNING_CANVAS_EVENT, { detail: { panelId, canvasTarget } }));
        }
        if (panelId === "blueprint" || panelId === "ai-chat") {
          window.dispatchEvent(new Event("yumina:studio-canvas-clear-selection"));
          setInspectorOpen(false);
        }
        if (panelId === "ai-chat") setAiOpen(true);
      } else openDrill(panelId);
    };
    window.addEventListener(LEARNING_PANEL_EVENT, open);
    const pending = sessionStorage.getItem("yumina-studio-learning-target");
    if (pending) {
      sessionStorage.removeItem("yumina-studio-learning-target");
      try { open(new CustomEvent(LEARNING_PANEL_EVENT, { detail: JSON.parse(pending) })); } catch { /* Ignore an obsolete tab handoff. */ }
    }
    return () => window.removeEventListener(LEARNING_PANEL_EVENT, open);
  }, [openDrill]);

  useEffect(() => {
    const wanted = takeRequestedPanel((panel) => panel === "frontend" || !!DRAWER_PANELS[panel]);
    if (wanted) openDrill(wanted);
  }, [openDrill]);

  // Header actions that are dockview panel-opens in classic mode (the
  // marketplace chip) arrive here as an event — the shell's dockview api is
  // null while the stage is up, so its own handler no-ops.
  useEffect(() => {
    const handler = (event: Event) => {
      const panelId = (event as CustomEvent<{ panelId?: string }>).detail?.panelId;
      if (panelId) openDrill(panelId);
    };
    window.addEventListener("yumina:studio-stage-open-panel", handler);
    return () => window.removeEventListener("yumina:studio-stage-open-panel", handler);
  }, [openDrill]);

  // "Open the code" from the frontend inspector. The panel it targets may not
  // be mounted yet, so the line is parked for it to claim rather than shouted
  // at a listener that does not exist for another frame.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ file?: string; line?: number }>).detail;
      if (!detail?.file) return;
      setPendingCodeJump(detail.file, detail.line ?? 1);
      setDrawer({ kind: "panel", panelId: "code-view" });
      setTreeOpen(false);
    };
    window.addEventListener("yumina:studio-open-code", handler);
    return () => window.removeEventListener("yumina:studio-open-code", handler);
  }, []);

  // A job handed to the AI from another surface (the builder's 拆积木 button)
  // must land in a VISIBLE column — the chat panel stays mounted while
  // hidden, so it will receive and run the message either way, but a run the
  // user can't watch is a run they'll think never started.
  useEffect(() => {
    const handler = (event: Event) => {
      window.dispatchEvent(new Event("yumina:studio-canvas-clear-selection"));
      holdForAssistant(event);
      setAiOpen(true);
    };
    window.addEventListener("yumina:studio-ai-send", handler);
    window.addEventListener("yumina:studio-attach-block", handler);
    return () => {
      window.removeEventListener("yumina:studio-ai-send", handler);
      window.removeEventListener("yumina:studio-attach-block", handler);
    };
  }, []);

  // AI change proposals open in the drawer (same event the shell handles in
  // classic mode — there its dockview api is null while the stage is up).
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ toolCall?: unknown; agentRunId?: string }>).detail;
      if (!detail?.toolCall) return;
      const key = `${detail.agentRunId ?? "local"}:${Date.now()}`;
      const review = renderReviewPanel({ toolCall: detail.toolCall, agentRunId: detail.agentRunId }, key);
      setDrawer({ kind: "review", title: review.title, node: review.node, key });
    };
    window.addEventListener("yumina:studio-mobile-review", handler);
    return () => window.removeEventListener("yumina:studio-mobile-review", handler);
  }, [renderReviewPanel]);

  // Playtest owns the right edge — the drawer yields.
  useEffect(() => {
    if (isPlaytest) setDrawer(null);
  }, [isPlaytest]);

  // ESC closes the drawer.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) setDrawer(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  // The shell's ← is the editor's only way back, and it goes back one step:
  // whatever this stage has open over the board closes first, and only a
  // board with nothing over it lets the arrow leave the card.
  useEffect(() => {
    const back = (event: Event) => {
      if (showVersions) setShowVersions(false);
      else if (drawer) setDrawer(null);
      else if (isPlaytest) useStudioStore.getState().setMode("edit");
      else if (centre !== "blueprint") setCentre("blueprint");
      else return;
      event.preventDefault();
    };
    window.addEventListener(STUDIO_BACK_EVENT, back);
    return () => window.removeEventListener(STUDIO_BACK_EVENT, back);
  }, [showVersions, drawer, isPlaytest, centre, setCentre]);

  const drawerMeta = drawer?.kind === "panel" ? DRAWER_PANELS[drawer.panelId] : null;
  const DrawerComponent = drawerMeta?.component;

  // ── The frame. One centre with two pages, one right column with one
  // identity, and an index that floats instead of taking width.
  //
  // A playtest always opens the column — collapsing the thing you are playing
  // is not a state anyone means, and neither is selecting something and having
  // nowhere for it to appear. Closing the selection hands the column back to
  // whatever the creator had chosen before.
  // The card's TSX compiles in exactly one place. The frontend page and a
  // running playtest each take that place; the blueprint's interface block
  // stands down for both.
  const frontendShown = centre === "frontend" && !isPlaytest;
  const generationShown = features.imageGeneration && centre === "generation" && !isPlaytest;
  /**
   * The player view is not a page in the editor's frame — it IS the frame.
   *
   * Arranging a card means looking at the card, and the card was the fourth
   * band down a stack of chrome: the world's own bar, the page tabs, the
   * inspector's toolbar, and only then the thing being made. Each band is
   * defensible on its own and together they left a 812-tall phone rendering
   * at a third of the height of a monitor.
   *
   * So this page takes the viewport. The rail, the tabs and the shell's bar
   * all go; the way back is one control in the top-left corner, which is the
   * only thing that has to be true of a mode you can be inside of.
   *
   * Not while a drill-down page or the version dialog is open — those are
   * other surfaces, and they need the frame back to be reachable.
   */
  const immersive = frontendShown && !drawer && !showVersions;
  const detailShown = drawer?.kind === "panel";
  const reviewShown = drawer?.kind === "review";
  const canvasInspectorShown = inspectorOpen && !frontendShown && !generationShown && !detailShown && !isPlaytest;
  // While a lesson is on, the assistant only shows for the lessons that are
  // about it — the guide stands on the canvas beside the block it teaches,
  // and a column beside a staged board is 340px the block does not get.
  // The assistant is a window of its own now: selecting a block or starting a
  // playtest no longer takes its place.
  const aiShown = aiOpen && (!teaching || (learning.step !== null && lessonById(learning.step)?.panel === "ai-chat"));
  useEffect(() => {
    if (!aiShown || assistantMountedRef.current) return;
    // Wait for the panel itself, then hand it what came in while it was not
    // there.
    let tries = 0;
    const timer = window.setInterval(() => {
      if (!document.querySelector('[data-onboarding="assistant"]') && ++tries < 40) return;
      window.clearInterval(timer);
      window.setTimeout(() => {
        assistantMountedRef.current = true;
        const held = heldForAssistant.current.splice(0);
        for (const event of held) window.dispatchEvent(event);
      }, 200);
    }, 75);
    return () => window.clearInterval(timer);
  }, [aiShown]);
  // The assistant used to float over the frontend page and the full editors,
  // hiding whatever sat under its 400px (a preview cut to one line, an
  // Overview form with its right edge gone). It now takes a real column there,
  // exactly as it does beside the canvas: the page shrinks, nothing is covered.
  const inspectorOverlay = canvasInspectorShown && inspectorLayout.overlay;
  const companionOverlay = inspectorOverlay;
  // A playtest is the player's screen across the whole frame, as it is when
  // the card is played for real — not a column squeezed beside the board
  // (where it also remembered the last side it was docked on, and opened on
  // the left with the board pushed right).
  const fullPlay = isPlaytest;
  const rightExpanded = canvasInspectorShown || fullPlay;
  useLayoutEffect(() => {
    learning.setInspecting(canvasInspectorShown);
    return () => learning.setInspecting(false);
  }, [canvasInspectorShown, learning.setInspecting]);

  // The shell's bar stays: it holds the switch between the pages, and a page
  // you cannot switch away from is a mode. Only the canvas's own row and rail
  // step aside for the player view.

  // The narrow inspector is a temporary view over the same canvas. Its own
  // close button clears selection; Escape uses that exact same action.
  useEffect(() => {
    if (!inspectorOverlay || drawer || showVersions) return;
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      window.dispatchEvent(new Event("yumina:studio-canvas-clear-selection"));
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [inspectorOverlay, drawer, showVersions]);

  const dockHeader = "flex shrink-0 items-center gap-2 border-b border-white/[0.07] px-3 py-2";
  const dockTitle = "min-w-0 flex-1 truncate text-xs font-bold text-foreground";
  const dockIconBtn = "rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";
  const pageTab = (active: boolean) =>
    cn(
      "shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-[11px] font-semibold transition-colors",
      active ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
    );

  // When the assistant is the one playing, the playtest says so, and says
  // what it checks and which turn — you are watching it test, not testing.
  const aiPlaytest = useStudioStore((s) => s.aiPlaytest);
  const aiPlaying = aiPlaytest && !aiPlaytest.done
    ? t("studio.job.playingBanner", { label: `${aiPlaytest.purpose ? `${aiPlaytest.purpose} · ` : ""}${aiPlaytest.turn}/${aiPlaytest.total}` })
    : null;
  // A playtest has one place to type. With the assistant beside it there were
  // two near-identical boxes, and a line meant for the character went to the
  // assistant (and was billed). It steps aside while you play — unless it is
  // the one playing — and comes back as it was when the playtest ends.
  const aiBeforePlay = useRef<boolean | null>(null);
  useEffect(() => {
    if (isPlaytest) {
      if (aiBeforePlay.current !== null) return;
      aiBeforePlay.current = aiOpen;
      if (!useStudioStore.getState().aiPlaytest) setAiOpen(false);
    } else if (aiBeforePlay.current !== null) {
      setAiOpen(aiBeforePlay.current);
      aiBeforePlay.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaytest]);
  // A situation's settings (or anything else that opens the column beside
  // the board) and the assistant were two columns at once, and the board
  // left between them was a strip. Settings are hand work: the assistant
  // steps aside while they are open and comes back as it was. Its button
  // still brings it back in the meantime.
  const aiBeforeInspect = useRef<boolean | null>(null);
  useEffect(() => {
    if (canvasInspectorShown) {
      if (aiBeforeInspect.current !== null) return;
      aiBeforeInspect.current = aiOpen;
      setAiOpen(false);
    } else if (aiBeforeInspect.current !== null) {
      if (aiBeforeInspect.current) setAiOpen(true);
      aiBeforeInspect.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasInspectorShown]);
  // The playtest covers the toolbar that holds the assistant's button, so it
  // borrows the toggle to offer its own.
  const setStageAssistant = useStudioStore((s) => s.setStageAssistant);
  useEffect(() => { setStageAssistant({ open: aiShown, toggle: toggleAi }); }, [aiShown, toggleAi, setStageAssistant]);
  useEffect(() => () => setStageAssistant(null), [setStageAssistant]);
  // The block or row the assistant is changing right now glows on the canvas.
  useAgentPresence();
  useExternalWrites(useEditorStore((s) => s.serverWorldId));

  const stageTools: DockTool[] = [
    {
      id: "ai",
      title: t("studio.panels.aiAssistant"),
      open: aiShown,
      onClose: () => setAiOpen(false),
      keepMounted: true,
      defaultPosition: { direction: "right", size: 400 },
      children: <div data-onboarding="assistant" className="flex h-full min-h-0 flex-col"><AiChatPanel {...STUB_PANEL_PROPS} /></div>,
    },
    {
      id: "playtest",
      title: t("studio.panels.playtest"),
      open: false,
      onClose: () => useStudioStore.getState().setMode("edit"),
      defaultPosition: { direction: "right", size: 480 },
      children: (
        <div className="flex h-full min-h-0 flex-col">
          {aiPlaying && (
            <div data-ai-playtest className="flex shrink-0 items-center gap-2 border-b border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
              {aiPlaying}
            </div>
          )}
          <div className="min-h-0 flex-1"><PlaytestPanel {...STUB_PANEL_PROPS} /></div>
        </div>
      ),
    },
  ];

  return (
    <>
    <AiPresenceLayer />
    <DockWorkspace scope="canvas" mainTitle={t("studio.panels.blueprint")} tools={stageTools} className="flex min-h-0 w-full flex-1">
    <div
      ref={attachStage}
      className={cn(
        "relative flex min-h-0 w-full flex-1 overflow-hidden",
      )}
    >
      {/* No left rail: it held 44px for one button (the outline), and search
          finds the same things. */}
      {/* ── Centre: two pages, one frame ── */}
      <div className={cn("flex min-w-0 flex-1 flex-col", fullPlay && "invisible")} inert={fullPlay || undefined}>
        {!immersive && (
        // Three columns: the page tabs, the board's tools in the middle of
        // the row, the assistant on the right. The outer two share what is
        // left equally, so the middle stays centred and never runs into the
        // tabs on a narrow screen. Narrower than the toolbar wants (a
        // playtest beside the assistant leaves the board ~440px), the outer
        // buttons drop their words for their icons rather than being cut to
        // 「面」 and 「作助手」.
        <div className="@container grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-white/[0.07] px-2 py-1.5">
          <div className="flex min-w-0 items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild><button type="button" data-onboarding="editors" className={cn(pageTab(!!detailShown), "flex items-center gap-1.5")}><PanelsTopLeft className="h-3.5 w-3.5 shrink-0" /><span className="truncate @max-[46rem]:hidden">{detailShown && drawerMeta ? t(drawerMeta.titleKey as never) : t("studio.workspace.editors")}</span><ChevronDown className="h-3 w-3 shrink-0" /></button></DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-[80vh] w-60 overflow-y-auto">
              {/* What only lives here first; then the same things the board
                  shows, as full-page lists (folders, bulk edits, imports),
                  labelled as such so they no longer read as a second,
                  rival place to edit each thing. Nothing is taken out. */}
              {["overview", "code-view", "assets", "variants", "marketplace"].filter(id => id !== "overview" || !secondaryVariant).map(id => { const meta = DRAWER_PANELS[id]!; return <DropdownMenuItem key={id} onSelect={() => openDrill(id)} className="gap-2 py-2"><meta.icon className="h-4 w-4 text-muted-foreground" />{t(meta.titleKey as never)}</DropdownMenuItem>; })}
              <DropdownMenuItem disabled={!serverWorldId || !!readOnly} onSelect={() => setShowVersions(true)} className="gap-2 py-2"><History className="h-4 w-4" />{t("studio.versionHistory")}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <p className="px-2 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">{t("studio.workspace.fullLists")}</p>
              {["first-message", "lorebook", "variables", "rules", "modules", "components", "audio", "scene-images", "packs"].map(id => { const meta = DRAWER_PANELS[id]!; return <DropdownMenuItem key={id} onSelect={() => openDrill(id)} className="gap-2 py-1.5 text-muted-foreground"><meta.icon className="h-4 w-4" />{t(meta.titleKey as never)}</DropdownMenuItem>; })}
            </DropdownMenuContent>
          </DropdownMenu>
          {/* The board's tools (加东西, then search and view once the board
              has something to find) sit beside 面板 on the left, where a row
              of tools is read from — alone in the middle of the bar, 加东西
              read as a stray button. Portalled from the canvas; invisible
              with the board, not removed. */}
          <div ref={setToolbarHost} data-stage-toolbar className={cn("flex min-w-0 items-center justify-start", (frontendShown || generationShown || detailShown) && "invisible")} />
          </div>

          <div className="flex min-w-0 items-center justify-end gap-1 overflow-hidden">
            <StudioLearningButton />
            <StudioDocsButton />
            <button type="button" onClick={toggleAi} aria-pressed={aiShown} title={t("studio.panels.aiAssistant")} className={cn(pageTab(aiShown), "flex shrink-0 items-center gap-1.5 whitespace-nowrap")}><MessageSquare className="h-3.5 w-3.5" /><span className="@max-[46rem]:hidden">{t("studio.panels.aiAssistant")}</span></button>
          </div>
        </div>
        )}

        <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* The canvas gets a way to take the whole frame.
            The right column is 32vw — the right size for a conversation with
            the assistant, and 500px of nothing when there is not one yet. The
            canvas is where that costs something: a big board is already pinned
            at the readable-zoom floor, and the column is the width it is short
            of. So the control lives on the canvas too, wired to the very same
            toggle as the column's own header — the two can never disagree
            about whether it is open.
            Not during a playtest: collapsing the thing you are playing is not
            a state anyone means. */}
        <div data-onboarding="blueprint" className={cn("h-full min-h-0", (frontendShown || generationShown || detailShown) && "invisible")} inert={frontendShown || generationShown || detailShown || reviewShown || showVersions} aria-hidden={frontendShown || generationShown || detailShown}>
        <BlueprintCanvasCore
          onDrillPanel={openDrill}
          onInspectorChange={setInspectorOpen}
          inspectorHost={inspectorHost}
          active={!frontendShown && !generationShown && !drawer && !showVersions}
          edgeInsets={{ left: 12, right: inspectorOverlay ? inspectorLayout.width + STAGE_INSPECTOR_OVERLAY_INSET : 12 }}
          previewOwnedElsewhere={frontendShown || isPlaytest}
          focus={isPlaytest ? undefined : { active: !aiOpen, toggle: toggleAi, kind: "rail" }}
          toolbarHost={immersive ? null : toolbarHost}
        />

        </div>
        {/* What the card's lore costs, in the board's top-right corner; it
            steps left of an inspector that floats over the board. */}
        {!frontendShown && !generationShown && !detailShown && !isPlaytest && (
          <LoreTokenMeter right={inspectorOverlay ? inspectorLayout.width + STAGE_INSPECTOR_OVERLAY_INSET + 12 : 12} />
        )}

        {/* The card's own screen. Overlays rather than replaces, so the
            blueprint keeps its layout, selection and undo history. */}
        {generationShown && (
          <div className={cn("absolute inset-0 z-20 bg-[#0d0c11]", detailShown && "invisible")} inert={!!drawer || showVersions} aria-hidden={!!detailShown} data-generation-page>
            <GenerationAtelier worldId={serverWorldId ?? null} />
          </div>
        )}
        {frontendShown && (
          <div className={cn("absolute inset-0 z-20 bg-[#0d0c11]", detailShown && "invisible")} inert={!!drawer || showVersions} aria-hidden={!!detailShown}>
            <FrontendPage
              screenFirst={screenFirst}
              active={!drawer && !showVersions}
              immersive={immersive}
              assistant={{ open: aiShown, toggle: toggleAi }}
            />
          </div>
        )}

        {/* The index, floating. */}
        {treeOpen && (
          <div className="absolute bottom-2 left-2 top-2 z-40 flex w-[232px] flex-col studio-pill overflow-hidden rounded-xl border backdrop-blur-xl">
            <div className={dockHeader}>
              <ListTree className="h-3.5 w-3.5 shrink-0 text-violet-300" />
              <span className={dockTitle}>{t("blueprint.tree.title")}</span>
              <button type="button" onClick={toggleTree} title={t("studio.stage.close")} className={dockIconBtn}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <StageTree />
            </div>
          </div>
        )}

        {/* Detail page: drilling into an object turns the WHOLE centre into
            that object's editor — a whole page, not a 620px strip. The canvas
            stays mounted underneath (layout, selection and undo state survive)
            and the top bar's ← walks straight back to it.
            The AI keeps its column throughout. */}
        {drawer && drawer.kind === "panel" && DrawerComponent && (
          <div className="absolute inset-0 z-30 flex flex-col bg-[#131118]">
            {/* A title, not a way out: the top bar's ← is the one way back
                (it closes this page first), and Esc does the same. */}
            <div className="flex shrink-0 items-center gap-1.5 border-b border-white/[0.07] px-3 py-2">
              {drawerMeta && <drawerMeta.icon className="h-3.5 w-3.5 shrink-0 text-amber-400" />}
              <span className={dockTitle}>{t(drawerMeta!.titleKey as never)}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <DrawerComponent {...STUB_PANEL_PROPS} />
            </div>
          </div>
        )}

        {/* AI change-review proposals stay a transient overlay — they relate
            to the canvas you are looking at, so they must not replace it. */}
        {drawer && drawer.kind === "review" && (
          <div className="absolute bottom-3 right-3 top-3 z-[60] flex w-[620px] max-w-[90%] flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#181a24] shadow-[0_24px_80px_rgba(0,0,0,0.6)]">
            <div className={dockHeader}>
              <Code className="h-3.5 w-3.5 shrink-0 text-amber-400" />
              <span className={dockTitle}>{drawer.title}</span>
              <button type="button" onClick={() => setDrawer(null)} title={t("studio.stage.close")} className={dockIconBtn}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">{drawer.node}</div>
          </div>
        )}
        </div>
      </div>

      {/* ── Right column: one place, three occupants ──
          A creator is doing exactly one of three things at any instant: playing
          the card, talking to the assistant, or editing the thing they just
          clicked. Selecting something USED to open a third column that shoved
          the canvas from 939px to 599px while the assistant sat idle beside it
          — clicking an entry means "I am doing this by hand", which is the one
          moment the assistant is not wanted.
          The assistant stays mounted underneath so its conversation and scroll
          survive a detour into an entry. */}
      <aside
        data-studio-companion={canvasInspectorShown ? "inspector" : "playtest"}
        data-studio-companion-layout={rightExpanded ? companionOverlay ? "overlay" : "column" : "closed"}
        className={cn(
          "studio-column shrink-0 flex-col border-l border-white/[0.07]",
          rightExpanded ? "flex" : "hidden",
          // Over the board, not instead of it: hidden, the board measured
          // nothing, laid itself out for a zero-wide frame and came back from
          // a playtest as a thumbnail in the corner.
          fullPlay ? "absolute inset-0 z-40 border-l-0 bg-background" : companionOverlay ? "absolute bottom-3 right-3 top-14 z-50 rounded-xl border shadow-2xl" : "relative h-full min-h-0",
        )}
        style={fullPlay ? undefined : { width: canvasInspectorShown ? inspectorLayout.width : 400, maxWidth: companionOverlay ? "calc(100% - 24px)" : canvasInspectorShown ? undefined : "42%" }}
      >
        {canvasInspectorShown && <div
          role="separator" aria-label={t("blueprint.insp.resize")} aria-orientation="vertical"
          aria-valuemin={inspectorLayout.minWidth} aria-valuemax={inspectorLayout.maxWidth} aria-valuenow={inspectorLayout.width} tabIndex={0}
          onPointerDown={event => { event.preventDefault(); setResizing(true); }}
          onDoubleClick={() => { setInspectorWidth(STAGE_INSPECTOR_DEFAULT_WIDTH); writeLocalPref("yumina-stage-inspector-width", String(STAGE_INSPECTOR_DEFAULT_WIDTH)); }}
          onKeyDown={event => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const next = Math.max(inspectorLayout.minWidth, Math.min(inspectorLayout.maxWidth, inspectorLayout.width + (event.key === "ArrowLeft" ? 20 : -20)));
            setInspectorWidth(next); writeLocalPref("yumina-stage-inspector-width", String(next));
          }}
          className={cn("absolute -left-1 top-0 z-20 h-full w-2 cursor-col-resize hover:bg-primary/30 focus-visible:bg-primary/30", resizing && "bg-primary/30")}
        />}
        <div ref={setInspectorHost} className={cn("min-h-0 flex-1", !canvasInspectorShown && "hidden")} />
        {fullPlay && <>
          {aiPlaying && (
            <div data-ai-playtest className="flex shrink-0 items-center gap-2 border-b border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" aria-hidden="true" />
              {aiPlaying}
            </div>
          )}
          <div className="min-h-0 flex-1"><PlaytestPanel {...STUB_PANEL_PROPS} /></div>
        </>}
      </aside>
      {showVersions && serverWorldId && <Suspense fallback={null}><VersionHistoryDialog worldId={serverWorldId} onClose={() => setShowVersions(false)} /></Suspense>}
    </div>
    </DockWorkspace>
    </>
  );
}
