import { Component, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LEARNING_CANCEL_EVENT, LEARNING_CANVAS_EVENT, LEARNING_REVEAL_EVENT, LEARNING_ROOM_EVENT, LEARNING_SHOW_EVENT, LEARNING_STEP_EVENT, LEARNING_TARGET_EVENT } from "../learn/learning-catalog";
import { resolveLearningCanvasTarget, type LearningCanvasTarget } from "../learn/learning-target";
import { flowNodeBlockKind, learningStageHides } from "../learn/learning-stage";
import { TOUR_CARD_HEIGHT } from "../learn/tour-spotlight";
import { aiRoster, hasSeveralAis } from "./blueprint/ai-roster";
import { AiTable } from "./blueprint/ai-table";
import { NOTE_SIZE, StickyNoteLayer } from "./blueprint/sticky-note-layer";
import { rowFacts, type Translate } from "./blueprint/row-facts";
import { useLearningWorkspace } from "../learn/learning-workspace";
import { useStudioSidebarStore } from "@/stores/studio-sidebar";
import { useTokenizerReady } from "@/hooks/use-tokenizer-ready";
import type { IDockviewPanelProps } from "dockview-react";
import { useTranslation } from "react-i18next";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  useUpdateNodeInternals,
  ViewportPortal,
  MarkerType,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
  type IsValidConnection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  blockId,
  buildBoard,
  buildFrames,
  blockIdForNode,
  checkConditions,
  computeActiveWorldbookIds,
  isBlockId,
  memoryPoolMembers,
  parseRowHandle,
  portHandleId,
  resolveStation,
  rowHandleId,
  COVER_BACKGROUND_URL,
  DEFAULT_BACKGROUND_BLUR,
  DEFAULT_BACKGROUND_DIM, DEFAULT_BACKGROUND_OPACITY,
  toGraph,
  WORLD_LOGIC_KEYS,
  type Block,
  type GraphLayout,
  type GraphNode,
  type GraphPatch,
} from "@yumina/engine";
import { useAiFocus } from "../lib/ai-focus";
import { describeFocus } from "../lib/ai-focus-describe";
import { resolveBackground, UNPLACED_WORLDBOOK_ID } from "@yumina/engine";
import type { Worldbook } from "@yumina/engine";
import { absoluteImageUrl } from "@/lib/asset-url";
import {
  AlertTriangle,
  BookOpen,
  Boxes,
  Copy as CopyIcon,
  CopyPlus,
  ClipboardPaste,
  FolderInput,
  ArrowUpToLine,
  ChevronRight,
  ExternalLink,
  Layers,
  LayoutGrid,
  LayoutTemplate,
  ListChecks,
  Link2,
  Lock,
  LockOpen,
  Maximize2,
  Volume2,
  MessageCircle,
  MessageSquare,
  Network,
  Minimize2,
  ChevronsDownUp,
  ChevronsUpDown,
  Palette,
  Plus,
  Scan,
  Search,
  Spline,
  StickyNote,
  Trash2,
  Wand2,
  Bot,
  Table2,
  Variable as VariableIcon,
  X,
  Zap,
  Images,
  Image as ImageIcon,
  SlidersHorizontal,
  ChevronDown,
  Check,
} from "lucide-react";
import { useEditorStore } from "@/stores/editor";
import { feedback } from "@/lib/feedback";
import { classifyInterface } from "@/features/studio/lib/ui-doc-takeover";
import { proseSnippet } from "@/features/studio/lib/prose-snippet";
import { reactionSummary } from "@/features/studio/lib/reaction-summary";
import { FocusEditor } from "./blueprint/focus-editor";
import { useChatStore } from "@/stores/chat";
import { cn } from "@/lib/utils";
import { isLessonHello } from "@/lib/world-templates";
import { captureHubEvent } from "@/lib/analytics";
import { addStudioPanelInstance, getActiveStudioGroup } from "../studio-page-catalog";
import { KIND_STYLE, edgeColor } from "./blueprint/style";
import {
  BLOCK_MINI,
  BlockNode,
  GateNode,
  gateTint,
  type BlockNodeData,
  type BlockRowView,
  type ContextRowView,
  type GateNodeData,
} from "./blueprint/block-node";
import { AI_RECEIVES_H, BLOCK_W, FRAME_GAP, FRAME_NOTE_H, FRAME_TITLE_H, TILE_ROW_LIMIT, blockHeight, rowColumns, type BlockChrome, type FrameBox } from "./blueprint/board";
import { LETTERHEAD_W, letterheadBeside, letterheadRoom, tileBoardLayout } from "./blueprint/tile-board";
import { arrangeSituations, type SituationGroupBox } from "./blueprint/situation-map";
import { livesSomewhere, placeAis, type PlaceAis } from "./blueprint/place-ais";
import { addAiTo, removeAi } from "./blueprint/add-ai";
import { SituationGroupNode } from "./blueprint/situation-group-node";
import { memoryOf, poolColours } from "./blueprint/situation-describe";
import { wirePairs } from "./blueprint/wires";
import { moduleActivationBadge } from "@/features/editor/lib/module-badge";
import { computeContextBudget } from "@/features/editor/lib/context-budget";
import { LiveFrontendPreview } from "@/features/editor/components/preview/live-frontend-preview";
import { OpeningPreviewPicker, resolvePreviewOpening } from "./blueprint/opening-preview-picker";
import { BlueprintFloatingMenu, blueprintMenuAnchor } from "./blueprint/floating-menu";
import { setPendingCodeJump } from "@/lib/code-jump";
import { moduleSceneState } from "@/features/editor/components/preview/scene-state";
import { measureGaps, overlapping, snapToNeighbours, type Gap, type Rect as SnapRect, type Snap } from "./blueprint/helper-lines";
import { renderMessage } from "@/lib/markdown";
import { BlueprintInspector, isDerivedEdge, type InspectorTarget } from "./blueprint/inspector";
import { ObjectRelationshipsPanel, type RelationCandidate } from "./blueprint/object-relationships-panel";
import { requestUiEditor } from "./inspector/new-page-hooks";
import { AI_FOLLOW_EVENT } from "../lib/agent-job";
import { VoicePickerPopover } from "./blueprint/voice-picker-popover";
import { useAssetStore } from "@/stores/assets";
import { contextBadgeFor, type ContextBadge } from "@/features/editor/lib/module-context";
import { aiInspectorId, resolveCanvasInspectorNode } from "./blueprint/canvas-inspector-target";
import { defaultStateFor, turnContextView } from "./blueprint/turn-context";
import { liveRuntimeState } from "../lib/runtime-state";
import { lastTurnWhy } from "../lib/turn-explain";
import { TurnContextCard } from "./blueprint/turn-context-card";
import { StarterNode, type StarterNodeData } from "./blueprint/starter-node";
import { WireEdge } from "./blueprint/wire-edge";
import { isDefaultChatInterface } from "./blueprint/starter-state";
import { withStarterSlots, type CanvasBlock, type TrayItem } from "./blueprint/starter-board";
import { canvasBlockHostMap, canvasBlockHostsMap, resolveCanvasBlockId, resolveSourceBlockId } from "./blueprint/canvas-block-hosts";
import { cardReadiness } from "../lib/card-readiness";
import { askForBlock, blockAskKey, type AskableBlockKind } from "../lib/block-ask";
import { useBlueprintDocumentKey } from "./blueprint/use-blueprint-document";
import { CanvasWritingNode, canvasWritingNodeHeight, PRESETS_GROUP_ID, type CanvasWritingNodeData } from "./blueprint/canvas-writing-node";
import { BlueprintRowEditor, canEditRowInline } from "./blueprint/row-editor";
import { FloatingEditor, type FloatingAnchor } from "./blueprint/floating-editor";
import { useSmoothWheelZoom } from "./blueprint/use-smooth-wheel-zoom";
import { glide } from "./blueprint/glide";
import { PieceSlotNode, PIECE_SLOT_H, type PieceSlotNodeData } from "./blueprint/piece-slot-node";
import { pieceMoves } from "./blueprint/piece-move";
import { useInitialBlueprintFit } from "./blueprint/use-initial-blueprint-fit";
import { useBlueprintTargetNavigation, waitForMeasuredBlueprintTarget, type BlueprintTargetRequest } from "./blueprint/use-blueprint-target-navigation";
import { getUnmappedSearchPanel, getWorldSearchNode, indexWorldContent, searchWorldContent } from "../lib/world-search";
import { useTurnDiff } from "./blueprint/turn-diff";
import { isTextEntryTarget } from "../lib/text-entry-target";
import { readLocalPref, writeLocalPref } from "../lib/local-pref";

const NODE_TYPES = { block: BlockNode, gate: GateNode, starter: StarterNode, writing: CanvasWritingNode, pieceSlot: PieceSlotNode, situationGroup: SituationGroupNode };
const EDGE_TYPES = { wire: WireEdge };

/** Bumped for the board. Every version so far has changed what a coordinate
 *  belongs to — v1 keyed objects, v2 keyed racks, v3 keys blocks — and a
 *  partial match is worse than none: honouring the handful of ids that happen
 *  to survive strands those nodes wherever the old canvas left them while
 *  everything else lands in formation. A version mismatch drops the whole
 *  coordinate table. Sticky notes live under their own key and are carried
 *  through untouched. */
// 4: blocks live inside module frames, so their coordinates are relative to
// the frame rather than to the canvas. A version-3 layout read as version 4
// would scatter every block by its frame's offset.
// 5: only FRAMES carry coordinates, and only the ones the creator dragged
// (`pinned`); blocks keep just their collapsed flag. A version-4 table held a
// coordinate for every block from the last collapse toggle, which read as v5
// would pin the whole board wherever it happened to be.
const GRAPH_LAYOUT_VERSION = 5;

/** The frames the creator dragged, at the coordinate they were dropped. */
/** A module frame (or the card's fallback strip): the nodes a drag may move
 *  and the smart guides align. Blocks are laid out by the board; notes have
 *  their own store. */
const isFrameNodeId = (id: string) => id.startsWith("module:") || id.startsWith("frame:");
/** A loose object's own block: top-level and dragged, unlike other blocks. */
const isLooseBlockId = (id: string) => id.startsWith("block:loose:");

/** Card-level objects the creator has not yet put in a module, and where
 *  each stands on the canvas. */
function storedLoose(layout: GraphLayout | undefined): Record<string, { x: number; y: number }> {
  if (!layout || layout.version !== GRAPH_LAYOUT_VERSION) return {};
  const out: Record<string, { x: number; y: number }> = {};
  for (const [id, p] of Object.entries(layout.nodes)) if (p.loose) out[id] = { x: p.x, y: p.y };
  return out;
}

function storedPinned(): Record<string, { x: number; y: number }> {
  const layout = useEditorStore.getState().worldDraft.graphLayout;
  if (!layout || layout.version !== GRAPH_LAYOUT_VERSION) return {};
  const out: Record<string, { x: number; y: number }> = {};
  for (const [id, p] of Object.entries(layout.nodes ?? {})) {
    if (p.pinned && !isBlockId(id)) out[id] = { x: p.x, y: p.y };
  }
  return out;
}

/** Below this the labels stop being readable, so "fit" stops shrinking and
 *  lets the creator pan instead. */
/** The board is allowed to fit down to this. Module and block names scale
 *  themselves up below 90% (see ZoomLabel), so at 30% the names are still
 *  ~11px on screen and the faces are still pictures; only the chips have
 *  gone small, and those are what zooming in is for. */
const MIN_READABLE_ZOOM = 0.3;
/** Below this a row is its name; at or above GLANCE_LEAVE it says what it
 *  holds. Between the two it keeps whatever it was. */
const GLANCE_ENTER = 0.72;
const GLANCE_LEAVE = 0.9;
/** The board's toolbar floats over the top of the canvas (`top-3`, 40px
 *  tall). Anything the viewport brings into view has to clear it, or its
 *  first line arrives underneath the toolbar. */
const TOOLBAR_CLEARANCE = 44;
/** The floor for a card's own board. Higher than a board of modules: this one
 *  is the card, and its rows carry the names you came to read. */
const STORY_BOARD_MIN_ZOOM = 0.62;
/** Room the camera keeps free for the guide when it frames a lesson's
 *  block: the card, its gap from the highlight, and its margin from the
 *  edge. Mushie stands next to the thing he is explaining, so the frame has
 *  to leave him a place to stand — beside the block when the block is
 *  tall, under it when the block is a wide shelf that a column beside it
 *  would shrink to nothing. */
/** The guide is docked at the bottom of the canvas, centred; whatever a
 *  lesson frames sits in the room above it. */
const LEARNING_GUIDE_BELOW = { bottom: TOUR_CARD_HEIGHT + 16 + 12, zoom: 0.85 };
/** The zoom a row of open tiles is packed for: three or four squares
 *  abreast on a laptop, at a size their rows can still be read. */
const TILE_ROW_ZOOM = 0.6;
/** The player's screen sits this close above the card: stuck to it. */
const SCREEN_STICK_GAP = 8;

/**
 * Every frame as a tile, keyed by id, the way the canvas looks them up —
 * plus the card's letterhead, which is laid out here because it is the one
 * thing on the board that belongs to no frame.
 *
 * The face and the chat background are the CARD's, not its content's, so
 * they are not blocks of the card's tile: they stand above it, side by side,
 * across its width. (Left of it they were the first thing on the board and
 * the two nobody could name; inside it they were one strip that read as
 * chrome rather than as two blocks about two different pictures.)
 */
/** The situations the board arranges beside the card. The placeholder book
 *  that holds unplaced content is not a situation anyone made, and an AI
 *  that lives on the card or in a situation is drawn in that place's
 *  「这里的 AI」, not as a frame of its own. */
function situationBooks(books: readonly Worldbook[] | undefined): Worldbook[] {
  return (books ?? []).filter((b) => b.id !== UNPLACED_WORLDBOOK_ID && !livesSomewhere(b));
}

/** 「AI」 stands open at the foot of every frame, like any other block: a
 *  row per AI, its name and its type (owner, 10/6). */
const blockCollapsed = (set: ReadonlySet<string>, id: string) => set.has(id);

/** 「这里的 AI」 for the card (no owner) or a situation. Canvas-only, like the
 *  tray: the engine's board has no rows for it. */
const placeAisBlock = (ownerId?: string): Block => ({
  id: blockId.ais(ownerId),
  kind: "ais",
  ...(ownerId ? { ownerId } : {}),
  headSlots: [],
  rows: [],
  hiddenCount: 0,
  total: 0,
  sharedCount: 0,
});

function tileBoxes(
  frames: ReadonlyArray<{ id: string; blocks: readonly Block[]; module?: GraphNode | null }>,
  opts: {
    heightAt: (block: Block, width: number) => number;
    isOpen: (frameId: string) => boolean;
    pinned: Record<string, { x: number; y: number }>;
    hasPreview: (block: Block) => boolean;
    openingId?: string;
    viewWidth: number;
    /** The card's situations, so they stand beside it grouped by how the
     *  player gets in rather than packed in rows under it. */
    worldbooks?: readonly Worldbook[];
    /** Receives the groups' outlines, for the board to draw behind them. */
    onGroups?: (groups: SituationGroupBox[]) => void;
    headerH?: number | ((frameId: string) => number);
  },
): Map<string, FrameBox> {
  const noted = new Set(frames.filter((f) => typeof f.module?.data.note === "string" && f.module.data.note).map((f) => f.id));
  // The letterhead's size does not depend on the tile — it is a fixed column
  // — so it can be measured before the pack and the room reserved for it.
  const cardFrameId = blockId.frame(null);
  const letterhead = (frames.find((f) => f.id === cardFrameId)?.blocks ?? [])
    .filter((b) => b.kind === "card" || b.kind === "background");
  const letterheadHeights = letterhead.map((b) => opts.heightAt(b, LETTERHEAD_W));
  const room = letterheadRoom(letterheadHeights);
  // The player's screen is the card's too, but not inside it (owner, 10/6):
  // its own block, stuck to the top of the card's tile, as wide as it.
  const screen = (frames.find((f) => f.id === cardFrameId)?.blocks ?? []).find((b) => b.kind === "frontend" && !b.ownerId);

  const boxes = tileBoardLayout(
    frames.map((f) => ({ id: f.id, blocks: f.blocks.filter((b) => b.kind !== "card" && b.kind !== "background" && b !== screen) })),
    opts.heightAt,
    {
      isOpen: opts.isOpen,
      hasNote: (id) => noted.has(id),
      openingId: opts.openingId,
      pinned: opts.pinned,
      hasPreview: opts.hasPreview,
      rowW: Math.max(1100, opts.viewWidth / TILE_ROW_ZOOM),
      headerH: opts.headerH,
      // Without this the next module in the row is packed straight over the
      // letterhead: the packer lays out frames, and this is not one.
      reserve: (id) => (id === cardFrameId && letterhead.length ? room : { w: 0, h: 0 }),
    },
  );
  const map = new Map(boxes.map((b) => [b.id, b]));
  const cardTile = map.get(cardFrameId);
  if (cardTile && letterhead.length) {
    const spots = letterheadBeside(cardTile, letterheadHeights);
    letterhead.forEach((block, i) => {
      const spot = spots[i]!;
      map.set(block.id, { id: block.id, ...spot, height: letterheadHeights[i]!, blocks: {} });
    });
  }
  if (cardTile && screen) {
    const height = opts.heightAt(screen, cardTile.width);
    map.set(screen.id, { id: screen.id, x: cardTile.x, y: cardTile.y - height - SCREEN_STICK_GAP, width: cardTile.width, height, blocks: {} });
  }
  const books = opts.worldbooks ?? [];
  if (cardTile && books.length) {
    const byFrame = new Map(books.map((b) => [blockId.frame(b.id), b]));
    const right = cardTile.x + cardTile.width + (letterhead.length ? room.w : 0);
    opts.onGroups?.(arrangeSituations(map, (id) => byFrame.get(id), { startX: right + FRAME_GAP * 2, startY: cardTile.y, pinned: opts.pinned }));
  } else {
    opts.onGroups?.([]);
  }
  return map;
}

/** Collapse flags ride in the same versioned coordinate map, so they are only
 *  meaningful when the version matches. */
function storedCollapsed(): string[] {
  const layout = useEditorStore.getState().worldDraft.graphLayout;
  if (!layout || layout.version !== GRAPH_LAYOUT_VERSION) return [];
  return Object.keys(layout.nodes ?? {}).filter((id) => layout.nodes[id]!.collapsed);
}

/** Every flow node is either a content block or a module gate. */
type BlueprintNode = import("@xyflow/react").Node<BlockNodeData | GateNodeData | StarterNodeData | CanvasWritingNodeData | PieceSlotNodeData>;

/** Which Studio panel a node drills into on double-click / "open full". */
/**
 * Which editor a block opens.
 *
 * The frontend block used to have two answers: hand-written cards were routed
 * to code, because the builder's welcome for them was a "this will overwrite
 * your work, forever" dialog. Adoption is lossless now — the existing
 * frontend becomes the document's preserved base layer and export restores it
 * exactly — so there is one answer: the interface opens the interface
 * builder. The code stays one button away inside it.
 */
function drillPanelFor(g: GraphNode, _handwritten = false): { panelId: string; titleKey: string } | null {
  switch (g.kind) {
    case "variable": return { panelId: "variables", titleKey: "studio.panels.variables" };
    case "entry": return { panelId: "lorebook", titleKey: "studio.panels.lorebook" };
    case "module": return { panelId: "modules", titleKey: "studio.panels.modules" };
    case "greeting": return { panelId: "first-message", titleKey: "studio.panels.firstMessage" };
    case "rule":
      return { panelId: "rules", titleKey: "studio.panels.behaviors" };
    case "component":
      return { panelId: "frontend", titleKey: "studio.stage.tabFrontend" };
    case "audio": return { panelId: "audio", titleKey: "studio.panels.audio" };
    case "world": return { panelId: "overview", titleKey: "studio.panels.overview" };
    default: return null;
  }
}

const PANEL_TITLE_KEY: Record<string, string> = {
  variables: "studio.panels.variables",
  lorebook: "studio.panels.lorebook",
  modules: "studio.panels.modules",
  "first-message": "studio.panels.firstMessage",
  rules: "studio.panels.behaviors",
  "code-view": "studio.panels.frontEndCode",
  "frontend": "studio.stage.tabFrontend",
  audio: "studio.panels.audio",
  overview: "studio.panels.overview",
  assets: "studio.panels.assets",
};

// ── Connection → GraphPatch mapping (the write-back contract) ───────

function connectionPatch(conn: Connection): GraphPatch | null {
  const { source, target, sourceHandle, targetHandle } = conn;
  if (!source || !target || source === target) return null;
  const mk = (fromPort: string, toPort: string): GraphPatch => ({
    op: "add-edge",
    edge: { id: "", from: source, fromPort, to: target, toPort },
  });
  if (source.startsWith("var:") && target.startsWith("module:")) return mk("read", "activate");
  if (source.startsWith("greeting:") && target.startsWith("module:") && sourceHandle !== "seeds") return mk("select", "activate");
  if (source.startsWith("greeting:") && target.startsWith("var:") && sourceHandle !== "select") return mk("seeds", "write");
  if (source.startsWith("var:") && target.startsWith("entry:")) return mk("read", "gate");
  if (source.startsWith("entry:") && target === "frontend" && targetHandle?.startsWith("slot:")) return mk("show", targetHandle);
  if ((source.startsWith("reaction:") || source.startsWith("rule:")) && target.startsWith("var:")) return mk("effect", "write");
  if (source.startsWith("reaction:") && target.startsWith("entry:")) return mk("effect", "gate");
  return null;
}

/** What a block's "+" creates. Blocks with nothing to add get no button:
 *  the card face is one per card, the frontend is one per card, and audio
 *  tracks appear because a behaviour names one. A button that does nothing is
 *  worse than no button. */
function addLabelKey(block: Block): string | null {
  switch (block.kind) {
    // A module's openings list adds an opening; the card's own opening block
    // IS one opening and adds nothing.
    case "opening": return block.head ? null : "blueprint.blocks.add.opening";
    case "lore": return "blueprint.blocks.add.lore";
    case "state": return "blueprint.blocks.add.state";
    case "behavior": return "blueprint.blocks.add.behavior";
    default: return null;
  }
}

/** Openings render through the same markdown pipeline as the chat, so the
 *  block shows what the player will actually read. Cached by exact text: a
 *  card can carry ten openings and this runs on every keystroke otherwise. */
const openingHtmlCache = new Map<string, string>();
function renderOpening(text: string): string {
  const hit = openingHtmlCache.get(text);
  if (hit !== undefined) return hit;
  const html = renderMessage(text);
  if (openingHtmlCache.size > 200) openingHtmlCache.clear();
  openingHtmlCache.set(text, html);
  return html;
}

/** Objects that can belong to a module. Projections (the frontend, event
 *  sources, folded summaries) belong to no one. */
const PARENTABLE_ID = /^(var|entry|greeting|reaction|rule):/;

/** Dragging a gate's output onto a row is how an object joins a module now
 *  that a module is no longer a box you can drop things into. */
function parentPatchFor(conn: Connection): GraphPatch | null {
  const { source, target } = conn;
  if (!source?.startsWith("module:") || !target || !PARENTABLE_ID.test(target)) return null;
  return { op: "set-parent", nodeId: target, parentId: source };
}

function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/60">{children}</div>
  );
}

/** The graph's id for a drawn wire. A wire drawn in several frames (both ends
 *  shared) carries a suffixed React Flow id and the graph id in its data. */
const graphEdgeId = (edge: Edge) => (edge.data as { edgeId?: string } | undefined)?.edgeId ?? edge.id;

/** Runs a multi-object gesture as ONE undo step. Each store write inside is
 *  its own history entry otherwise, so dragging three rows into a module took
 *  three Ctrl+Z to put back. Nesting is fine: the store counts depth. */
function inOneUndoStep(run: () => void): void {
  const store = useEditorStore.getState();
  store.beginBatch();
  try {
    run();
  } finally {
    store.commitBatch();
  }
}

function MenuItem({
  icon: Icon,
  tint,
  danger,
  onClick,
  children,
  description,
  shortcut,
  trailing,
}: {
  icon: typeof Zap;
  tint?: string;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  description?: string;
  /** The key that does the same thing, right-aligned and muted, as Figma's menus show it. */
  shortcut?: string;
  trailing?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs font-medium transition-colors",
        danger ? "text-destructive hover:bg-destructive/10" : "text-foreground hover:bg-accent",
      )}
    >
      <Icon className={cn("h-3.5 w-3.5 shrink-0", tint ?? "text-muted-foreground")} />
      <span className="min-w-0 flex-1"><span className="block">{children}</span>{description && <span className="mt-0.5 block text-[11px] font-normal leading-relaxed text-muted-foreground">{description}</span>}</span>
      {shortcut && <span className="ml-4 shrink-0 text-[11px] font-normal text-muted-foreground/70">{shortcut}</span>}
      {trailing}
    </button>
  );
}

/** The id analytics files a board event under: the saved card, or the draft's. */
const eventWorldId = () => { const st = useEditorStore.getState(); return st.serverWorldId ?? st.worldDraft.id; };

/** A line of the board's View menu: a switch shows a check while it is on. */
function ViewMenuItem({ icon: Icon, on, hint, onClick, children }: {
  icon: typeof Zap;
  on?: boolean;
  hint?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={hint}
      aria-pressed={on === undefined ? undefined : on}
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent"
    >
      <Icon className={cn("h-3.5 w-3.5 shrink-0", on ? "text-amber-400" : "text-muted-foreground")} />
      <span className="min-w-0 flex-1">{children}</span>
      {on && <Check className="h-3.5 w-3.5 shrink-0 text-amber-400" />}
    </button>
  );
}

/** Live diff state per session at module scope. The panel can remount between
 *  turns (dock reshuffles, HMR), and anything kept in component state or refs
 *  would lose both the baseline and the freshly-computed delta — exactly the
 *  moment we want to show. */
const liveBaseline = new Map<
  string,
  { vars: Record<string, unknown>; changes: Record<string, string>; at: number }
>();
const LIVE_DELTA_MS = 6000;

function readLiveChanges(sessionId: string | null): Record<string, string> {
  if (!sessionId) return {};
  const entry = liveBaseline.get(sessionId);
  if (!entry || Date.now() - entry.at > LIVE_DELTA_MS) return {};
  return entry.changes;
}

/** Object ids that map to a real object the creator may delete or duplicate.
 *  Summary nodes, the frontend and event sources are projections only. */
/** What the card shares into every module — and so what can be made a
 *  module's own, or given back to all of them. Openings, the interface and
 *  audio exist once and are nobody's to share. */
function isShareableObject(nodeId: string): boolean {
  return nodeId.startsWith("entry:") || nodeId.startsWith("var:") || nodeId.startsWith("rule:");
}

function isDeletableObject(nodeId: string): boolean {
  return (
    nodeId.startsWith("var:") ||
    nodeId.startsWith("greeting:") ||
    (nodeId.startsWith("entry:") && !nodeId.startsWith("module-entries:")) ||
    nodeId.startsWith("reaction:") ||
    nodeId.startsWith("module:")
  );
}

/** Canvas deletion belongs to the canvas, never to a focused form control
 * or a button used to inspect the current object. */
function isInteractiveDeleteTarget(target: EventTarget | null | undefined): boolean {
  return target instanceof Element && Boolean(target.closest(
    'input, textarea, select, button, a[href], summary, [role="button"], [role="textbox"], [role="combobox"], [role="listbox"], [contenteditable]:not([contenteditable="false"]), .nokey',
  ));
}

/** Delete pressed while a canvas row is the event target must still delete
 *  the row. A click lands on the row (or a control inside it), and the
 *  interactive-target guard above then swallowed the key — the one place
 *  Delete was most expected did nothing. Only text entry keeps the key. */
function isCanvasRowTarget(target: EventTarget | null | undefined): boolean {
  return target instanceof Element && Boolean(target.closest("[data-row-anchor]"));
}

/** Stable "no search", so an idle search box never re-forces the board. */
const NO_SEARCH_RESULTS: never[] = [];

/** One shared empty set, so "nothing multi-selected" never re-renders the
 *  blocks the way a fresh `new Set()` per render would. */
const EMPTY_MULTI: ReadonlySet<string> = new Set();

/** Which rows a screen-space rectangle covers. Rows carry `data-row-anchor`,
 *  so the marquee reads the DOM the board already draws instead of keeping a
 *  second geometry of its own. A row counts when the box crosses it at all —
 *  drawing a box that fully encloses a 40px row is fiddlier than it sounds. */
function rowsInRect(root: HTMLElement, box: { left: number; top: number; right: number; bottom: number }): string[] {
  const out: string[] = [];
  // List rows carry a row anchor; written settings and openings are rows of
  // their own node and carry their object id.
  for (const el of root.querySelectorAll<HTMLElement>("[data-row-anchor], [data-canvas-writing-object]")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right < box.left || r.left > box.right || r.bottom < box.top || r.top > box.bottom) continue;
    const id = el.dataset.rowAnchor || el.dataset.canvasWritingObject;
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Zoom cluster: reads the live zoom so the number is the truth, and clicking
 *  it snaps back to 100% — the default three-button stack said nothing. */
/** One button: see the whole card. Zooming is the wheel or a pinch, the
 *  way every canvas does it; − / 77% / ＋ were three more things to look at
 *  for what the hand already does. */
function ZoomCluster({ onFit }: { onFit: () => void }) {
  const { t } = useTranslation("editor");
  return (
    <div data-onboarding="zoom" className="studio-pill absolute bottom-4 left-4 z-10 flex items-center rounded-xl border p-1">
      <button
        type="button"
        onClick={onFit}
        data-learn="fit"
        title={t("blueprint.fitView")}
        className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <Scan className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// ── Edge-color legend (mirrors edgeColor in blueprint/style.ts) ────

const LEGEND_ITEMS = [
  { color: "#d9a13f", key: "activation" },
  { color: "#34b27a", key: "seed" },
  { color: "#8b5cf6", key: "gate" },
  { color: "#f97316", key: "write" },
  { color: "#818cf8", key: "chain" },
  { color: "#14b8a6", key: "audio" },
  { color: "#f43f5e", key: "ui" },
  { color: "#71717a", key: "event" },
  { color: "#22d3ee", key: "uiRead" },
] as const;

// ── Panel ───────────────────────────────────────────────────────────

/** Only the card and a situation take the right-hand column: each is a whole
 *  form with sections of its own. Everything else is a few settings, edited
 *  beside the row it belongs to so the eye does not cross the screen. */
const floatsBeside = (target: InspectorTarget) =>
  !(target.type === "node" && (target.node.kind === "world" || target.node.kind === "module") && target.section !== "memory");

/** Everything the canvas needs from its host. The dockview adapter and the
 *  full-bleed stage both provide these — the core knows neither. */
type BlueprintCanvasCoreProps = {
  /** Hidden workspaces stay mounted without consuming canvas shortcuts. */
  active?: boolean;
  /** Open an object's full editor (lorebook / variables / rules / …). */
  onDrillPanel: (panelId: string) => void;
  /** Maximize control — omitted on the stage, which is already full-bleed. */
  /** `kind: "rail"` — the stage's button folds the assistant rail away, and
   *  the assistant is shut by default, so "exit focus mode" was the first
   *  thing a new author read on a board they had never focused. The button
   *  says what it does to the rail instead. `"maximize"` (the dock) keeps the
   *  focus-mode wording, because there it is one. */
  focus?: { active: boolean; toggle: () => void; kind?: "rail" | "maximize" };
  /** Fires when something is selected, i.e. when the inspector has an
   *  occupant. */
  onInspectorChange?: (open: boolean) => void;
  /**
   * Where to render the selected object's editor.
   *
   * The stage hands over its right column. A creator is doing exactly one of
   * three things at any instant — talking to the assistant, playing the card,
   * or editing the thing they just clicked — so those three share one column
   * instead of the third one shoving the canvas aside. Absent (the dockview
   * adapter) the editor stays a column of the panel, as it was.
   */
  inspectorHost?: HTMLElement | null;
  /** Screen edges covered by the stage's floating docks. React Flow sizes
   *  itself to the whole element, so without this "fit" centres the graph
   *  under the AI dock and the card is off-screen on open. */
  edgeInsets?: { left: number; right: number };
  /** True while the full-size preview or a playtest owns the card's frontend.
   *  Two live compiles of the same TSX means two shadow roots and the card's
   *  own side effects firing twice, so the interface block yields. */
  previewOwnedElsewhere?: boolean;
  /** Where the board's toolbar goes when the stage has a row for it (the
   *  page tabs). Absent, it floats over the top of the canvas as before. */
  toolbarHost?: HTMLElement | null;
};

function BlueprintCanvas({
  active = true,
  onDrillPanel,
  focus,
  onInspectorChange,
  inspectorHost,
  edgeInsets,
  previewOwnedElsewhere,
  toolbarHost,
}: BlueprintCanvasCoreProps) {
  const { t } = useTranslation("editor");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const worldDraft = useEditorStore((s) => s.worldDraft);
  const entryFolders = worldDraft.entryFolders;
  const presetsTitle = t("blueprint.starter.presetsTitle");
  const serverWorldId = useEditorStore((s) => s.serverWorldId);
  const readOnly = useEditorStore((s) => s.readOnlyInspect);
  // Decides where the frontend block drills: somebody's code, or the visual
  // builder. A card already on a uiDoc is never "hand-written" again.
  const interfaceIsHandwritten =
    !worldDraft.uiDoc && classifyInterface(worldDraft.rootComponent) === "handwritten";
  const setGraphLayout = useEditorStore((s) => s.setGraphLayout);
  const applyGraphPatch = useEditorStore((s) => s.applyGraphPatch);
  const addWorldbook = useEditorStore((s) => s.addWorldbook);
  const addVariable = useEditorStore((s) => s.addVariable);
  const addReaction = useEditorStore((s) => s.addReaction);
  const addEntry = useEditorStore((s) => s.addEntry);
  const rf = useReactFlow();

  // Entries the canvas just created stay materialized for this session — a
  // brand-new entry has nothing wired to it, so the fold rules would swallow
  // it the instant it appears and the creator would think the add failed.
  const [pinnedEntryIds, setPinnedEntryIds] = useState<string[]>([]);
  /** Only the fields the projection actually reads. `worldDraft` is replaced on
   *  every edit anywhere in the card, so depending on the object recompiled the
   *  whole graph for changes the graph cannot show — dragging a frame and
   *  typing in a sticky note both live in graphLayout, and both did it once per
   *  keystroke. WORLD_LOGIC_KEYS comes from the compiler and is checked against
   *  its own input type, so this list cannot fall behind. */
  const logicDeps = WORLD_LOGIC_KEYS.map((k) => worldDraft[k]);
  // No summary nodes: a block folds its own long tail behind "N more", and
  // those rows keep their names and stay one click from being edited.
  const graphOptions = useMemo(() => ({ pinnedEntryIds, foldPlainEntries: false }), [pinnedEntryIds]);
  const graph = useMemo(
    () => toGraph(worldDraft, graphOptions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [...logicDeps, graphOptions],
  );
  const graphById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const defaultChat = isDefaultChatInterface(worldDraft);
  const storyBoard = (worldDraft.worldbooks?.length ?? 0) === 0;
  // A 基础 lesson's canvas: the guide names the block kinds it is about and
  // the board draws only those, zoomed to fill the frame. Nothing about the
  // board changes underneath — layout, selection and undo are as they were;
  // the other blocks are merely not drawn until their lesson.
  const { stage: learningStage, focus: learningFocus, teaching: inLesson } = useLearningWorkspace();
  // A lesson that frames a few blocks up close reads their rows in full.
  const teaching = !!learningStage || !!learningFocus;
  const blueprintDocumentKey = useBlueprintDocumentKey({ worldId: worldDraft.id, serverWorldId });
  // The funnel's first step. Once per card per mount — not per re-render, and
  // not again when the draft changes under the same id.
  useEffect(() => {
    if (!active) return;
    const draft = useEditorStore.getState().worldDraft;
    captureHubEvent("studio_blueprint_opened", {
      world_id: serverWorldId ?? draft.id,
      modules: draft.worldbooks?.length ?? 0,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverWorldId, worldDraft.id]);
  const [blueprintTarget, setBlueprintTarget] = useState<BlueprintTargetRequest | null>(null);
  const blueprintTargetSequence = useRef(0);
  const fitViewEpoch = useRef({ documentKey: blueprintDocumentKey, value: 0 });
  if (fitViewEpoch.current.documentKey !== blueprintDocumentKey) {
    fitViewEpoch.current = { documentKey: blueprintDocumentKey, value: fitViewEpoch.current.value + 1 };
    if (blueprintTarget) setBlueprintTarget(null);
  }
  const previewOpeningId = useStudioSidebarStore(state => state.previewGreetingIdByWorld[worldDraft.id]);
  const [writingFocusRequest, setWritingFocusRequest] = useState<{ documentKey: string; id: string } | null>(null);
  const preferredWritingHosts = useRef(new Map<string, string>());
  useEffect(() => { preferredWritingHosts.current.clear(); }, [blueprintDocumentKey]);
  const previewGreeting = resolvePreviewOpening(worldDraft.entries, previewOpeningId);
  const previewGreetingId = previewGreeting?.id;
  const anyOpeningWritten = worldDraft.entries.some((e) => e.role === "greeting" && !e.worldbookId && e.content?.trim());
  /** The player's screen starts folded to a line: it is opened to glance at,
   *  and double-clicked to work on. The author's choice is remembered. A
   *  lesson about the screen always sees it. */
  const [screenFoldPref, setScreenFoldPref] = useState(() => readLocalPref("yumina-bp-screen-open") !== "1");
  const toggleScreenFold = useCallback(() => {
    setScreenFoldPref((folded) => { writeLocalPref("yumina-bp-screen-open", folded ? "1" : "0"); return !folded; });
  }, []);
  const screenFolded = screenFoldPref && !learningStage;
  /** A stock-chat card with a background is no longer a one-line "ready to
   *  use": the picture IS what the player sees, and the block has to show it
   *  the moment it is uploaded, or the author looks for it and concludes the
   *  upload did nothing. Resolved the way play resolves it, for the opening
   *  being previewed; a cover-backed background on a card with no cover is
   *  still nothing to show. */
  const cardHasBackground = useMemo(
    () => resolveBackground({ backgrounds: worldDraft.backgrounds }, null, { activeGreetingId: previewGreetingId ?? null, coverUrl: absoluteImageUrl(worldDraft.avatar) }) !== null,
    [worldDraft.backgrounds, worldDraft.avatar, previewGreetingId],
  );
  const selectPreviewOpening = useCallback((id: string) => useStudioSidebarStore.getState().setPreviewGreetingId(worldDraft.id, id), [worldDraft.id]);
  const previewGreetingIdRef = useRef(previewGreetingId);
  previewGreetingIdRef.current = previewGreetingId;
  /** Every opening the card has, in the order the player meets them — the
   *  list behind the numbered switch on the opening block. */
  const cardOpenings = useMemo(
    () => (worldDraft.entries ?? []).filter((e) => e.role === "greeting"),
    [worldDraft.entries],
  );
  const storyBoardRef = useRef(storyBoard);
  storyBoardRef.current = storyBoard;
  // The official presets (fiction mode, task, style, instructions, CoT
  // bypass) used to be folded off the board while untouched, into a one-line
  // "default narration" block that opened on a list of names. The owner asked
  // where they had gone: every card ships with them, they are the first
  // things the AI reads, and a board that hides them is a board that lies
  // about what the card sends. They are rows now, grouped under their own
  // header at the end of the always-on shelf (see writingItems).
  const boardGraph = graph;

  // ── Localized presentation of a projected node ──
  const draftById = useMemo(() => {
    const entries = new Map(worldDraft.entries.map((e) => [e.id, e]));
    const variables = new Map(worldDraft.variables.map((v) => [v.id, v]));
    const reactions = new Map((worldDraft.reactions ?? []).map((r) => [r.id, r]));
    const audio = new Map((worldDraft.audioTracks ?? []).map((track) => [track.id, track]));
    const images = new Map((worldDraft.sceneImages ?? []).map((image) => [image.id, image]));
    return { entries, variables, reactions, audio, images };
    // The five lists it indexes, not the draft: the draft is a new object on
    // every edit anywhere (the card's name, a sticky note, a frame drag), and
    // this feeds the node build, which then redrew every block for it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [worldDraft.entries, worldDraft.variables, worldDraft.reactions, worldDraft.audioTracks, worldDraft.sceneImages, worldDraft.worldbooks, t]);
  /** The chips and the note a row wears in detail mode — what kind of thing
   *  it is and what it is for — so the board says what the inspector knows.
   *  The rules live in row-facts.ts, with their tests. */
  const rowFactsFor = useCallback((g: GraphNode) => rowFacts(g, draftById, t as Translate), [draftById, t]);

  const displayTitle = useCallback((g: GraphNode): string => {
    if (g.id === "core-entries") return t("blueprint.nodes.coreEntries");
    if (g.id.startsWith("module-entries:")) return t("blueprint.nodes.moduleEntries");
    if (g.id === "frontend") return t("blueprint.nodes.frontend");
    if (g.kind === "event") {
      const key = g.id.slice(4);
      const map: Record<string, string> = {
        "evt:user": t("blueprint.events.playerInput"),
        "evt:turn": t("blueprint.events.eachTurn"),
        "evt:session": t("blueprint.events.sessionStart"),
        "turn:complete": t("blueprint.events.eachTurn"),
        "session:start": t("blueprint.events.sessionStart"),
        "message:user": t("blueprint.events.playerInput"),
        "message:ai": t("blueprint.events.aiReply"),
        "state:changed": t("blueprint.events.stateChanged"),
        "action:fired": t("blueprint.events.actionFired"),
        "clock:every": t("blueprint.events.clockEvery"),
        clockevery: t("blueprint.events.clockEvery"),
      };
      return map[g.id] ?? map[key] ?? key;
    }
    return g.title;
  }, [t]);

  /** What this object actually SAYS. A lore row shows two clamped lines of
   *  it, which is the whole difference between the board and the rack: a name
   *  tells you which entry it is, the text tells you whether it is the one you
   *  meant. Sliced generously — the CSS clamp decides how much fits. */
  const previewFor = useCallback((g: GraphNode): string | undefined => {
    const id = g.id.slice(g.id.indexOf(":") + 1);
    if (g.id.startsWith("module-entries:")) return t("blueprint.nodes.moduleEntriesHintShort");
    // A rule the engine could not read draws with no wires at all. Saying so on
    // the row is the difference between "this behaviour is broken" and the
    // author assuming the canvas just doesn't draw their kind of rule.
    if (g.kind === "rule" && Array.isArray(g.data.shapeIssues)) return t("blueprint.nodes.ruleUnreadable");
    if (g.kind === "greeting" || (g.kind === "entry" && g.id !== "core-entries")) {
      const content = draftById.entries.get(id)?.content?.trim();
      // Stripped for DISPLAY only — the row should preview the prose, not the
      // <personality> wrapper it ships in. The inline editor shows raw text.
      return content ? proseSnippet(content) : t("blueprint.nodes.emptyContent");
    }
    if (g.kind === "variable") {
      const v = draftById.variables.get(id);
      if (!v) return undefined;
      // The value alone: the row already carries the variable's name, and its
      // type is what the inspector is for.
      return typeof v.defaultValue === "string" ? v.defaultValue : JSON.stringify(v.defaultValue);
    }
    if (g.kind === "rule" && g.id.startsWith("reaction:")) {
      const r = draftById.reactions.get(id);
      if (!r) return undefined;
      // "2 effects" told nobody anything. The summary reads like the
      // behaviour itself: 好感度+5, damage:taken · →scream. The every-turn
      // case omits its when-part — the row's firedBy chip already says it.
      return reactionSummary(r, draftById.variables, {
        everyTurn: "",
        ifMark: t("blueprint.summary.ifMark"),
        tellAi: t("blueprint.summary.tellAi"),
        entryOn: t("blueprint.summary.entryOn"),
        entryOff: t("blueprint.summary.entryOff"),
        varOn: t("blueprint.summary.varOn"),
        varOff: t("blueprint.summary.varOff"),
      });
    }
    if (g.id === "core-entries") return t("blueprint.nodes.coreEntriesHintShort");
    return undefined;
  }, [draftById, t]);

  /** Stable door into the focus editor — block data is rebuilt often and
   *  must not capture a changing closure. */
  const focusEditRef = useRef<(objId: string) => void>(() => {});
  focusEditRef.current = (objId) => setFocusEdit(objId);

  /** A variable row's value chip commits here. Coercion follows the declared
   *  type; an uncoercible edit (letters into a number) is dropped rather than
   *  written, because silently storing NaN is worse than doing nothing. */
  const commitVariableValue = useCallback((variableId: string, raw: string | boolean) => {
    const store = useEditorStore.getState();
    const index = store.worldDraft.variables.findIndex((v) => v.id === variableId);
    const variable = store.worldDraft.variables[index];
    if (!variable) return;
    let next: typeof variable.defaultValue;
    if (typeof raw === "boolean") next = raw;
    else if (variable.type === "number") {
      const n = Number(raw);
      if (!Number.isFinite(n)) return;
      next = n;
    } else if (variable.type === "boolean") next = raw === "true";
    else next = raw;
    if (next === variable.defaultValue) return;
    store.updateVariableAt(index, { defaultValue: next });
  }, []);

  const addLabelFor = useCallback(
    (block: Block): string | undefined => {
      const key = addLabelKey(block);
      return key ? t(key as never) : undefined;
    },
    [t],
  );

  // ── Live mode: while a playtest session runs, the circuit shows real values ──
  const liveSession = useChatStore((s) => s.session);
  const liveVars = useChatStore((s) => s.gameState);
  const runtimeRecords = useChatStore((s) => s.runtimeRecords);
  // An imported card keeps its ORIGINAL id inside the schema, so the draft id
  // and the server id can differ — accept either.
  const liveState = useMemo(
    () => liveRuntimeState(liveSession, [serverWorldId, worldDraft.id], liveVars),
    [liveSession, serverWorldId, worldDraft.id, liveVars],
  );
  const isLive = liveState !== null;

  /** Values that changed since the previous turn — the node pulses and shows
   *  the delta so you can watch your own mechanics fire. */
  const [recentChanges, setRecentChanges] = useState<Record<string, string>>({});
  const changeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Session identity keeps the baseline honest: switching sessions must not
  // report the whole state as "changed".
  const liveSessionId = liveSession?.id ?? liveSession?.worldId ?? null;
  useEffect(() => {
    // The store briefly empties gameState mid-turn; treating that as a change
    // would reset the baseline and swallow the very delta we want to show.
    if (!liveSessionId || Object.keys(liveVars).length === 0) return;
    const entry = liveBaseline.get(liveSessionId);
    const prev = entry?.vars;
    if (!prev) {
      liveBaseline.set(liveSessionId, { vars: { ...liveVars }, changes: {}, at: 0 });
      return;
    }
    const changes: Record<string, string> = {};
    for (const [id, value] of Object.entries(liveVars)) {
      const before = prev[id];
      if (before === undefined || JSON.stringify(before) === JSON.stringify(value)) continue;
      changes[id] =
        typeof value === "number" && typeof before === "number"
          ? `${value - before > 0 ? "+" : ""}${Math.round((value - before) * 100) / 100}`
          : "→";
    }
    liveBaseline.set(liveSessionId, {
      vars: { ...liveVars },
      changes,
      at: Object.keys(changes).length > 0 ? Date.now() : (entry.at ?? 0),
    });
    if (Object.keys(changes).length === 0) return;
    setRecentChanges(changes);
    if (changeTimerRef.current) clearTimeout(changeTimerRef.current);
    changeTimerRef.current = setTimeout(() => setRecentChanges({}), LIVE_DELTA_MS);
  }, [liveVars, liveSessionId]);
  useEffect(() => () => { if (changeTimerRef.current) clearTimeout(changeTimerRef.current); }, []);

  // A remount mid-turn would drop the freshly computed delta; re-read it from
  // the module map so the pulse survives one.
  useEffect(() => {
    const pending = readLiveChanges(liveSessionId);
    if (Object.keys(pending).length === 0) return;
    setRecentChanges(pending);
    const timer = setTimeout(() => setRecentChanges({}), LIVE_DELTA_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSessionId]);

  /** Live gating: which modules are active and which entry gates pass right
   *  now — computed with the same engine functions the runtime uses. */
  const liveGating = useMemo(() => {
    if (!liveState) return null;
    const state = liveState;
    const activeBooks = computeActiveWorldbookIds(worldDraft.worldbooks ?? [], state);
    const entryGate = new Map<string, boolean>();
    for (const e of worldDraft.entries) {
      if ((e.conditions?.length ?? 0) > 0) {
        entryGate.set(e.id, checkConditions(state, e.conditions, e.conditionLogic ?? "all"));
      }
    }
    return { activeBooks, entryGate, state };
    // Reads only these two; see draftById for why not the whole draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveState, worldDraft.worldbooks, worldDraft.entries]);

  const [showTurnContext, setShowTurnContext] = useState(false);

  /** Configuration estimate using the complete session state when available. */
  const turnContext = useMemo(() => {
    if (!showTurnContext) return null;
    const state = liveGating?.state ?? defaultStateFor(worldDraft);
    return turnContextView(worldDraft, state, Boolean(liveGating));
  }, [showTurnContext, liveGating, worldDraft]);

  // ── The AI's last write turn, as an audit rather than a notification ──
  const { turn, dismiss: dismissTurn, restore: undoTurn, restoring: undoingTurn } = useTurnDiff(graph, serverWorldId, graphOptions);
  const turnMark = useMemo(() => {
    const marks = new Map<string, "added" | "changed">();
    if (!turn) return marks;
    for (const id of turn.diff.addedNodes) marks.set(id, "added");
    for (const id of turn.diff.changedNodes) marks.set(id, "changed");
    for (const id of turn.diff.addedEdges) marks.set(id, "added");
    return marks;
  }, [turn]);

  // Freshly-appeared objects/wires (from ANY writer — the canvas, the classic
  // panels, or the Studio AI) glow briefly, so the creator can watch the
  // assistant wire the card up live.
  const prevIdsRef = useRef<Set<string> | null>(null);
  const [recentIds, setRecentIds] = useState<Set<string>>(() => new Set());
  const recentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const current = new Set<string>([...graph.nodes.map((n) => n.id), ...graph.edges.map((e) => e.id)]);
    const prev = prevIdsRef.current;
    prevIdsRef.current = current;
    if (!prev) return;
    const fresh = [...current].filter((id) => !prev.has(id));
    if (fresh.length === 0) return;
    setRecentIds((old) => new Set([...old, ...fresh]));
    if (recentTimerRef.current) clearTimeout(recentTimerRef.current);
    recentTimerRef.current = setTimeout(() => setRecentIds(new Set()), 8000);
  }, [graph]);
  useEffect(() => () => { if (recentTimerRef.current) clearTimeout(recentTimerRef.current); }, []);
  /** Light objects up as "just happened" — a move into a module as much as
   *  a birth, so the eye finds where the thing went. */
  const flashRecent = useCallback((ids: string[]) => {
    setRecentIds((old) => new Set([...old, ...ids]));
    if (recentTimerRef.current) clearTimeout(recentTimerRef.current);
    recentTimerRef.current = setTimeout(() => setRecentIds(new Set()), 8000);
  }, []);

  // ── Selection / inspector ──
  // Selection is always an OBJECT (a row, or the object a block IS) or an
  // edge. A memory block is the sole exception: its inspector edits the
  // owning module without treating that whole module as the selected object.
  const [selection, setSelection] = useState<{ type: "node" | "edge"; id: string } | null>(null);
  /** Rows picked up beside the selection: Shift / Ctrl-click adds one, a
   *  Shift-drag on the pane sweeps up a rectangle of them. The inspector
   *  stays on `selection`; the batch bar and Delete act on these. */
  const [multiSelected, setMultiSelected] = useState<ReadonlySet<string>>(EMPTY_MULTI);
  const multiSelectedRef = useRef(multiSelected);
  multiSelectedRef.current = multiSelected;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const learningStageRef = useRef(learningStage);
  learningStageRef.current = learningStage;
  const toggleMulti = useCallback((objId: string, seed: string | null) => {
    setMultiSelected((prev) => {
      const next = new Set(prev);
      // The first modifier-click grows the single selection into a pair
      // rather than replacing it — that is what Shift-click means everywhere.
      if (next.size === 0 && seed && seed !== objId && !isBlockId(seed) && isDeletableObject(seed)) next.add(seed);
      if (next.has(objId)) next.delete(objId);
      else next.add(objId);
      return next.size === 0 ? EMPTY_MULTI : next;
    });
  }, []);
  const [relationshipId, setRelationshipId] = useState<string | null>(null);
  const showRelationships = useCallback((objectId: string) => {
    setSelection({ type: "node", id: objectId });
    setRelationshipId(objectId);
  }, []);
  useEffect(() => { setRelationshipId(null); }, [blueprintDocumentKey]);
  useEffect(() => {
    if (relationshipId && (selection?.type !== "node" || selection.id !== relationshipId)) setRelationshipId(null);
  }, [selection, relationshipId]);
  /** Drawer width — dragging its edge sticks, so writing an opening in the
   *  drawer isn't stuck in a 290px slot. */
  const [inspectorWidth, setInspectorWidth] = useState(() => {
    const stored = Number(readLocalPref("yumina-blueprint-inspector-w"));
    return Number.isFinite(stored) && stored >= 260 ? Math.min(stored, 900) : 340;
  });
  const inspectorWidthRef = useRef(inspectorWidth);
  inspectorWidthRef.current = inspectorWidth;
  const commitInspectorWidth = useCallback((w: number) => {
    const clamped = Math.max(260, Math.min(900, Math.round(w)));
    setInspectorWidth(clamped);
    writeLocalPref("yumina-blueprint-inspector-w", String(clamped));
  }, []);
  useEffect(() => {
    if (!selection) return;
    // A list block selected as a whole ("N more") is not a graph node; it
    // is gone only when no block answers to that id any more.
    const isBlock = selection.type === "node" && isBlockId(selection.id)
      && blocksRef.current.some((b) => b.id === selection.id || b.sourceBlockId === selection.id);
    const gone =
      selection.type === "node"
        ? !isBlock && !resolveCanvasInspectorNode(selection.id, graph.nodes)
        : !graph.edges.some((e) => e.id === selection.id);
    if (gone) setSelection(null);
  }, [graph, selection]);

  // ── Search ──
  const [query, setQuery] = useState("");
  // Indexing reads the text of every object on the card, and nobody is
  // searching most of the time — so with no query there is no index, and the
  // memo stops depending on the draft at all. The first keystroke of a search
  // builds it from the current draft; from then on it follows every edit, as
  // before.
  const searching = query.trim().length > 0;
  const searchIndex = useMemo(
    () => (searching ? indexWorldContent(worldDraft) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searching, searching ? worldDraft : null],
  );
  const searchResults = useMemo(() => {
    if (!searchIndex) return NO_SEARCH_RESULTS;
    return searchWorldContent(searchIndex, query).flatMap(result => {
      const node = getWorldSearchNode(result, graphById);
      return node ? [{ ...node, scope: result.scope, excerpt: result.excerpt }] : [];
    });
  }, [query, searchIndex, graphById]);
  // ── Block collapse (persisted) + row expansion (session-only) ──
  const [collapsedSet, setCollapsedSet] = useState<Set<string>>(() => new Set(storedCollapsed()));
  /** Per 「这里的 AI」 block, the row open in place. */
  /** Sticks a note beside a block (set once addNoteOn exists, further down). */
  const addNoteOnRef = useRef<(target: string) => void>(() => {});
  const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(() => new Set());
  /** Opening blocks showing their whole text rather than the first lines. */
  const [openedTexts, setOpenedTexts] = useState<Set<string>>(() => new Set());
  /** The one row writing its entry in place. One at a time on purpose: two
   *  open editors would be two places to look, which is the thing this fixes. */
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  /** Rows a block's head opened all at once (a click on the head opens every
   *  row, the next shuts them). Kept apart from the one row a click opens. */
  const [headOpened, setHeadOpened] = useState<ReadonlySet<string>>(() => new Set());
  const openRowIds = useMemo(() => new Set([...(openRowId ? [openRowId] : []), ...headOpened]), [openRowId, headOpened]);
  /** The chevron, and only the chevron. Clicking a row still hands the object
   *  to the drawer — the two ways in are independent on purpose, so opening a
   *  row in place never takes the drawer away and vice versa. The same field
   *  rendered in both stays in sync: the unfocused copy re-reads the draft
   *  when the focused one commits. */
  const toggleOpenRow = useCallback((objectId: string) => {
    setOpenRowId((current) => (current === objectId ? null : objectId));
  }, []);
  // Selecting a setting, an opening or a scene image opens it in its row —
  // that row is where it is edited now. Whatever selected it (a click, an
  // add, a search jump, a paste) gets the same result; leaving it for empty
  // canvas shuts it again. Another object's row only closes by opening one.
  const selectedInlineId = selection?.type === "node" && canEditRowInline(selection.id) ? selection.id : null;
  const lastInlineId = useRef<string | null>(null);
  /** A plain click on a row picks it and nothing more: opening it on the
   *  first click moved every block under it, and the second click of a
   *  double-click then landed on whatever had slid under the pointer. */
  const selectOnlyRef = useRef<string | null>(null);
  /** The selection came from a click on the board: the thing is in view
   *  already, so the camera stays put. Search, the tree and the assistant
   *  still bring the board to what they pick. */
  const pickedByClickRef = useRef<string | null>(null);
  /** A click moved from the row being written to another one: the open row
   *  stays open until the new one takes over (clickRow), so nothing shifts
   *  under the pointer between the two clicks of a double-click. */
  const keepOpenRowRef = useRef(false);
  const openRowIdRef = useRef(openRowId);
  const openRowIdsRef = useRef(openRowIds);
  openRowIdsRef.current = openRowIds;
  openRowIdRef.current = openRowId;
  useEffect(() => {
    const previous = lastInlineId.current;
    lastInlineId.current = selectedInlineId;
    if (selectedInlineId && selectOnlyRef.current === selectedInlineId) {
      selectOnlyRef.current = null;
      if (keepOpenRowRef.current) keepOpenRowRef.current = false;
      else setOpenRowId((current) => (current === selectedInlineId ? current : null));
    } else if (selectedInlineId) setOpenRowId(selectedInlineId);
    else if (previous && !selection) setOpenRowId((current) => (current === previous ? null : current));
  }, [selectedInlineId, selection]);
  // Opening or shutting a row changes the height of its block, and every
  // block under it moves. For that one moment the blocks glide to their new
  // places instead of jumping there; never while dragging, and never for the
  // glance switch, whose anchoring measures where the rows are right now.
  const [layoutGliding, setLayoutGliding] = useState(false);
  const firstOpenRow = useRef(true);
  useEffect(() => {
    if (firstOpenRow.current) { firstOpenRow.current = false; return; }
    setLayoutGliding(true);
    const timer = window.setTimeout(() => setLayoutGliding(false), 480);
    return () => window.clearTimeout(timer);
  }, [openRowId]);
  /** A click on an inline row: open it, or shut it when it is already open. */
  const pressInlineRow = useCallback((objectId: string) => {
    setOpenRowId((current) => (current === objectId && lastInlineId.current === objectId ? null : objectId));
    setSelection({ type: "node", id: objectId });
  }, []);
  /** Folders shut on the board. The official presets start shut: five
   *  system entries standing open above the author's own settings were the
   *  first thing on the shelf, and the one thing a beginner should not be
   *  reading first. */
  const [collapsedFolders, setCollapsedFolders] = useState<ReadonlySet<string>>(() => new Set([PRESETS_GROUP_ID]));
  const toggleFolder = useCallback((folderId: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);
  /**
   * Which row is writing when a card opens: the opening, while it is still
   * the template's, and nothing otherwise.
   *
   * The guidance is a placeholder, not content — it must never reach a player
   * as prose — so the editor is the only place the whole of it can be read.
   * Shut, the row shows the clamp's worth and the advice under it never
   * arrives. Opening it is the difference between "there is a box here" and
   * "here is what goes in the box".
   *
   * One effect, not a reset plus a ref-guarded open: under StrictMode every
   * effect runs, unmounts and runs again, and the guarded half declined the
   * second pass while the reset did not — which left the row shut and the
   * behaviour looking like it had never been written. Deciding the whole
   * answer here makes the second pass agree with the first.
   */
  //
  // Decided ONCE per card, when its entries first arrive — not on every edit.
  // Re-deciding on each change meant that the first character typed into the
  // opening made it "touched", the answer flipped to "shut", and the row the
  // author was writing in closed under their hands. The same reset took an
  // open entry row with it, since the decision was the whole openRowId.
  const autoOpenDecidedFor = useRef<string | null>(null);
  useEffect(() => {
    const entries = useEditorStore.getState().worldDraft.entries ?? [];
    if (autoOpenDecidedFor.current === blueprintDocumentKey || entries.length === 0) return;
    autoOpenDecidedFor.current = blueprintDocumentKey;
    // A card with written words opens with every row shut: the opening is
    // on the player's screen already, and open as well it stood twice. A
    // new card has nothing written yet — its opening is the one place to
    // start, so it opens ready to type into.
    const openings = entries.filter((e) => e.role === "greeting" && !e.worldbookId);
    const fresh = openings.length === 1 && entries.every((e) =>
      e.presetId || !e.content?.trim() || isLessonHello(e.content));
    setOpenRowId(fresh ? `greeting:${openings[0].id}` : null);
  }, [blueprintDocumentKey, worldDraft.entries]);
  // The panel usually mounts before the draft finishes loading, so re-read the
  // persisted flags once per world identity (also covers switching cards).
  const worldId = useEditorStore((s) => s.worldDraft.id);
  const collapseSyncRef = useRef<string | null>(null);
  useEffect(() => {
    const key = String(worldId ?? "");
    if (collapseSyncRef.current === key) return;
    collapseSyncRef.current = key;
    setCollapsedSet(new Set(storedCollapsed()));
    setExpandedBlocks(new Set());
    setOpenedTexts(new Set());
  }, [worldId]);

  // ── The board: the projection, grouped into what the card is made of ──
  const gates = useMemo(() => graph.nodes.filter((n) => n.kind === "module"), [graph]);
  const gatesRef = useRef(gates);
  gatesRef.current = gates;
  const gateIndex = useMemo(() => new Map(gates.map((g, i) => [g.id, i])), [gates]);
  const gateIdSet = useMemo(() => new Set(gates.map((g) => g.id)), [gates]);

  /** Rows that must stay on screen no matter how long their block is. */
  const forcedRowIds = useMemo(() => {
    const forced = new Set<string>(recentIds);
    for (const id of turnMark.keys()) forced.add(id);
    for (const varId of Object.keys(recentChanges)) forced.add(`var:${varId}`);
    for (const id of pinnedEntryIds) {
      forced.add(`entry:${id}`);
      forced.add(`greeting:${id}`);
    }
    if (selection?.type === "node") forced.add(selection.id);
    for (const n of searchResults) forced.add(n.id);
    return forced;
  }, [recentIds, turnMark, recentChanges, pinnedEntryIds, selection, searchResults]);

  /** What this card ships on every turn. On a card with no wiring — most of
   *  them — this is what the canvas has to say instead of "the first eight". */
  // computeContextBudget reads `entries` and `variables` and nothing else —
  // keep this list in step with it if that changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  // tokenizerReady: recount once exact counts replace the pre-load estimate.
  const tokenizerReady = useTokenizerReady();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const budget = useMemo(() => computeContextBudget(worldDraft), [worldDraft.entries, worldDraft.variables, tokenizerReady]);

  /** How many wires touch each object. Nothing is drawn until a row is lit, so
   *  these counts are the only sign a row is connected at all. */
  const linkCounts = useMemo(() => {
    const map = new Map<string, { in: number; out: number }>();
    const bump = (id: string, side: "in" | "out") => {
      const cur = map.get(id) ?? { in: 0, out: 0 };
      cur[side]++;
      map.set(id, cur);
    };
    for (const e of graph.edges) {
      bump(e.from, "out");
      bump(e.to, "in");
    }
    return map;
  }, [graph]);

  /**
   * How much a row says is decided by how big it is drawn. Zoomed out to see
   * the whole card, a row is its name: at 51% the two lines of text under
   * every entry were six-pixel type nobody could read, twelve thousand
   * characters of it on a real card, and that wall was what creators meant
   * by "everything at once". Zoomed in far enough to read, each row gets
   * its excerpt, its delivery line and its value back.
   *
   * Two thresholds, not one: the board changes height when rows open, and a
   * single line would flip back and forth as the fit zoom crossed it.
   */
  const [glance, setGlance] = useState(true);
  const glanceRef = useRef(glance);
  glanceRef.current = glance;
  /**
   * Which device every preview on the board is laid out for — the card's own
   * interface as well as each module's scene.
   *
   * Phone is the default now that the card's interface follows this too. It
   * used to only reach the scene blocks, where desktop-first was the call;
   * on the card's interface desktop means a 1024x640 screen, which takes a
   * row of its own and doubles the tile's height, so every card would open
   * on a view nobody asked for. Play is phone-first and the interface
   * preview has always been a phone. The choice sticks per browser.
   */
  const [device, setDevice] = useState<"desktop" | "phone">(() =>
    // The phone unless the author chose the desktop: play is phone-first, and
    // a desktop layout scaled into a block this wide came out at half the
    // size a player reads it at — the board's words were unreadable.
    readLocalPref("yumina-blueprint-device") === "desktop" ? "desktop" : "phone",
  );
  const deviceRef = useRef(device);
  deviceRef.current = device;
  const toggleDevice = useCallback(() => {
    setDevice((d) => {
      const next = d === "desktop" ? "phone" : "desktop";
      writeLocalPref("yumina-blueprint-device", next);
      return next;
    });
  }, []);
  /**
   * A locked view stays where the author put it. Selecting, adding and
   * jumping still select, add and highlight; nothing moves the viewport. A
   * tester adding entries watched the board slide left on every one and
   * asked for a way to make it stop — the slide itself is fixed too (see the
   * nudge below), and this is for the author who wants the board to hold
   * still no matter what. Shift+L, and it sticks per browser.
   */
  const [viewLocked, setViewLocked] = useState(() => {
    try { return localStorage.getItem("yumina-blueprint-lock-view") === "on"; } catch { return false; }
  });
  const viewLockedRef = useRef(viewLocked);
  viewLockedRef.current = viewLocked;
  const toggleViewLock = useCallback(() => {
    setViewLocked((v) => {
      try { localStorage.setItem("yumina-blueprint-lock-view", v ? "off" : "on"); } catch { /* a per-browser preference; nothing to recover */ }
      return !v;
    });
  }, []);

  // ── The tools on a media block's header: upload · generate · market ──
  //
  // Every picture and sound the player gets has a block; these are how the
  // block gets filled without leaving the board. Generating opens a popover
  // that already knows the slot's shape and where the picture lands; the
  // panels stay where they were for the settings that need a page.
  /** Whose voice is being chosen: a character's (entryId) or the narrator's. */
  const [voiceFor, setVoiceFor] = useState<{ entryId?: string; title: string } | null>(null);
  /** Uploads and the cover need the card to exist on the server. */
  const ensureWorldId = useCallback(async () => {
    const store = useEditorStore.getState();
    if (store.serverWorldId) return store.serverWorldId;
    const ok = await store.saveDraft();
    return ok ? useEditorStore.getState().serverWorldId : null;
  }, []);
  const uploadMedia = useCallback((kind: "audio" | "image") => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = kind === "audio" ? "audio/*" : "image/*";
    input.multiple = true;
    // In the document, hidden, so a test can hand it a file; gone once used.
    input.hidden = true;
    input.dataset.blueprintUpload = kind;
    document.body.appendChild(input);
    input.onchange = async () => {
      const files = Array.from(input.files ?? []);
      input.remove();
      if (files.length === 0) return;
      const worldId = await ensureWorldId();
      if (!worldId) { feedback.error(t("overview.saveWorldFirst")); return; }
      const made: string[] = [];
      for (const file of files) {
        const asset = await useAssetStore.getState().uploadAsset(worldId, file, kind);
        if (!asset) continue;
        const store = useEditorStore.getState();
        const name = file.name.replace(/\.[^.]+$/, "");
        const url = `@asset:${asset.id}`;
        if (kind === "audio") {
          store.addAudioTrack();
          const tracks = useEditorStore.getState().worldDraft.audioTracks ?? [];
          const track = tracks[tracks.length - 1];
          if (!track) continue;
          // A file named like an effect is one; everything else is music.
          store.updateAudioTrack(track.id, { name, url, type: /sfx|hit|click|whoosh|impact|ding|效果|音效/i.test(name) ? "sfx" : "bgm" });
          made.push(`audio:${track.id}`);
        } else {
          store.addSceneImage();
          const images = useEditorStore.getState().worldDraft.sceneImages ?? [];
          const image = images[images.length - 1];
          if (!image) continue;
          store.updateSceneImage(image.id, { name, url });
          made.push(`image:${image.id}`);
        }
      }
      if (made.length) flashRecent(made);
    };
    input.click();
  }, [ensureWorldId, flashRecent, t]);
  /** The header tools a block of this kind wears. */
  const blockTools = useCallback((block: Block) => {
    if (readOnly) return undefined;
    const label = (id: "upload" | "market" | "voice" | "open") => t(`blueprint.tools.${id}` as never) as string;
    // No "generate" on any block: generation lives on the AI page beside the
    // board (the owner: every block wearing one made the board too busy).
    switch (block.kind) {
      case "card":
        // No "upload" here: it only opened the card's settings, which a click
        // on the card itself already does.
        // Nothing: the narrator's voice, language and the rest are in the
        // card's details, which a click on the cover opens.
        return undefined;
      case "background":
        return [{ id: "upload" as const, label: label("upload"), onClick: () => onDrillPanel("backgrounds") }];
      case "image":
        if (block.ownerId) return undefined;
        return [{ id: "upload" as const, label: label("upload"), onClick: () => uploadMedia("image") }];
      case "audio":
        if (block.ownerId) return undefined;
        return [
          { id: "upload" as const, label: label("upload"), onClick: () => uploadMedia("audio") },
          { id: "market" as const, label: label("market"), onClick: () => onDrillPanel("marketplace") },
        ];
      case "frontend":
        // Its page is in the top bar's switch and behind the block's own
        // 编辑界面 button; a third door in the header only added an icon.
        return undefined;
      default:
        return undefined;
    }
  }, [readOnly, t, onDrillPanel, uploadMedia]);

  /** Objects made with nothing selected stand on the canvas by themselves
   *  until they are dragged into a module. Read from the layout, where the
   *  flag and the coordinate live. */
  const layoutForLoose = useEditorStore((s) => s.worldDraft.graphLayout);
  const looseStored = useMemo(() => storedLoose(layoutForLoose), [layoutForLoose]);

  /** Unused slots the author has taken out of the tray this session. Not
   *  saved: a slot that stays empty goes back in the tray next time. */
  const [revealedSlots, setRevealedSlots] = useState<ReadonlySet<TrayItem>>(() => new Set());
  const pickTrayItem = useCallback((item: TrayItem, _anchor?: DOMRect) => {
    captureHubEvent("studio_tray_pick", { world_id: eventWorldId(), item });
    if (item === "packs") { onDrillPanel("packs"); return; }
    // A number or a behaviour is made on the spot, on the card (the tray is
    // the card's), and opens in its row to be set up.
    if (item === "state" || item === "behavior") { trayAddRef.current?.(item); return; }
    setRevealedSlots((prev) => new Set(prev).add(item));
    // Music and pictures: their block comes out (or was already out, off
    // screen) and the board brings it into view, or the menu item seemed
    // to do nothing.
    if (item === "audio" || item === "image" || item === "background") {
      const target = item === "audio" ? blockId.audio() : item === "image" ? blockId.image() : blockId.background;
      window.setTimeout(() => fitFocusedBlockRef.current(target, 420), 120);
    }
  }, [onDrillPanel]);
  const trayAddRef = useRef<((item: "state" | "behavior") => void) | null>(null);

  /** The card's AIs (ai-roster.ts). */
  const roster = useMemo(() => aiRoster(worldDraft, t as Translate), [worldDraft, t]);
  const blocks = useMemo(
    () =>
      withStarterSlots(buildBoard(boardGraph, {
        forced: forcedRowIds,
        preferred: budget.preferred,
        expanded: expandedBlocks,
        // The card is the root module: its own tile beside the modules, its
        // objects as rows there and as a count in each module. Nothing is
        // "loose" on such a board — a new card-level object lands on the
        // card's tile.
        cardFrame: true,
        // A tile block shows two columns of eight before it folds; a chip
        // is a fraction of a row, so a chip board shows more.
        rowLimits: { lore: TILE_ROW_LIMIT, state: TILE_ROW_LIMIT, behavior: TILE_ROW_LIMIT, opening: TILE_ROW_LIMIT },
      }), !readOnly, storyBoard,
      // Any lesson, basic or advanced, teaches the slots as blocks, so it
      // has no tray: the advanced ones frame no blocks of their own and still
      // point at the audio block.
      inLesson || teaching ? undefined : { hasBackground: cardHasBackground, revealed: revealedSlots, packs: false })
      // An AI that lives somewhere has no frame, so none of its blocks either:
      // who it is opens in its row of 「这里的 AI」.
      .filter((block) => {
        if (!block.ownerId) return true;
        const book = (worldDraft.worldbooks ?? []).find((b) => b.id === block.ownerId);
        return !book || !livesSomewhere(book);
      })
      // Who answers where: the card and every scenario end on their 「AI」
      // block, always — the card's own AI is one row of it — so the place
      // to add another is always where it would land.
      .concat([placeAisBlock(), ...situationBooks(worldDraft.worldbooks).map((b) => placeAisBlock(b.id))])
      // The card's Context too: the engine draws one for every scenario.
      .concat([{ id: blockId.context(), kind: "context", headSlots: [], rows: [], hiddenCount: 0, total: 0, sharedCount: 0 } satisfies Block]),
    [boardGraph, forcedRowIds, budget.preferred, expandedBlocks, storyBoard, readOnly, teaching, inLesson, cardHasBackground, revealedSlots, worldDraft.worldbooks],
  );
  /** 「这里的 AI」 of every frame, keyed by owner ("" is the card). */
  const placeAisByOwner = useMemo(() => {
    const map = new Map<string, PlaceAis>();
    map.set("", placeAis(worldDraft, undefined, t as Translate));
    for (const b of worldDraft.worldbooks ?? []) if (b.host === undefined) map.set(b.id, placeAis(worldDraft, b.id, t as Translate));
    return map;
  }, [worldDraft, t]);

  /** What fires each object, when the answer sits in the same block as it —
   *  an event source, or the upstream behaviour whose emit it listens for.
   *  Those wires would have to leave the block and loop back to say anything,
   *  so the row carries the name instead. Cross-block triggers stay wires. */
  const firedBy = useMemo(() => {
    const hosts = canvasBlockHostMap(blocks, graph);
    const map = new Map<string, string>();
    for (const e of graph.edges) {
      const from = hosts.get(e.from);
      const to = hosts.get(e.to);
      if (!from || !to || from.host !== to.host) continue;
      const source = graphById.get(e.from);
      if (source) map.set(e.to, displayTitle(source));
    }
    return map;
  }, [blocks, graph, graphById, displayTitle]);
  const graphRef = useRef(graph);
  graphRef.current = graph;
  /** The card and its modules, each holding its own blocks. This is the unit
   *  the canvas draws now: a module is a complete thing, not a switch whose
   *  contents live in global lists somewhere else. */
  const frames = useMemo(() => {
    // An AI that lives on the card or in a situation is a row of that place's
    // 「这里的 AI」, so it has no frame of its own.
    const living = new Set((worldDraft.worldbooks ?? []).filter(livesSomewhere).map((b) => blockId.frame(b.id)));
    return buildFrames(graph, blocks, true).filter((f) => !living.has(f.id));
  }, [graph, blocks, worldDraft.worldbooks]);
  const framesRef = useRef(frames);
  framesRef.current = frames;

  /** What each module holds, per shelf. Counted off the blocks rather than the
   *  draft so the number on a shelf and the rows in the block below it can
   *  never disagree — lore arrives as up to four blocks (one per trigger) and
   *  the shelf is the sum. */
  const EMPTY_SHELVES = useMemo(() => ({ opening: 0, lore: 0, state: 0, behavior: 0 }), []);
  const shelfCounts = useMemo(() => {
    const m = new Map<string, { opening: number; lore: number; state: number; behavior: number }>();
    for (const b of blocks) {
      // "" is the card's own frame, which has shelves too.
      const owner = b.ownerId ?? "";
      const kind = b.kind === "opening" ? "opening" : b.kind;
      if (kind !== "opening" && kind !== "lore" && kind !== "state" && kind !== "behavior") continue;
      const e = m.get(owner) ?? { opening: 0, lore: 0, state: 0, behavior: 0 };
      // The module's OWN. The card's shared rows are drawn in the block too,
      // but the shelf is the "+" that adds to this module, and its count
      // should be what that "+" has made.
      e[kind] += b.total - b.sharedCount;
      m.set(owner, e);
    }
    return m;
  }, [blocks]);
  /** Open frames, by id. Shut is the default — twenty modules open at once is
   *  a wall of text, and the card's own frame is the one you usually want. */
  const [openFrames, setOpenFrames] = useState<Set<string>>(() => new Set([blockId.frame(null)]));
  const openFramesRef = useRef(openFrames);
  openFramesRef.current = openFrames;
  /** On a card with modules the card is a strip, and what a creator came to
   *  see — the shared entries, each module's own — is inside the modules. So
   *  the first module opens too, once per card; after that it stays however
   *  the creator leaves it. */
  const autoOpenedFor = useRef<string | null>(null);
  useEffect(() => {
    const modules = frames.filter((f) => f.ownerId);
    if (modules.length === 0 || autoOpenedFor.current === worldDraft.id) return;
    autoOpenedFor.current = worldDraft.id;
    // A card with a handful of modules opens them all: the creator came to
    // see the card, and four shut bars are not it. Past a handful the board
    // would be a wall, so only the first opens and the rest are theirs.
    const open = modules.length <= 6 ? modules : modules.slice(0, 1);
    setOpenFrames((prev) => {
      const next = new Set(prev);
      for (const f of open) next.add(f.id);
      return next;
    });
  }, [frames, worldDraft.id]);
  /** The frame a dragged row is currently over. Purely visual — the drop
   *  itself reads the id off the event. */
  const [dropFrameId, setDropFrameId] = useState<string | null>(null);

  /** A whole block in the air, and the module it is over. The board lays
   *  itself out as if the piece had already landed there: the blocks below
   *  slide down and the gap that opens IS the slot. Nothing is written
   *  until the drop, so letting go anywhere else puts everything back. */
  const [piece, setPiece] = useState<{ kind: Block["kind"]; over: string | null } | null>(null);
  const pieceRef = useRef(piece);
  pieceRef.current = piece;
  const onPieceDrag = useCallback((kind: Block["kind"] | null) => {
    setPiece(kind ? { kind, over: null } : null);
    if (!kind) setDropFrameId(null);
  }, []);
  /** Shift-click a head: the whole piece joins (or leaves) the selection,
   *  so several pieces can travel as one. */
  /** A whole group at once — a folder's rows, an object's relations — as THE
   *  selection, or joining it with a modifier held, the way a row does. */
  const selectPieces = useCallback((ids: string[], add: boolean) => {
    setMultiSelected((prev) => {
      const next = new Set(add ? prev : []);
      for (const id of ids) next.add(id);
      return next.size === 0 ? EMPTY_MULTI : next;
    });
    if (!add) setSelection(null);
  }, []);
  const onPieceSelect = useCallback((ids: string[], add: boolean) => {
    setMultiSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (add) next.add(id);
        else next.delete(id);
      }
      return next.size ? next : EMPTY_MULTI;
    });
  }, []);
  /** The id the reserved slot is laid out under. Never a real object. */
  const SLOT_ID = "block:piece-slot";

  /** Write (or clear) an object's loose entry in the layout. Loose = a
   *  card-level object not yet in a module, drawn alone at x/y. */
  const setLoose = useCallback(
    (objId: string, at: { x: number; y: number } | null) => {
      const layout = useEditorStore.getState().worldDraft.graphLayout;
      const cur: GraphLayout["nodes"] = layout?.version === GRAPH_LAYOUT_VERSION ? { ...layout.nodes } : {};
      if (at) cur[objId] = { x: Math.round(at.x), y: Math.round(at.y), pinned: true, loose: true };
      else if (cur[objId]) {
        const { loose: _loose, pinned: _pinned, ...rest } = cur[objId]!;
        void _loose;
        void _pinned;
        cur[objId] = rest as GraphLayout["nodes"][string];
      }
      setGraphLayout({
        version: GRAPH_LAYOUT_VERSION,
        nodes: cur,
        notes: layout?.version === GRAPH_LAYOUT_VERSION ? (layout.notes ?? []) : [],
      });
    },
    [setGraphLayout],
  );
  /** Re-home an object into a module, or out to the card.
   *
   *  The projection already knows how to say this — `set-parent` is the patch
   *  the module inspector's dropdown writes — so the gesture and the dropdown
   *  cannot disagree about what "belongs to" means. */
  const dropOnFrame = useCallback(
    (frameId: string, ownerId: string | null) => (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropFrameId(null);
      setPiece(null);
      // A piece carries every object in the block; a row carries one. Same
      // gesture, same patch — only how many objects it re-homes differs.
      const many = e.dataTransfer.getData("application/yumina-objects");
      if (many) {
        const ownerOf = (id: string) => {
          const n = graphRef.current.nodes.find((x: GraphNode) => x.id === id);
          if (!n) return undefined;
          return n.parentId?.startsWith("module:") ? n.parentId.slice("module:".length) : null;
        };
        const moved = pieceMoves(many.split(",").filter(Boolean), ownerOf, ownerId);
        inOneUndoStep(() => {
          for (const id of moved) {
            applyGraphPatch({ op: "set-parent", nodeId: id, parentId: ownerId ? `module:${ownerId}` : undefined });
            setLoose(id, null);
          }
        });
        if (moved.length) {
          setOpenFrames((prev) => (prev.has(frameId) ? prev : new Set(prev).add(frameId)));
          flashRecent(moved);
        }
        return;
      }
      const objId = e.dataTransfer.getData("application/yumina-object");
      if (!objId) return;
      const node = graphRef.current.nodes.find((n: GraphNode) => n.id === objId);
      if (!node) return;
      const currentOwner = node.parentId?.startsWith("module:")
        ? node.parentId.slice("module:".length)
        : null;
      // Dropping something back where it already lives is not an edit, and
      // writing one would put a no-op on the undo stack.
      if (currentOwner === ownerId) return;
      inOneUndoStep(() => {
        applyGraphPatch({ op: "set-parent", nodeId: objId, parentId: ownerId ? `module:${ownerId}` : undefined });
        setLoose(objId, null);
      });
      // Show where it landed: the frame opens if it was shut, and the row
      // lights up there for a while.
      setOpenFrames((prev) => (prev.has(frameId) ? prev : new Set(prev).add(frameId)));
      flashRecent([objId]);
    },
    [applyGraphPatch, flashRecent, setLoose],
  );

  /** "Put it in every module": the loose object becomes what a card-level
   *  object is — a shared row in each module. */
  const unloose = useCallback(
    (objId: string) => {
      inOneUndoStep(() => {
        applyGraphPatch({ op: "set-parent", nodeId: objId, parentId: undefined });
        setLoose(objId, null);
      });
      flashRecent([objId]);
    },
    [applyGraphPatch, setLoose, flashRecent],
  );
  /** A free spot in what the creator is looking at, for a block that has to
   *  appear on the canvas. The middle of the view first; if a frame is
   *  there, the left margin, then the right margin, then below the frames
   *  — never on top of a module, where a loose block reads as being inside
   *  it. */
  const placeInView = useCallback((): { x: number; y: number } => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const tl = rf.screenToFlowPosition({ x: rect.left + (insetsRef.current?.left ?? 0), y: rect.top + 130 });
    const br = rf.screenToFlowPosition({ x: rect.left + rect.width - (insetsRef.current?.right ?? 0), y: rect.top + rect.height - 40 });
    const w = BLOCK_W;
    const h = 140;
    // Frames, and whatever already stands outside them: a second new object
    // must not land on the first.
    const frames = rfNodesRef.current
      .filter((n) => isFrameNodeId(n.id) || isLooseBlockId(n.id))
      .map((n) => {
        const b = frameBoxesRef.current.get(n.id);
        return { x: n.position.x, y: n.position.y, width: b?.width ?? n.measured?.width ?? 0, height: b?.height ?? n.measured?.height ?? 0 };
      });
    const free = (x: number, y: number) =>
      !frames.some((f) => x < f.x + f.width + 12 && f.x < x + w + 12 && y < f.y + f.height + 12 && f.y < y + h + 12);
    const cx = (tl.x + br.x) / 2 - w / 2;
    const cy = (tl.y + br.y) / 2 - h / 2;
    const candidates = [
      { x: cx, y: cy },
      { x: tl.x + 24, y: cy },
      { x: br.x - w - 24, y: cy },
      { x: tl.x + 24, y: tl.y + 24 },
      { x: br.x - w - 24, y: tl.y + 24 },
    ];
    for (const c of candidates) if (free(c.x, c.y)) return c;
    // Nowhere free in view: just below the lowest frame that is on screen.
    const lowest = Math.max(...frames.filter((f) => f.y < br.y && f.y + f.height > tl.y).map((f) => f.y + f.height), cy);
    return { x: cx, y: lowest + 28 };
  }, [rf]);
  /** A row dropped on the empty canvas: out of its module (if it had one)
   *  and loose, standing where it was dropped. */
  /** Dropping a row on the empty board pulls it out of its module. That has
   *  always worked and nothing ever said so — no cursor change, no landing
   *  zone, no words. A feature no one can see is a feature no one has. */
  /** Where the held row would land on the bare board: a dashed card under
   *  the pointer, the size it will be, saying what letting go there does.
   *  (It used to be a dashed border round the whole board, which said
   *  "somewhere" — and said it over the blocks too.) */
  const [paneDropHint, setPaneDropHint] = useState<{ x: number; y: number; w: number } | null>(null);
  const paneDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("application/yumina-object")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);
  /** Runs in the capture phase, ahead of the rows (which keep their own
   *  dragover to themselves), so the card follows the pointer everywhere and
   *  goes the moment it is over a block. */
  /** Held near an edge of the board, a dragged row scrolls the board that
   *  way — the card and the situation it is going into are rarely on screen
   *  together, and a drag cannot zoom out on the way. */
  const dragPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const startEdgePanRef = useRef<() => void>(() => {});
  useEffect(() => {
    let raf = 0;
    const EDGE = 64, MAX = 18;
    const tick = () => {
      const p = dragPointerRef.current;
      const rect = containerRef.current?.getBoundingClientRect();
      if (p && rect && performance.now() - p.at < 400) {
        const left = rect.left + (insetsRef.current?.left ?? 0), right = rect.right - (insetsRef.current?.right ?? 0);
        const speed = (d: number) => (d < EDGE ? Math.ceil(MAX * (1 - Math.max(0, d) / EDGE)) : 0);
        const dx = speed(p.x - left) - speed(right - p.x);
        const dy = speed(p.y - rect.top - topChromeRef.current) - speed(rect.bottom - p.y);
        if (dx || dy) { const vp = rf.getViewport(); void rf.setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom }); }
      }
      raf = requestAnimationFrame(tick);
    };
    // Started from the first dragover that carries a row: at dragstart the
    // row has not written its data yet.
    startEdgePanRef.current = () => { if (!raf) raf = requestAnimationFrame(tick); };
    const stop = () => { dragPointerRef.current = null; if (raf) { cancelAnimationFrame(raf); raf = 0; } };
    window.addEventListener("dragend", stop, true);
    window.addEventListener("drop", stop, true);
    return () => { stop(); window.removeEventListener("dragend", stop, true); window.removeEventListener("drop", stop, true); };
  }, [rf]);
  /** An AI row dragged to another place: the card or a scenario, read off
   *  whichever of its frame or blocks the pointer is over. */
  const aiDropPlace = (target: EventTarget | null): string | null => {
    const id = (target as Element | null)?.closest?.(".react-flow__node")?.getAttribute("data-id") ?? "";
    const m = /^block:m:([^:]+):/.exec(id) ?? /^module:(.+)$/.exec(id);
    if (m) return (useEditorStore.getState().worldDraft.worldbooks ?? []).some((b) => b.id === m[1] && b.host === undefined) ? m[1]! : null;
    return id.startsWith("block:") || id === "frame:card" ? "card" : null;
  };
  const aiDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("application/yumina-ai") || readOnly) return;
    e.stopPropagation();
    if (!aiDropPlace(e.target)) { e.dataTransfer.dropEffect = "none"; return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, [readOnly]);
  const aiDrop = useCallback((e: React.DragEvent) => {
    const bookId = e.dataTransfer.getData("application/yumina-ai");
    if (!bookId || readOnly) return;
    e.preventDefault();
    e.stopPropagation();
    const place = aiDropPlace(e.target);
    const book = (useEditorStore.getState().worldDraft.worldbooks ?? []).find((b) => b.id === bookId);
    if (!place || !book || book.host === place) return;
    useEditorStore.getState().updateWorldbook(bookId, { host: place });
    const block = blockId.ais(place === "card" ? undefined : place);
    flashRecent([`module:${bookId}`]);
    window.setTimeout(() => fitFocusedBlockRef.current(block, 420), 200);
  }, [readOnly, flashRecent]);
  const trackPaneDrop = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("application/yumina-object") || useEditorStore.getState().readOnlyInspect) return;
    dragPointerRef.current = { x: e.clientX, y: e.clientY, at: performance.now() };
    startEdgePanRef.current();
    // Over a block or a situation the drop is theirs (they light up and say
    // what it does); only bare board shows the landing card.
    if ((e.target as Element | null)?.closest?.(".react-flow__node")) { setPaneDropHint(null); return; }
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const zoom = rf.getViewport().zoom;
    const x = Math.round(e.clientX - rect.left), y = Math.round(e.clientY - rect.top);
    setPaneDropHint((prev) => (prev && Math.abs(prev.x - x) < 3 && Math.abs(prev.y - y) < 3 ? prev : { x, y, w: Math.round(BLOCK_W * zoom) }));
  }, [rf]);
  useEffect(() => {
    if (!paneDropHint) return;
    const off = () => setPaneDropHint(null);
    window.addEventListener("dragend", off, true);
    window.addEventListener("drop", off, true);
    return () => { window.removeEventListener("dragend", off, true); window.removeEventListener("drop", off, true); };
  }, [paneDropHint]);
  const paneDrop = useCallback(
    (e: React.DragEvent) => {
      setPaneDropHint(null);
      const objId = e.dataTransfer.getData("application/yumina-object");
      if (!objId || useEditorStore.getState().readOnlyInspect) return;
      e.preventDefault();
      setDropFrameId(null);
      setPiece(null);
      // A piece let go over open canvas comes OUT of its module. It does not
      // float there: on this board the card IS the root module, so "out of a
      // module" means "back on the card" and the piece flies to the card's
      // tile. (Free-floating blocks belonged to the old board, where the card
      // had no tile of its own — see buildBoard({ cardFrame: true }).)
      // Out of every frame is out of play: it stands where it was let go,
      // faded, until it is dragged back onto the card or into a situation.
      // A whole block (a piece) comes out as one column of its rows.
      const at = rf.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const many = e.dataTransfer.getData("application/yumina-objects");
      const ids = (many ? many.split(",") : [objId]).filter(Boolean).filter((id) => {
        const n = graphRef.current.nodes.find((x: GraphNode) => x.id === id);
        return n && (n.kind === "entry" || n.kind === "variable" || n.kind === "rule") && n.parentId !== `module:${UNPLACED_WORLDBOOK_ID}`;
      });
      if (!ids.length) return;
      inOneUndoStep(() => {
        ids.forEach((id, i) => {
          applyGraphPatch({ op: "set-parent", nodeId: id, parentId: `module:${UNPLACED_WORLDBOOK_ID}` });
          setLoose(id, { x: at.x - BLOCK_W / 2, y: at.y - 20 + i * 64 });
        });
      });
      flashRecent(ids);
    },
    [applyGraphPatch, rf, setLoose, flashRecent],
  );

  /** Where the row being dragged comes from ("core" = the card's, shared),
   *  read off the drag's own MIME types — the data itself is sealed until
   *  the drop. Lets the frame under the pointer say what dropping means. */
  const [dragFrom, setDragFrom] = useState<string | null>(null);
  // Whatever started a drag, its marks go when the drag ends anywhere on the
  // page. A dragged head re-renders mid-drag (the board makes room for it),
  // and an element that is no longer there never hears its own dragend:
  // the 「放这里」 slot and the landing lines stayed on the board after it.
  useEffect(() => {
    const clear = () => window.setTimeout(() => {
      setPiece(null);
      setDropFrameId(null);
      setPaneDropHint(null);
      setDragFrom(null);
      for (const el of document.querySelectorAll("[data-row-lifted], [data-row-landing], [data-canvas-writing-lifted], [data-canvas-writing-landing]")) {
        el.removeAttribute("data-row-lifted"); el.removeAttribute("data-row-landing");
        el.removeAttribute("data-canvas-writing-lifted"); el.removeAttribute("data-canvas-writing-landing");
      }
    }, 0);
    window.addEventListener("dragend", clear, true);
    window.addEventListener("drop", clear, true);
    return () => { window.removeEventListener("dragend", clear, true); window.removeEventListener("drop", clear, true); };
  }, []);
  const dragOverFrame = useCallback(
    (frameId: string) => (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes("application/yumina-object")) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDropFrameId(frameId);
      // A piece announces its kind as a MIME type, the one thing readable
      // before the drop, so the module can reserve the slot it would take.
      const kindType = e.dataTransfer.types.find((ty) => ty.startsWith("application/yumina-piece-"));
      if (kindType) {
        const kind = kindType.slice("application/yumina-piece-".length) as Block["kind"];
        setPiece((prev) => (prev?.over === frameId && prev.kind === kind ? prev : { kind, over: frameId }));
      }
      const from = e.dataTransfer.types.find((ty) => ty.startsWith("application/yumina-from-"));
      setDragFrom(from ? from.slice("application/yumina-from-".length) : null);
    },
    [],
  );
  /** What a drop on this frame would do, for the frame to say while a row
   *  hovers over it. MIME types come back lower-cased, so compare that way. */
  const dropLabelFor = useCallback(
    (ownerId: string | null, name: string): string | undefined => {
      if (dragFrom === null) return undefined;
      const here = (ownerId ?? "core").toLowerCase();
      if (dragFrom === here) return String(t("blueprint.frame.dropSame"));
      if (!ownerId) return String(t("blueprint.frame.stripDrop"));
      return String(dragFrom === "core" ? t("blueprint.frame.dropOwn", { name }) : t("blueprint.frame.dropMove", { name }));
    },
    [dragFrom, t],
  );

  const toggleFrame = useCallback((frameId: string) => {
    setOpenFrames((prev) => {
      const next = new Set(prev);
      if (next.has(frameId)) next.delete(frameId);
      else next.add(frameId);
      return next;
    });
  }, []);

  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;
  // What is selected is what the assistant is pointed at: "make this shorter"
  // gets an address, and only this goes to it in full.
  const worldForFocus = useRef(worldDraft);
  worldForFocus.current = worldDraft;
  useEffect(() => {
    const ids = new Set<string>(multiSelected);
    if (selection?.type === "node") ids.add(selection.id);
    const ctx = { graphById, blocks: blocksRef.current, world: worldForFocus.current, t: t as unknown as (key: string) => string };
    useAiFocus.getState().setFromCanvas([...ids].map((id) => describeFocus(id, ctx)).filter((item): item is NonNullable<typeof item> => !!item));
    // graphById: a rename changes the chip's title without changing what is
    // selected. setFromCanvas ignores a re-send that changes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, multiSelected, graphById]);
  const writingBlockIds = useMemo(() => new Set(blocks.filter(block => block.kind === "opening" || block.kind === "lore").map(block => block.id)), [blocks]);

  /** objId → the flow node that renders it, and whether it currently has its
   *  own handle (a folded row, or anything inside a shut block, re-anchors
   *  onto the block itself). */
  const hostOf = useMemo(() => {
    const map = canvasBlockHostMap(blocks, graph);
    for (const [id, host] of map) {
      if (collapsedSet.has(host.host) && !writingBlockIds.has(host.host)) map.set(id, { ...host, shown: false });
    }
    for (const g of gates) map.set(g.id, { host: g.id, shown: true });
    return map;
  }, [blocks, graph, gates, collapsedSet, writingBlockIds]);

  /** Every block that renders each object, per frame — a shared object has
   *  one per module. Wires pick their ends from this; `hostOf` keeps the
   *  first for selection and reveal. */
  const hostsOf = useMemo(() => {
    const map = canvasBlockHostsMap(blocks, graph);
    for (const [id, hosts] of map) {
      map.set(id, hosts.map((h) => (collapsedSet.has(h.host) && !writingBlockIds.has(h.host) ? { ...h, shown: false } : h)));
    }
    // A gate lives in its own frame, so a wire from a shared variable into
    // module B lands on B's copy of the variable.
    for (const g of gates) map.set(g.id, [{ host: g.id, shown: true, ownerId: g.id.slice("module:".length) }]);
    return map;
  }, [blocks, graph, gates, collapsedSet, storyBoard, writingBlockIds]);

  /** Everything wired to the current selection. Selecting a row lights up its
   *  neighbours and greys the rest — on a card with sixty objects that is the
   *  only way to read one object's relationships. */
  // Nothing greys the board. Selecting something used to grey everything it
  // was not wired to, and the eye went to what had faded rather than to what
  // was picked: the pick is marked on itself, and its wires still light.
  const focusIds: ReadonlySet<string> | null = null;
  /** Frames lit because the pointer is on an AI's 「它收到」 chip: where
   *  that chip's things come from. */
  const [litFrames, setLitFrames] = useState<ReadonlySet<string> | null>(null);
  const lightSources = useCallback((sources: string[] | null) => setLitFrames(sources?.length ? new Set(sources) : null), []);

  // ── Layout: the standard formation ──
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }> | null>(null);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  /** graphLayout carries positions AND sticky notes, so every layout write has
   *  to forward the notes — otherwise one drag silently deletes them. */
  const currentNotes = useCallback(() => useEditorStore.getState().worldDraft.graphLayout?.notes, []);
  const collapsedRef = useRef(collapsedSet);
  collapsedRef.current = collapsedSet;

  /** Chrome that changes a block's height, so the formation can be computed
   *  without measuring the DOM. Held in a ref because the formation is rebuilt
   *  from callbacks that must not re-create themselves on every toggle. */
  const chromeRef = useRef<(block: Block, width?: number) => BlockChrome>(() => ({
    collapsed: false, expanded: false,
  }));
  /** `jumpTo` is declared with the rest of the navigation machinery, hundreds
   *  of lines below where the frames are built. */
  const jumpToRef = useRef<(objId: string) => void>(() => {});
  const [focusedModule, setFocusedModule] = useState<string | null>(null);
  /** The block the selected row lives in, zoomed to fill the view. Selecting
   *  a row anywhere brings its block to a readable size and dims the others;
   *  selecting a row in another block glides there; clicking empty canvas (or
   *  Esc) returns to the overview the author was looking at before. On a
   *  full board that is the difference between "where am I" and reading. */
  const [focusedBlock, setFocusedBlock] = useState<string | null>(null);
  const focusedBlockRef = useRef<string | null>(null);
  focusedBlockRef.current = focusedBlock;
  const focusBlockRef = useRef<(objId: string) => void>(() => {});
  const leaveBlockFocusRef = useRef<() => void>(() => {});
  const fitFocusedBlockRef = useRef<(hostId: string, duration: number) => void>(() => {});
  /** A jump animates its own centre; the block focus stands down while it runs. */
  const focusSuppressedUntil = useRef(0);
  const overviewViewport = useRef<ReturnType<typeof rf.getViewport> | null>(null);
  const focusModuleRef = useRef<(id: string) => void>(() => {});
  const focusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelObjectCenter = useRef<() => void>(() => {});
  useEffect(() => () => { if (focusTimer.current) clearTimeout(focusTimer.current); cancelObjectCenter.current(); }, []);
  useEffect(() => {
    if (focusTimer.current) clearTimeout(focusTimer.current);
    overviewViewport.current = null;
    setFocusedModule(null);
  }, [worldId]);

  const contextBadges = useMemo(() => {
    const books = worldDraft.worldbooks ?? [];
    const anyStation = books.some((b) => Boolean(resolveStation(b)));
    if (!anyStation) return null;
    const out = new Map<string, ContextBadge>();
    for (const b of books) out.set(b.id, contextBadgeFor(b, books));
    return out;
  }, [worldDraft.worldbooks]);

  /** A small memory node: scope, direct connections, and at most one warning.
   * Full explanations and the underlying controls live in its inspector. */
  /** The author's own history window, off the card's settings. A module can
   *  narrow it further; that is the module's own block's business. */
  const cardHistoryLimit = useEditorStore(s => s.worldDraft.settings?.historyLimit) || 0;
  const cardSummaryOn = useEditorStore(s => s.worldDraft.settings?.storySummary?.enabled === true);
  const cardPinnedNote = useEditorStore(s => (s.worldDraft.settings?.pinnedNote?.content ?? "").trim());
  /**
   * A colour per memory pool, stable across renders and shared by everyone in
   * it. The pool's id would do as a key, but it is a random string — so the
   * order of the pools on the card picks the colour, which keeps the first
   * pool the same colour after a second one appears.
   *
   * Drawn as a tint rather than a wire: every line on this board runs between
   * two OBJECTS through their row handles, and a memory pool is a relation
   * between two BLOCKS. Giving blocks their own kind of edge would be a
   * second wire model living beside the first, for one relationship.
   */
  const poolTint = useCallback((pool: string): string => {
    const books = useEditorStore.getState().worldDraft.worldbooks ?? [];
    const pools = [...new Set(books.map((b) => resolveStation(b)?.memoryPool).filter((p): p is string => !!p))].sort();
    const at = pools.indexOf(pool);
    return gateTint(at < 0 ? 0 : at);
  }, []);

  const contextRowsFor = useCallback(
    (block: Block): ContextRowView[] => {
      const books = worldDraft.worldbooks ?? [];
      const ownerId = block.ownerId;
      const book = ownerId ? books.find((b) => b.id === ownerId) : undefined;
      const station = book ? resolveStation(book) : null;
      const pick = ownerId ? () => setSelection({ type: "node", id: block.id }) : undefined;
      const rows: ContextRowView[] = [];
      const join = String(t("blueprint.ctx.flowJoin"));
      const nameList = (names: string[]) =>
        names.slice(0, 3).join(join) + (names.length > 3 ? ` +${names.length - 3}` : "");
      // One memory is shared by the card, every plain module and every
      // narrator that did not name a pool of its own.
      const sharers = books.filter((b) => {
        const st = resolveStation(b);
        return st ? st.kind === "narrator" && st.memoryPool === null : true;
      });

      // Context is its own small block (owner, 10/6): one line, the memory
      // of this place. Its settings are a click away.
      if (!ownerId) {
        const open = () => setSelection({ type: "node", id: blockId.context() });
        const text = String(t("blueprint.ctx.row.memoryCardAlone")) + (cardHistoryLimit ? ` · ${t("blueprint.turnCtx.historyLimitCard", { count: cardHistoryLimit })}` : "");
        const cardRows: ContextRowView[] = [{ key: "memory", icon: "memory", text, title: t("blueprint.ctx.row.memoryCardHint"), onClick: open }];
        // The two settings that change what the AI is handed show as lines of
        // their own, so a card with a summary or a pinned note says so on the
        // board rather than only in the column.
        if (cardSummaryOn) cardRows.push({ key: "summary", icon: "in", text: t("blueprint.ctx.row.summaryOn"), title: t("blueprint.insp.historySummaryHint"), onClick: open });
        if (cardPinnedNote) cardRows.push({ key: "pinned", icon: "in", text: t("blueprint.ctx.row.pinnedRow", { text: cardPinnedNote.length > 40 ? `${cardPinnedNote.slice(0, 40)}…` : cardPinnedNote }), title: cardPinnedNote, onClick: open });
        return cardRows;
      }
      if (!book) return rows;
      // A scenario with no AI of its own talks in the card's conversation.
      if (!station) {
        return [{ key: "memory", icon: "shared", text: t("blueprint.ctx.row.usesCard"), onClick: pick }];
      }

      let memoryRow: ContextRowView | null = null;
      if (station?.kind === "narrator" && station.memoryPool !== null) {
        // A pool with others in it is "shared with these"; a pool of one is
        // the tower.
        const mates = memoryPoolMembers(books, station.memoryPool).filter((b) => b.id !== ownerId).map((b) => b.name);
        memoryRow = {
          key: "memory",
          icon: "memory",
          text: mates.length
            ? t("blueprint.ctx.row.memoryPool", { names: nameList(mates) })
            : t(station.onClose === "keep" ? "blueprint.ctx.row.memoryOwnKeep" : "blueprint.ctx.row.memoryOwnArchive"),
          title: t(mates.length ? "blueprint.ctx.row.memoryPoolHint" : "blueprint.ctx.row.memoryOwnHint"),
          // Only a pool with company gets a colour: a pool of one is a module
          // keeping to itself, which is the absence of a relationship and so
          // has nothing to match anywhere else on the board.
          ...(mates.length ? { tint: poolTint(station.memoryPool) } : {}),
        };
      } else if (station?.kind === "narrator") {
        const others = sharers.filter((b) => b.id !== ownerId).map((b) => b.name);
        memoryRow = {
          key: "memory",
          icon: "memory",
          text: t("blueprint.ctx.row.memoryShared", { names: nameList([String(t("blueprint.ctx.row.theCard")), ...others]) }),
          title: t("blueprint.ctx.row.memorySharedHint"),
        };
      }

      const badge = contextBadges?.get(ownerId);
      if (memoryRow) rows.push({ ...memoryRow, onClick: pick });
      if (badge?.indirect.length) rows.push({
        key: "connections-warning",
        icon: "trap",
        text: t("blueprint.ctx.row.reviewConnections", { count: badge.indirect.length }),
        title: badge.indirect.map(link => t("blueprint.ctx.chainTrap", { via: link.viaName, source: link.sourceName })).join("\n"),
        onClick: pick,
      });
      return rows;
    },
    [worldDraft.worldbooks, contextBadges, cardHistoryLimit, cardSummaryOn, cardPinnedNote, poolTint, t],
  );


  // No frame is an AI any more (owner, 10/6: an AI is one more API call, not
  // a place): a scenario that runs its own AI is drawn as a scenario, and
  // the AI is a row of its 「AI」 block. Kept as a set so the callers read the
  // same; it is always empty.
  const aiFrameIds = useMemo(() => new Set<string>(), []);
  const headerHFor = useCallback((frameId: string) => (aiFrameIds.has(frameId) ? FRAME_TITLE_H + AI_RECEIVES_H : FRAME_TITLE_H), [aiFrameIds]);
  const headerHForRef = useRef(headerHFor);
  headerHForRef.current = headerHFor;

  /** The one-word scope under the block's title. */
  const contextScopeFor = useCallback(
    (block: Block): "shared" | "own" | "pool" | "worker" => {
      const book = (worldDraft.worldbooks ?? []).find((b) => b.id === block.ownerId);
      const st = book ? resolveStation(book) : null;
      if (st?.kind === "worker") return "worker";
      if (st?.kind === "narrator" && st.memoryPool !== null) {
        return memoryPoolMembers(worldDraft.worldbooks ?? [], st.memoryPool).length > 1 ? "pool" : "own";
      }
      return "shared";
    },
    [worldDraft.worldbooks],
  );

  // ── Scenes: every module shows its own face ──
  // Each module's scene block runs the interface with the preview's
  // variables forced into the state that opens that module (its `eq`
  // conditions), so four modules are four faces side by side. A module
  // nothing in the variables opens shows the interface as the preview has
  // it. The override objects are memoised per module: a fresh object per
  // render would re-send the variables to every preview every render.
  const sceneFiles = useMemo(() => Object.keys(worldDraft.rootComponent?.files ?? {}), [worldDraft.rootComponent?.files]);
  const sceneOverrides = useMemo(() => {
    const m = new Map<string, Record<string, number | string | boolean | Record<string, unknown> | unknown[]> | undefined>();
    for (const b of worldDraft.worldbooks ?? []) m.set(b.id, moduleSceneState(b) ?? undefined);
    return m;
  }, [worldDraft.worldbooks]);
  const isWritingBlock = useCallback((block: Block) => block.kind === "opening" || block.kind === "lore", []);
  const writingEntriesFor = useCallback((block: Block) => (block.head ? [block.head] : block.rows.map(row => row.g))
    .map(node => draftById.entries.get(String(node.data.entryId ?? node.id.slice(node.id.indexOf(":") + 1))))
    // The platform's own narration presets stay off the board: they come
    // with every card, nobody needs to touch them, and a folder of them read
    // as something to deal with. They are in 面板 → 设定.
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry) && !entry!.presetId), [draftById]);
  /** A module's face with nothing of its own to show: no scene file, on a
   *  card that has no interface either. Its live preview would be the
   *  platform's default chat with nothing in it — 610×460 of black beside a
   *  module you just made, half the board. The card's own block already
   *  previews that chat; the module's block says so in a line and keeps the
   *  file picker, which is the one thing about it that can change. */
  const isBareScene = useCallback(
    (block: Block): boolean =>
      block.kind === "scene" && defaultChat && !(worldDraft.worldbooks ?? []).find((b) => b.id === block.ownerId)?.frontendFile,
    [defaultChat, worldDraft.worldbooks],
  );
  const isBareSceneRef = useRef(isBareScene);
  isBareSceneRef.current = isBareScene;

  /** The card's own empty variables / behaviours blocks. These are the two
   *  places a new creator stalls, so they get a second door beside the "+":
   *  a pack they can read instead of a form they have to fill. Both the
   *  layout (height) and the node (button) ask this, so they agree. */
  // The assistant writes entries, variables, behaviours and openings. It has
  // no tool for the card's interface or its memory, so those blocks do not
  // offer a button that would lead nowhere.
  const ASKABLE = useMemo(() => new Set(["opening", "lore", "state", "behavior", "image", "audio"]), []);

  const hasPackDoor = useCallback(
    (block: Block) =>
      !block.ownerId && (block.kind === "state" || block.kind === "behavior") && block.total === 0,
    [],
  );

  /** How finished this card is, for the frame header. The publish flow runs
   *  the same function, so the number a creator watches while writing is the
   *  number they are held to at the end. */
  // cardReadiness is typed to the six fields it reads, so they are passed
  // (and depended on) by name; the type keeps the two lists honest.
  const { name: cardName, entries: cardEntries, variables: cardVariables, reactions: cardReactions, rules: cardRules, avatar: cardAvatar } = worldDraft;
  const cardProgress = useMemo(() => {
    const readiness = cardReadiness({ name: cardName, entries: cardEntries, variables: cardVariables, reactions: cardReactions, rules: cardRules, avatar: cardAvatar });
    const next = readiness.missing[0];
    return {
      done: readiness.done,
      total: readiness.total,
      ...(next ? { nextLabel: String(t(`blueprint.readiness.${next.id}` as never)) } : {}),
    };
  }, [cardName, cardEntries, cardVariables, cardReactions, cardRules, cardAvatar, t]);

  const chromeFor = useCallback(
    (block: Block, width: number = BLOCK_W): BlockChrome => ({
      collapsed: blockCollapsed(collapsedSet, block.id),
      expanded: openedTexts.has(block.id),
      expandedIds: openRowIds,
      width,
      compactCard: !block.head?.data.coverUrl && !worldDraft.description,
      defaultChat: defaultChat,
      // The stock chat used to draw as one line. It shows the opening live
      // now, like every other interface: writing the opening and watching
      // the player's screen not change was the first thing a beginner hit.
      // Until there is an opening it IS one line: an empty phone was the
      // biggest thing on a new card's first screen. The first words typed
      // grow it, so the screen still visibly answers the opening.
      // Only while the card has no opening written at all: a second, empty
      // opening (the tutorial adds one) collapsed the screen and took its
      // 手机/电脑 switch and 编辑界面 away from the lesson about them.
      frontendThin: block.kind === "frontend" && ((defaultChat && !anyOpeningWritten) || screenFolded),
      // On a tile a writing block is a list of rows. Simple mode makes them
      // names; detail mode gives each one what it says and when the AI is
      // told it; an open row is that object's whole editor, in place.
      ...(isWritingBlock(block) ? { collapsed: false, starterHeight: canvasWritingNodeHeight({ kind: block.kind === "opening" ? "opening" : "setting", entries: writingEntriesFor(block), rows: block.head ? [{ g: block.head, slots: block.headSlots }] : block.rows, compact: glance, expandedIds: openRowIds, columns: block.kind === "opening" ? 1 : rowColumns(writingEntriesFor(block).length, width), hiddenCount: block.hiddenCount, folders: entryFolders, presetsTitle, collapsedFolders }) } : {}),
      ...(block.kind === "context" ? { contextRows: contextRowsFor(block).length } : {}),
      ...(block.kind === "ais" ? { aiRows: placeAisByOwner.get(block.ownerId ?? "")?.rows.length ?? 1 } : {}),
      ...(block.kind === "scene" ? { sceneWide: device === "desktop", sceneBare: isBareScene(block) } : {}),
      ...(block.kind === "frontend" ? { frontendDesktop: device === "desktop" } : {}),
      ...(hasPackDoor(block) ? { packDoor: true } : {}),
    }),
    [collapsedSet, openedTexts, openRowIds, contextRowsFor, placeAisByOwner, glance, device, worldDraft.description, worldDraft.entries, defaultChat, isWritingBlock, writingEntriesFor, isBareScene, hasPackDoor, entryFolders, presetsTitle, collapsedFolders, cardHasBackground, anyOpeningWritten, screenFolded],
  );
  /** Whether a face block (the card's interface, a module's scene) has a
   *  real preview to show — which puts it on a row of its own, full width. */
  const hasPreview = useCallback(
    (block: Block) => (block.kind === "frontend" && !defaultChat) || (block.kind === "scene" && !isBareScene(block)),
    [defaultChat, isBareScene],
  );
  const hasPreviewRef = useRef(hasPreview);
  hasPreviewRef.current = hasPreview;

  /** When the module opens, in the creator's own terms — "当 位置 = 副本A",
   *  the keywords, how many openings — rather than the name of the mode.
   *  "Conditional" told a creator nothing they could act on. */
  const activationLabelFor = useCallback(
    (ownerId: string | null): string | undefined => {
      const book = ownerId ? (worldDraft.worldbooks ?? []).find((b) => b.id === ownerId) : undefined;
      if (!book) return undefined;
      if (book.enabled === false) return String(t("blueprint.moduleDisabled"));
      // A sentence, not a badge: when this situation is in use is the one
      // thing its frame has to say ("from the 码头 opening", "when 好感 ≥ 80").
      const varName = (id: string) => worldDraft.variables.find((v) => v.id === id)?.name ?? id;
      const a = book.activation;
      if (a.mode === "greeting") {
        const openings = worldDraft.entries.filter((e) => e.role === "greeting");
        const names = a.greetingIds.map((id) => {
          const i = openings.findIndex((e) => e.id === id);
          return i < 0 ? undefined : openings[i]!.name?.trim() || String(t("blueprint.insp.openingN", { n: i + 1 }));
        }).filter(Boolean);
        return String(names.length ? t("modules.when.greeting", { names: names.join("」「") }) : t("modules.when.greetingNone"));
      }
      if (a.mode === "keywords") {
        const words = (a.keywords ?? []).filter(Boolean);
        if (!words.length) return String(t("modules.when.keywordsNone"));
        const enter = String(t("modules.when.keywords", { words: words.slice(0, 3).join("」「") }));
        const out = (a.leaveKeywords ?? []).filter(Boolean);
        return out.length ? `${enter} · ${String(t("modules.when.leaveWords", { words: out.slice(0, 2).join("」「") }))}` : enter;
      }
      if (a.mode === "conditions") {
        const detail = moduleActivationBadge(book, varName).detail;
        return String(detail ? t("modules.when.conditions", { detail }) : t("modules.when.conditionsNone"));
      }
      return String(t(`modules.when.${a.mode}` as never));
    },
    [worldDraft.worldbooks, worldDraft.variables, t],
  );

  chromeRef.current = chromeFor;

  /** Lay the board out in whichever formation fits the space that is free:
   *  a wide board on a bare canvas, a narrower one beside an open dock. */
  const buildFormation = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    const view = rect
      ? {
          width: rect.width - (insetsRef.current?.left ?? 0) - (insetsRef.current?.right ?? 0),
          height: rect.height,
        }
      : { width: 1200, height: 800 };
    const boxes = tileBoxes(framesRef.current, {
      heightAt: (b, w) => blockHeight(b, chromeRef.current(b, w)),
      isOpen: (id) => openFramesRef.current.has(id),
      pinned: storedPinned(),
      hasPreview: (b) => hasPreviewRef.current(b),
      openingId: previewGreetingIdRef.current,
      viewWidth: view.width,
      worldbooks: situationBooks(useEditorStore.getState().worldDraft.worldbooks),
      headerH: (id) => headerHForRef.current(id),
    });
    const pos: Record<string, { x: number; y: number }> = {};
    for (const box of boxes.values()) {
      pos[box.id] = { x: box.x, y: box.y };
      // Relative on purpose: React Flow positions a child against its parent,
      // so a frame can be dragged and its contents come with it.
      for (const [blockIdStr, at] of Object.entries(box.blocks)) pos[blockIdStr] = { x: at.x, y: at.y };
    }
    return pos;
  }, []);

  /**
   * Who reads whom, for every module at once.
   *
   * Computed here rather than per frame because a link is a fact about a PAIR:
   * the module being read has to learn about it from the module doing the
   * reading, and neither one can answer alone.
   */

  /** Only blocks and gates need coordinates — a handful, instead of one per
   *  object. The signature changes when the formation has to be recomputed.
   *
   *  That means HEIGHT, not just which blocks exist. Adding a behaviour does
   *  not add a block — it adds a row to the block already standing there, so
   *  that block grows and everything below it has to move down. Keyed on ids
   *  alone the formation stayed as it was, the new row rendered on top of the
   *  block underneath, and the creator's report was "I added a behaviour and
   *  nothing showed up". */
  /** Where the creator has dragged frames to. Part of the layout signature:
   *  a drop has to re-run the formation so the rest of the board settles
   *  around the moved frame. */
  const graphLayout = useEditorStore((s) => s.worldDraft.graphLayout);
  const pinnedSig = useMemo(() => JSON.stringify(storedPinned()), [graphLayout]);
  const layoutSig = useMemo(
    () =>
      [
        ...frames.map((f) => `${f.id}${openFrames.has(f.id) ? "+" : "-"}`),
        ...blocks.map((b) => `${b.id}:${blockHeight(b, chromeFor(b))}`),
        pinnedSig,
      ].join("|"),
    [frames, blocks, openFrames, chromeFor, pinnedSig],
  );

  useEffect(() => {
    // Always the formation. Blocks used to carry hand-dragged coordinates, and
    // a NEW block had none — so it took a formation slot while everything else
    // kept its dragged one, and landed on top of a block that was already
    // there. That is both halves of what a creator sees: overlapping boxes,
    // and "I added a behaviour and nothing appeared" (it appeared, underneath).
    //
    // Two coordinate systems for one board was the mistake. Where a block sits
    // was never load-bearing anyway — which frame it belongs to is, and what
    // order its rows are in is, and both of those are still dragged. So the
    // board lays itself out and nothing can ever overlap.
    setPositions(buildFormation());
  }, [layoutSig, buildFormation]);


  const [rfNodes, setRfNodes] = useState<BlueprintNode[]>([]);
  const rfNodesRef = useRef(rfNodes);
  rfNodesRef.current = rfNodes;
  const [rfEdges, setRfEdges] = useState<Edge[]>([]);
  /** Node ids currently being dragged — the rebuild pass must not move them. */

  const insetsRef = useRef(edgeInsets);
  insetsRef.current = edgeInsets;

  /** Frame id → its measured box, for sizing the node and for hit-testing a
   *  drop. Recomputed with the formation, never guessed from the DOM. */
  /** The frames as the board should DRAW them: with the slot reserved in
   *  whichever module the piece is over. The piece itself keeps its place
   *  in its own module until the drop — a hole opening behind the cursor
   *  reads as "already moved", and it has not been. */
  const framesForLayout = useMemo(() => {
    const at = piece?.over;
    if (!at) return frames;
    const slot: Block = { id: SLOT_ID, kind: piece.kind, total: 0, sharedCount: 0, hiddenCount: 0, headSlots: [], rows: [] };
    return frames.map((f) => (f.id === at ? { ...f, blocks: [...f.blocks, slot] } : f));
  }, [frames, piece]);

  const situationGroupsRef = useRef<SituationGroupBox[]>([]);
  const frameBoxes = useMemo(() => {
    const rect = containerRef.current?.getBoundingClientRect();
    const view = rect
      ? {
          width: rect.width - (insetsRef.current?.left ?? 0) - (insetsRef.current?.right ?? 0),
          height: rect.height,
        }
      : { width: 1200, height: 800 };
    return tileBoxes(framesForLayout, {
      heightAt: (b, w) => (b.id === SLOT_ID ? PIECE_SLOT_H : blockHeight(b, chromeRef.current(b, w))),
      isOpen: (id) => openFrames.has(id),
      pinned: storedPinned(),
      hasPreview,
      openingId: previewGreetingId,
      viewWidth: view.width,
      worldbooks: situationBooks(worldDraft.worldbooks),
      onGroups: (groups) => { situationGroupsRef.current = groups; },
      headerH: headerHFor,
    });
    // The signature carries every block height, so a block that grows for a
    // reason other than its rows — the scene block taking the live preview
    // when the previewed module changes — resizes its frame too. Keyed on
    // the collapse/expand sets alone, the preview moved into a module whose
    // frame was still the old height and hung out of its bottom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [framesForLayout, frames, blocks, openFrames, collapsedSet, openedTexts, pinnedSig, layoutSig, device, storyBoard, hasPreview, previewGreetingId, worldDraft.worldbooks, headerHFor]);
  /** Where loose blocks stand: where they were put, unless that is on top of
  *  a frame or of another loose block — then beside the frames, one under
  *  another, so three new settings are three readable blocks, not a pile
  *  over the card's open editor. */
  const loosePlaced = useMemo(() => {
    const out: Record<string, { x: number; y: number }> = {};
    const W = BLOCK_W, H = 120, GAP = 24;
    const frames = [...frameBoxes.values()];
    const hit = (x: number, y: number, r: { x: number; y: number; width: number; height: number }) =>
      x < r.x + r.width && x + W > r.x && y < r.y + r.height && y + H > r.y;
    const right = frames.reduce((m, f) => Math.max(m, f.x + f.width), 0);
    const top = frames.reduce((m, f) => Math.min(m, f.y), Infinity);
    const placed: Array<{ x: number; y: number; width: number; height: number }> = [];
    let nextY = Number.isFinite(top) ? top : 0;
    for (const [id, at] of Object.entries(looseStored)) {
      let pos = at;
      if (frames.some((f) => hit(pos.x, pos.y, f)) || placed.some((p) => hit(pos.x, pos.y, p))) {
        pos = { x: right + 48, y: nextY };
        while (placed.some((p) => hit(pos.x, pos.y, p))) pos = { x: pos.x, y: pos.y + H + GAP };
        nextY = pos.y + H + GAP;
      }
      placed.push({ ...pos, width: W, height: H });
      out[id] = pos;
    }
    return out;
  }, [frameBoxes, looseStored]);
  const frameBoxesRef = useRef(frameBoxes);
  frameBoxesRef.current = frameBoxes;

  /** A pinned frame stays put when another is dragged — but when a frame
   *  GROWS (opened, a row added, a preview mounted) the pinned frames below
   *  it are pushed down out of its way, the way a document flows. Dragging
   *  and growing are the two reasons frames overlap; only the second is not
   *  the creator's doing, so only the second moves neighbours. */
  const prevFrameHeights = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const boxes = [...frameBoxes.values()];
    const prev = prevFrameHeights.current;
    prevFrameHeights.current = new Map(boxes.map((b) => [b.id, b.height]));
    if (prev.size === 0 || useEditorStore.getState().readOnlyInspect) return;
    const grown = boxes.filter((b) => (prev.get(b.id) ?? b.height) < b.height);
    if (grown.length === 0) return;
    const pinned = storedPinned();
    if (Object.keys(pinned).length === 0) return;
    const moved: Record<string, { x: number; y: number }> = {};
    const noted = new Set(
      frames.filter((f) => typeof f.module?.data.note === "string" && f.module.data.note).map((f) => f.id),
    );
    const push = (f: { id: string; x: number; y: number; width: number; height: number }) => {
      for (const o of boxes) {
        if (o.id === f.id || !pinned[o.id]) continue;
        const oy = moved[o.id]?.y ?? o.y;
        if (oy < f.y) continue;
        const overlapX = f.x < o.x + o.width && o.x < f.x + f.width;
        if (!overlapX) continue;
        const bottom = f.y + f.height + (noted.has(f.id) ? FRAME_NOTE_H : 0) + FRAME_GAP;
        if (oy < bottom) {
          moved[o.id] = { x: o.x, y: bottom };
          push({ ...o, y: bottom });
        }
      }
    };
    for (const g of grown) push(g);
    if (Object.keys(moved).length === 0) return;
    const layout = useEditorStore.getState().worldDraft.graphLayout;
    const cur: GraphLayout["nodes"] = layout?.version === GRAPH_LAYOUT_VERSION ? { ...layout.nodes } : {};
    for (const [id, at] of Object.entries(moved)) cur[id] = { ...cur[id], x: Math.round(at.x), y: Math.round(at.y), pinned: true };
    setGraphLayout({ version: GRAPH_LAYOUT_VERSION, nodes: cur, notes: layout?.version === GRAPH_LAYOUT_VERSION ? (layout.notes ?? []) : [] });
  }, [frameBoxes, frames, setGraphLayout]);
  /** Smart guides and the frames under the one being dragged — live, while
   *  the drag is happening. */
  const [guides, setGuides] = useState<(Snap & { gaps: Gap[]; zoom: number }) | null>(null);
  const [overlapIds, setOverlapIds] = useState<Set<string>>(() => new Set());
  /** The last snapped position per dragged node: what the drop pins, since
   *  the node React Flow hands the drop handler may carry the raw one. */
  const lastSnapRef = useRef<Record<string, { x: number; y: number }>>({});

  /** Fit the graph into the strip the docks leave free, rather than into the
   *  whole element. Plain fitView centres it behind the AI dock, and the
   *  command bar is a pill 40px tall at the top of the pane; 56 clears it.
   *  (It used to reserve 116, which on a laptop was a fifth of the height
   *  spent on nothing — every pixel here comes straight off the zoom.) With
   *  the toolbar up in the stage's page row there is no pill to clear. Read
   *  through a ref: the host arrives a render after the fit callbacks do. */
  const topChromeRef = useRef(56);
  topChromeRef.current = toolbarHost ? 16 : 56;
  /** ...and the zoom cluster sits in the bottom-left corner. Auto-fitting into
   *  the whole height parked content underneath it — on a fresh card the
   *  module you had just made landed with its bottom row behind the zoom
   *  buttons, which reads as "the thing I made came out broken". */
  const BOTTOM_CHROME = 56;
  /** Whether the board is bigger than the screen even after fitting, i.e.
   *  whether there is anything off screen to go looking for. Decides if the
   *  minimap earns its corner. */
  const [boardOverflows, setBoardOverflows] = useState(false);
  // useReactFlow's wrapper changes when the pan/zoom pane mounts. That alone
  // must not re-run dock/layout fit effects after restoring a saved viewport.
  const flowViewportRef = useRef(rf);
  flowViewportRef.current = rf;
  const updateBoardOverflow = useCallback(() => {
    const flow = flowViewportRef.current;
    const rect = containerRef.current?.getBoundingClientRect();
    // What a lesson keeps off the board is not off screen.
    const nodes = flow.getNodes().filter((n) => !n.hidden);
    if (!rect || !nodes.length) return;
    const bounds = flow.getNodesBounds(nodes);
    const viewport = flow.getViewport();
    const left = bounds.x * viewport.zoom + viewport.x;
    const top = bounds.y * viewport.zoom + viewport.y;
    setBoardOverflows(left < (insetsRef.current?.left ?? 0) || top < topChromeRef.current ||
      left + bounds.width * viewport.zoom > rect.width - (insetsRef.current?.right ?? 0) ||
      top + bounds.height * viewport.zoom > rect.height - BOTTOM_CHROME);
  }, []);
  useEffect(() => {
    const frame = requestAnimationFrame(updateBoardOverflow);
    return () => cancelAnimationFrame(frame);
  }, [rfNodes, edgeInsets?.left, edgeInsets?.right, updateBoardOverflow]);
  useEffect(() => {
    if (!containerRef.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateBoardOverflow);
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [updateBoardOverflow]);
  /** The last fit, so a fit that changes how much the rows say can fit
   *  again to the board it produced. */
  const lastFitRef = useRef<{ at: number; args: [number, boolean, ReadonlySet<string> | undefined, boolean, { right?: number; bottom?: number }] } | null>(null);
  /** When the entrance last framed the board (0 when it has not). */
  const lastEntranceRef = useRef(0);
  /** The same moment, kept: the settle above clears its copy. */
  const enteredAtRef = useRef(0);
  const fitEntranceRef = useRef<(() => unknown) | null>(null);
  /** Moves the glance switch made itself; they must not decide it again. */
  const glanceQuietUntilRef = useRef(0);
  const readReportedRef = useRef(false);
  /** Where the person's last own move was aimed, in client pixels. */
  const glanceAnchorRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const teachingRef = useRef(teaching);
  teachingRef.current = teaching;

  const fitBetweenDocks = useCallback(
    (duration = 0, wholeBoard = false, only?: ReadonlySet<string>, dryRun = false, reserve: { right?: number; bottom?: number; zoom?: number } = {}): number | false | void | Promise<boolean> => {
      const flow = flowViewportRef.current;
      const rect = containerRef.current?.getBoundingClientRect();
      const nodes = only ? flow.getNodes().filter((n) => only.has(n.id)) : flow.getNodes();
      if (!rect || nodes.length === 0) return;
      // The INSTANCE method, never the one exported from the package. Every
      // block is a child of its frame (parentId + extent:"parent"), so its
      // `position` is relative to that frame; the free function has no node
      // lookup to resolve a parent with, reads those relatives as absolutes,
      // and hands back a box roughly twice as wide with its centre far to the
      // right. The viewport then centred that phantom, which put the card's
      // own block off the left edge of the screen on every card in the
      // library. React Flow warns about exactly this in the console.
      const b = flow.getNodesBounds(nodes);
      if (!(b.width > 0) || !(b.height > 0)) return;
      const left = insetsRef.current?.left ?? 0;
      // `reserve` is room kept free beside or under what is framed — the
      // guide's card stands there during a lesson, next to the block and
      // not on it.
      const right = (insetsRef.current?.right ?? 0) + (reserve.right ?? 0);
      const availW = Math.max(240, rect.width - left - right);
      // A tile board fits by HEIGHT on every laptop (1366×768 and below), so
      // the padding above and below is nearly nothing: every pixel reserved
      // there comes straight off the zoom.
      const top = topChromeRef.current;
      const availH = Math.max(240, rect.height - top - BOTTOM_CHROME - (reserve.bottom ?? 0));
      const pad = 12;
      // Floor the zoom at something you can still read. Fitting a big card by
      // shrinking it to 39% showed everything and told you nothing; past this
      // point the creator pans instead.
      //
      // A card's own board keeps a higher floor than a board of modules, but
      // not an absolute one: at 85% a board thirty pixels wider than the strip
      // left free simply hung off the edge, and the whole right-hand lane —
      // the card's own face included — was behind the dock on a first look.
      // A few percent is a cheap price for seeing the card you just made.
      // A lesson reads at one zoom from start to finish (`reserve.zoom`):
      // only a block too wide for the strip reads smaller. A tall one is not
      // shrunk to fit; the camera shows it from the top.
      const zoom = reserve.zoom
        ? Math.max(0.35, Math.min(reserve.zoom, (availW - pad * 2) / b.width))
        : Math.max(
          wholeBoard ? 0.12 : storyBoardRef.current ? STORY_BOARD_MIN_ZOOM : MIN_READABLE_ZOOM,
          Math.min((availW - pad * 2) / b.width, (availH - pad * 2) / b.height, 1),
        );
      if (dryRun) return zoom;
      lastFitRef.current = { at: performance.now(), args: [duration, wholeBoard, only, false, reserve] };
      // Still too big at the readable floor = there is something off screen,
      // and the minimap has a job.
      setBoardOverflows(b.width * zoom > availW - pad || b.height * zoom > availH - pad);
      return flow.setViewport(
        {
          x: left + availW / 2 - (b.x + b.width / 2) * zoom,
          y: top + ((storyBoardRef.current || reserve.zoom) && b.height * zoom > availH - pad ? pad : availH / 2 - b.height * zoom / 2) - b.y * zoom,
          zoom,
        },
        glide(duration),
      );
    },
    [],
  );

  /**
   * Decide, once a move has come to rest, whether rows are names or say what
   * they hold (see `glance`). Changing it changes the height of every writing
   * block, so the board is put back under the reader: after a fit it fits
   * again, otherwise the block at the centre of the screen stays there.
   */
  const settleGlance = useCallback((zoom: number) => {
    if (performance.now() < glanceQuietUntilRef.current) return;
    const want = teachingRef.current ? false : glanceRef.current ? zoom < GLANCE_LEAVE : zoom < GLANCE_ENTER;
    if (want === glanceRef.current) return;
    const flow = flowViewportRef.current;
    const rect = containerRef.current?.getBoundingClientRect();
    const fit = lastFitRef.current && performance.now() - lastFitRef.current.at < 1500 ? lastFitRef.current : null;
    lastFitRef.current = null;
    // The entrance frames by hand rather than through fitBetweenDocks, so it
    // leaves its own note: the rows changing under it move the blocks it
    // just centred (on a wide screen ~330px right, half under the
    // assistant), and it has to frame them again rather than keep a spot.
    const entrance = !fit && lastEntranceRef.current && performance.now() - lastEntranceRef.current < 1500;
    lastEntranceRef.current = 0;
    let anchor: { id: string; fy: number; sy: number } | null = null;
    // Best of all, the very row that was under the pointer (or the middle):
    // its top edge goes back to where it was on screen.
    let rowAnchor: { attr: string; value: string; top: number } | null = null;
    if (!fit && !entrance && rect) {
      const aimAt = glanceAnchorRef.current && performance.now() - glanceAnchorRef.current.at < 3000 ? glanceAnchorRef.current : null;
      const px = aimAt ? aimAt.x : rect.left + rect.width / 2;
      const py = aimAt ? aimAt.y : rect.top + rect.height / 2;
      const hit = document.elementFromPoint(px, py)?.closest<HTMLElement>("[data-canvas-writing-object],[data-row-anchor]");
      if (hit) {
        const attr = hit.hasAttribute("data-canvas-writing-object") ? "data-canvas-writing-object" : "data-row-anchor";
        rowAnchor = { attr, value: hit.getAttribute(attr) ?? "", top: hit.getBoundingClientRect().top };
      }
    }
    if (!fit && !entrance && rect && !rowAnchor) {
      const vp = flow.getViewport();
      const aim = glanceAnchorRef.current && performance.now() - glanceAnchorRef.current.at < 3000 ? glanceAnchorRef.current : null;
      const sx = aim ? aim.x - rect.left : rect.width / 2;
      const sy = aim ? aim.y - rect.top : rect.height / 2;
      const cx = (sx - vp.x) / vp.zoom;
      const cy = (sy - vp.y) / vp.zoom;
      for (const n of flow.getNodes()) {
        if (!n.id.startsWith("block:")) continue;
        const inner = flow.getInternalNode(n.id);
        const at = inner?.internals.positionAbsolute;
        const w = inner?.measured?.width ?? 0;
        const h = inner?.measured?.height ?? 0;
        if (!at || !w || !h) continue;
        if (cx >= at.x && cx <= at.x + w && cy >= at.y && cy <= at.y + h) {
          anchor = { id: n.id, fy: (cy - at.y) / h, sy };
          break;
        }
      }
    }
    // Put the board back once React Flow has measured the new heights —
    // two frames is not always enough, and fitting the old size again just
    // lands on the zoom that asked for the change.
    const sizeOf = () => { const b = flow.getNodesBounds(flow.getNodes().filter((n) => !n.hidden)); return `${Math.round(b.width)}x${Math.round(b.height)}`; };
    const before = sizeOf();
    // Zoom-to-read, once per visit: a zoom of the person's own, not a fit
    // and not a lesson.
    if (!want && !fit && !teachingRef.current && !readReportedRef.current) {
      readReportedRef.current = true;
      captureHubEvent("studio_board_read", { world_id: eventWorldId(), zoom: Math.round(zoom * 100) / 100 });
    }
    setGlance(want);
    // Changed from `before`, then unchanged for a few frames: the heights
    // arrive a block at a time as React Flow measures them.
    let frames = 0;
    let last = before;
    let still = 0;
    const settle = () => {
      const now = sizeOf();
      still = now === last ? still + 1 : 0;
      last = now;
      if ((now === before || still < 3) && ++frames < 60) { requestAnimationFrame(settle); return; }
      // A lesson owns the camera: rows unfolding as it starts (the board
      // was read at a glance on the catalog before it) re-take the lesson's
      // frame. Keeping the reader's spot instead jumped back to the zoom
      // the lesson was moving away from.
      if (refitLessonRef.current) {
        glanceQuietUntilRef.current = performance.now() + 650;
        refitLessonRef.current(250);
        return;
      }
      if (fit) {
        glanceQuietUntilRef.current = performance.now() + fit.args[0] + 400;
        void fitBetweenDocks(...fit.args);
        return;
      }
      if (entrance) {
        glanceQuietUntilRef.current = performance.now() + 400;
        void fitEntranceRef.current?.();
        return;
      }
      if (rowAnchor) {
        const el = containerRef.current?.querySelector<HTMLElement>(`[${rowAnchor.attr}="${CSS.escape(rowAnchor.value)}"]`);
        if (el) {
          const vp = flow.getViewport();
          glanceQuietUntilRef.current = performance.now() + 400;
          void flow.setViewport({ x: vp.x, y: vp.y + (rowAnchor.top - el.getBoundingClientRect().top), zoom: vp.zoom });
        }
        return;
      }
      if (!anchor) return;
      const inner = flow.getInternalNode(anchor.id);
      const at = inner?.internals.positionAbsolute;
      const h = inner?.measured?.height ?? 0;
      if (!at || !h) return;
      const vp = flow.getViewport();
      glanceQuietUntilRef.current = performance.now() + 400;
      void flow.setViewport({ x: vp.x, y: anchor.sy - (at.y + anchor.fy * h) * vp.zoom, zoom: vp.zoom });
    };
    requestAnimationFrame(settle);
  }, [fitBetweenDocks]);
  // A lesson frames a few blocks up close and teaches what they say, so it
  // reads rows in full; when it ends the zoom decides again.
  const wasTeachingRef = useRef(teaching);
  useEffect(() => {
    const was = wasTeachingRef.current;
    wasTeachingRef.current = teaching;
    if (teaching) { if (glanceRef.current) setGlance(false); return; }
    // Only on the way out of a lesson: on mount the viewport is still the
    // default 100% and would open every row before the first fit.
    if (was) settleGlance(flowViewportRef.current.getViewport().zoom);
  }, [teaching, settleGlance]);
  // A move the person starts (wheel, drag, pinch) is not the tail of the last
  // fit, however soon after it comes: without this, zooming right after
  // "fit" snapped the board back to a fit instead of staying where they put it.
  /** The minimap shows while the board is moving and a moment after, and
   *  while the pointer is on it. Parked over the bottom-right corner it sat on
   *  the rows there, and its faded tile still took their clicks. */
  const [mapAwake, setMapAwake] = useState(false);
  const mapHoverRef = useRef(false);
  const mapSleepRef = useRef<number | null>(null);
  const wakeMap = useCallback(() => {
    if (mapSleepRef.current !== null) window.clearTimeout(mapSleepRef.current);
    mapSleepRef.current = null;
    setMapAwake(true);
  }, []);
  const sleepMapSoon = useCallback(() => {
    if (mapSleepRef.current !== null) window.clearTimeout(mapSleepRef.current);
    mapSleepRef.current = window.setTimeout(() => {
      mapSleepRef.current = null;
      if (!mapHoverRef.current) setMapAwake(false);
    }, 1400);
  }, []);
  useEffect(() => () => { if (mapSleepRef.current !== null) window.clearTimeout(mapSleepRef.current); }, []);
  const onMoveStart = useCallback((event: MouseEvent | TouchEvent | null) => {
    if (!event) return;
    wakeMap();
    lastFitRef.current = null;
    // Nor is it one of the switch's own settling moves: a zoom begun while a
    // fit was still sliding in has to be decided when it ends.
    glanceQuietUntilRef.current = 0;
    // Zooming with the wheel or a pinch is zooming INTO a spot: that spot is
    // what has to stay put when the rows change height, not the middle.
    const point = "clientX" in event ? event : event.touches?.[0];
    if (point) glanceAnchorRef.current = { x: point.clientX, y: point.clientY, at: performance.now() };
  }, [wakeMap]);
  const onMoveEnd = useCallback((_: unknown, viewport: { zoom: number }) => {
    updateBoardOverflow();
    settleGlance(viewport.zoom);
    sleepMapSoon();
  }, [updateBoardOverflow, settleGlance, sleepMapSoon]);
  useSmoothWheelZoom({
    // A scroll stops when the board's edge reaches the middle of the window,
    // rather than running on into empty desk.
    clampScroll: (vp) => {
      const flow = flowViewportRef.current;
      const rect = containerRef.current?.getBoundingClientRect();
      const nodes = flow.getNodes().filter((n) => !n.hidden);
      if (!rect || !nodes.length) return vp;
      const b = flow.getNodesBounds(nodes);
      const clamp = (v: number, lo: number, hi: number) => (lo > hi ? v : Math.min(hi, Math.max(lo, v)));
      const halfW = rect.width / 2, halfH = rect.height / 2;
      return {
        zoom: vp.zoom,
        x: clamp(vp.x, halfW - (b.x + b.width) * vp.zoom, halfW - b.x * vp.zoom),
        y: clamp(vp.y, halfH - (b.y + b.height) * vp.zoom, halfH - b.y * vp.zoom),
      };
    },
    container: containerRef,
    getViewport: rf.getViewport,
    setViewport: (viewport) => { void rf.setViewport(viewport); },
    minZoom: 0.12,
    maxZoom: 1.75,
    enabled: active,
    // Mid-glide the board is not done zooming: the switch between the full
    // and the glance rows waits for it to come to rest, then aims at the
    // spot the pointer zoomed into — the same as a pinch that ended there.
    onGlide: () => { glanceQuietUntilRef.current = performance.now() + 250; lastFitRef.current = null; wakeMap(); },
    onSettle: (zoom, point) => {
      sleepMapSoon();
      glanceQuietUntilRef.current = 0;
      glanceAnchorRef.current = { ...point, at: performance.now() };
      updateBoardOverflow();
      settleGlance(zoom);
    },
  });

  /** Frame a lesson's blocks in the room above the docked guide, centred,
   *  so the block and the words about it stand on one line down the
   *  middle of the canvas. */
  const frameLesson = useCallback((only: ReadonlySet<string>, duration: number) => {
    return fitBetweenDocks(duration, true, only, false, LEARNING_GUIDE_BELOW);
  }, [fitBetweenDocks]);

  // Content growth and inspector resize preserve the canvas viewport.
  // Initial fit and explicit Fit/Locate commands own camera changes.
  const measuredBlueprintNodes = useCallback(() => {
    const flow = flowViewportRef.current;
    // Controlled nodes are rebuilt for content changes. ReactFlow retains the
    // actual measured dimensions in its internal lookup across those rebuilds.
    return flow.getNodes().map(node => flow.getInternalNode(node.id) ?? node);
  }, []);
  // The board opens on the whole board when the whole board can be read at
  // once. When it cannot — six modules on a laptop — it opens on the card's
  // own tile and its face, which are the first things on it; the rest is a
  // pan away. (The old board opened on the first module, because the card
  // was not a frame on a card with modules; now it is.)
  const ENTRANCE_MIN_ZOOM = 0.6;
  const fitEntrance = useCallback(() => {
    // A card's own openings come first: the board opens close enough on them
    // to read the opening, not on everything at once too small to read.
    const opening = blocksRef.current.find((b) => b.kind === "opening" && !b.ownerId && !b.loose);
    if (opening) {
      // ...with the player's screen that sits right above it. Centring the
      // opening alone left the bottom third of that screen hanging off the
      // top edge, which reads as a board that loaded broken.
      const flow = flowViewportRef.current;
      const rect = containerRef.current?.getBoundingClientRect();
      const nodes = flow.getNodes();
      const openingNode = nodes.find((n) => n.id === opening.id);
      const screenNode = nodes.find((n) => n.id === blockId.frontend && !n.hidden);
      const both = rect && openingNode && screenNode ? flow.getNodesBounds([screenNode, openingNode]) : null;
      if (!rect || !both || !openingNode || !screenNode || !(both.width > 0) || !(both.height > 0)) {
        return fitBetweenDocks(0, false, new Set([opening.id]), false, { zoom: 1 });
      }
      const pad = 24;
      const left = insetsRef.current?.left ?? 0;
      const availW = Math.max(240, rect.width - left - (insetsRef.current?.right ?? 0));
      const top = topChromeRef.current;
      // The card opens at READING size, from its top, like a page: the board
      // used to fit the screen and the opening into the window, which on a
      // card of any length meant ~50% and text of five or six pixels — a
      // thumbnail to be zoomed into before anything could be read. The wheel
      // scrolls down it now. The cover column comes in when it fits at full
      // size; otherwise it is a scroll to the right, beside the card.
      const frameNode = nodes.find((n) => n.id === blockId.frame(null) && !n.hidden);
      const tile = frameNode ? flow.getNodesBounds([frameNode]) : both;
      const cardNode = nodes.find((n) => n.id === blockId.card && !n.hidden);
      const wide = cardNode ? flow.getNodesBounds([frameNode ?? screenNode, cardNode]) : null;
      // Exactly 1 when the tile fits: at any other scale the browser draws
      // the board's 12–13px type resampled, and at 0.85 it came out at ten
      // blurred pixels. The card tile is capped (CARD_TILE_WIDTHS) so that
      // it fits beside the assistant at 1.
      const READ_ZOOM = 1;
      const fit = (width: number) => (availW - pad * 2) / width;
      const target = wide && fit(wide.width) >= 1 ? wide : tile;
      const zoom = Math.max(0.85, Math.min(READ_ZOOM, fit(target.width)));
      const x = target.width * zoom <= availW - pad * 2
        ? left + availW / 2 - (target.x + target.width / 2) * zoom
        : left + pad - target.x * zoom;
      const y = top + pad - tile.y * zoom;
      requestAnimationFrame(updateBoardOverflow);
      lastEntranceRef.current = enteredAtRef.current = performance.now();
      return flow.setViewport({ x, y, zoom });
    }
    const whole = fitBetweenDocks(0, false, undefined, true);
    if (typeof whole === "number" && whole >= ENTRANCE_MIN_ZOOM) return fitBetweenDocks();
    const first = new Set([blockId.frame(null), blockId.card, blockId.background]);
    return fitBetweenDocks(0, false, first);
  }, [fitBetweenDocks, updateBoardOverflow]);
  fitEntranceRef.current = fitEntrance;
  const { isViewportSettled, cancelInitialFit } = useInitialBlueprintFit({ writing: false, worldId: blueprintDocumentKey, ready: Boolean(positions), viewportReady: rf.viewportInitialized, nodeCount: rfNodes.length, getNodes: measuredBlueprintNodes, getViewport: rf.getViewport, setViewport: rf.setViewport, fit: fitEntrance });

  /** The nodes React Flow draws: the built board, minus whatever the
   *  current lesson keeps off screen. Derived, never written back — the
   *  board's own state has no idea a lesson is on. */
  // The kinds this lesson brings onto the stage that the last one did not
  // draw (or, opened from the catalog, the lesson's own): they come in with a short rise (`studio-learn-enter`), so each
  // lesson reads as one more real block arriving on the board.
  const stageHistory = useRef<{ key: string | null; entering: ReadonlySet<string> }>({ key: null, entering: new Set() });
  const stageKeyNow = learningStage ? learningStage.join(",") : null;
  if (stageHistory.current.key !== stageKeyNow) {
    // Opened from the catalog there is no previous stage to compare with:
    // the lesson's own block is the one arriving, the rest were already known.
    const before: readonly string[] = stageHistory.current.key ? stageHistory.current.key.split(",") : (learningStage ?? []).filter((kind) => !(learningFocus ?? []).includes(kind));
    stageHistory.current = { key: stageKeyNow, entering: new Set((learningStage ?? []).filter((kind) => !before.includes(kind))) };
  }
  const entering = stageHistory.current.entering;
  const stagedNodes = useMemo(
    () => (learningStage ? rfNodes.map((n) => {
      if (learningStageHides(n, learningStage)) return { ...n, hidden: true };
      const kind = flowNodeBlockKind(n);
      return kind && entering.has(kind) ? { ...n, className: `${n.className ?? ""} studio-learn-enter`.trim() } : n;
    }) : rfNodes),
    [rfNodes, learningStage, entering],
  );
  // Each lesson moves the camera to the block it is about — the whole
  // stage when it names none — with the guide's room kept free beside it,
  // and the whole board comes back when the guide lets go. Freshly shown
  // nodes measure on their next paint, so the fit waits for them (briefly)
  // rather than framing a box of zeros. The column opening or closing
  // beside the board (the lesson's behaviour in the inspector, the
  // assistant) changes what "beside" is, so the frame is taken again.
  const learningStageKey = learningStage ? learningStage.join(",") : null;
  const learningFocusKey = learningFocus ? learningFocus.join(",") : null;
  const hadLearningStage = useRef(false);
  /** The running lesson's own framing, for anything that changes the
   *  board's shape under it; null when no lesson is framing. */
  const refitLessonRef = useRef<((duration: number) => void) | null>(null);
  useEffect(() => {
    if (!learningStageKey && !hadLearningStage.current) return;
    // Between lessons, and on a lesson about the whole board, the guide is
    // still open: the camera stays where the last lesson left it and the
    // next one pans from there. Zooming out to the whole board and back in
    // at every lesson change was a large in-and-out that made people dizzy;
    // the board is handed back whole once, when the guide closes.
    if (!learningStageKey && inLesson) return;
    hadLearningStage.current = Boolean(learningStageKey);
    cancelInitialFit();
    // Whatever view the board saved to go back to (a block the learner
    // clicked into before) belongs to before this lesson: the lesson frames
    // its own, and the board handed back after it is framed whole.
    overviewViewport.current = null;
    setFocusedBlock(null);
    if (focusTimer.current) clearTimeout(focusTimer.current);
    cancelObjectCenter.current();
    let frame = 0;
    let cancelled = false;
    const focusKinds = learningFocusKey ? new Set(learningFocusKey.split(",")) : null;
    const framed = () => {
      const shown = flowViewportRef.current.getNodes().filter((n) => !n.hidden);
      const focused = focusKinds ? shown.filter((n) => { const kind = flowNodeBlockKind(n); return kind !== null && focusKinds.has(kind); }) : [];
      return { shown, only: learningStageKey ? new Set((focused.length ? focused : shown).map((n) => n.id)) : undefined };
    };
    const fit = (duration: number) => {
      if (viewLockedRef.current) return;
      const { only } = framed();
      // A lesson's block must be on screen whole. The board handed back when
      // the guide closes opens the way a card opens — at reading size, from
      // its top; framed whole, as the Fit button frames it, a new author's
      // first board after the lessons was text of five or six pixels.
      void (only ? frameLesson(only, duration) : fitEntranceRef.current ? fitEntranceRef.current() : fitBetweenDocks(duration, true));
    };
    refitLessonRef.current = learningStageKey ? fit : null;
    const deadline = performance.now() + 1200;
    // The framed blocks change shape in the lesson's first moments — the
    // sample entry opens on its row, the tile takes a new width for it —
    // so the frame follows them for a while. After that the camera is the
    // learner's: typing into the entry grows the block, and a board that
    // re-framed itself under every keystroke would be unusable.
    const settleUntil = performance.now() + 2500;
    const signature = () => {
      const flow = flowViewportRef.current;
      const { only } = framed();
      return flow.getNodes().filter((n) => !n.hidden && (!only || only.has(n.id))).map((n) => {
        const at = flow.getInternalNode(n.id)?.internals.positionAbsolute;
        return `${n.id}:${n.measured?.width}:${n.measured?.height}:${at?.x}:${at?.y}`;
      }).join("|");
    };
    let framedAs = "";
    const settle = () => {
      if (cancelled || performance.now() > settleUntil) return;
      const next = signature();
      if (next !== framedAs) { framedAs = next; fit(250); }
      frame = requestAnimationFrame(settle);
    };
    const attempt = () => {
      if (cancelled) return;
      const { shown } = framed();
      const measured = shown.length > 0 && shown.every((n) => n.measured?.width && n.measured?.height);
      if (!measured && performance.now() < deadline) { frame = requestAnimationFrame(attempt); return; }
      framedAs = signature();
      fit(learningStageKey ? 350 : 600);
      if (learningStageKey) frame = requestAnimationFrame(settle);
    };
    frame = requestAnimationFrame(attempt);
    let width = containerRef.current?.getBoundingClientRect().width ?? 0;
    const observer = learningStageKey && containerRef.current && typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
      const next = containerRef.current?.getBoundingClientRect().width ?? 0;
      if (Math.abs(next - width) < 1) return;
      width = next;
      fit(250);
    }) : null;
    if (observer && containerRef.current) observer.observe(containerRef.current);
    return () => { cancelled = true; cancelAnimationFrame(frame); observer?.disconnect(); refitLessonRef.current = null; };
  }, [learningStageKey, learningFocusKey, inLesson, cancelInitialFit, fitBetweenDocks, frameLesson]);

  /** Folding changes a block's height, so the formation has to settle again —
   *  otherwise unfolding twenty entries buries the block below. Deferred a
   *  beat so the new rows are in `blocks` before it measures. */
  const reflowIfSystemOwned = useCallback(() => {
    const epoch = fitViewEpoch.current.value;
    window.setTimeout(() => {
      if (epoch === fitViewEpoch.current.value) setPositions(buildFormation());
    }, 40);
  }, [buildFormation]);

  const toggleBlockCollapse = useCallback(
    (blockNodeId: string) => {
      const next = new Set(collapsedSet);
      const on = !next.has(blockNodeId);
      if (on) next.add(blockNodeId);
      else next.delete(blockNodeId);
      setCollapsedSet(next);
      if (!useEditorStore.getState().readOnlyInspect) {
        // Only the flag. A coordinate on a block would read as a pin, and a
        // block's place is the formation's to decide.
        const layout = useEditorStore.getState().worldDraft.graphLayout;
        const cur: GraphLayout["nodes"] = layout?.version === GRAPH_LAYOUT_VERSION ? { ...layout.nodes } : {};
        const base = cur[blockNodeId] ?? { x: 0, y: 0 };
        cur[blockNodeId] = { ...base, collapsed: on ? true : undefined };
        setGraphLayout({ version: GRAPH_LAYOUT_VERSION, nodes: cur, notes: currentNotes() });
      }
      reflowIfSystemOwned();
    },
    [collapsedSet, setGraphLayout, currentNotes, reflowIfSystemOwned],
  );

  const expandBlockRows = useCallback(
    (blockNodeId: string) => {
      setExpandedBlocks((prev) => new Set([...prev, resolveSourceBlockId(blockNodeId, blocksRef.current)]));
      reflowIfSystemOwned();
    },
    [reflowIfSystemOwned],
  );

  /** Show an opening's whole text rather than its first lines. */
  const toggleOpeningText = useCallback(
    (blockNodeId: string) => {
      setOpenedTexts((prev) => {
        const next = new Set(prev);
        if (next.has(blockNodeId)) next.delete(blockNodeId);
        else next.add(blockNodeId);
        return next;
      });
      reflowIfSystemOwned();
    },
    [reflowIfSystemOwned],
  );


  /** Handlers a block head needs but that are declared further down (they
   *  depend on the add/menu machinery). Held in a ref so the build effect
   *  doesn't have to list them — and doesn't rerun when they change. */
  const blockActionsRef = useRef<{
    onAdd: (block: Block, anchor?: DOMRect) => void;
    addOpening: () => void;
    addSetting: () => void;
    onRowContextMenu: (objId: string, e: React.MouseEvent, ownerId?: string) => void;
    onRowDrop: (dragged: string, target: string) => void;
  }>({ onAdd: () => {}, addOpening: () => {}, addSetting: () => {}, onRowContextMenu: () => {}, onRowDrop: () => {} });

  // Carry the object and its scope into the full editor; opening only the
  // section used to select whichever item that editor happened to show first.
  /** One click picks a row; a click on the row already picked opens it in
   *  place — a beat later, so the second click of a double-click (which
   *  opens the full page instead) never gets to move the board first. */
  const expandTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clickRow = useCallback((objId: string) => {
    pickedByClickRef.current = objId;
    setMultiSelected(EMPTY_MULTI);
    if (expandTimer.current) { clearTimeout(expandTimer.current); expandTimer.current = null; }
    const picked = selectionRef.current?.type === "node" && selectionRef.current.id === objId;
    if (!canEditRowInline(objId)) { setSelection({ type: "node", id: objId }); return; }
    // A lesson says "click the row to write in it", and waits for it to open.
    if (learningStageRef.current) { pressInlineRow(objId); return; }
    if (picked) { expandTimer.current = setTimeout(() => { expandTimer.current = null; pressInlineRow(objId); }, 280); return; }
    selectOnlyRef.current = objId;
    // Writing one row and clicking the next: that is "write this one now".
    // It opens a beat later in place of the other, which stays open until
    // then: shutting it first slid the clicked row up from under the
    // pointer, and the second click opened whatever had moved there.
    const writing = openRowIdRef.current !== null && openRowIdRef.current !== objId;
    if (writing) keepOpenRowRef.current = true;
    setSelection({ type: "node", id: objId });
    if (writing) expandTimer.current = setTimeout(() => { expandTimer.current = null; setOpenRowId(objId); }, 280);
  }, [pressInlineRow]);
  const drillObject = useCallback((objId: string) => {
    if (expandTimer.current) { clearTimeout(expandTimer.current); expandTimer.current = null; }
    const g = graphById.get(objId);
    const drill = g && drillPanelFor(g, interfaceIsHandwritten);
    if (!g || !drill) return;
    const store = useEditorStore.getState();
    const id = objId.slice(objId.indexOf(":") + 1);
    const worldbookId = g.parentId?.startsWith("module:") ? g.parentId.slice("module:".length) : undefined;
    if (g.kind === "variable") store.focusObject("variable", id, worldbookId);
    else if (g.kind === "module") store.focusObject("module", id);
    else if (objId.startsWith("reaction:")) store.focusObject("reaction", id, worldbookId);
    else if (objId.startsWith("entry:")) store.focusObject("entry", id, worldbookId);
    else if (g.kind === "greeting") store.focusObject("greeting", id, worldbookId);
    else if (g.kind === "audio") store.focusObject("audio", id);
    else if (g.kind === "image") store.focusObject("sceneImage", id);
    else if (objId === "core-entries") store.setModuleScope("core");
    else if (objId.startsWith("module-entries:")) store.setModuleScope(`mod:${id}`);
    onDrillPanel(drill.panelId);
  }, [graphById, onDrillPanel, interfaceIsHandwritten]);
  /** For the frames, built in an effect that should not re-run on it. */
  const drillObjectRef = useRef(drillObject);
  drillObjectRef.current = drillObject;

  const onRowClick = useCallback((objId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if ((e.shiftKey || e.ctrlKey || e.metaKey) && !isBlockId(objId) && isDeletableObject(objId)) {
      toggleMulti(objId, selectionRef.current?.type === "node" ? selectionRef.current.id : null);
      return;
    }
    clickRow(objId);
  }, [toggleMulti, clickRow]);

  const onRowDoubleClick = drillObject;

  /** What the turn that just ran actually used.
   *
   *  Read off the server's own report rather than re-derived here: the engine
   *  can say which entries COULD fire, never which did — that depends on the
   *  words the player typed. Null when nothing has run yet or the server did
   *  not report, and null must NOT dim anything: an unlit board that simply
   *  has no data would read as a card where nothing works. */
  const lastTurn = useMemo(() => {
    if (!liveGating) return null;
    for (let i = runtimeRecords.length - 1; i >= 0; i -= 1) {
      const rec = runtimeRecords[i]!;
      if (rec.kind === "restore") continue;
      if (!rec.injectedEntryIds && !rec.firedIds) continue;
      return {
        entries: rec.injectedEntryIds ? new Set(rec.injectedEntryIds) : null,
        behaviors: rec.firedIds ? new Set(rec.firedIds) : null,
      };
    }
    return null;
  }, [runtimeRecords, liveGating]);

  /** Who moved each value on that turn, and how far each behavior still is —
   *  the playtest's "this turn" column, condensed to one tag per row. */
  const lastWhy = useMemo(() => lastTurnWhy(worldDraft, runtimeRecords), [runtimeRecords, worldDraft]);

  // -- Build the flow --
  useEffect(() => {
    if (!positions) return;

    /** The live readout for one object: the value the running session holds,
     *  whether it just changed, and whether its gate is open right now. */
    /** Did this object take part in the turn that just ran? */
    const ranThisTurn = (g: GraphNode): "used" | "idle" | undefined => {
      if (!lastTurn) return undefined;
      const objId = g.id.slice(g.id.indexOf(":") + 1);
      if (g.kind === "entry" && lastTurn.entries) return lastTurn.entries.has(objId) ? "used" : "idle";
      if (g.kind === "rule" && lastTurn.behaviors) return lastTurn.behaviors.has(objId) ? "used" : "idle";
      return undefined;
    };

    const liveFor = (g: GraphNode): BlockRowView["live"] => {
      const objId = g.id.slice(g.id.indexOf(":") + 1);
      // After the playtest closes, the rows keep what its last turn said.
      if (!liveGating) {
        const why = g.kind === "variable" ? lastWhy?.vars.get(objId) : undefined;
        if (why) return { why };
        if (g.kind === "rule" && lastWhy?.rules.has(objId)) return { value: lastWhy.rules.get(objId) };
        return undefined;
      }
      if (g.kind === "variable") {
        const value = liveVars[objId];
        if (value === undefined) return undefined;
        const text = typeof value === "string" ? value : JSON.stringify(value);
        const why = lastWhy?.vars.get(objId);
        return { value: text.length > 18 ? text.slice(0, 18) + "…" : text, delta: recentChanges[objId], ...(why ? { why } : {}) };
      }
      if (g.kind === "rule" && lastWhy?.rules.has(objId)) return { value: lastWhy.rules.get(objId) };
      if (g.kind === "entry" && liveGating.entryGate.has(objId)) {
        return { active: liveGating.entryGate.get(objId) };
      }
      return undefined;
    };

    const rowView = (g: GraphNode, slots: BlockRowView["slots"], shared = false): BlockRowView => {
      // A shared row is the card's, drawn inside a module. It wears no
      // module's colour, because it belongs to every one of them.
      const gateIdx = g.parentId && !shared ? gateIndex.get(g.parentId) : undefined;
      return {
        g,
        ...(shared ? { shared: true } : {}),
        title: displayTitle(g),
        preview: previewFor(g),
        varType:
          g.kind === "variable"
            ? draftById.variables.get(g.id.slice(g.id.indexOf(":") + 1))?.type
            : undefined,
        ...rowFactsFor(g),
        // Slot ports are addressed individually; every other inbound port
        // aggregates onto the row's single in-handle.
        hasIn: g.ports.some((p) => p.direction === "in" && !p.id.startsWith("slot:")),
        hasOut: g.ports.some((p) => p.direction === "out"),
        slots,
        tint: gateIdx === undefined ? undefined : gateTint(gateIdx),
        moduleTitle: g.parentId && !shared ? graphById.get(g.parentId)?.title : undefined,
        live: liveFor(g),
        turn: turnMark.get(g.id),
        recent: recentIds.has(g.id),
        disabled: g.data.disabled === true,
        readByUi: g.data.readByUi === true,
        deadRead: g.data.uiReadNeverWritten === true,
        count: typeof g.data.count === "number" ? g.data.count : undefined,
        cost: budget.rows.get(g.id),
        links: linkCounts.get(g.id),
        firedBy: firedBy.get(g.id),
        ...(ranThisTurn(g) ? { ranThisTurn: ranThisTurn(g) } : {}),
      };
    };

    /** The line under a block's title. Gone: token costs, counts and "reads
     *  no variables" were numbers nobody acted on, and every one of them
     *  made a block look like it needed attention. One stays: a place where
     *  several AIs answer is a group chat, and says so. */
    const subtitleFor = (block: Block): string | undefined => {
      // Context's head carries the one line that says what the block is —
      // everything the AI here reads each turn — since its rows alone do not.
      if (block.kind === "context") return String(t("blueprint.blocks.contextHint"));
      if (block.kind !== "ais") return undefined;
      // The rows are right below; the head only says when they take turns.
      return placeAisByOwner.get(block.ownerId ?? "")?.group ? String(t("blueprint.placeAis.group")) : undefined;
    };

    const titleFor = (block: Block): string => {
      // NOT the card's name. A block's title says what the block is, and the
      // card block was the one that said what the card is called — a name
      // floating above the tile with nothing to say it was where the cover
      // lives. The name is edited in the body now.
      if (block.kind === "opening") return block.head ? displayTitle(block.head) : t("blueprint.blocks.opening");
      if (block.kind === "lore") return storyBoard && block.trigger === "always" ? t("blueprint.starter.settingTitle") : t(("blueprint.blocks.lore." + (block.trigger ?? "manual")) as never);
      if (block.kind === "frontend" && defaultChat) return t("blueprint.starter.playerInterface");
      return t(("blueprint.blocks." + block.kind) as never);
    };

    const nodes: BlueprintNode[] = [];

    // Behind everything: the outline of each group of situations, titled with
    // how the player gets into them.
    for (const group of situationGroupsRef.current) {
      nodes.push({
        id: group.id,
        type: "situationGroup",
        position: { x: group.x, y: group.y },
        data: { title: t(`blueprint.situationGroups.${group.way}` as never), count: group.count, width: group.width, height: group.height } as never,
        draggable: false,
        selectable: false,
        focusable: false,
        zIndex: -1,
      });
    }
    // A situation's colour says which memory it keeps: every dungeon that
    // only remembers itself shares one, a named pool has its own.
    const books = situationBooks(worldDraft.worldbooks);
    const poolTint = poolColours(books);
    const tintFor = (ownerId: string | null | undefined, idx: number) => {
      const book = ownerId ? books.find((b) => b.id === ownerId) : undefined;
      if (book?.station?.kind === "worker") return "#9a948a";
      if (book?.station?.kind === "narrator") return poolTint.get(memoryOf(book)) ?? gateTint(idx);
      return gateTint(idx);
    };

    // The card's strip is never shut — there is no bar to fold it into.
    const openNow = new Set(openFrames);
    for (const f of frames) if (f.strip) openNow.add(f.id);
    const cardStrip = frames.some((f) => f.strip);

    // Frames first. React Flow resolves a child against a parent that is
    // already in the array; a child listed before its parent is dropped.
    for (const frame of frames) {
      const box = frameBoxes.get(frame.id);
      const open = openNow.has(frame.id);
      const g = frame.module ?? undefined;
      const idx = g ? (gateIndex.get(g.id) ?? 0) : 0;
      const bookId = frame.ownerId ?? "";
      const data: GateNodeData = {
        ...(g ? { g } : {}),
        frame: {
          width: box?.width ?? 236,
          height: box?.height ?? 46,
          open,
          total: frame.total,
          own: frame.own,
          shared: frame.shared,
          strip: frame.strip,
          sole: frames.length === 1,
          // Shut, a tile says what it holds as four counts.
          counts: shelfCounts.get(frame.ownerId ?? "") ?? EMPTY_SHELVES,
          onToggle: () => toggleFrame(frame.id),
          onFocus: g ? () => focusModuleRef.current(frame.id) : undefined,
          drillId: g ? g.id : "world:root",
          onOpenPage: () => drillObjectRef.current(g ? g.id : "world:root"),
          dropping: dropFrameId === frame.id,
          dropLabel: dropFrameId === frame.id ? dropLabelFor(frame.ownerId, g?.title ?? "") : undefined,
          // `overlapping` is NOT set here: it changes on every mouse move of
          // a drag, and rebuilding the nodes mid-drag puts the dragged frame
          // back at its formation position between two pointer events —
          // which is a frame flickering between two places. The effect
          // below patches just the frames whose overlap state changed.
          onDragOver: dragOverFrame(frame.id),
          onDragLeave: () => {
            setDropFrameId(null);
            setPiece((prev) => (prev?.over === frame.id ? { ...prev, over: null } : prev));
          },
          onDrop: dropOnFrame(frame.id, frame.ownerId),
          // Every frame shows the shelves it is made of, so a brand-new module
          // is a place to put things rather than a blank box — and so adding
          // an opening, an entry, a variable or a behaviour to the CARD is a
          // thing you do where it will land, not a menu at the top of the
          // screen that never says which frame it means.
          // The card gets openings too; a module cannot have its own opening.
          // The strip has no shelves: its lore, state and behaviours are in
          // the modules, and an opening is added from the card's own block.
          ...(readOnly || frame.strip
            ? {}
            : {
                shelves: (frame.ownerId
                  ? (["lore", "state", "behavior"] as const)
                  : (["opening", "lore", "state", "behavior"] as const)
                ).map((kind) => ({
                  kind,
                  count: (shelfCounts.get(frame.ownerId ?? "") ?? EMPTY_SHELVES)[kind],
                  onAdd: () => addInto(kind, frame.ownerId ?? undefined),
                })),
              }),
        },
        // Only the card's own frame: a module is a part of a card, and parts
        // are not the thing that gets published.
        ...(g ? {} : { readiness: cardProgress }),
        title: g ? displayTitle(g) : t("blueprint.frame.cardFrame"),
        // The card's own frame is deliberately colourless: it is not one of
        // the modules, it is what the modules sit beside.
        tint: g ? tintFor(frame.ownerId, idx) : "#8b8b96",
        ...(g ? { activationLabel: activationLabelFor(frame.ownerId) } : {}),
        // The title says only what the place is and when it is on: who
        // answers there is the 「AI」 block at its foot.
        aiLit: litFrames?.has(frame.id) ?? false,
        ...(g && typeof g.data.note === "string" ? { note: g.data.note } : {}),
        ...(g && liveGating ? { live: { active: liveGating.activeBooks.has(bookId) } } : {}),
        ...(g && turnMark.get(g.id) ? { turn: turnMark.get(g.id) } : {}),
        recent: g ? recentIds.has(g.id) : false,
        dimmed: Boolean(focusIds) && !!g && !focusIds!.has(g.id),
      };
      nodes.push({
        id: frame.id,
        type: "gate",
        // A situation stands where its group put it (a dragged one is left
        // where it was dragged — the grouping skips pinned frames).
        position: frame.ownerId && box && situationGroupsRef.current.length ? { x: box.x, y: box.y } : positions[frame.id] ?? { x: 0, y: 0 },
        data,
        selected: selection?.type === "node" && !!g && selection.id === g.id,
        draggable: !readOnly,
        ...(g && g.data.note && !open ? { zIndex: 1 } : {}),
      });
    }

    for (const block of storyBoard ? [...blocks].sort((a, b) => {
      const rank = (value: Block) => value.kind === "opening" ? 0 : value.kind === "lore" ? 1 : value.kind === "state" ? 2 : value.kind === "behavior" ? 3 : 4;
      return rank(a) - rank(b);
    }) : blocks) {
      // A shut frame renders none of its contents: that is what shut means,
      // and rendering them invisibly would still cost React Flow the nodes.
      // A loose block is in no frame and always shows.
      const frameId = block.ownerId ? blockId.frame(block.ownerId) : blockId.frame(null);
      // The card's letterhead belongs to the card, not to a frame: it is laid
      // out above the card's tile in board coordinates and drawn whether or
      // not that tile is open. Everything else lives in a frame and goes with
      // it.
      const isFace = block.kind === "card" || block.kind === "background" || (block.kind === "frontend" && !block.ownerId);
      if (!block.loose && !isFace && !openNow.has(frameId)) continue;
      // The card's openings are alternatives with one switch between them, so
      // only the one in hand is on the board. The others have no box in the
      // tile and would otherwise be drawn at the board's origin.
      if (block.kind === "opening" && !block.ownerId && block.head
        && !frameBoxes.get(frameId)?.blocks[block.id]) continue;
      const laid = frameBoxes.get(frameId)?.blocks[block.id];
      // The letterhead is in no frame, so its box is filed under its own id.
      // Without this it fell back to BLOCK_W and came out as two 300px
      // squares above a 1160px tile instead of spanning it.
      const ownBox = isFace ? frameBoxes.get(block.id) : undefined;
      if (isWritingBlock(block)) {
        const kind = block.kind === "opening" ? "opening" : "setting";
        const entries = writingEntriesFor(block);
        const data: CanvasWritingNodeData = {
          kind, entries, readOnly, compact: glance, ownerId: block.ownerId, shared: block.sharedCount, total: block.total - block.sharedCount,
          width: laid?.w, flush: !!laid && !block.loose, fillHeight: laid?.h,
          onPieceDrag, onPieceSelect,
          folders: entryFolders, onSelectFolder: selectPieces, presetsTitle, collapsedFolders, onToggleFolder: toggleFolder,
          multiSelected: multiSelected.size > 0 ? multiSelected : null,
          columns: kind === "opening" ? 1 : rowColumns(entries.length, laid?.w ?? BLOCK_W), hiddenCount: block.hiddenCount,
          ...(kind === "opening" && !block.ownerId
            ? {
                openings: cardOpenings.map((g) => ({ id: g.id, selected: g.id === previewGreetingId, title: g.name || t("blueprint.starter.openingTitle") })),
                onPickOpening: selectPreviewOpening,
              }
            : {}),
          onMore: () => { setRelationshipId(null); setSelection({ type: "node", id: resolveSourceBlockId(block.id, blocksRef.current) }); },
          // Inside an AI, its settings are who it is: only it reads them.
          title: kind === "setting" && block.ownerId && aiFrameIds.has(blockId.frame(block.ownerId)) ? t("blueprint.aiForm.self") : block.total > 0 ? titleFor(block) : t(`blueprint.starter.${kind}Title`),
          rows: block.head ? [rowView(block.head, block.headSlots)] : block.rows.map(row => rowView(row.g, row.slots, row.shared === true)),
          selectedId: selection?.type === "node" ? selection.id : null,
          documentKey: blueprintDocumentKey,
          onOpen: (id: string) => { preferredWritingHosts.current.set(id, block.id); setRelationshipId(null); clickRow(id); },
          // A row you click is a row you can see: it only notes which block
          // holds it. Moving the board on every click (a wide block was always
          // "out of view") made picking two rows a chase.
          onEngage: (id: string) => { preferredWritingHosts.current.set(id, block.id); },
          expandedIds: openRowIds,
          onToggleExpand: (id: string) => { preferredWritingHosts.current.set(id, block.id); toggleOpenRow(id); },
          onToggleMulti: (id: string) => toggleMulti(id, selectionRef.current?.type === "node" ? selectionRef.current.id : null),
          onRename: (id: string, name: string) => useEditorStore.getState().updateEntry(id, { name }),
          renderEditor: (id: string) => <BlueprintRowEditor objectId={id} onDrill={onDrillPanel} readOnly={readOnly} />,
          onHoverObject: setHoveredRowId,
          onFocusEntry: id => {
            preferredWritingHosts.current.set(`${kind === "opening" ? "greeting" : "entry"}:${id}`, block.id);
            if (kind === "opening") selectPreviewOpening(id);
          },
          onRowContextMenu: (id, event) => { preferredWritingHosts.current.set(id, block.id); blockActionsRef.current.onRowContextMenu(id, event, block.ownerId); },
          onRowDrop: readOnly ? undefined : (dragged, target) => blockActionsRef.current.onRowDrop(dragged, target),
          // Blocks cover most of their frame and are not inside it in the
          // DOM, so a drop on one is handed to the frame it stands in.
          ...(readOnly || block.loose ? {} : { dropIn: { over: dragOverFrame(frameId), drop: dropOnFrame(frameId, block.ownerId ?? null) } }),
          ...(block.loose ? { loose: { onShareAll: () => unloose(block.rows[0]?.g.id ?? "") } } : {}),
          onAdd: readOnly ? undefined : () => {
            blockActionsRef.current.onAdd(block);
            const created = useEditorStore.getState().worldDraft.entries.at(-1);
            if (created) preferredWritingHosts.current.set(`${kind === "opening" ? "greeting" : "entry"}:${created.id}`, block.id);
          },
        };
        nodes.push({ id: block.id, type: "writing", ...(block.loose ? {} : { parentId: frameId }),
          position: block.loose ? loosePlaced[block.rows[0]?.g.id ?? ""] ?? { x: 0, y: 0 } : frameBoxes.get(frameId)?.blocks[block.id] ?? { x: 0, y: 0 },
          data, zIndex: 2000, draggable: !readOnly, selectable: false, deletable: false,
        });
        continue;
      }
      const collapsed = blockCollapsed(collapsedSet, block.id);
      const addLabel = addLabelFor(block);

      const data: BlockNodeData = {
        block,
        title: titleFor(block),
        subtitle: subtitleFor(block),
        // A block that IS an object renders that object's own row data, so the
        // head carries its handles, its turn mark and its live readout.
        rows: block.head
          ? [rowView(block.head, block.headSlots)]
          : block.rows.map((r) => rowView(r.g, r.slots, r.shared === true)),
        collapsed,
        expanded: openedTexts.has(block.id),
        hiddenCount: block.hiddenCount,
        // An empty block on the card's own board says what the thing is FOR —
        // "还没有变量" tells someone who has never made one nothing at all.
        // Inside a module, where the creator has plainly found the feature,
        // the short form is the right one.
        width: ownBox?.width ?? laid?.w, flush: !!laid && !block.loose, fillHeight: laid?.h,
        // A piece's top edge is a seam unless it is the first row, and its
        // left edge is one only when it shares the row with another piece.
        seamTop: !!laid && laid.y > headerHFor(blockId.frame(block.ownerId ?? null)), seamLeft: !!laid && laid.x > 0,
        ownerId: block.ownerId ?? null, onPieceDrag, onPieceSelect,
        onMore: () => { setRelationshipId(null); setSelection({ type: "node", id: block.id }); },
        tools: blockTools(block),
        // The two blocks where a new creator stalls get a second door: the "+"
        // opens a blank form, this opens a working example they can read.
        onOpenPacks: hasPackDoor(block) ? () => openPanel("packs") : undefined,
        // Every block the assistant has a tool for gets the second way in.
        // The "+" opens a blank row; this opens a sentence.
        ...(ASKABLE.has(block.kind) && !block.loose
          ? { onAsk: () => { openPanel("ai-chat"); askForBlock(String(t(blockAskKey(block.kind as AskableBlockKind, block.total === 0) as never))); } }
          : {}),
        emptyLabel:
          // A module with nothing of its own in this block but the card's
          // objects counted into it says so, rather than "none yet".
          block.ownerId && block.sharedCount > 0 && block.rows.length === 0
            ? t("blueprint.writing.sharedOnly", { count: block.sharedCount })
          : !block.ownerId && (block.kind === "state" || block.kind === "behavior")
            ? t(("blueprint.addPurpose." + (block.kind === "state" ? "variable" : "behavior")) as never)
          : block.kind === "lore" ||
            block.kind === "state" ||
            block.kind === "behavior" ||
            block.kind === "audio" ||
            block.kind === "image" ||
            (block.kind === "opening" && !block.head)
            ? t(("blueprint.blocks.empty." + block.kind) as never)
            : "",
        // On the card's own board, the shelves that are only there to be found
        // — an empty variables or behaviours block, a screen nobody has built
        // — draw in neutral, so the blocks the author WRITES in are where the
        // eye lands on a new card.
        //
        // The memory used to be in here too. It is not a shelf waiting to be
        // filled: every card has one, it is always saying something, and what
        // it says is the most expensive decision on the card. It gets its own
        // colour like everything else that is always there.
        // An empty variables or behaviours shelf keeps its own colour, turned
        // down — see BLOCK_FAINT. It used to be in `quiet` with the rest, and
        // the two shelves a card gets its mechanics from were grey until the
        // first row landed and then suddenly blue and orange.
        faint: block.total === 0 && (block.kind === "state" || block.kind === "behavior"),
        // The stock chat is what a card has before anyone builds a screen for
        // it. Announced in the frontend's own red, an interface nobody has
        // made yet was the loudest thing on a board full of things to write.
        quiet: !block.ownerId && block.kind === "frontend" && defaultChat,
        addLabel: readOnly ? undefined : addLabel,
        selectedId: selection?.type === "node" ? selection.id : null,
        multiSelected: multiSelected.size > 0 ? multiSelected : null,
        focusIds,
        readOnly,
        glance,
        ...((block as CanvasBlock).tray ? { tray: { items: (block as CanvasBlock).tray!, onPick: pickTrayItem } } : {}),
        ...(block.kind === "context" ? { context: { rows: contextRowsFor(block) } } : {}),
        ...(block.kind === "ais" && placeAisByOwner.get(block.ownerId ?? "")
          ? {
              ais: {
                ...placeAisByOwner.get(block.ownerId ?? "")!,
                // A row opens in the column, like every object on the board:
                // an AI on its settings, the card's own AI on its judge. The
                // open one is lit the way a selected row is.
                openKey: selection?.type === "node"
                  ? placeAisByOwner.get(block.ownerId ?? "")!.rows.find((r) => aiInspectorId(r.bookId ?? undefined) === selection.id)?.key ?? null
                  : null,
                onToggle: (_key: string, _memory?: boolean, bookId?: string) => setSelection({ type: "node", id: aiInspectorId(bookId) }),
                ...(readOnly ? {} : { onRemove: (bookId: string) => removeAi(bookId), onNote: () => addNoteOnRef.current(block.id) }),
                ...(readOnly || !block.ownerId
                  ? {}
                  : { onKeepNarrator: (keep: boolean) => useEditorStore.getState().updateWorldbook(block.ownerId!, { narratorHere: keep || undefined }) }),
              },
            }
          : {}),
        onCommitVariableValue: block.kind === "state" && !readOnly ? commitVariableValue : undefined,
        onFocusEdit: readOnly ? undefined : focusEditRef.current,
        onToggleCollapse: () => toggleBlockCollapse(block.id),
        onToggleExpand: () => toggleOpeningText(block.id),
        // The second way into a row's object, beside the click that opens the
        // drawer. Only for the kinds that have a form; an audio track's row
        // would show a chevron onto an empty box.
        expandedIds: openRowIds,
        onToggleRowExpand: toggleOpenRow,
        canExpandRow: canEditRowInline,
        renderEditor: (id: string) => <BlueprintRowEditor objectId={id} onDrill={onDrillPanel} readOnly={readOnly} />,
        onExpandRows: () => expandBlockRows(block.id),
        onAdd: readOnly || !addLabel ? undefined : (anchor?: DOMRect) => blockActionsRef.current.onAdd(block, anchor),
        onRowClick,
        onRowHover: setHoveredRowId,
        onRowDoubleClick,
        onRowContextMenu: (objId, e) => blockActionsRef.current.onRowContextMenu(objId, e, block.ownerId),
        onRowDrop: readOnly ? undefined : (dragged, target) => blockActionsRef.current.onRowDrop(dragged, target),
        ...(readOnly || block.loose ? {} : { dropIn: { over: dragOverFrame(frameId), drop: dropOnFrame(frameId, block.ownerId ?? null) } }),
      };

      if (block.kind === "background") {
        const list = worldDraft.backgrounds ?? [];
        const active = list.find((b) => b.isDefault) ?? list[0];
        const coverUrl = typeof block.head?.data.coverUrl === "string" ? block.head.data.coverUrl : undefined;
        // `@cover` is a sentinel the renderer resolves at play time; on the
        // board there is no renderer, so resolve it here or the strip shows
        // a broken image on the most common background there is.
        const raw = active?.url === COVER_BACKGROUND_URL ? coverUrl : active?.url;
        data.background = {
          url: (raw ? absoluteImageUrl(raw) : undefined) ?? undefined,
          blur: active?.blur ?? DEFAULT_BACKGROUND_BLUR,
          dim: active?.dim ?? DEFAULT_BACKGROUND_DIM,
          opacity: active?.opacity ?? DEFAULT_BACKGROUND_OPACITY,
          count: list.length,
          canUseCover: Boolean(coverUrl),
          onUseCover: () => {
            useEditorStore.getState().addBackground(COVER_BACKGROUND_URL);
            onDrillPanel("backgrounds");
          },
          onOpen: () => onDrillPanel("backgrounds"),
        };
      } else if (block.kind === "card") {
        data.card = {
          compact: chromeFor(block).compactCard,
          name: worldDraft.name ?? "",
          description: worldDraft.description ?? "",
          coverUrl: typeof block.head?.data.coverUrl === "string" ? block.head.data.coverUrl : undefined,
          onCommitName: (v: string) => useEditorStore.getState().setField("name", v),
          onCommitDescription: (v: string) => useEditorStore.getState().setField("description", v),
          // The cover, 卡片信息 and 设置 all open the card in the column,
          // which carries the whole 概览 now — no detour off the canvas.
          onOpenCover: () => { setRelationshipId(null); setSelection({ type: "node", id: "world:root" }); },
          onOpenAssets: () => onDrillPanel("assets"),
          onOpenOverview: () => { setRelationshipId(null); setSelection({ type: "node", id: "world:root" }); },
          onOpenSettings: () => { setRelationshipId(null); setSelection({ type: "node", id: "world:root" }); },
          // A secondary variant's name and blurb are its primary's.
          locked: useEditorStore.getState().variants.find((v) => v.id === useEditorStore.getState().serverWorldId)?.isPrimaryVariant === false,
          // With the card's shelves gone (it is a strip), adding an opening
          // moves onto the card's own block — the one thing only it can hold.
          ...(readOnly || !cardStrip ? {} : { onAddOpening: () => blockActionsRef.current.addOpening() }),
        };
      } else if (block.kind === "opening" && block.head) {
        const entryId = String(block.head.data.entryId ?? "");
        const content = draftById.entries.get(entryId)?.content?.trim() ?? "";
        const headId = block.head.id;
        data.opening = {
          entryId,
          // Rendered the way the player will read it, through the same
          // markdown pipeline the chat uses (DOMPurify-sanitised).
          html: content ? renderOpening(content) : "",
          empty: content.length === 0,
          raw: draftById.entries.get(entryId)?.content ?? "",
          onCommitName: (v: string) => useEditorStore.getState().updateEntry(entryId, { name: v }),
          onCommitContent: (v: string) => useEditorStore.getState().updateEntry(entryId, { content: v }),
          seedCount: graph.edges.filter((e) => e.from === headId && e.fromPort === "seeds").length,
        };
      } else if (block.kind === "frontend") {
        data.frontend = {
          defaultChat,
          thin: (defaultChat && !anyOpeningWritten) || screenFolded,
          ...(defaultChat && !anyOpeningWritten ? {} : { folded: screenFolded, onToggleFold: toggleScreenFold }),
          emptyOpening: !previewGreeting?.content.trim(),
          ...(readOnly || !previewGreeting ? {} : { openingId: previewGreeting.id }),
          openingPicker: <OpeningPreviewPicker entries={worldDraft.entries} selectedId={previewGreetingId} onSelect={selectPreviewOpening} />,
          openingCount: worldDraft.entries.filter((e) => e.role === "greeting").length,
          // Into the player-screen page; a card with no pages yet lands in
          // the template gallery, since choosing one is all there is to do.
          ...(readOnly ? {} : { onEdit: () => {
            if (!(worldDraft.uiDoc?.pages ?? []).some((page) => page.elements.length > 0)) requestUiEditor({ gallery: true });
            onDrillPanel("frontend");
          } }),
          // One live compile at a time: the full preview and a playtest each
          // mount the card's TSX, and two shadow roots means the card's own
          // side effects (audio unlock, timers) fire twice.
          render: previewOwnedElsewhere ? null : <LiveFrontendPreview greetingId={previewGreetingId} fitToFrame />,
          pausedLabel: t("blueprint.block.previewPaused"),
          readNames: [],
          dynamicReads: 0,
          device,
          onToggleDevice: toggleDevice,
        };
      } else if (block.kind === "scene" && block.ownerId) {
        const ownerId = block.ownerId;
        const book = (worldDraft.worldbooks ?? []).find((b) => b.id === ownerId);
        const file = book?.frontendFile;
        data.scene = {
          file,
          files: sceneFiles,
          bare: isBareScene(block),
          // Paused while the full preview dock or a playtest owns the
          // screen: those mount the card's TSX too, and the card's own side
          // effects (audio unlock, timers) must not fire from two places.
          render: previewOwnedElsewhere ? null : <LiveFrontendPreview greetingId={previewGreetingId} overrides={sceneOverrides.get(ownerId)} fitToFrame />,
          openingPicker: <OpeningPreviewPicker entries={worldDraft.entries} selectedId={previewGreetingId} onSelect={selectPreviewOpening} />,
          pausedLabel: t("blueprint.block.previewPaused"),
          device,
          onToggleDevice: toggleDevice,
          onPick: (next) => useEditorStore.getState().updateWorldbook(ownerId, { frontendFile: next }),
          onEdit: () => {
            if (!file) return;
            setPendingCodeJump(file, 1);
            onDrillPanel("code-view");
          },
        };
      }

      nodes.push({
        id: block.id,
        type: "block",
        // Contents belong to their module, so their coordinates are relative to
        // it and a frame carries them. Deliberately NOT `extent: "parent"`:
        // that clamps a child into the parent's MEASURED box, and a frame that
        // is momentarily unmeasured — mid-`setCenter`, or scrolled out of view
        // — measures as nothing, so every block in it got clamped onto the
        // frame's top-left corner and the board came back as one pile in the
        // corner. Constraining a drag was all it ever bought, and nothing on
        // this board is dragged any more.
        // A loose block is the exception: it is top-level, stands where the
        // creator put it, and IS dragged — into a module, or around.
        ...(block.loose
          ? {
              position: loosePlaced[block.rows[0]?.g.id ?? ""] ?? { x: 0, y: 0 },
              data: { ...data, loose: { onShareAll: () => unloose(block.rows[0]?.g.id ?? "") } },
              draggable: !readOnly,
            }
          : isFace
          ? {
              // The formation first, like the frames: the tile below it is
              // placed from `positions`, and a letterhead placed from the
              // layout memo alone drifted onto the tile whenever the
              // formation moved without the memo (the inspector opening,
              // for one).
              position: positions[block.id] ?? frameBoxes.get(block.id) ?? { x: 0, y: 0 },
              data,
              draggable: false,
            }
          : {
               parentId: frameId,
               // Use the same layout snapshot as the parent's dimensions.
               // Its width can change while a saved formation still has the
               // old child columns (for example after leaving the frontend).
               position: frameBoxes.get(frameId)?.blocks[block.id] ?? positions[block.id] ?? { x: 0, y: 0 },
              data,
              // Draggable so that grabbing a block drags its module (see
              // onNodesChange); the block's own movement is dropped, and
              // rows and controls carry `nodrag` so they keep their own
              // gestures.
              draggable: !readOnly,
            }),
        selected: block.kind === "context" && selection?.type === "node" && selection.id === block.id,
        selectable: false,
        deletable: false,
      });
    }

    // The reserved gap, drawn where the tile pass put it.
    const slotAt = piece?.over ? frameBoxes.get(piece.over)?.blocks[SLOT_ID] : undefined;
    if (piece?.over && slotAt) {
      nodes.push({
        id: SLOT_ID,
        type: "pieceSlot",
        parentId: piece.over,
        position: { x: slotAt.x, y: slotAt.y },
        data: { width: slotAt.w, fillHeight: slotAt.h },
        zIndex: 2500,
        draggable: false,
        selectable: false,
        deletable: false,
      });
    }

    setRfNodes(nodes);
    // liveGating/liveVars/recentChanges belong here: without them the flow is
    // built once and never repaints when the running session reports new
    // values -- the live readout would silently stay at the boot state.
  }, [
    blocks, gates, graph, positions, frameBoxes, collapsedSet, openedTexts, openRowIds, toggleOpenRow, selection, multiSelected, focusIds, firedBy,
    gateIndex, displayTitle, previewFor, graphById, draftById, t, readOnly, recentIds, turnMark,
    budget, linkCounts, liveGating, liveVars, recentChanges, lastTurn, lastWhy, onDrillPanel, toggleBlockCollapse, contextRowsFor, contextScopeFor, placeAisByOwner,
    toggleOpeningText, expandBlockRows, onRowClick, onRowDoubleClick, worldDraft.name,
    worldDraft.description, previewOwnedElsewhere, glance, pickTrayItem, activationLabelFor, roster, litFrames, lightSources, headerHFor, clickRow, toggleMulti, screenFolded, toggleScreenFold,
    defaultChat, storyBoard, worldDraft.entries, chromeFor, presetsTitle, collapsedFolders, toggleFolder, cardHasBackground, blockTools, isWritingBlock, writingEntriesFor, showRelationships, blueprintDocumentKey, previewGreeting, previewGreetingId, selectPreviewOpening,
    sceneOverrides, sceneFiles, worldDraft.worldbooks, dropLabelFor, looseStored, loosePlaced, unloose, device, toggleDevice,
    piece, onPieceDrag, worldDraft.sceneImages, worldDraft.continuity,
    // Read by the build but missing here, so the card frame's readiness and
    // the background strip only caught up when something else rebuilt.
    cardProgress, worldDraft.backgrounds,
    // The interface block lists the screen's pages.
    worldDraft.uiDoc?.pages, worldDraft.uiDoc?.entryPageId,
  ]);

  // A block React Flow never measured stays `visibility: hidden` for good:
  // it subscribes to the board's ResizeObserver once, and a new card's first
  // mount can get there before the board has made one, so the subscription
  // does nothing and nothing retries. The board opened empty until a reload.
  // Anything still unmeasured once it has had a moment is measured by hand.
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    const timer = setTimeout(() => {
      const flow = flowViewportRef.current;
      const stuck = rfNodes
        .filter((n) => !n.hidden)
        .filter((n) => { const m = flow.getInternalNode(n.id)?.measured; return !m?.width || !m?.height; })
        .map((n) => n.id);
      if (stuck.length) updateNodeInternals(stuck);
    }, 400);
    return () => clearTimeout(timer);
  }, [rfNodes, updateNodeInternals]);

  // The red "you are over this" on frames, patched onto the existing nodes
  // rather than rebuilt with them (see the note in the nodes memo).
  useEffect(() => {
    setRfNodes((nds) => {
      let changed = false;
      const next = nds.map((n) => {
        if (!isFrameNodeId(n.id) || n.type !== "gate") return n;
        const on = overlapIds.has(n.id);
        const d = n.data as GateNodeData;
        if (Boolean(d.frame.overlapping) === on) return n;
        changed = true;
        return { ...n, data: { ...d, frame: { ...d.frame, overlapping: on } } } as typeof n;
      });
      return changed ? next : nds;
    });
  }, [overlapIds]);


  // ── Wires: drawn only when something asks for them ──
  //
  // Across the stored library four out of five objects carry no wire at all,
  // and the cards that DO have wiring have enough of it to become spaghetti —
  // the worst one fits its 67 edges on screen at 39% zoom, which is unreadable.
  // Both ends of that range are the same mistake: drawing every relationship,
  // always. So the canvas stays quiet and lights a row's wires when you point
  // at it.
  //
  // Four things light themselves, because waiting to be pointed at would hide
  // the very thing the creator opened the canvas to see:
  //   · a gate the running session is pushing current through (live mode)
  //   · a wire the last AI turn added (the audit)
  //   · a wire that was just created (the 4s pulse)
  //   · the edge you have selected
  const [hoveredRowId, setHoveredRowId] = useState<string | null>(null);
  const [showAllWires, setShowAllWires] = useState(
    () => readLocalPref("yumina-blueprint-all-wires") === "on",
  );
  const toggleAllWires = useCallback(() => {
    setShowAllWires((v) => {
      writeLocalPref("yumina-blueprint-all-wires", v ? "off" : "on");
      return !v;
    });
  }, []);

  useEffect(() => {
    if (!positions) return;
    // Entering a situation selects it (so its settings open), but nobody
    // pointed at it: its every wire, animated across the screen, was the
    // first thing a creator saw inside. Wires light for what is pointed at.
    const selectedNode = selection?.type === "node" ? selection.id : null;
    const lit = hoveredRowId ?? (selectedNode && selectedNode === focusedModule ? null : selectedNode);
    // Pointing at a gate lights everything it governs, not just its own
    // condition wire — that is the question a gate raises.
    const litMembers =
      lit && gateIdSet.has(lit)
        ? new Set(graph.nodes.filter((n) => n.parentId === lit).map((n) => n.id))
        : null;

    const edges: Edge[] = [];
    for (const e of graph.edges) {
      // One wire may be drawn more than once: a shared object is a row in
      // every module, and a wire between two shared objects holds in every
      // module — so it is drawn in each frame the two ends have in common.
      const pairs = wirePairs(hostsOf.get(e.from), hostsOf.get(e.to));
      for (let pairIndex = 0; pairIndex < pairs.length; pairIndex++) {
      const { from: fromHost, to: toHost, frame: pairFrame } = pairs[pairIndex]!;
      // The card owning its openings IS worth drawing now: the card face and
      // each opening are separate blocks, so the wire is the only thing saying
      // which openings this card offers.
      //
      // Unless the card is the whole board. With no modules there is one frame
      // and every opening in it is this card's, so the wire answers a question
      // nobody has — and it answers it by leaving the card's right edge,
      // crossing the board behind three blocks and arriving at the opening's
      // left. On a brand new card that stray diagonal was the only line on
      // screen, and it looked like something had gone wrong.
      if (storyBoard && e.from === "world:root") continue;
      if (fromHost.host === toHost.host) continue;
      // What the player interface shows is in its preview already; a wire
      // from every value it reads only crossed the board to say so twice.
      if (e.to === "frontend" || e.from === "frontend") continue;

      const liveGate = liveGating
        ? (() => {
            const m = /^e:var:.+?->(module|entry):(.+?):(\d+)$/.exec(e.id);
            if (!m) return undefined;
            if (m[1] === "module") return liveGating.activeBooks.has(m[2]!);
            return liveGating.entryGate.get(m[2]!);
          })()
        : undefined;

      const recent = recentIds.has(e.id);
      const byTurn = turnMark.get(e.id) === "added";
      const selectedEdge = selection?.type === "edge" && selection.id === e.id;
      const touched =
        (lit != null && (e.from === lit || e.to === lit)) ||
        (litMembers != null && (litMembers.has(e.from) || litMembers.has(e.to)));

      // Wires are hidden by default because a real card has a hundred of them
      // and drawing every variable read is spaghetti. A wire BETWEEN MODULES is
      // the exception: it says which AI reads whose memory, there are a handful
      // at most, and it is the whole reason the module model exists. Hidden, a
      // board of module frames looks like boxes that have nothing to do with
      // each other — which is exactly how the feature read as missing.
      const structural = e.from.startsWith("module:") && e.to.startsWith("module:");
      if (!structural && !showAllWires && !touched && !selectedEdge && !recent && !byTurn && liveGate !== true)
        continue;

      const sourceHandle = gateIdSet.has(e.from)
        ? "governs"
        : fromHost.shown
          ? rowHandleId(e.from, "out")
          : "block-out";
      const targetHandle = gateIdSet.has(e.to)
        ? "activate"
        : toHost.shown
          ? e.toPort.startsWith("slot:")
            ? portHandleId(e.to, e.toPort)
            : rowHandleId(e.to, "in")
          : "block-in";

      const color = edgeColor(e.id);
      // In "show everything" mode the old dimming still earns its keep: it is
      // the only way to read one object out of a full graph.
      const dimmed = showAllWires && lit != null && !touched;

      edges.push({
        // The first drawing keeps the wire's own id; a repeat in another
        // frame is suffixed. Both carry the graph id for selection and menus.
        id: pairIndex === 0 ? e.id : `${e.id}~${pairFrame ?? pairIndex}`,
        type: "wire",
        data: { edgeId: e.id },
        source: fromHost.host,
        sourceHandle,
        target: toHost.host,
        targetHandle,
        // The engine has no language, so a wire the projection NAMES arrives as
        // a key; one labelled with the creator's own data (an operation, a
        // channel, a value) arrives ready to read.
        label:
          fromHost.shown && toHost.shown
            ? e.labelKey
              ? t(`blueprint.${e.labelKey}` as never)
              : e.label
            : undefined,
        animated: recent || byTurn || touched || liveGate === true,
        // ReactFlow adds the endpoint node's layer for parented edges. Keep
        // the wire and its invisible hit area below the text editor itself.
        zIndex: writingBlockIds.has(fromHost.host) || writingBlockIds.has(toHost.host) ? -1 : touched || selectedEdge || liveGate === true ? 10 : undefined,
        markerEnd: { type: MarkerType.ArrowClosed, width: 15, height: 15, color },
        style: {
          strokeWidth: selectedEdge ? 4 : touched ? 3.4 : liveGate === true ? 3.2 : recent || byTurn ? 3 : 2,
          stroke: liveGate === true ? "#34d399" : byTurn ? "#34d399" : color,
          opacity: dimmed ? 0.16 : liveGate === false ? 0.35 : 1,
          filter:
            liveGate === true
              ? "drop-shadow(0 0 7px rgba(52,211,153,0.65))"
              : touched || selectedEdge
                ? `drop-shadow(0 0 6px ${color}88)`
                : undefined,
          transition: "opacity 160ms ease, stroke-width 160ms ease",
        },
        labelStyle: { fontSize: 11, fontWeight: 600, fill: dimmed ? "#6b6a75" : "#d7d5df" },
        labelBgStyle: { fill: "#0b0a0e", fillOpacity: dimmed ? 0.6 : 0.92, stroke: color, strokeOpacity: dimmed ? 0.15 : 0.45 },
        labelBgPadding: [5, 3] as [number, number],
        labelBgBorderRadius: 5,
      });
      }
    }
    setRfEdges(edges);
  }, [
    graph, positions, hostsOf, gateIdSet, hoveredRowId, selection, showAllWires, focusedModule,
    // `t` belongs here now that a wire's label can be a key: without it the
    // canvas keeps the old language's labels until something else changes.
    liveGating, recentIds, turnMark, t, writingBlockIds, storyBoard,
  ]);

  // Dimensions and selection, never position.
  //
  // Where a block sits is computed by `buildFormation` and nothing else is
  // allowed to write it back. React Flow clamps a child of a frame into the
  // parent's MEASURED box (`extent: "parent"`), and a frame that is momentarily
  // unmeasured — mid-`setCenter`, or scrolled out of view — measures as nothing,
  // so every block in it gets clamped to the frame's top-left corner. That
  // clamp arrives as a position change; letting it through wrote the pile-up
  // into our own state, permanently, and the board came back as one stack of
  // boxes in the corner. Dropping position changes makes the formation the only
  // author of a position, which is what it already was in intent.
  //
  // A FRAME, though, may be dragged: its children ride along (their positions
  // are relative to it), and where it lands is the creator's, kept as a pin.
  /** Where a node's parent stands on the board: a situation sits in its
   *  group and its position is relative to it, while the guides are drawn
   *  in board coordinates. */
  const parentOffset = (nodeId: string): { x: number; y: number } => {
    const parentId = rfNodesRef.current.find((n) => n.id === nodeId)?.parentId;
    if (!parentId) return { x: 0, y: 0 };
    return rf.getInternalNode(parentId)?.internals.positionAbsolute ?? { x: 0, y: 0 };
  };
  /** What a dragged frame or loose block lines up with, in board
   *  coordinates: every other frame, loose block and stand-alone block (the
   *  cover), at the size it is drawn. */
  const snapTargets = (exclude: string): SnapRect[] =>
    rfNodesRef.current
      .filter((n) => n.id !== exclude && (isFrameNodeId(n.id) || isLooseBlockId(n.id) || (isBlockId(n.id) && !n.parentId)))
      .map((n) => {
        const b = frameBoxesRef.current.get(n.id);
        const at = rf.getInternalNode(n.id)?.internals.positionAbsolute ?? n.position;
        return { id: n.id, x: at.x, y: at.y, width: b?.width ?? n.measured?.width ?? 0, height: b?.height ?? n.measured?.height ?? 0 };
      })
      .filter((n) => n.width > 0 && n.height > 0);
  const onNodesChange = useCallback(
    (incoming: NodeChange<BlueprintNode>[]) => {
      let changes = incoming;
      // A frame being dragged snaps to its neighbours' edges and centres, the
      // way a slide's boxes do, and the frames it is lying over light up red
      // while it is over them — the overlap is shown while it is being made.
      // Grabbing a block drags the module it is in. A frame is mostly
      // covered by its blocks, so without this the only draggable part of a
      // module was its header strip and its padding — everywhere else the
      // press fell through to the canvas and panned the whole board, which
      // reads as "the module will not move". The block itself never moves
      // (the board lays it out); its delta is handed to the frame.
      const relayed: NodeChange<BlueprintNode>[] = [];
      for (const c of changes) {
        if (c.type !== "position" || !c.position || !isBlockId(c.id) || isLooseBlockId(c.id)) continue;
        const block = rfNodesRef.current.find((n) => n.id === c.id);
        const frame = block?.parentId ? rfNodesRef.current.find((n) => n.id === block.parentId) : undefined;
        if (!block || !frame) continue;
        relayed.push({
          type: "position",
          id: frame.id,
          dragging: c.dragging,
          position: { x: frame.position.x + (c.position.x - block.position.x), y: frame.position.y + (c.position.y - block.position.y) },
        });
      }
      if (relayed.length > 0) changes = [...changes, ...relayed];

      for (const c of changes) {
        if (c.type !== "position" || !c.position) continue;
        // A loose block over a module is about to join it: the module lights
        // up as a drop target and says so, the way it does for a dragged row.
        if (isLooseBlockId(c.id)) {
          const self = rfNodesRef.current.find((n) => n.id === c.id);
          const w = self?.measured?.width ?? BLOCK_W;
          const h = self?.measured?.height ?? 80;
          // Out on the open board a loose block lines up with what is around
          // it, the same as a frame; over a frame it is being dropped in, and
          // the frame's highlight says so instead.
          const zoom = rf.getViewport().zoom || 1;
          const track = dragRawRef.current[c.id] ?? (self ? { raw: { ...self.position }, applied: { ...self.position } } : undefined);
          const raw = track
            ? { x: track.raw.x + (c.position.x - track.applied.x), y: track.raw.y + (c.position.y - track.applied.y) }
            : { x: c.position.x, y: c.position.y };
          const rawCx = raw.x + w / 2;
          const rawCy = raw.y + h / 2;
          const overFrame = rfNodesRef.current.some((f) => {
            if (!isFrameNodeId(f.id)) return false;
            const fb = frameBoxesRef.current.get(f.id);
            const at = rf.getInternalNode(f.id)?.internals.positionAbsolute ?? f.position;
            return !!fb && rawCx >= at.x && rawCx <= at.x + fb.width && rawCy >= at.y && rawCy <= at.y + fb.height;
          });
          if (c.dragging && !overFrame) {
            const off = parentOffset(c.id);
            const me = { id: c.id, x: raw.x + off.x, y: raw.y + off.y, width: w, height: h };
            const targets = snapTargets(c.id);
            const snap = snapToNeighbours(me, targets, 8 / zoom);
            c.position = { x: snap.x - off.x, y: snap.y - off.y };
            dragRawRef.current[c.id] = { raw, applied: { ...c.position } };
            lastSnapRef.current[c.id] = { ...c.position };
            const gaps = measureGaps({ ...me, x: snap.x, y: snap.y }, targets, 600);
            setGuides(snap.vertical || snap.horizontal || gaps.length ? { ...snap, gaps, zoom } : null);
          } else {
            // The release lands where the guide was showing, not where the
            // pointer was a few pixels off it.
            const held = !c.dragging && !overFrame ? lastSnapRef.current[c.id] : undefined;
            c.position = held ? { ...held } : { x: raw.x, y: raw.y };
            dragRawRef.current[c.id] = { raw, applied: { ...c.position } };
            if (c.dragging) delete lastSnapRef.current[c.id];
            setGuides(null);
          }
          const cx = c.position.x + w / 2;
          const cy = c.position.y + h / 2;
          let under: string | null = null;
          if (c.dragging) {
            // The card's own tile takes it back too, not only a situation.
            for (const f of rfNodesRef.current) {
              if (!f.id.startsWith("module:") && f.id !== blockId.frame(null)) continue;
              const fb = frameBoxesRef.current.get(f.id);
              if (fb && cx >= f.position.x && cx <= f.position.x + fb.width && cy >= f.position.y && cy <= f.position.y + fb.height) {
                under = f.id;
                break;
              }
            }
          }
          setDropFrameId(under);
          setDragFrom(under ? "core" : null);
          continue;
        }
        if (!isFrameNodeId(c.id)) continue;
        const self = rfNodesRef.current.find((n) => n.id === c.id);
        const box = frameBoxesRef.current.get(c.id) ?? (self?.measured?.width ? { width: self.measured.width, height: self.measured.height ?? 0 } : undefined);
        if (!box) continue;
        const targets = snapTargets(c.id);
        const others = targets.filter((n) => isFrameNodeId(n.id));
        const zoom = rf.getViewport().zoom || 1;
        // Pointer-true position: the last raw plus the step React Flow just
        // took from what we last applied (see dragRawRef).
        // The first change of a drag can arrive before onNodeDragStart: seed
        // the track from where the node stands in the store right now.
        const track =
          dragRawRef.current[c.id] ??
          (self ? { raw: { ...self.position }, applied: { ...self.position } } : undefined);
        const raw = track
          ? { x: track.raw.x + (c.position.x - track.applied.x), y: track.raw.y + (c.position.y - track.applied.y) }
          : { x: c.position.x, y: c.position.y };
        const off = parentOffset(c.id);
        const me = { id: c.id, x: raw.x + off.x, y: raw.y + off.y, width: box.width, height: box.height };
        const snap = snapToNeighbours(me, targets, 8 / zoom);
        // The release comes through as one more position change, computed
        // from the pointer and not from what we snapped to — snap it too, or
        // the frame lands three pixels off the line it was showing.
        c.position = { x: snap.x - off.x, y: snap.y - off.y };
        dragRawRef.current[c.id] = { raw, applied: { ...c.position } };
        lastSnapRef.current[c.id] = { ...c.position };
        if (!c.dragging) {
          setGuides(null);
          setOverlapIds((prev) => (prev.size ? new Set() : prev));
          continue;
        }
        const gaps = measureGaps({ ...me, x: snap.x, y: snap.y }, targets, 600);
        setGuides(snap.vertical || snap.horizontal || gaps.length ? { ...snap, gaps, zoom } : null);
        const over = overlapping({ ...me, x: snap.x, y: snap.y }, others);
        const nextOver = over.length ? new Set([c.id, ...over]) : new Set<string>();
        // Same set → same state: a fresh Set every mouse move is a render
        // every mouse move.
        setOverlapIds((prev) => (prev.size === nextOver.size && [...nextOver].every((id) => prev.has(id)) ? prev : nextOver));
      }
      setRfNodes((nds) =>
        applyNodeChanges(changes.filter((c) => c.type !== "position" || !isBlockId(c.id) || isLooseBlockId(c.id)), nds),
      );
    },
    [rf],
  );

  /** Where a frame was dropped becomes its pin — and the first drop freezes
   *  the formation: every other frame is pinned where it stands, so from
   *  now on only the frame you drag moves. Dragging used to re-run the
   *  layout and shove the neighbours around on every drop; a slide's boxes
   *  stay put, and so do these. 整理 pulls every pin and lays the board out
   *  again. */
  /** Where a drag began, so a click that never moved is not a drop: React
   *  Flow reports drag start/stop for any press on a node, and pinning the
   *  whole board on a header click froze the formation before anyone had
   *  dragged anything. */
  const dragStartRef = useRef<Record<string, { x: number; y: number }>>({});
  /** React Flow moves a node by adding each pointer step to the position it
   *  finds in the store — the SNAPPED one we wrote. So every snap would
   *  leave the frame that much behind the pointer for the rest of the
   *  drag: snap twice and the frame is forty pixels off your hand. We keep
   *  the raw, pointer-true position ourselves (start + the steps) and snap
   *  from that each time, so leaving a guide line snaps straight back to
   *  the pointer. */
  const dragRawRef = useRef<Record<string, { raw: { x: number; y: number }; applied: { x: number; y: number } }>>({});
  /** A frame grabbed by one of its blocks: React Flow moves the frame (the
   *  block is not draggable) but reports the block. Resolve to the frame,
   *  or the drop is never pinned and the frame jumps back on the next
   *  layout. */
  const dragSubject = useCallback((node: BlueprintNode): BlueprintNode => {
    if (isBlockId(node.id) && !isLooseBlockId(node.id) && node.parentId) {
      const parent = rfNodesRef.current.find((n) => n.id === node.parentId);
      if (parent) return parent;
    }
    return node;
  }, []);
  const onNodeDragStart = useCallback(
    (_e: unknown, started: BlueprintNode) => {
      const node = dragSubject(started);
      dragStartRef.current[node.id] = { x: node.position.x, y: node.position.y };
      dragRawRef.current[node.id] = { raw: { ...node.position }, applied: { ...node.position } };
    },
    [dragSubject],
  );
  const onNodeDragStop = useCallback(
    (_e: unknown, ended: BlueprintNode) => {
      setGuides(null);
      setOverlapIds(new Set());
      if (useEditorStore.getState().readOnlyInspect) return;
      const dropped = dragSubject(ended);
      const start = dragStartRef.current[dropped.id];
      delete dragStartRef.current[dropped.id];
      delete dragRawRef.current[dropped.id];
      if (start && Math.abs(start.x - dropped.position.x) < 2 && Math.abs(start.y - dropped.position.y) < 2) {
        delete lastSnapRef.current[dropped.id];
        setDropFrameId(null);
        setDragFrom(null);
        return;
      }
      const snapped = lastSnapRef.current[dropped.id];
      delete lastSnapRef.current[dropped.id];
      const node = snapped ? { ...dropped, position: snapped } : dropped;
      // A loose block dropped on a module joins it; dropped anywhere else it
      // stays loose, there.
      if (isLooseBlockId(node.id)) {
        setDropFrameId(null);
        setDragFrom(null);
        const objId = node.id.slice("block:loose:".length);
        const w = node.measured?.width ?? BLOCK_W;
        const h = node.measured?.height ?? 80;
        const cx = node.position.x + w / 2;
        const cy = node.position.y + h / 2;
        for (const f of rfNodesRef.current) {
          const onCard = f.id === blockId.frame(null);
          if (!f.id.startsWith("module:") && !onCard) continue;
          const fb = frameBoxesRef.current.get(f.id);
          if (!fb) continue;
          if (cx >= f.position.x && cx <= f.position.x + fb.width && cy >= f.position.y && cy <= f.position.y + fb.height) {
            const ownerId = f.id.slice("module:".length);
            applyGraphPatch({ op: "set-parent", nodeId: objId, parentId: onCard ? undefined : `module:${ownerId}` });
            setLoose(objId, null);
            setOpenFrames((prev) => (prev.has(f.id) ? prev : new Set(prev).add(f.id)));
            flashRecent([objId]);
            return;
          }
        }
        setLoose(objId, { x: node.position.x, y: node.position.y });
        return;
      }
      if (isBlockId(node.id)) return;
      // An AI not put anywhere, dropped on the card or a situation, lives
      // there from now on: its frame folds into that place's 「这里的 AI」.
      if (node.id.startsWith("module:")) {
        const aiId = node.id.slice("module:".length);
        const books = useEditorStore.getState().worldDraft.worldbooks ?? [];
        const ai = books.find((b) => b.id === aiId);
        if (ai?.host === "unplaced") {
          // Where the pointer let go, in board coordinates: a frame in a
          // group is placed relative to the group, so its own position would
          // not land on anything.
          const ev = _e as { clientX?: number; clientY?: number } | null;
          const at = ev && typeof ev.clientX === "number" && typeof ev.clientY === "number"
            ? rf.screenToFlowPosition({ x: ev.clientX, y: ev.clientY })
            : null;
          for (const f of rfNodesRef.current) {
            if (!at || f.id === node.id) continue;
            const onCard = f.id === blockId.frame(null);
            if (!f.id.startsWith("module:") && !onCard) continue;
            const place = onCard ? undefined : books.find((b) => `module:${b.id}` === f.id);
            if (!onCard && (!place || place.host !== undefined || place.station?.kind === "worker")) continue;
            const fb = frameBoxesRef.current.get(f.id);
            if (!fb) continue;
            const pos = rf.getInternalNode(f.id)?.internals.positionAbsolute ?? f.position;
            if (at.x >= pos.x && at.x <= pos.x + fb.width && at.y >= pos.y && at.y <= pos.y + fb.height) {
              useEditorStore.getState().updateWorldbook(aiId, { host: onCard ? "card" : place!.id });
              setDropFrameId(null);
              setDragFrom(null);
              flashRecent([node.id]);
              return;
            }
          }
        }
      }
      const layout = useEditorStore.getState().worldDraft.graphLayout;
      const cur: GraphLayout["nodes"] = layout?.version === GRAPH_LAYOUT_VERSION ? { ...layout.nodes } : {};
      if (isFrameNodeId(node.id)) {
        for (const n of rfNodesRef.current) {
          if (n.id === node.id || !isFrameNodeId(n.id) || cur[n.id]?.pinned) continue;
          cur[n.id] = { ...cur[n.id], x: Math.round(n.position.x), y: Math.round(n.position.y), pinned: true };
        }
      }
      cur[node.id] = { ...cur[node.id], x: Math.round(node.position.x), y: Math.round(node.position.y), pinned: true };
      setGraphLayout({ version: GRAPH_LAYOUT_VERSION, nodes: cur, notes: currentNotes() });
    },
    [setGraphLayout, currentNotes, applyGraphPatch, setLoose, flashRecent, dragSubject, rf],
  );

  /** Every pin pulled: the board goes back to laying itself out. */
  const tidyBoard = useCallback(() => {
    const layout = useEditorStore.getState().worldDraft.graphLayout;
    const cur: GraphLayout["nodes"] = {};
    for (const [id, p] of Object.entries(layout?.version === GRAPH_LAYOUT_VERSION ? layout.nodes : {})) {
      if (!p.pinned) cur[id] = p;
    }
    setGraphLayout({ version: GRAPH_LAYOUT_VERSION, nodes: cur, notes: currentNotes() });
    reflowIfSystemOwned();
  }, [setGraphLayout, currentNotes, reflowIfSystemOwned]);
  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) =>
      setRfEdges((eds) => applyEdgeChanges(changes.filter((c) => c.type !== "remove"), eds)),
    [],
  );


  /** A block handle carries the object id: "<objId>@in" / "<objId>@out", or
   *  "<objId>@slot:x" for the one port class that has to be addressed
   *  individually. Gates are their own node, so their handles are bare. Undo
   *  that encoding and the original object-level wiring contract applies
   *  unchanged — connectionPatch never learns the canvas changed shape. */
  const resolveConnection = useCallback((conn: Connection): Connection | null => {
    const from = parseRowHandle(conn.sourceHandle);
    const to = parseRowHandle(conn.targetHandle);
    const source = from?.objId ?? (conn.sourceHandle === "governs" ? conn.source : null);
    const target = to?.objId ?? (conn.targetHandle === "activate" ? conn.target : null);
    if (!source || !target || source === target) return null;
    return { source, target, sourceHandle: from?.port ?? null, targetHandle: to?.port ?? null };
  }, []);

  const isValidConnection: IsValidConnection<Edge> = useCallback(
    (conn) => {
      if (readOnly) return false;
      const resolved = resolveConnection(conn as Connection);
      if (!resolved) return false;
      if (parentPatchFor(resolved)) return true;
      if (connectionPatch(resolved) === null) return false;
      // A json variable can't take a scalar opening seed — refuse the wire up
      // front instead of letting it silently vanish on apply.
      if (resolved.source?.startsWith("greeting:") && resolved.target?.startsWith("var:")) {
        const v = useEditorStore.getState().worldDraft.variables.find((x) => x.id === resolved.target!.slice(4));
        if (v?.type === "json") return false;
      }
      return true;
    },
    [readOnly, resolveConnection],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (readOnly) return;
      const resolved = resolveConnection(conn);
      if (!resolved) return;
      const patch = parentPatchFor(resolved) ?? connectionPatch(resolved);
      if (patch) applyGraphPatch(patch);
    },
    [applyGraphPatch, readOnly, resolveConnection],
  );

  const onBeforeDelete = useCallback(
    async ({ nodes, edges }: { nodes: BlueprintNode[]; edges: Edge[] }) => {
      // ReactFlow's own key handler excludes inputs but still fires from
      // buttons/links. Protect selected module gates and wires there too.
      if (readOnly || isInteractiveDeleteTarget(document.activeElement)) return false;
      // Delete key removes real objects and wires; projections (summaries, the
      // frontend, event sources) and derived emit-chain wires stay put.
      const deletableEdges = edges.filter((e) => !isDerivedEdge(graphEdgeId(e)));
      // Blocks are furniture. The only deletable node on this canvas is a
      // module gate; rows are deleted through their own key handler and menu.
      const deletableNodes = nodes.filter((n) => !isBlockId(n.id) && isDeletableObject(n.id));
      if (deletableEdges.length === 0 && deletableNodes.length === 0) return false;
      return { nodes: deletableNodes, edges: deletableEdges };
    },
    [readOnly],
  );

  const onEdgesDelete = useCallback(
    (edges: Edge[]) => {
      if (readOnly) return;
      // A wire drawn in more than one frame arrives here once per drawing, the
      // repeats as `${id}~frame` — which is not an id the graph knows. Resolve
      // each back to the wire it draws, once, and remove the lot as one step.
      const ids = new Set(edges.map(graphEdgeId).filter((id) => !isDerivedEdge(id)));
      if (ids.size === 0) return;
      inOneUndoStep(() => {
        for (const id of ids) applyGraphPatch({ op: "remove-edge", edgeId: id });
      });
    },
    [applyGraphPatch, readOnly],
  );

  const openPanel = onDrillPanel;

  /** Rows stop their own clicks, so anything reaching here is block chrome or
   *  a gate. A block that IS an object (the card face, an opening, the
   *  interface) selects that object; a list block's chrome clears the
   *  selection. */
  const blockHeadIdRef = useRef<Map<string, string>>(new Map());
  blockHeadIdRef.current = new Map(blocks.filter((b) => b.head).map((b) => [b.id, b.head!.id]));

  const onNodeClick = useCallback((_e: unknown, node: BlueprintNode) => {
    pickedByClickRef.current = blockHeadIdRef.current.get(node.id) ?? node.id;
    // The head of a list of rows opens them all in place; the next click (or
    // the first, if any row is already open) shuts them. The column listing
    // the same rows again said nothing the block did not.
    const onHead = !!(_e as { target?: Element | null } | null)?.target?.closest?.("[data-block-head]");
    const listBlock = onHead && isBlockId(node.id)
      ? blocksRef.current.find((b) => b.id === node.id && !b.head && (b.kind === "lore" || b.kind === "opening" || b.kind === "state" || b.kind === "behavior"))
      : undefined;
    if (listBlock) {
      const ids = listBlock.rows.map((r) => r.g.id).filter((id) => canEditRowInline(id));
      const anyOpen = ids.some((id) => openRowIdsRef.current.has(id));
      setHeadOpened((prev) => {
        const next = new Set(prev);
        for (const id of ids) { if (anyOpen) next.delete(id); else next.add(id); }
        return next;
      });
      if (anyOpen && openRowIdRef.current && ids.includes(openRowIdRef.current)) setOpenRowId(null);
      setSelection(null);
      return;
    }
    if (isBlockId(node.id)) {
      if (blocksRef.current.some(block => block.id === node.id && block.kind === "context")) {
        setSelection({ type: "node", id: node.id });
        return;
      }
      const headId = blockHeadIdRef.current.get(node.id);
      if (headId) {
        // The card's face and its background share one head (the card), so
        // the camera is told which of the two was clicked.
        preferredWritingHosts.current.set(headId, node.id);
        selectOnlyRef.current = headId;
        setSelection({ type: "node", id: headId });
        return;
      }
      // A block that is not itself an object (a list): the block itself is
      // selected, so the column lists what it holds — a click that only
      // zoomed read as broken. "Add into this module" still works, because
      // the module a new object joins is read off the selected block's owner
      // (currentModuleId). The selection effect brings the board to it.
      setSelection({ type: "node", id: node.id });
      return;
    }
    setSelection({ type: "node", id: node.id });
  }, []);
  const onEdgeClick = useCallback((_e: unknown, edge: Edge) => {
    setSelection({ type: "edge", id: graphEdgeId(edge) });
  }, []);
  const onPaneClick = useCallback(() => {
    // A block engaged without a selection (the caret in an opening's text)
    // has nothing to clear, so the empty canvas hands the overview back here.
    if (!selectionRef.current) leaveBlockFocusRef.current();
    setSelection(null); setMultiSelected(EMPTY_MULTI);
  }, []);

  // -- Double-click a row: into its full editor --
  // Recognised here, at the canvas, not by the row. The first click opens
  // the column and the board lays itself out again under the pointer, so the
  // second press lands on whatever moved in — almost always the empty pane,
  // where React Flow zoomed in and the pane click cleared the selection:
  // double-clicking a row did the opposite of opening it. The first press on
  // a row is remembered, and a second one close to it in time and place is a
  // double-click on that row, whatever is under the pointer by then.
  const lastRowPress = useRef<{ id: string; t: number; x: number; y: number } | null>(null);
  const pairsWithRowPress = (e: React.MouseEvent) => {
    const prev = lastRowPress.current;
    return prev && e.timeStamp - prev.t <= 500 && Math.abs(e.clientX - prev.x) <= 8 && Math.abs(e.clientY - prev.y) <= 8 ? prev : null;
  };
  const onCanvasClickCapture = useCallback((e: React.MouseEvent) => {
    // The click a box-drag ends with is not a click on the canvas: let
    // through, the pane read it as "clicked empty space" and dropped
    // everything the box had just picked up.
    if (swallowClickRef.current) {
      swallowClickRef.current = false;
      e.stopPropagation();
      return;
    }
    if (e.detail >= 2 && pairsWithRowPress(e)) {
      // The second click of the pair belongs to the double-click, not to
      // whatever slid under the pointer.
      e.stopPropagation();
      return;
    }
    const target = e.target as Element | null;
    // Text being written in (an open row, the opening) keeps its own
    // double-click: that is how a word is selected.
    const editing = target?.closest("input, textarea, [contenteditable='true'], [data-canvas-writing-editor]");
    const id = editing || e.shiftKey || e.ctrlKey || e.metaKey
      ? null
      : target?.closest("[data-row-anchor]")?.getAttribute("data-row-anchor")
        ?? target?.closest("[data-canvas-writing-object]")?.getAttribute("data-canvas-writing-object")
        // A frame's title bar too: its first click opens the settings column
        // and moves the board just as a row's does.
        ?? (target?.closest("button") ? null : target?.closest("[data-frame-drill]")?.getAttribute("data-frame-drill"))
        ?? null;
    lastRowPress.current = id && e.detail === 1 ? { id, t: e.timeStamp, x: e.clientX, y: e.clientY } : null;
  }, []);
  const onCanvasDoubleClickCapture = useCallback((e: React.MouseEvent) => {
    const prev = pairsWithRowPress(e);
    if (!prev) return;
    lastRowPress.current = null;
    e.stopPropagation();
    e.preventDefault();
    drillObject(prev.id);
  }, [drillObject]);

  // -- Marquee: Shift-drag on empty canvas sweeps up rows --
  // Rows are not flow nodes, so React Flow's own selection box cannot see
  // them. The container catches the press in the capture phase, ahead of the
  // pane's d3-zoom listener, so the gesture draws a box instead of panning.
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const marqueeRef = useRef<typeof marquee>(null);
  /** Set when a box-drag ends, for the click the release fires. */
  const swallowClickRef = useRef(false);
  const onCanvasPointerDownCapture = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    cancelInitialFit();
    // Ctrl / ⌘ / Shift + drag sweeps up a box of rows from anywhere on the
    // board — over a module too, which is most of it (the box used to start
    // only on bare canvas, where there was hardly anywhere to start it). A
    // press that does not move stays a click: Ctrl-click adds one row.
    swallowClickRef.current = false;
    const target = e.target as Element | null;
    // A plain drag on empty canvas moves the board (owner, 10/6); Ctrl / ⌘ /
    // Shift + drag draws the box, from anywhere.
    if (readOnly || !(e.shiftKey || e.ctrlKey || e.metaKey) || e.button !== 0) return;
    if (!target?.closest(".react-flow") || target.closest("input, textarea, select, [contenteditable=true], .react-flow__handle, .nowheel")) return;
    const host = containerRef.current;
    if (!host) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = host.getBoundingClientRect();
    const start = { x0: e.clientX - rect.left, y0: e.clientY - rect.top, x1: e.clientX - rect.left, y1: e.clientY - rect.top };
    marqueeRef.current = start;
    setMarquee(start);
    const additive = e.ctrlKey || e.metaKey;
    const onMove = (ev: PointerEvent) => {
      const cur = marqueeRef.current;
      if (!cur) return;
      const next = { ...cur, x1: ev.clientX - rect.left, y1: ev.clientY - rect.top };
      marqueeRef.current = next;
      setMarquee(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      const cur = marqueeRef.current;
      marqueeRef.current = null;
      setMarquee(null);
      if (!cur) return;
      const box = {
        left: rect.left + Math.min(cur.x0, cur.x1), right: rect.left + Math.max(cur.x0, cur.x1),
        top: rect.top + Math.min(cur.y0, cur.y1), bottom: rect.top + Math.max(cur.y0, cur.y1),
      };
      // A click with Shift held is not a box; leave the selection alone.
      if (box.right - box.left < 4 && box.bottom - box.top < 4) return;
      swallowClickRef.current = true;
      const hit = rowsInRect(host, box).filter((id) => !isBlockId(id) && isDeletableObject(id));
      setMultiSelected((prev) => {
        const next = new Set(additive ? prev : []);
        for (const id of hit) next.add(id);
        return next.size === 0 ? EMPTY_MULTI : next;
      });
      if (!additive) setSelection(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [cancelInitialFit, readOnly]);

  // Rows that vanished (deleted elsewhere, or moved out of view by a filter)
  // drop out of the multi-selection, so the batch bar never counts ghosts.
  useEffect(() => {
    if (multiSelected.size === 0) return;
    const alive = new Set(graph.nodes.map((n: GraphNode) => n.id));
    if ([...multiSelected].every((id) => alive.has(id))) return;
    setMultiSelected((prev) => {
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === 0 ? EMPTY_MULTI : next;
    });
  }, [graph, multiSelected]);

  /** Batch re-home: every multi-selected row into one module, or back to the card. */
  const moveMultiTo = useCallback((ownerId: string | null, only?: string[]) => {
    const moving = only ?? [...multiSelected];
    // One move, one undo step, however many rows it carried.
    inOneUndoStep(() => {
      for (const objId of moving) {
        const node = graphRef.current.nodes.find((n: GraphNode) => n.id === objId);
        if (!node) continue;
        const current = node.parentId?.startsWith("module:") ? node.parentId.slice("module:".length) : null;
        if (current === ownerId) continue;
        applyGraphPatch({ op: "set-parent", nodeId: objId, parentId: ownerId ? `module:${ownerId}` : undefined });
      }
    });
    if (ownerId) setOpenFrames((prev) => (prev.has(blockId.frame(ownerId)) ? prev : new Set(prev).add(blockId.frame(ownerId))));
    flashRecent(moving);
    setMultiSelected(EMPTY_MULTI);
    // The rows leave the screen in one go; say where they went, and offer
    // the way there — otherwise it reads as a delete.
    const first = moving[0];
    const where = ownerId ? (useEditorStore.getState().worldDraft.worldbooks ?? []).find((b) => b.id === ownerId)?.name ?? "" : String(t("blueprint.moved.card"));
    const close = feedback.persistent(String(t("blueprint.moved.to", { count: moving.length, where })), {
      label: String(t("blueprint.moved.go")),
      onClick: () => { if (first) jumpToRef.current(first); },
    });
    window.setTimeout(close, 6000);
  }, [multiSelected, applyGraphPatch, flashRecent, t]);
  const onNodeDoubleClick = useCallback(
    (_e: unknown, node: BlueprintNode) => {
      const objId = isBlockId(node.id) ? (blockHeadIdRef.current.get(node.id) ?? null) : node.id;
      if (objId) drillObject(objId);
    },
    [drillObject],
  );

  // ── Toolbar adds: localized default names + auto-open the inspector ──
  const [newObjectId, setNewObjectId] = useState<string | null>(null);
  useEffect(() => { if (selection?.id !== newObjectId) setNewObjectId(null); }, [selection?.id, newObjectId]);
  const selectNewest = useCallback((nodeId: string) => {
    if (nodeId.startsWith("greeting:") || nodeId.startsWith("entry:")) {
      setSelection(null);
      setRelationshipId(null);
      setWritingFocusRequest({ documentKey: blueprintDocumentKey, id: nodeId });
      return;
    }
    setNewObjectId(nodeId);
    setSelection({ type: "node", id: nodeId });
  }, [blueprintDocumentKey]);

  /** The module a new object should join: whichever container the selection
   *  sits in (or is). Nothing selected → Core. */
  const currentModuleId = useCallback((): string | undefined => {
    if (selection?.type !== "node") return undefined;
    if (selection.id.startsWith("module:")) return selection.id.slice("module:".length);
    // A whole list block selected: its module, or the card.
    if (isBlockId(selection.id)) {
      const block = blocksRef.current.find((b) => b.id === selection.id);
      if (block && !block.head) return block.ownerId;
    }
    const resolved = resolveCanvasInspectorNode(selection.id, graph.nodes);
    if (resolved?.section === "memory") return resolved.node.id.slice("module:".length);
    return resolved?.node.parentId?.slice("module:".length);
  }, [selection, graph]);

  /** A new object added into a shut block renders hidden — the add has to
   *  open the block it landed in, or it reads as "nothing happened". (Being
   *  folded behind "N more" can't happen: the new object is selected, and the
   *  selection is always a forced row.) A brand-new entry has no keywords and
   *  no conditions, so it lands in the standby block. */
  const revealBlock = useCallback(
    (id: string, ownerId?: string) => {
      // The block also has to be in an OPEN module, or the reveal unfolds
      // something the canvas is not drawing. Adding a variable while a shut
      // module was selected put it somewhere real and showed nothing.
      const frameId = blockId.frame(ownerId ?? null);
      setOpenFrames((prev) => (prev.has(frameId) ? prev : new Set(prev).add(frameId)));
      const canvasId = resolveCanvasBlockId(id, blocksRef.current);
      if (collapsedSet.has(canvasId)) toggleBlockCollapse(canvasId);
    },
    [collapsedSet, toggleBlockCollapse],
  );

  /**
   * Put a new lore entry / variable / behaviour into a named module.
   *
   * The toolbar infers the module from the selection; a module's own shelves
   * name it outright. Both land here so "which module did that go into" has
   * exactly one answer.
   */
  const addInto = useCallback(
    (kind: "opening" | "lore" | "state" | "behavior", bookId: string | undefined, opts?: { loose?: boolean; via?: "menu" | "block" }) => {
      const store = useEditorStore.getState();
      captureHubEvent("studio_object_added", {
        world_id: store.serverWorldId ?? store.worldDraft.id,
        kind: kind === "lore" ? "setting" : kind === "state" ? "variable" : kind === "behavior" ? "behavior" : "opening",
        via: opts?.via ?? "menu",
      });
      // From 添加内容: the new object stands outside every frame, faded and
      // in play nowhere, until it is dragged onto the card or into a
      // situation — the gesture that switches it on.
      const loose = Boolean(opts?.loose) && !bookId;
      const home = loose ? UNPLACED_WORLDBOOK_ID : bookId;
      const land = (objId: string, blockIdIfPlaced: string) => {
        if (loose) setLoose(objId, placeInView());
        else revealBlock(blockIdIfPlaced, bookId);
      };
      // Creating the object and assigning its localized name/scope is one edit.
      store.beginBatch();
      try {
        if (kind === "opening") {
          addEntry("greeting", "system-presets");
          const entries = useEditorStore.getState().worldDraft.entries;
          const created = entries[entries.length - 1];
          if (!created) return;
          store.updateEntry(created.id, { name: t("blueprint.defaults.greeting"), worldbookId: bookId });
          // The block shows one opening at a time; show the new one, open, or
          // the + looked like it had shut the opening being written.
          selectPreviewOpening(created.id);
          // With modules, openings are rows of every module's openings block;
          // show it where the creator is, else in the first module.
          const firstModule = useEditorStore.getState().worldDraft.worldbooks?.[0]?.id;
          const inModule = bookId ?? firstModule;
          if (inModule) revealBlock(blockId.openings(inModule), inModule);
          else revealBlock(blockId.opening(created.id));
          selectNewest(`greeting:${created.id}`);
          return;
        }
        if (kind === "lore") {
          addEntry("custom", "system-presets");
          const entries = useEditorStore.getState().worldDraft.entries;
          const created = entries[entries.length - 1];
          if (!created) return;
          store.updateEntry(created.id, { name: t("blueprint.defaults.entry"), worldbookId: home });
          land(`entry:${created.id}`, blockId.lore("manual", bookId));
          // Pin it: nothing is wired to a fresh entry, so without this it folds
          // into a summary node the moment it is born.
          setPinnedEntryIds((prev) => (prev.includes(created.id) ? prev : [...prev, created.id]));
          // Outside, the next thing to do is drag it into a frame, so the
          // view stays put (the writing focus would zoom onto it and push
          // every frame off screen); it opens in the column to write.
          if (loose) setSelection({ type: "node", id: `entry:${created.id}` });
          else selectNewest(`entry:${created.id}`);
          return;
        }
        if (kind === "state") {
          addVariable();
          const vars = useEditorStore.getState().worldDraft.variables;
          const idx = vars.length - 1;
          const created = vars[idx];
          if (!created) return;
          store.updateVariableAt(idx, { name: t("blueprint.defaults.variable"), worldbookId: home });
          land(`var:${created.id}`, blockId.state(bookId));
          selectNewest(`var:${created.id}`);
          return;
        }
        addReaction();
        const reactions = useEditorStore.getState().worldDraft.reactions ?? [];
        const created = reactions[reactions.length - 1];
        if (!created) return;
        store.updateReaction(created.id, { name: t("blueprint.defaults.behavior"), worldbookId: home });
        land(`reaction:${created.id}`, blockId.behavior(bookId));
        selectNewest(`reaction:${created.id}`);
      } finally {
        store.commitBatch();
      }
    },
    [addEntry, addVariable, addReaction, revealBlock, selectNewest, t, setLoose, placeInView, selectPreviewOpening],
  );

  /** Where 加东西 puts a new setting, variable or behaviour: into the
   *  situation that is selected (or holds what is selected), and onto the
   *  card otherwise, where it works in every situation. A new object never
   *  starts outside every frame: standing there marked 「没生效」, a variable
   *  the creator had just added read as broken. Dragging one out to set it
   *  aside stays the creator's own gesture. */
  const addTarget = useCallback((): { into: string | undefined } | "outside" => {
    if (selection?.type !== "node") return { into: undefined };
    const mod = currentModuleId();
    if (mod === UNPLACED_WORLDBOOK_ID) return "outside";
    return { into: mod };
  }, [selection, currentModuleId]);
  const addFromMenu = useCallback((kind: "lore" | "state" | "behavior") => {
    const target = addTarget();
    if (target === "outside") addInto(kind, undefined, { loose: true });
    else addInto(kind, target.into);
  }, [addTarget, addInto]);
  const handleAddEntry = useCallback(() => addFromMenu("lore"), [addFromMenu]);

  const handleAddModule = useCallback(() => {
    captureHubEvent("studio_object_added", { world_id: useEditorStore.getState().serverWorldId ?? worldDraft.id, kind: "module", via: "menu" });
    addWorldbook(t("blueprint.defaults.module"));
    const books = useEditorStore.getState().worldDraft.worldbooks ?? [];
    const created = books[books.length - 1];
    if (!created) return;
    // Open it: a new module is empty, and a shut empty bar is the one thing on
    // the canvas that tells the creator nothing about what they just made.
    setOpenFrames((prev) => new Set(prev).add(blockId.frame(created.id)));
    selectNewest(`module:${created.id}`);
    // Then the board glides to it. A situation is a frame, which the
    // selection's own pan leaves alone, so the new one was made off screen
    // (on a one-card board the layout also jumps to make room for it) and
    // the creator saw only its settings. Pan, never zoom; after the column
    // has opened and the frame has been measured.
    window.setTimeout(() => fitFocusedBlockRef.current(blockId.frame(created.id), 420), 450);
  }, [addWorldbook, selectNewest, t]);

  /** One more AI, in a place: the scenario being worked in (or the one
   *  whose 「AI」 block was used), otherwise the card. An AI is one more API
   *  call and nothing else, so it comes with nothing of its own; it is named
   *  AI, AI 2, … and opens in its row to be set up. One undo step. */
  const addAiNow = useCallback((place?: string) => {
    const where = place ?? currentModuleId() ?? "card";
    const taken = new Set((useEditorStore.getState().worldDraft.worldbooks ?? []).map((b) => b.name));
    let name = String(t("blueprint.placeAis.defaultName"));
    // The card's own AI is already called that.
    taken.add(name);
    for (let n = 2; taken.has(name); n++) name = `${t("blueprint.placeAis.defaultName")} ${n}`;
    const made = addAiTo(where, name);
    if (!made) return;
    const block = blockId.ais(where === "card" ? undefined : where);
    setSelection({ type: "node", id: aiInspectorId(made.bookId) });
    window.setTimeout(() => fitFocusedBlockRef.current(block, 420), 300);
  }, [currentModuleId, t]);

  const handleAddGreeting = useCallback(() => {
    addInto("opening", undefined);
  }, [addInto, currentModuleId]);

  /**
   * Give the card an interface and open the builder on it.
   *
   * Without this the builder is unreachable for the cards it exists for. The
   * canvas only draws a frontend block once `world.rootComponent` is set
   * (graph/compiler.ts), so the 201 stored cards with no frontend had nothing
   * to click, and every other route to the panel is mobile-only or lives in
   * the classic dockview picker. The people who never wrote TSX are exactly
   * the people who could not find the thing built for them.
   */
  const handleAddInterface = useCallback(() => {
    // No eager adoption here: creating the document is the builder's opening
    // move — the gate wraps a hand-written frontend or offers the template
    // picker. Adopting first silently skipped both, so every card entered
    // through this menu landed on the default layout with no choice.
    // With modules the interface is each module's scene block; reveal the
    // first module's.
    const inModule = useEditorStore.getState().worldDraft.worldbooks?.[0]?.id;
    if (inModule) revealBlock(blockId.scene(inModule), inModule);
    else revealBlock(blockId.frontend);
    selectNewest("frontend");
    openPanel("frontend");
  }, [openPanel, revealBlock, selectNewest]);

  // The tray is on the card's tile, so what it makes belongs to the card.
  trayAddRef.current = (item) => addInto(item, undefined);

  /** A scene image needs a picture before it is anything, so it is made in
   *  its own editor: create it and land there with it selected. */
  const handleAddSceneImage = useCallback(() => {
    useEditorStore.getState().addSceneImage();
    const list = useEditorStore.getState().worldDraft.sceneImages ?? [];
    const created = list[list.length - 1];
    if (created) useEditorStore.getState().focusObject("sceneImage", created.id);
    onDrillPanel("scene-images");
  }, [onDrillPanel]);

  /** A block's "+" adds the object that block is made of. */
  const addToBlock = useCallback(
    (block: Block, _anchor?: DOMRect) => {
      if (block.kind === "lore") addInto("lore", block.ownerId, { via: "block" });
      // A behaviour is said in one sentence first, beside the "+" that asked
      // for it — the same form as 加东西, not an empty four-part editor.
      else if (block.kind === "behavior") addInto("behavior", block.ownerId, { via: "block" });
      else if (block.kind === "state") addInto("state", block.ownerId, { via: "block" });
      // An opening is always the card's, whichever module's list it was
      // added from — it is drawn in every module.
      else if (block.kind === "opening") addInto("opening", undefined, { via: "block" });
      // The frontend block is not a list you add rows to — its "+" means
      // "work on the interface", which is the builder. Without this the
      // control was on screen and did nothing.
      else if (block.kind === "frontend") handleAddInterface();
      // 「这里的 AI」's "+": an AI that lives in this place.
      else if (block.kind === "ais") addAiNow(block.ownerId ?? "card");
    },
    [handleAddInterface, addInto, addAiNow],
  );


  const preferredHostFor = useCallback((id: string) => {
    const preferred = preferredWritingHosts.current.get(id);
    return hostsOf.get(id)?.find(host => host.host === preferred) ?? hostOf.get(id);
  }, [hostsOf, hostOf]);
  /** The row an object is drawn as inside its host block — a writing row or
   *  a list row — if it is on the board yet. */
  const objectRowElement = useCallback((objectId: string, hostId: string) => {
    const inHost = (element: HTMLElement) => element.closest(".react-flow__node")?.getAttribute("data-id") === hostId;
    return Array.from(containerRef.current?.querySelectorAll<HTMLElement>("[data-canvas-writing-object]") ?? [])
      .find(element => element.dataset.canvasWritingObject === objectId && inHost(element))
      ?? Array.from(containerRef.current?.querySelectorAll<HTMLElement>("[data-row-anchor]") ?? [])
      .find(element => element.dataset.rowAnchor === objectId && inHost(element));
  }, []);
  const objectBounds = useCallback((objectId: string, hostId: string) => {
    const flow = flowViewportRef.current;
    const field = objectRowElement(objectId, hostId);
    if (field) {
      const rect = field.getBoundingClientRect();
      const zoom = flow.getViewport().zoom;
      if (rect.width > 0 && rect.height > 0 && zoom > 0) return { ...flow.screenToFlowPosition({ x: rect.left, y: rect.top }), width: rect.width / zoom, height: rect.height / zoom };
    }
    const internal = flow.getInternalNode(hostId);
    const absolute = internal?.internals.positionAbsolute;
    if (!absolute || !internal.measured?.width || !internal.measured.height) return undefined;
    return { ...absolute, width: internal.measured.width, height: internal.measured.height };
  }, [objectRowElement]);

  /** Jump to an object: reveal it, then centre its own editing area. */
  const jumpTo = useCallback(
    (objId: string) => {
      if (learningTarget.current?.id !== objId) learningTarget.current = null;
      cancelObjectCenter.current();
      const direct = getUnmappedSearchPanel(objId, graphById);
      if (direct) {
        setQuery("");
        setSelection(null);
        useEditorStore.getState().focusObject(direct.kind, direct.id);
        onDrillPanel(direct.panelId);
        return;
      }
      if (objId.startsWith("module:")) {
        focusModuleRef.current(objId);
        return;
      }
      if (focusTimer.current) clearTimeout(focusTimer.current);
      if (!overviewViewport.current && !focusedModule && !focusedBlockRef.current) overviewViewport.current = rf.getViewport();
      setFocusedModule(null);
      focusSuppressedUntil.current = Date.now() + 900;
      const directBlock = blocksRef.current.find(block => block.id === objId);
      const host = directBlock ? { host: directBlock.id, ownerId: directBlock.ownerId } : preferredHostFor(objId);
      const hostId = host?.host;
      setFocusedBlock(hostId && isBlockId(hostId) ? hostId : null);
      if (hostId && isBlockId(hostId)) {
        revealBlock(hostId, host?.ownerId);
        expandBlockRows(hostId);
      }
      setQuery("");
      // Found and lit, not opened: a search hit opened into the whole editor
      // and pushed half of what it was found in off the screen. A lesson
      // still opens what it points at.
      if (!learningStageRef.current) selectOnlyRef.current = objId;
      setSelection({ type: "node", id: objId });
      // Give React Flow a beat to (re)register and measure the block — and let
      // the reflow that unfolding it triggers finish its own fit first. That
      // fit used to land a few ms after this centre and silently undo it, so a
      // search hit selected the right object and then went nowhere near it.
      const epoch = fitViewEpoch.current.value;
      focusTimer.current = setTimeout(() => {
        if (epoch !== fitViewEpoch.current.value) return;
        const target = hostId ?? objId;
        cancelObjectCenter.current = waitForMeasuredBlueprintTarget({
          isCurrent: () => epoch === fitViewEpoch.current.value,
          getTarget: () => objectBounds(objId, target),
          onReady: bounds => {
            if (viewLockedRef.current) return;
            const now = flowViewportRef.current.getViewport().zoom;
            const zoom = now >= 0.7 ? now : 0.9;
            // Across, the whole block when it fits: centred on the row alone,
            // a row in a two-column block left half its block off screen.
            const host = hostId ? flowViewportRef.current.getInternalNode(hostId) : undefined;
            const avail = (containerRef.current?.clientWidth ?? 0) - (insetsRef.current?.left ?? 0) - (insetsRef.current?.right ?? 0);
            const hw = host?.measured?.width ?? 0;
            const cx = host && hw && hw * zoom < avail - 48 ? host.internals.positionAbsolute.x + hw / 2 : bounds.x + bounds.width / 2;
            void flowViewportRef.current.setCenter(cx, bounds.y + bounds.height / 2, { zoom, ...glide(450) });
          },
        });
      }, 220);
    },
    [preferredHostFor, revealBlock, expandBlockRows, graphById, onDrillPanel, objectBounds],
  );

  jumpToRef.current = jumpTo;
  // Shift+L locks and unlocks the view. Not a bare letter: rows take single
  // keys for their own editing, and the board's other shortcuts are chords.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || e.key.toLowerCase() !== "l") return;
      const target = e.composedPath?.()[0] ?? e.target;
      if (e.isComposing || isTextEntryTarget(target)) return;
      e.preventDefault();
      toggleViewLock();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, toggleViewLock]);
  // A newly made opening or entry, or one arrived at from somewhere else: show
  // the block it lives in and hand the object to the column, which is where it
  // is written. This used to hunt the canvas for the row's textarea and focus
  // it; there is no textarea on the canvas any more, and the selection pass
  // below already pans a selected row into view.
  useEffect(() => {
    if (!writingFocusRequest || writingFocusRequest.documentKey !== blueprintDocumentKey) return;
    const { id } = writingFocusRequest;
    const host = preferredHostFor(id);
    if (host) revealBlock(host.host, host.ownerId);
    setRelationshipId(null);
    setSelection({ type: "node", id });
    setWritingFocusRequest(null);
    if (learningTarget.current?.id === id) learningTarget.current = null;
  }, [writingFocusRequest, blueprintDocumentKey, preferredHostFor, revealBlock]);
  const showObjectInBlueprint = useCallback((objectId: string) => {
    setRelationshipId(null);
    setQuery("");
    setBlueprintTarget({ objectId, documentKey: blueprintDocumentKey, sequence: ++blueprintTargetSequence.current });
  }, [blueprintDocumentKey]);
  const learningTarget = useRef<{ id: string; writing: boolean } | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const { canvasTarget, panelId } = (event as CustomEvent<{ canvasTarget?: LearningCanvasTarget; panelId: string }>).detail;
      if (!canvasTarget) return;
      const target = resolveLearningCanvasTarget(canvasTarget, blocksRef.current);
      if (!target) { onDrillPanel(panelId); return; }
      window.dispatchEvent(new CustomEvent(LEARNING_TARGET_EVENT, { detail: { id: target } }));
      learningTarget.current = { id: target, writing: canvasTarget !== "memory" };
      showObjectInBlueprint(target);
    };
    const cancel = () => {
      const target = learningTarget.current;
      if (!target) return;
      learningTarget.current = null;
      setBlueprintTarget(current => current?.objectId === target.id ? null : current);
      setWritingFocusRequest(current => current?.id === target.id ? null : current);
      cancelObjectCenter.current();
      if (focusTimer.current) clearTimeout(focusTimer.current);
    };
    window.addEventListener(LEARNING_CANVAS_EVENT, open);
    window.addEventListener(LEARNING_CANCEL_EVENT, cancel);
    return () => { learningTarget.current = null; window.removeEventListener(LEARNING_CANVAS_EVENT, open); window.removeEventListener(LEARNING_CANCEL_EVENT, cancel); };
  }, [showObjectInBlueprint, onDrillPanel]);
  // A lesson about a block moves the camera to it: the block framed whole,
  // read at full size when it fits, with the guide's room kept beside it.
  // A lesson about a control that is not on the board leaves the camera
  // where it is.
  useEffect(() => {
    const reveal = (event: Event) => {
      const { nodeId, kinds } = (event as CustomEvent<{ nodeId?: string; kinds?: readonly string[] }>).detail;
      if (!active || viewLockedRef.current) return;
      const flow = flowViewportRef.current;
      const ids = kinds
        ? flow.getNodes().filter((n) => !n.hidden && kinds.includes(flowNodeBlockKind(n) ?? "")).map((n) => n.id)
        : nodeId ? [nodeId] : [];
      if (!ids.length || !ids.every((id) => flow.getInternalNode(id)?.measured?.width)) return;
      cancelObjectCenter.current();
      if (focusTimer.current) clearTimeout(focusTimer.current);
      void frameLesson(new Set(ids), 300);
    };
    window.addEventListener(LEARNING_REVEAL_EVENT, reveal);
    return () => window.removeEventListener(LEARNING_REVEAL_EVENT, reveal);
  }, [active, frameLesson]);
  // The assistant started on a block that is off screen: bring it in, the
  // least pan that shows it — unless the creator touched the board in the
  // last few seconds, whose view is theirs.
  const lastBoardTouch = useRef(0);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const touch = () => { lastBoardTouch.current = Date.now(); };
    el.addEventListener("pointerdown", touch, true);
    el.addEventListener("wheel", touch, { capture: true, passive: true });
    return () => { el.removeEventListener("pointerdown", touch, true); el.removeEventListener("wheel", touch, true); };
  }, []);
  useEffect(() => {
    const follow = (event: Event) => {
      const { nodeId } = (event as CustomEvent<{ nodeId: string }>).detail;
      if (!active || viewLockedRef.current || Date.now() - lastBoardTouch.current < 4000) return;
      fitFocusedBlockRef.current(nodeId, 420);
    };
    window.addEventListener(AI_FOLLOW_EVENT, follow);
    return () => window.removeEventListener(AI_FOLLOW_EVENT, follow);
  }, [active]);
  // The guide's card found no clear spot beside its block: slide the board.
  useEffect(() => {
    const room = (event: Event) => {
      const { dx } = (event as CustomEvent<{ dx: number }>).detail;
      if (!active || viewLockedRef.current || !(dx > 0)) return;
      const flow = flowViewportRef.current;
      const vp = flow.getViewport();
      void flow.setViewport({ ...vp, x: vp.x - dx }, { duration: 250 });
    };
    window.addEventListener(LEARNING_ROOM_EVENT, room);
    return () => window.removeEventListener(LEARNING_ROOM_EVENT, room);
  }, [active]);
  // The guide's sample object, opened the way the author would open it: an
  // entry writes in place on its row, a variable or behaviour opens in the
  // column. Selecting nothing would leave a beginner looking at a name.
  useEffect(() => {
    const show = (event: Event) => {
      const { objectId, mode } = (event as CustomEvent<{ objectId: string; mode: "row" | "inspect" }>).detail;
      if (!active) return;
      const host = preferredHostFor(objectId);
      if (host) revealBlock(host.host, host.ownerId);
      if (mode === "row") setOpenRowId(objectId);
      else {
        // The lesson already framed its blocks; selecting must not re-aim
        // the board at the one row. A plain selection, not "newest": the
        // sample is something to read, and a name field focused with its
        // text selected invites the learner to type over it.
        focusSuppressedUntil.current = Date.now() + 1500;
        setSelection({ type: "node", id: objectId });
      }
    };
    window.addEventListener(LEARNING_SHOW_EVENT, show);
    return () => window.removeEventListener(LEARNING_SHOW_EVENT, show);
  }, [active, preferredHostFor, revealBlock]);
  useBlueprintTargetNavigation({
    request: blueprintTarget,
    documentKey: blueprintDocumentKey,
    active,
    viewportReady: rf.viewportInitialized,
    isViewportSettled,
    navigate: objectId => {
      jumpToRef.current(objectId);
      if (learningTarget.current?.id === objectId && learningTarget.current.writing) {
        setSelection(null);
        setWritingFocusRequest({ id: objectId, documentKey: blueprintDocumentKey });
      } else if (learningTarget.current?.id === objectId) {
        learningTarget.current = null;
      }
    },
    onComplete: completed => setBlueprintTarget(current => current === completed ? null : current),
  });
  focusModuleRef.current = (id) => {
    cancelObjectCenter.current();
    if (!focusedModule && !overviewViewport.current) overviewViewport.current = rf.getViewport();
    if (focusTimer.current) clearTimeout(focusTimer.current);
    setFocusedBlock(null);
    setFocusedModule(id);
    setSelection({ type: "node", id });
    const current = rf.getNode(id);
    if (current?.type === "gate" && !(current.data as GateNodeData).frame.open) toggleFrame(id);
    const epoch = fitViewEpoch.current.value;
    focusTimer.current = setTimeout(() => {
      if (epoch !== fitViewEpoch.current.value) return;
      const frame = rf.getNode(id);
      if (!frame || viewLockedRef.current) return;
      // A situation that fits on screen at reading size is fitted, as before.
      // A tall one used to be fitted too — shrunk until every word was too
      // small to read. Now it opens at 100% from its top, the way a page
      // does, and the creator scrolls down it.
      const pane = document.querySelector(".react-flow") as HTMLElement | null;
      const vw = pane?.clientWidth ?? 1200;
      const vh = pane?.clientHeight ?? 800;
      const w = frame.measured?.width ?? frame.width ?? 0;
      const h = frame.measured?.height ?? frame.height ?? 0;
      if (w * 1.12 <= vw && h * 1.12 + 120 <= vh) {
        void rf.fitView({ nodes: [frame], padding: 0.12, maxZoom: 1, ...glide(250) });
      } else {
        // Clear of the 「返回总览」 pill above the board.
        // A situation sits inside its group's box: its own position is
        // relative to that box, so the camera needs the absolute one.
        const abs = rf.getInternalNode(id)?.internals.positionAbsolute ?? frame.position;
        void rf.setViewport({ x: Math.max(24, (vw - w) / 2) - abs.x, y: 120 - abs.y, zoom: 1 }, glide(250));
      }
    }, 300);
  };
  focusBlockRef.current = (objId) => {
    // A lesson's camera is the lesson's: the row it opens, or the one the
    // learner adds with its 「+」, does not pull the board onto its block.
    if (learningStageRef.current || viewLockedRef.current || focusedModule || Date.now() < focusSuppressedUntil.current) return;
    if (objId.startsWith("module:")) return;
    const direct = blocksRef.current.find(block => block.id === objId);
    // A head shared by two blocks (the card is the head of its face and of
    // its background) goes to the block that was clicked.
    const preferred = preferredWritingHosts.current.get(objId);
    const headed = preferred ? blocksRef.current.find(block => block.id === preferred && block.head?.id === objId) : undefined;
    const hostId = direct ? direct.id : headed ? headed.id : preferredHostFor(objId)?.host;
    if (!hostId || !isBlockId(hostId)) return;
    // The block the camera is already on: nothing to do while it is in
    // view at reading size. Once the author has panned or zoomed away from
    // it, the same click brings it back — a second click on a block you
    // can no longer read should not be the one click that does nothing.
    if (focusedBlockRef.current === hostId) {
      if (blockInView(hostId)) return;
      fitFocusedBlockRef.current(hostId, 380);
      return;
    }
    if (!focusedBlockRef.current && !overviewViewport.current) overviewViewport.current = rf.getViewport();
    setFocusedBlock(hostId);
    if (focusTimer.current) clearTimeout(focusTimer.current);
    const epoch = fitViewEpoch.current.value;
    // A beat for the inspector column to open and the board to take its new
    // width; fitting before that centred on a frame that was about to shrink.
    focusTimer.current = setTimeout(() => {
      if (epoch !== fitViewEpoch.current.value || focusedBlockRef.current !== hostId) return;
      fitFocusedBlockRef.current(hostId, 380);
    }, 260);
  };
  /** Where a block sits and how large it can be read in the strip beside
   *  the column. Absolute bounds, read off React Flow's internals: every
   *  block is a child of its frame, so its `position` is relative to that
   *  frame, and fitting on the relative box landed the view a whole frame
   *  away. */
  const blockFit = (hostId: string) => {
    const flow = flowViewportRef.current;
    const internal = flow.getInternalNode(hostId);
    const abs = internal?.internals.positionAbsolute;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!abs || !internal.measured?.width || !internal.measured.height || !rect) return null;
    const left = insetsRef.current?.left ?? 0;
    const right = insetsRef.current?.right ?? 0;
    const availW = Math.max(240, rect.width - left - right);
    const availH = Math.max(240, rect.height - topChromeRef.current - BOTTOM_CHROME);
    const pad = 28;
    // Read the block at full size when it fits; a block wider than the strip
    // beside the inspector shrinks just enough to fit, never past the floor
    // where its rows stop being legible.
    const zoom = Math.max(MIN_READABLE_ZOOM, Math.min(1, (availW - pad * 2) / internal.measured.width, (availH - pad * 2) / internal.measured.height));
    return { abs, width: internal.measured.width, height: internal.measured.height, left, availW, availH, zoom, strip: { left, right: rect.width - right, top: topChromeRef.current, bottom: rect.height - BOTTOM_CHROME } };
  };
  /** Whole, and near the size a fit would read it at. */
  const blockInView = (hostId: string) => {
    const fit = blockFit(hostId);
    if (!fit) return true;
    const { x, y, zoom } = flowViewportRef.current.getViewport();
    const bx = fit.abs.x * zoom + x, by = fit.abs.y * zoom + y;
    // A block taller or wider than the strip is "in view" once its top-left
    // corner is: nothing more can be shown without zooming, and a click
    // never zooms.
    const w = Math.min(fit.width * zoom, fit.strip.right - fit.strip.left), h = Math.min(fit.height * zoom, fit.strip.bottom - fit.strip.top);
    return bx >= fit.strip.left && by >= fit.strip.top && bx + w <= fit.strip.right && by + h <= fit.strip.bottom;
  };
  /** Bring a clicked block into view without touching the zoom: the zoom
   *  is the author's. Already in view, nothing moves; otherwise the board
   *  pans the least it can. (It used to zoom every clicked block to reading
   *  size and zoom back out on an empty click, a zoom in and out on every
   *  other click, which people found dizzying.) */
  fitFocusedBlockRef.current = (hostId, duration) => {
    if (viewLockedRef.current || blockInView(hostId)) return;
    const fit = blockFit(hostId);
    if (!fit) return;
    const vp = flowViewportRef.current.getViewport();
    const zoom = vp.zoom, m = 16;
    const bx = fit.abs.x * zoom + vp.x, by = fit.abs.y * zoom + vp.y;
    const w = fit.width * zoom, h = fit.height * zoom;
    const { left, right, top, bottom } = fit.strip;
    let dx = 0, dy = 0;
    if (w > right - left - 2 * m || bx < left + m) dx = left + m - bx;
    else if (bx + w > right - m) dx = right - m - (bx + w);
    if (h > bottom - top - 2 * m || by < top + m) dy = top + m - by;
    else if (by + h > bottom - m) dy = bottom - m - (by + h);
    if (dx || dy) void flowViewportRef.current.setViewport({ x: vp.x + dx, y: vp.y + dy, zoom }, glide(duration));
  };
  leaveBlockFocusRef.current = () => {
    if (!focusedBlockRef.current) return;
    // Nor does a cleared selection hand back a view saved before the lesson.
    if (learningStageRef.current) { overviewViewport.current = null; setFocusedBlock(null); return; }
    if (focusTimer.current) clearTimeout(focusTimer.current);
    // The board stays where it is: nothing zoomed in on the way in, so there
    // is no overview to zoom back out to.
    overviewViewport.current = null;
    setFocusedBlock(null);
  };
  const leaveModuleFocus = () => {
    if (focusTimer.current) clearTimeout(focusTimer.current);
    const viewport = overviewViewport.current;
    overviewViewport.current = null;
    setFocusedModule(null);
    setSelection(null);
    if (viewport) void rf.setViewport(viewport, glide(250));
    else void fitBetweenDocks(250, true);
  };

  // Selection drives the focus: a row picked on the board, in the tree or
  // from a relationship all zoom to their block; a cleared selection (empty
  // canvas, Esc) restores the overview.
  useEffect(() => {
    const byClick = selection?.type === "node" && pickedByClickRef.current === selection.id;
    pickedByClickRef.current = null;
    if (byClick) return;
    if (selection?.type === "node") focusBlockRef.current(selection.id);
    else if (!selection) leaveBlockFocusRef.current();
  }, [selection]);
  useEffect(() => {
    if (!focusedBlock || !containerRef.current) return;
    // The first fit fires while the inspector column is still opening; each
    // resize after that re-centres the block in the strip that is left.
    let last = { w: 0, h: 0 };
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || (box.width === last.w && box.height === last.h)) return;
      const first = last.w === 0;
      last = { w: box.width, h: box.height };
      if (!first) fitFocusedBlockRef.current(focusedBlock, 200);
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [focusedBlock]);

  // The stage's content tree asks for objects by id — same jump the search
  // uses, reached by event so the tree needs none of the graph machinery.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ objId?: string; open?: boolean }>).detail;
      if (!detail?.objId) return;
      jumpTo(detail.objId);
      // Asked for by name to be worked on (a button's 「打开」 in the player
      // interface): opened, not only lit the way a search hit is.
      if (detail.open) selectOnlyRef.current = null;
    };
    const clearSelection = () => setSelection(null);
    window.addEventListener("yumina:studio-canvas-focus", handler);
    window.addEventListener("yumina:studio-canvas-clear-selection", clearSelection);
    return () => {
      window.removeEventListener("yumina:studio-canvas-focus", handler);
      window.removeEventListener("yumina:studio-canvas-clear-selection", clearSelection);
    };
  }, [jumpTo]);

  // ── Edge-color legend ──
  const [showLegend, setShowLegend] = useState(false);
  const legendRef = useRef<HTMLDivElement | null>(null);
  // Shut on a press outside it. Not a click-catching overlay: the legend is
  // read while pointing at rows, and an overlay would eat those hovers.
  useEffect(() => {
    if (!showLegend) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (legendRef.current?.contains(target)) return;
      if ((target as HTMLElement | null)?.closest?.("[data-blueprint-popover]")) return;
      setShowLegend(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [showLegend]);
  const [showDirectory, setShowDirectory] = useState(false);
  /** 「AI 分工表」 over the board. */
  const [showAiTable, setShowAiTable] = useState(false);
  const [batchMoveOpen, setBatchMoveOpen] = useState(false);
  // Both popovers close on any click outside them, the way the add menu does.
  useEffect(() => {
    if (!showDirectory && !batchMoveOpen) return;
    const onDown = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (el?.closest("[data-blueprint-popover]")) return;
      setShowDirectory(false);
      setBatchMoveOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    return () => window.removeEventListener("pointerdown", onDown, true);
  }, [showDirectory, batchMoveOpen]);

  // ── Context menus — right-click is how node editors breathe ──
  type Menu = { keyboardTrigger?: HTMLElement } & (
    | { kind: "pane"; x: number; y: number; flow: { x: number; y: number }; ownerId?: string; stickOn?: string }
    | { kind: "node"; x: number; y: number; id: string; ownerId?: string }
    | { kind: "edge"; x: number; y: number; id: string });
  const [menu, setMenu] = useState<Menu | null>(null);
  /** 移到's list, open under it inside the right-click menu. */
  const [menuMoveOpen, setMenuMoveOpen] = useState(false);
  useEffect(() => { if (!menu) setMenuMoveOpen(false); }, [menu]);
  /** The toolbar's ＋ menu — the pane context menu's add section, visible. */
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  // Esc shuts whichever toolbar menu is open, as it does every other menu:
  // these two hold their own state, and the key used to do nothing.
  useEffect(() => {
    if (!viewMenuOpen && !addMenuOpen) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setViewMenuOpen(false);
      setAddMenuOpen(false);
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  }, [viewMenuOpen, addMenuOpen]);
  useEffect(() => {
    const close = () => { setAddMenuOpen(false); setViewMenuOpen(false); };
    window.addEventListener(LEARNING_STEP_EVENT, close);
    return () => window.removeEventListener(LEARNING_STEP_EVENT, close);
  }, []);
  useEffect(() => {
    if (!addMenuOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); setAddMenuOpen(false); } };
    window.addEventListener("keydown", close, true);
    return () => window.removeEventListener("keydown", close, true);
  }, [addMenuOpen]);
  /** The big centred editor, open on one entry's text ("expand editor"). */
  const [focusEdit, setFocusEdit] = useState<string | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const localPoint = useCallback((e: Parameters<typeof blueprintMenuAnchor>[0]) => {
    return blueprintMenuAnchor(e, containerRef.current?.getBoundingClientRect());
  }, []);

  const onPaneContextMenu = useCallback(
    (e: React.MouseEvent | MouseEvent) => {
      e.preventDefault();
      if (readOnly) return;
      const p = localPoint(e);
      setMenu({ kind: "pane", ...p, flow: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
    },
    [localPoint, readOnly, rf],
  );
  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: BlueprintNode) => {
      e.preventDefault();
      if (readOnly) return;
      setSelection({ type: "node", id: node.id });
      // A block's body or the card's frame is no one object to open, copy
      // or delete: right-clicking it offers what can be added, the way the
      // empty canvas does.
      if (node.id.startsWith("block:") || node.id.startsWith("frame:")) {
        // A paste from here lands in the situation the block is part of.
        const ownerId = node.parentId?.startsWith("module:") ? node.parentId.slice("module:".length) : undefined;
        setMenu({ kind: "pane", ...localPoint(e), flow: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }), ...(ownerId ? { ownerId } : {}), stickOn: node.id });
        return;
      }
      setMenu({ kind: "node", ...localPoint(e), id: node.id });
    },
    [localPoint, readOnly, rf],
  );
  const onEdgeContextMenu = useCallback(
    (e: React.MouseEvent, edge: Edge) => {
      e.preventDefault();
      if (readOnly) return;
      setMenu({ kind: "edge", ...localPoint(e), id: graphEdgeId(edge) });
    },
    [localPoint, readOnly],
  );

  /** Right-click on a row. It never reaches React Flow's node handler — the
   *  row swallows it — so the block calls this directly. */
  const onRowContextMenu = useCallback(
    (objId: string, e: React.MouseEvent, ownerId?: string) => {
      e.preventDefault();
      e.stopPropagation();
      if (readOnly) return;
      // The frame the row was clicked in: a shared row is the same object in
      // every module, so "only in this module" needs to know which one.
      setMenu({ kind: "node", ...localPoint(e), id: objId, ...(ownerId ? { ownerId } : {}) });
    },
    [localPoint, readOnly],
  );

  /**
   * Put one entry where another one sits.
   *
   * The prompt sends entries in `position` order and the board now draws that
   * same order, so dragging a row onto another row IS reordering the prompt —
   * the one thing about an entry the canvas could show and could not change.
   *
   * Entries only. A behaviour's firing order is `priority`, not its place in
   * the array, and variables have no order at all; dragging one of those still
   * means "re-home into that module", which the frame underneath handles.
   *
   * The whole SECTION is renumbered rather than just the block. A block is one
   * trigger class, but the prompt sorts within a section — numbering only what
   * is on screen would collide with the entries that are not.
   */
  const reorderEntries = useCallback((draggedId: string, targetId: string) => {
    if (!draggedId.startsWith("entry:") && !draggedId.startsWith("greeting:")) return;
    const from = draggedId.slice(draggedId.indexOf(":") + 1);
    const to = targetId.slice(targetId.indexOf(":") + 1);
    if (from === to) return;
    const store = useEditorStore.getState();
    const all = store.worldDraft.entries;
    const moved = all.find((e) => e.id === from);
    const anchor = all.find((e) => e.id === to);
    if (!moved || !anchor) return;
    // Both ends have to live in the same section for "put it here" to mean
    // anything the prompt will honour.
    const section = moved.section ?? "system-presets";
    if ((anchor.section ?? "system-presets") !== section) return;

    const ordered = all
      .filter((e) => (e.section ?? "system-presets") === section)
      .map((e, i) => ({ e, i }))
      .sort((x, y) => (x.e.position ?? Infinity) - (y.e.position ?? Infinity) || x.i - y.i)
      .map((x) => x.e);
    const without = ordered.filter((e) => e.id !== from);
    const at = without.findIndex((e) => e.id === to);
    if (at < 0) return;
    without.splice(at, 0, moved);
    // Renumbering touches every entry in the section; it is still one move.
    inOneUndoStep(() => {
      without.forEach((e, i) => {
        if (e.position !== i) store.updateEntry(e.id, { position: i });
      });
    });
    // Picked where it landed, lit gold — not opened, and the board stays
    // where the author let go of it.
    selectOnlyRef.current = draggedId;
    pickedByClickRef.current = draggedId;
    setSelection({ type: "node", id: draggedId });
  }, []);

  // A block head renders before these exist, so it reaches them through a
  // ref rather than forcing the whole flow to rebuild when they change.
  blockActionsRef.current.onAdd = addToBlock;
  blockActionsRef.current.addOpening = () => addInto("opening", undefined);
  blockActionsRef.current.addSetting = () => addInto("lore", undefined);
  blockActionsRef.current.onRowContextMenu = onRowContextMenu;
  /** A row dropped on a row. In the same frame it is reordered; dropped on
   *  a row of another frame (a situation, the card) it moves there first —
   *  the frame is where it lands, so an outside object switches on the
   *  moment it is dropped anywhere inside one. Only entries have an order. */
  const rowDrop = useCallback((draggedId: string, targetId: string) => {
    const nodes = graphRef.current.nodes;
    const dragged = nodes.find((n: GraphNode) => n.id === draggedId);
    const target = nodes.find((n: GraphNode) => n.id === targetId);
    if (dragged && target && dragged.parentId !== target.parentId
      && (dragged.kind === "entry" || dragged.kind === "variable" || dragged.kind === "rule")) {
      inOneUndoStep(() => {
        applyGraphPatch({ op: "set-parent", nodeId: draggedId, parentId: target.parentId });
        setLoose(draggedId, null);
      });
      flashRecent([draggedId]);
    }
    reorderEntries(draggedId, targetId);
  }, [applyGraphPatch, setLoose, flashRecent, reorderEntries]);
  blockActionsRef.current.onRowDrop = rowDrop;

  // ── Sticky notes: canvas-only annotations (graphLayout.notes) ──
  const notes = worldDraft.graphLayout?.notes ?? [];
  const noteSaveRef = useRef<number | null>(null);
  const writeNotes = useCallback(
    (next: NonNullable<GraphLayout["notes"]>) => {
      if (readOnly) return;
      const cur = useEditorStore.getState().worldDraft.graphLayout;
      setGraphLayout({ version: GRAPH_LAYOUT_VERSION, nodes: cur?.nodes ?? {}, notes: next });
      // Outside AIs read the saved card: a note reaches them within seconds,
      // not at the next minute-long autosave.
      if (noteSaveRef.current) window.clearTimeout(noteSaveRef.current);
      noteSaveRef.current = window.setTimeout(() => {
        const st = useEditorStore.getState();
        if ((st.isDirty || st.layoutDirty) && !st.saving && st.serverWorldId) void st.saveDraft();
      }, 2500);
    },
    [readOnly, setGraphLayout],
  );
  const addNote = useCallback(
    (at: { x: number; y: number }) => {
      const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      writeNotes([...notes, { id, x: at.x, y: at.y, ...NOTE_SIZE, text: "" }]);
      setEditingNoteId(id);
    },
    [notes, writeNotes],
  );
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  /** A note stuck to things on the board — rows, AIs, blocks, scenarios —
   *  standing beside the first and threaded to each (owner, 10/6). */
  const addNoteOn = useCallback(
    (targets: string[]) => {
      const id = `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const latest = useEditorStore.getState().worldDraft.graphLayout?.notes ?? [];
      writeNotes([...latest, { id, x: 0, y: 0, ...NOTE_SIZE, text: "", targets }]);
      setEditingNoteId(id);
    },
    [writeNotes],
  );
  addNoteOnRef.current = (target: string) => addNoteOn([target]);
  /** The things a note started from here sticks to: the whole selection when
   *  this is part of it, otherwise this one. */
  const noteTargetsFor = useCallback((id: string): string[] => {
    const multi = multiSelectedRef.current;
    return multi.has(id) && multi.size > 1 ? [...multi] : [id];
  }, []);
  /** Where a row that is not drawn (its block folded) has its note instead. */
  const noteHostOf = useCallback((id: string): string | null => {
    const host = canvasBlockHostMap(blocksRef.current, graphRef.current).get(id)?.host;
    return host ?? null;
  }, []);
  /** 加东西 → 便签: stuck to everything selected, or to what is picked, or
   *  loose in the middle of the view. */
  const addStickyNote = useCallback(() => {
    const multi = multiSelectedRef.current;
    if (multi.size > 0) { addNoteOn([...multi]); return; }
    const picked = selectionRef.current?.id;
    if (picked) { addNoteOn([picked]); return; }
    const host = containerRef.current?.getBoundingClientRect();
    const at = host ? rf.screenToFlowPosition({ x: host.left + host.width / 2 - 110, y: host.top + host.height / 3 }) : { x: 0, y: 0 };
    addNote(at);
  }, [addNoteOn, addNote, rf]);

  const deleteNodeById = useCallback(
    (nodeId: string) => {
      if (readOnly || !isDeletableObject(nodeId)) return;
      const store = useEditorStore.getState();
      const id = nodeId.slice(nodeId.indexOf(":") + 1);
      if (nodeId.startsWith("var:")) {
        const idx = store.worldDraft.variables.findIndex((v) => v.id === id);
        if (idx >= 0) store.removeVariableAt(idx);
      } else if (nodeId.startsWith("reaction:")) {
        store.removeReaction(id);
      } else if (nodeId.startsWith("module:")) {
        store.removeWorldbook(id);
      } else {
        store.removeEntry(id);
      }
      setSelection((cur) => (cur?.id === nodeId ? null : cur));
    },
    [readOnly],
  );

  /** Deletes as one undo step. A situation (what it held falls back onto the
   *  card) or several things at once also get a pill to take it back: the
   *  keyboard is the only other way, and nothing on screen says so. */
  const deleteObjects = useCallback((ids: Iterable<string>) => {
    const doomed = [...new Set(ids)].filter((id) => isDeletableObject(id));
    if (readOnly || doomed.length === 0) return;
    const situation = doomed.find((id) => id.startsWith("module:"));
    const draft = useEditorStore.getState().worldDraft;
    const bookId = situation?.slice("module:".length);
    const name = bookId && draft.worldbooks?.find((w) => w.id === bookId)?.name;
    const held = !!bookId && [...draft.entries, ...draft.variables, ...(draft.reactions ?? [])].some((item) => item.worldbookId === bookId);
    inOneUndoStep(() => {
      for (const id of doomed) deleteNodeById(id);
    });
    if (!situation && doomed.length < 2) return;
    const past = useEditorStore.getState()._past;
    const before = past[past.length - 1];
    feedback.undo(
      doomed.length > 1 ? t("blueprint.deletedMany", { count: doomed.length })
        : t(held ? "blueprint.deletedSituation" : "blueprint.deletedSituationEmpty", { name: name || "" }),
      () => {
        // Only while the delete is still the last thing done.
        const store = useEditorStore.getState();
        if (before && store._past[store._past.length - 1] === before) store.undo();
      },
    );
  }, [readOnly, deleteNodeById, t]);
  const onNodesDelete = useCallback(
    (nodes: BlueprintNode[]) => deleteObjects(nodes.map((n) => n.id)),
    [deleteObjects],
  );
  const deleteMulti = useCallback(() => {
    deleteObjects(multiSelected);
    setMultiSelected(EMPTY_MULTI);
  }, [multiSelected, deleteObjects]);

  /** Where the selection's bar floats: just above what is selected, the way
   *  Figma and PowerPoint put it, re-read while the board moves under it. */
  const [batchPos, setBatchPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (multiSelected.size === 0) { setBatchPos(null); return; }
    const measure = () => {
      const host = containerRef.current;
      if (!host) return;
      const box = host.getBoundingClientRect();
      let top = Infinity, left = Infinity, right = -Infinity;
      for (const id of multiSelected) {
        const esc = CSS.escape(id);
        for (const el of host.querySelectorAll<HTMLElement>(`[data-row-anchor="${esc}"], [data-canvas-writing-object="${esc}"]`)) {
          const r = el.getBoundingClientRect();
          if (!r.width) continue;
          top = Math.min(top, r.top); left = Math.min(left, r.left); right = Math.max(right, r.right);
        }
      }
      if (!Number.isFinite(top)) { setBatchPos(null); return; }
      const x = Math.max(120, Math.min(box.width - 120, (left + right) / 2 - box.left));
      const y = Math.max(8, top - box.top - 46);
      setBatchPos((prev) => (prev && Math.abs(prev.x - x) < 1 && Math.abs(prev.y - y) < 1 ? prev : { x, y }));
    };
    measure();
    const timer = setInterval(measure, 200);
    return () => clearInterval(timer);
  }, [multiSelected]);

  const openingRowRef = useRef<{ id: string; held: string } | null>(null);
  /** A picked setting or opening takes typing the way a picked cell does:
   *  the first key opens it in place and lands in its text, Enter opens it,
   *  and Backspace starts editing rather than deleting the whole setting
   *  (Delete still deletes). Without this a first click only lit the row,
   *  and the words typed after it went nowhere. Runs ahead of the Delete
   *  handler below. */
  useEffect(() => {
    if (!active || readOnly) return;
    const id = selection?.type === "node" && /^(entry|greeting):/.test(selection.id) && multiSelected.size === 0 ? selection.id : null;
    if (!id || (openRowId === id && openingRowRef.current?.id !== id)) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.composedPath?.()[0] ?? e.target;
      // A real text field only: the row itself sits in a .nokey wrapper (so
      // the board's own shortcuts leave it alone), and that is exactly where
      // focus is after the click that picked it.
      if (target instanceof Element && target.closest('input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])')) return;
      // Space stays the board's: held, it pans.
      const typed = e.key.length === 1 && e.key !== " " ? e.key : null;
      if (!typed && e.key !== "Enter" && e.key !== "Process" && e.key !== "Backspace") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      // Keys typed while the row is still opening are held and land with the
      // first one, so a fast typist loses nothing.
      if (openingRowRef.current?.id === id) { openingRowRef.current.held += typed ?? ""; return; }
      openingRowRef.current = { id, held: typed ?? "" };
      setOpenRowId(id);
      let tries = 0;
      const land = () => {
        const box = document.querySelector<HTMLTextAreaElement>(`[data-canvas-writing-editor="${CSS.escape(id)}"] textarea`);
        if (!box && ++tries < 40) { requestAnimationFrame(land); return; }
        const held = openingRowRef.current?.id === id ? openingRowRef.current.held : "";
        openingRowRef.current = null;
        if (!box) return;
        box.focus();
        if (held) {
          // The field is React's: set it the way an input event would, so its
          // own state takes the letters.
          const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
          setValue?.call(box, box.value + held);
          box.dispatchEvent(new Event("input", { bubbles: true }));
        }
        box.setSelectionRange(box.value.length, box.value.length);
      };
      requestAnimationFrame(land);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [active, readOnly, selection, multiSelected, openRowId]);

  /** Rows share flow nodes, so they need a separate Delete handler.
   * Form controls keep their own keys, without deleting a canvas selection. */
  useEffect(() => {
    if (!active || readOnly) return;
    const single = selection?.type === "node" && !isBlockId(selection.id) && isDeletableObject(selection.id) ? selection.id : null;
    const batch = [...multiSelected].filter((id) => isDeletableObject(id));
    if (!single && batch.length === 0) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      // ReactFlow prevents the document event even when the selected object
      // is one of our rows, so defaultPrevented cannot suppress this handler.
      const target = e.composedPath?.()[0] ?? e.target;
      if (e.isComposing || isTextEntryTarget(target)) return;
      if (!isCanvasRowTarget(target) && isInteractiveDeleteTarget(target)) return;
      e.preventDefault();
      deleteObjects(single ? [...batch, single] : batch);
      if (batch.length > 0) setMultiSelected(EMPTY_MULTI);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, selection, multiSelected, readOnly, deleteObjects]);

  // Esc lets go of what is picked. Menus, forms and editors open over the
  // board take the key first and mark it handled.
  useEffect(() => {
    if (!active || (!selection && multiSelected.size === 0)) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (isTextEntryTarget(e.composedPath?.()[0] ?? e.target)) return;
      setSelection(null);
      setMultiSelected(EMPTY_MULTI);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, selection, multiSelected]);

  /**
   * Copy and paste, across modules.
   *
   * The board already had "duplicate" in the right-click menu, which makes a
   * copy where the original sits. That is the wrong verb for the thing
   * creators actually want: moving a setting they wrote in one module into
   * another without typing it again. Paste is that verb, and its whole value
   * is the destination — so it pastes into whichever module the selection is
   * in, and onto the card when the selection is the card's.
   */
  const clipboardRef = useRef<string[]>([]);
  const duplicateNodeByIdRef = useRef<(nodeId: string) => void>(() => {});

  /** A copy of one object, returned rather than selected: a multi-paste must
   *  not leave the selection jumping to each new thing in turn. */
  const copyObject = useCallback((objId: string): string | null => {
    const store = useEditorStore.getState();
    const id = objId.slice(objId.indexOf(":") + 1);
    const mark = t("blueprint.copySuffix");
    if (objId.startsWith("var:")) {
      const made = store.duplicateVariable(id, mark);
      return made ? `var:${made}` : null;
    }
    if (objId.startsWith("reaction:")) {
      const made = store.duplicateReaction(id, mark);
      return made ? `reaction:${made}` : null;
    }
    const src = store.worldDraft.entries.find((e) => e.id === id);
    if (!src) return null;
    const made = store.duplicateEntry(id, mark);
    return made ? `${src.role === "greeting" ? "greeting" : "entry"}:${made}` : null;
  }, [t]);

  /** 复制 on the selection's bar: a copy of each beside its original, the
  *  copies selected instead, in one undo step. */
  const duplicateMulti = useCallback(() => {
    const made: string[] = [];
    inOneUndoStep(() => {
      for (const id of multiSelected) {
        if (!isDeletableObject(id) || id.startsWith("module:")) continue;
        const copy = copyObject(id);
        if (copy) made.push(copy);
      }
    });
    if (made.length === 0) return;
    flashRecent(made);
    setMultiSelected(new Set(made));
  }, [multiSelected, copyObject, flashRecent]);

  /** Holds `ids` for the next paste. A situation is not copied this way
   *  (paste has nothing to make from one), so it is not counted as copied. */
  const copyIds = useCallback((ids: string[]): boolean => {
    const picked = ids.filter((id) => isDeletableObject(id) && !id.startsWith("module:"));
    if (picked.length === 0) return false;
    clipboardRef.current = picked;
    feedback.notice(t("blueprint.clipboard.copied", { count: picked.length }));
    return true;
  }, [t]);
  /** Where a paste next to `anchorId` lands: the module it lives in, or the card. */
  const ownerOf = useCallback((anchorId: string | null): string | undefined => {
    const anchorNode = anchorId ? graphRef.current.nodes.find((n: GraphNode) => n.id === anchorId) : undefined;
    return anchorNode?.parentId?.startsWith("module:") ? anchorNode.parentId : undefined;
  }, []);
  const pasteInto = useCallback((owner: string | undefined): boolean => {
    const held = clipboardRef.current;
    if (held.length === 0) return false;
    const made: string[] = [];
    // Each copy is a duplicate plus a re-home; the whole paste is one step.
    inOneUndoStep(() => {
      for (const objId of held) {
        const copy = copyObject(objId);
        if (!copy) continue;
        applyGraphPatch({ op: "set-parent", nodeId: copy, parentId: owner });
        made.push(copy);
      }
    });
    if (made.length === 0) return true;
    // The board is large and a paste lands wherever its block already is,
    // so say where: without the flash the creator has to go looking.
    flashRecent(made);
    setSelection({ type: "node", id: made[made.length - 1]! });
    feedback.notice(t("blueprint.clipboard.pasted", { count: made.length }));
    return true;
  }, [copyObject, applyGraphPatch, flashRecent, t]);

  /** Ctrl+A: everything on screen in the frame the selection is in — or, with
   *  nothing picked, everything on screen. Only rows that are drawn: a row
   *  in a folded block is not something the creator can see being picked,
   *  and a Delete after Ctrl+A must not reach it. */
  const selectAllVisible = useCallback(() => {
    const host = containerRef.current;
    if (!host) return false;
    const anchorId = selection?.type === "node" ? selection.id : multiSelected.size > 0 ? [...multiSelected][0]! : null;
    const scope = anchorId ? graphRef.current.nodes.find((n: GraphNode) => n.id === anchorId)?.parentId ?? null : null;
    const scoped = anchorId !== null;
    const ids = new Set<string>();
    for (const el of host.querySelectorAll<HTMLElement>("[data-row-anchor], [data-canvas-writing-object]")) {
      const id = el.dataset.rowAnchor ?? el.dataset.canvasWritingObject;
      if (!id || !isDeletableObject(id) || id.startsWith("module:")) continue;
      if (!el.getBoundingClientRect().width) continue;
      if (scoped && (graphRef.current.nodes.find((n: GraphNode) => n.id === id)?.parentId ?? null) !== scope) continue;
      ids.add(id);
    }
    if (ids.size === 0) return false;
    setSelection(null);
    setMultiSelected(ids);
    return true;
  }, [selection, multiSelected]);

  useEffect(() => {
    if (!active || readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.isComposing) return;
      const key = e.key.toLowerCase();
      if (key !== "c" && key !== "v" && key !== "a" && key !== "d") return;
      // Never steal the shortcut from a field the creator is typing in — the
      // whole board is full of them.
      const target = e.composedPath?.()[0] ?? e.target;
      if (isTextEntryTarget(target)) return;
      if (key !== "a" && typeof window !== "undefined" && (window.getSelection()?.toString() ?? "")) return;

      if (key === "a") {
        if (selectAllVisible()) e.preventDefault();
        return;
      }
      const picked = multiSelected.size > 0
        ? [...multiSelected]
        : selection?.type === "node" && !isBlockId(selection.id)
          ? [selection.id]
          : [];
      if (key === "c") {
        if (copyIds(picked)) e.preventDefault();
        return;
      }
      if (key === "d") {
        // 创建副本, the way Figma binds it — and the browser's bookmark
        // shortcut is no use on the board.
        if (picked.length === 0) return;
        e.preventDefault();
        if (multiSelected.size > 0) duplicateMulti();
        else duplicateNodeByIdRef.current(picked[0]!);
        return;
      }
      if (pasteInto(ownerOf(selection?.type === "node" ? selection.id : null))) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, readOnly, selection, multiSelected, copyIds, pasteInto, ownerOf, selectAllVisible, duplicateMulti]);

  /** 放到最前: the entries go to the top of their section — the top of the
   *  block they sit in, and first in the prompt — in the order they had. */
  const bringToFront = useCallback((ids: string[]) => {
    const store = useEditorStore.getState();
    const lifted = new Set(ids.filter((id) => id.startsWith("entry:") || id.startsWith("greeting:")).map((id) => id.slice(id.indexOf(":") + 1)));
    if (lifted.size === 0) return;
    const all = store.worldDraft.entries;
    const sections = new Set(all.filter((e) => lifted.has(e.id)).map((e) => e.section ?? "system-presets"));
    inOneUndoStep(() => {
      for (const section of sections) {
        const ordered = all
          .filter((e) => (e.section ?? "system-presets") === section)
          .map((e, i) => ({ e, i }))
          .sort((x, y) => (x.e.position ?? Infinity) - (y.e.position ?? Infinity) || x.i - y.i)
          .map((x) => x.e);
        const next = [...ordered.filter((e) => lifted.has(e.id)), ...ordered.filter((e) => !lifted.has(e.id))];
        next.forEach((e, i) => {
          if (e.position !== i) store.updateEntry(e.id, { position: i });
        });
      }
    });
    flashRecent(ids);
  }, [flashRecent]);

  /** Copies preserve authored behavior, regardless of which editor starts it. */
  const duplicateNodeById: (nodeId: string) => void = useCallback(
    (nodeId: string) => {
      if (readOnly || !isDeletableObject(nodeId) || nodeId.startsWith("module:")) return;
      const store = useEditorStore.getState();
      const id = nodeId.slice(nodeId.indexOf(":") + 1);
      const copyMark = t("blueprint.copySuffix");
      if (nodeId.startsWith("var:")) {
        const created = store.duplicateVariable(id, copyMark);
        if (created) setSelection({ type: "node", id: `var:${created}` });
        return;
      }
      if (nodeId.startsWith("reaction:")) {
        const created = store.duplicateReaction(id, copyMark);
        if (created) setSelection({ type: "node", id: `reaction:${created}` });
        return;
      }
      const src = store.worldDraft.entries.find((e) => e.id === id);
      if (!src) return;
      const created = store.duplicateEntry(id, copyMark);
      if (created) setSelection({ type: "node", id: `${src.role === "greeting" ? "greeting" : "entry"}:${created}` });
    },
    [readOnly, t],
  );
  duplicateNodeByIdRef.current = duplicateNodeById;

  // ── Inspector target derivation ──
  const inspectorTarget: InspectorTarget | null = useMemo(() => {
    if (!active || !selection) return null;
    if (selection.type === "node") {
      const resolved = resolveCanvasInspectorNode(selection.id, graph.nodes);
      const g = resolved?.node;
      // A list block as a whole — "N more" on a tile: the column lists
      // everything the block holds, which the tile no longer has room for.
      if (!g && isBlockId(selection.id)) {
        const block = blocks.find((b) => b.id === selection.id) ?? blocks.find((b) => b.sourceBlockId === selection.id);
        const listKinds: ReadonlyArray<Block["kind"]> = ["lore", "state", "behavior", "audio", "image", "opening"];
        if (!block || block.head || !listKinds.includes(block.kind)) return null;
        const sourceId = block.sourceBlockId ?? block.id;
        const rows = graph.nodes
          .filter((n) => blockIdForNode(n) === sourceId)
          .map((n) => ({ id: n.id, title: displayTitle(n), kind: n.kind, hint: previewFor(n) }));
        const title = block.kind === "lore"
          ? String(t(("blueprint.blocks.lore." + (block.trigger ?? "manual")) as never))
          : String(t(("blueprint.blocks." + block.kind) as never));
        return { type: "block", blockId: block.id, title, rows };
      }
      // Selecting a frontend still highlights its wires. Its real editor is
      // opened by the edit action; a second pane describing it adds no value.
      if (!g || g.kind === "event" || g.id === "frontend") return null;
      // A setting, an opening, a scene image: the text IS the thing, and it
      // opens in its own row on the board — no second copy anywhere else.
      if (!resolved?.section && canEditRowInline(g.id)) return null;
      return { type: "node", node: g, title: displayTitle(g), kindLabel: t(`blueprint.kinds.${g.kind}` as never), section: resolved?.section };
    }
    const e = graph.edges.find((x) => x.id === selection.id);
    if (!e) return null;
    const from = graphById.get(e.from);
    const to = graphById.get(e.to);
    const describe = `${from ? displayTitle(from) : e.from} → ${to ? displayTitle(to) : e.to}${e.label ? `  (${e.label})` : ""}`;
    return { type: "edge", edgeId: e.id, describe };
  }, [active, selection, graph, graphById, displayTitle, t]);
  const expandedObjectId = inspectorTarget?.type === "node" && !inspectorTarget.section && drillPanelFor(inspectorTarget.node, interfaceIsHandwritten)
    ? inspectorTarget.node.id
    : null;
  const expandInspector = expandedObjectId ? () => drillObject(expandedObjectId) : undefined;
  const drillFromInspector = (panelId: string) => {
    if (inspectorTarget?.type === "node" && drillPanelFor(inspectorTarget.node, interfaceIsHandwritten)?.panelId === panelId) {
      drillObject(inspectorTarget.node.id);
    } else {
      openPanel(panelId);
    }
  };

  const closeAuxiliary = () => { setRelationshipId(null); setSelection(null); };
  const configureObject = (id: string) => {
    setRelationshipId(null);
    if (graphById.has(id) && id !== "frontend") setSelection({ type: "node", id });
    else jumpTo(id);
  };
  /** What a wire could reach from this object, and what could reach it: the
   *  rules a dragged handle is held to, as a list for the panel's "+ relation". */
  const relationCandidatesFor = useCallback((objectId: string): RelationCandidate[] => {
    const out: RelationCandidate[] = [];
    const probe = { sourceHandle: null, targetHandle: null };
    for (const n of graph.nodes as GraphNode[]) {
      if (n.id === objectId || n.kind === "event" || isBlockId(n.id)) continue;
      if (parentPatchFor({ source: objectId, target: n.id, ...probe }) || connectionPatch({ source: objectId, target: n.id, ...probe })) out.push({ id: n.id, title: n.title, kind: n.kind, direction: "outgoing" });
      if (parentPatchFor({ source: n.id, target: objectId, ...probe }) || connectionPatch({ source: n.id, target: objectId, ...probe })) out.push({ id: n.id, title: n.title, kind: n.kind, direction: "incoming" });
    }
    return out;
  }, [graph]);
  const renderInspector = (ownColumn = false) => inspectorTarget ? <BlueprintInspector
    target={inspectorTarget} world={worldDraft} graph={graph} readOnly={readOnly} onPatch={applyGraphPatch}
    onDrill={drillFromInspector} onExpand={expandInspector} onShowRelations={showRelationships} onClose={closeAuxiliary}
    onOpenMemory={id => { setRelationshipId(null); setSelection({ type: "node", id: blockId.context(id) }); }}
    onOpenModule={id => { setRelationshipId(null); setSelection({ type: "node", id: `module:${id}` }); }}
    onOpenObject={id => { setRelationshipId(null); jumpTo(id); }}
    width={ownColumn ? inspectorWidth : undefined} onResize={ownColumn ? commitInspectorWidth : undefined}
    autoFocusName={inspectorTarget.type === "node" && inspectorTarget.node.id === newObjectId && newObjectId?.startsWith("var:") === true}
  /> : null;
  const visibleRelationshipId = active && selection?.type === "node" && selection.id === relationshipId ? relationshipId : null;
  const auxiliaryPane = visibleRelationshipId ? <ObjectRelationshipsPanel
    key={visibleRelationshipId} world={worldDraft} graph={graph} objectId={visibleRelationshipId}
    onOpenObject={id => { setRelationshipId(null); jumpTo(id); }} onEditObject={configureObject}
    onShowInBlueprint={showObjectInBlueprint} onClose={closeAuxiliary}
    readOnly={readOnly}
    candidates={relationCandidatesFor(visibleRelationshipId)}
    onAdd={(targetId, direction) => {
      const conn: Connection = direction === "outgoing"
        ? { source: visibleRelationshipId, target: targetId, sourceHandle: null, targetHandle: null }
        : { source: targetId, target: visibleRelationshipId, sourceHandle: null, targetHandle: null };
      const patch = parentPatchFor(conn) ?? connectionPatch(conn);
      if (patch) applyGraphPatch(patch);
    }}
    onRemove={edgeIds => inOneUndoStep(() => { for (const id of edgeIds) if (!isDerivedEdge(id)) applyGraphPatch({ op: "remove-edge", edgeId: id }); })}
    onSelectRelated={ids => selectPieces(ids, false)}
  /> : inspectorTarget && !floatsBeside(inspectorTarget) ? renderInspector() : null;
  /** The small ones stand beside the row on the board instead. */
  const floatingPane = !visibleRelationshipId && inspectorTarget && floatsBeside(inspectorTarget) ? renderInspector() : null;
  // Content editing and relationship inspection share the same auxiliary slot.
  const inspectorOpen = auxiliaryPane !== null;
  useEffect(() => {
    onInspectorChange?.(inspectorOpen);
  }, [inspectorOpen, onInspectorChange]);

  // Selecting a row must never bury it under the inspector: nudge the
  // viewport just enough to keep the block it lives in beside the drawer.
  const selectedNodeId = selection?.type === "node" ? (preferredHostFor(selection.id)?.host ?? selection.id) : null;
  const floatingAnchor = (): FloatingAnchor => {
    const root = containerRef.current;
    if (!root || !selection) return { row: null, host: null };
    if (selection.type === "edge") {
      const edge = root.querySelector(`.react-flow__edge[data-id="${CSS.escape(selection.id)}"]`);
      const box = edge?.getBoundingClientRect() ?? null;
      return { row: box, host: box };
    }
    const hostId = selectedNodeId ?? selection.id;
    const host = root.querySelector(`.react-flow__node[data-id="${CSS.escape(hostId)}"]`)?.getBoundingClientRect() ?? null;
    const row = objectRowElement(selection.id, hostId)?.getBoundingClientRect() ?? null;
    return { row, host };
  };
  useEffect(() => {
    if (!selectedNodeId || !inspectorOpen || viewLockedRef.current) return;
    // A staged lesson frames its own block beside the column, and the
    // behaviour it opens there is already in the clear; a nudge on top of
    // that fought the frame's animation and left the block at the edge.
    if (learningStageRef.current) return;
    let raf = 0;
    // A just-created node is neither registered nor measured on the next
    // frame, so a single rAF gives up before it exists and the new object is
    // left off-screen — the add looks like it did nothing. Keep looking.
    const deadline = performance.now() + 600;
    // A new row is drawn only after the store, the graph, the blocks and the
    // formation have each had their turn, which is well past 600ms on a
    // development build of a full card.
    const rowDeadline = performance.now() + 2500;
    const attempt = () => {
      // A focused block is already placed whole beside the drawer by the
      // block focus, which also follows the container as it resizes; nudging
      // on top of that fought its animation and left the block off-screen.
      if (focusedBlockRef.current) return;
      const rect = containerRef.current?.getBoundingClientRect();
      // A row that is not drawn yet must not stand in for its whole block: a
      // just-added entry measured as the 1480px shelf it was going into,
      // which is wider than the strip beside the drawer, so every add zoomed
      // the board out a notch and slid it left. Wait for the row.
      const rowPending = !isBlockId(selection!.id) && !selection!.id.startsWith("module:") && !objectRowElement(selection!.id, selectedNodeId);
      if (rowPending) {
        // Never the block in the row's place. The add went into a block the
        // author was looking at; if its row is not drawn in time, staying put
        // is the right outcome, and the amber flash still says where it went.
        if (performance.now() < rowDeadline) raf = requestAnimationFrame(attempt);
        return;
      }
      const bounds = objectBounds(selection!.id, selectedNodeId);
      if (!rect || !bounds) {
        if (performance.now() < deadline) raf = requestAnimationFrame(attempt);
        return;
      }
      const bottomRight = rf.flowToScreenPosition({ x: bounds.x + bounds.width, y: bounds.y + bounds.height });
      const margin = 20;
      // Only reserve the editor's width when the editor is a column of THIS
      // panel. On the stage it lives in the right column, outside the canvas
      // element entirely, so reserving it here would shove every selection
      // 340px left for nothing.
      const rightLimit = rect.right - (inspectorHost ? edgeInsets?.right ?? 0 : inspectorWidthRef.current) - margin;
      const vp = rf.getViewport();
      // A node wider than the strip the drawer leaves free cannot be nudged
      // into it: pushing its right edge clear of the drawer only pushes its
      // left edge off the screen. A module made from the add menu did exactly
      // that — the drawer opened on it, the canvas lost 420px, and the
      // module's first 70px went behind the left edge with the first
      // character of every block title. Zoom out until it fits instead, and
      // stand it at the strip's top-left.
      const stripW = rightLimit - (rect.left + margin);
      // The board's own toolbar floats over the canvas at top-3 and is 40px
      // tall. Nudging something to `rect.top + margin` put its first line —
      // an opened row's name field, a block's header — behind it.
      const topLimit = rect.top + margin + TOOLBAR_CLEARANCE;
      const stripH = rect.bottom - 64 - topLimit;
      // The row itself already in the clear: leave the board where it is.
      // Keeping the whole TILE clear of the drawer (below) used to slide the
      // board left on every added entry, though the new row was in plain
      // view — the tile only decides how far a nudge may go once one is due.
      const rowTL = rf.flowToScreenPosition({ x: bounds.x, y: bounds.y });
      if (rowTL.x >= rect.left + margin && bottomRight.x <= rightLimit && rowTL.y >= topLimit && bottomRight.y <= rect.bottom - 64) return;
      if (bounds.width * vp.zoom > stripW) {
        // Wider than the strip: show it from its start, at the zoom the
        // author picked.
        const zoom = vp.zoom;
        void stripH;
        if (learningStageRef.current) return;
        void rf.setViewport({ x: margin - bounds.x * zoom, y: topLimit - rect.top - bounds.y * zoom, zoom }, glide(220));
        return;
      }
      // Keep the tile the row lives in, not just the block: nudging a block on
      // the right column of the card tile clear of the drawer slid the card's
      // cover off the left edge (a search jump landed at x=−110). That was
      // always a horizontal worry — the cover stands beside the tile, not
      // above it — so the tile only ever decides how far left the nudge may
      // go, and only while it still fits beside the drawer at the zoom the
      // author picked.
      const frameId = rf.getNode(selectedNodeId)?.parentId;
      const frameNode = frameId ? rf.getInternalNode(frameId) : undefined;
      let keep = bounds;
      if (frameNode?.internals.positionAbsolute && frameNode.measured?.width && frameNode.measured.height) {
        const fa = frameNode.internals.positionAbsolute;
        // The card's face used to stand beside the frame, so the tile was the
        // union of the two. It is inside the frame now, and the frame is the
        // tile.
        const tile = { x: fa.x, y: fa.y, width: frameNode.measured.width, height: frameNode.measured.height };
        // A card tile is taller than the strip, so asking to keep all of it
        // panned the board down to the card's first line — and, when it did
        // not fit, zoomed the whole board out to make it. Adding a variable to
        // a card scrolled well past the top did both: the board jumped to the
        // card's head at the widest view the floor allowed. The row that was
        // just added is what has to end up on screen, so the tile contributes
        // its width and nothing else, and never a zoom of its own.
        if (stripW / tile.width >= vp.zoom) {
          keep = { x: tile.x, width: tile.width, y: bounds.y, height: bounds.height };
        }
      }
      const kTL = rf.flowToScreenPosition({ x: keep.x, y: keep.y });
      const kBR = rf.flowToScreenPosition({ x: keep.x + keep.width, y: keep.y + keep.height });
      let dx = 0;
      let dy = 0;
      if (kBR.x > rightLimit) dx = rightLimit - kBR.x;
      else if (kTL.x < rect.left + margin) dx = rect.left + margin - kTL.x;
      // Leave the zoom controls usable without covering the selected small
      // node — and the minimap, when the board is big enough to show one.
      const minimapW = 190 + 16, minimapH = 128 + 16;
      const underMinimap = boardOverflows && bottomRight.x + dx > rightLimit + margin - minimapW;
      const bottomLimit = rect.bottom - (underMinimap ? minimapH + 12 : 64);
      if (kBR.y > bottomLimit) dy = bottomLimit - kBR.y;
      else if (kTL.y < topLimit) dy = topLimit - kTL.y;
      // A lesson that began while this was waiting frames its own block.
      if (dx === 0 && dy === 0 || learningStageRef.current) return;
      void rf.setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom }, glide(220));
    };
    raf = requestAnimationFrame(attempt);
    const observer = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(attempt); });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => { cancelAnimationFrame(raf); observer.disconnect(); };
  }, [selectedNodeId, selection?.id, rf, inspectorHost, inspectorOpen, objectBounds, objectRowElement, edgeInsets?.right]);

  /** An opened row grows by the height of an editor, and the board relays
   *  itself out over the next few frames — the tile's own height, the frames
   *  under it, the formation. Wait for it to stop moving, then bring the whole
   *  open row into the free strip; nudging on the first frame lands on the
   *  height the row had before it opened. */
  useEffect(() => {
    if (!openRowId || viewLockedRef.current) return;
    // A staged lesson frames the block the row opens in; see the selection
    // nudge above.
    if (learningStageRef.current) return;
    let raf = 0;
    let lastTop = Number.NaN;
    let still = 0;
    const deadline = performance.now() + 1500;
    const attempt = () => {
      const container = containerRef.current;
      const editor = container?.querySelector<HTMLElement>(
        `[data-canvas-writing-editor="${CSS.escape(openRowId)}"],[data-row-editor="${CSS.escape(openRowId)}"]`,
      );
      // A writing row wraps its editor in a <section>; a block row's editor is
      // a sibling of the row, so there the editor itself is what to reveal.
      const row = editor?.closest<HTMLElement>("section") ?? editor;
      if (!container || !row) {
        if (performance.now() < deadline) raf = requestAnimationFrame(attempt);
        return;
      }
      const box = row.getBoundingClientRect();
      still = box.top === lastTop ? still + 1 : 0;
      lastTop = box.top;
      if (still < 2) {
        if (performance.now() < deadline) raf = requestAnimationFrame(attempt);
        return;
      }
      // The opening comes up open. On a short screen the entrance has just
      // framed the player screen above it on purpose; pulling the open row
      // up into view cut that screen off at the top.
      if (performance.now() - enteredAtRef.current < 2000) return;
      // A writing row opens to be written in: the caret goes to its text, so
      // the first click is not spent opening and the second (on a row that
      // has just slid under the pointer) on finding the box.
      const active = document.activeElement as HTMLElement | null;
      if (editor?.matches("[data-canvas-writing-editor]") && !(active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable))) {
        (editor.querySelector<HTMLTextAreaElement>('textarea[id^="studio-entry-content-"]') ?? editor.querySelector<HTMLTextAreaElement>("textarea"))
          ?.focus({ preventScroll: true });
      }
      const rect = container.getBoundingClientRect();
      const margin = 16;
      const top = rect.top + margin + TOOLBAR_CLEARANCE;
      const bottom = rect.bottom - 64;
      // Put its top under the toolbar; only pull it up again if that would
      // push its bottom off-screen, and never so far that the top goes.
      let dy = 0;
      if (box.top < top) dy = top - box.top;
      else if (box.bottom > bottom) dy = Math.max(bottom - box.bottom, top - box.top);
      // The drawer may be open on something else — the two ways in are
      // independent, so both can be on screen. Keep the open row out from
      // under it, the way a selected row is kept out from under it.
      const right = rect.right - (inspectorOpen ? (inspectorHost ? edgeInsets?.right ?? 0 : inspectorWidthRef.current) : 0) - margin;
      let dx = 0;
      if (box.right > right) dx = Math.max(right - box.right, rect.left + margin - box.left);
      else if (box.left < rect.left + margin) dx = rect.left + margin - box.left;
      // A lesson that began while this was waiting frames its own block.
      if (dx === 0 && dy === 0 || learningStageRef.current) return;
      const vp = rf.getViewport();
      void rf.setViewport({ x: vp.x + dx, y: vp.y + dy, zoom: vp.zoom }, glide(220));
    };
    raf = requestAnimationFrame(attempt);
    return () => cancelAnimationFrame(raf);
  }, [openRowId, rf, inspectorOpen, inspectorHost, edgeInsets?.right]);

  /** The board's own strip narrowing or widening — the assistant opening
   *  beside it, a window resized — keeps the board where the eye left it:
   *  same middle, and never its left edge (where every row's name is) off
   *  screen. Opening the assistant used to leave the card's right half under
   *  it. Pan only; the author's zoom stays. A selected row or a focused block
   *  has its own keeper above, and a lesson frames its own block. */
  const stripWidthRef = useRef(0);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") return;
    if (selectedNodeId || focusedBlock) { stripWidthRef.current = 0; return; }
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      const before = stripWidthRef.current;
      stripWidthRef.current = width;
      if (!before || !width || Math.abs(width - before) < 24) return;
      if (learningStageRef.current || viewLockedRef.current) return;
      const nodes = rf.getNodes().filter((n) => !n.hidden);
      if (!nodes.length) return;
      const vp = rf.getViewport();
      const bounds = rf.getNodesBounds(nodes);
      let x = vp.x + (width - before) / 2;
      const margin = 16;
      const left = bounds.x * vp.zoom + x;
      const right = left + bounds.width * vp.zoom;
      if (right > width - margin) x -= Math.min(right - (width - margin), Math.max(0, left - margin));
      if (bounds.x * vp.zoom + x < margin) x = margin - bounds.x * vp.zoom;
      void rf.setViewport({ x, y: vp.y, zoom: vp.zoom }, glide(200));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [selectedNodeId, focusedBlock, rf]);

  const isEmpty = graph.nodes.length === 0;
  // Search and the view menu earn their place once there is something to
  // look for: a new card is a handful of blocks read at a glance, and its
  // first screen was two rows of tools. They come back on their own as the
  // card grows or gains a situation, while a lesson is pointing at them, or
  // while anything in the view menu is switched on.
  const smallBoard = graph.nodes.length < 15 && !frames.some((fr) => fr.ownerId);
  const showFinders = !isEmpty && (!smallBoard || teaching || inLesson || !!query || viewMenuOpen || showAllWires || viewLocked || showLegend || showTurnContext);

  const placeToolbar = (node: React.ReactNode) => (toolbarHost ? createPortal(node, toolbarHost) : node);
  const toolbarBtn =
    "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-accent";

  return (
    <div className="flex h-full min-h-0 w-full">
      {/* The stage: a dark desk under one warm lamp (see studio-material.css).
          The lamp is a pool of light fixed to the container, so it stays
          where it is while the board pans underneath it. */}
      <div
        ref={containerRef}
        className={cn("studio-canvas relative min-w-0 flex-1", focusedBlock && "bp-block-focus", layoutGliding && "bp-animate-layout", showAllWires && "bp-wires-shown")}
        data-focused-block={focusedBlock ?? undefined}
        onDragOver={paneDragOver}
        onDragOverCapture={(e) => { aiDragOver(e); trackPaneDrop(e); }}
        onDropCapture={aiDrop}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPaneDropHint(null); }}
        onDrop={paneDrop}
        onPointerDownCapture={onCanvasPointerDownCapture}
        onClickCapture={onCanvasClickCapture}
        onDoubleClickCapture={onCanvasDoubleClickCapture}
        onWheelCapture={cancelInitialFit}
      >
        <div aria-hidden className="studio-lamp-pool pointer-events-none absolute left-1/2 top-[-140px] z-0 h-[320px] w-[640px] -translate-x-1/2" />
        {floatingPane && selection && (
          <FloatingEditor
            key={selection.id}
            container={containerRef.current}
            anchor={floatingAnchor}
            onClose={closeAuxiliary}
          >{floatingPane}</FloatingEditor>
        )}
        {paneDropHint && (
          <div
            aria-hidden
            data-pane-landing
            className="pointer-events-none absolute z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-amber-300/70 bg-amber-300/[0.07] px-3 text-center shadow-[0_0_24px_rgba(240,198,116,0.18)]"
            style={{ left: Math.max(8, Math.min(paneDropHint.x - paneDropHint.w / 2, (containerRef.current?.clientWidth ?? 9999) - paneDropHint.w - 8)), top: paneDropHint.y - 22, width: paneDropHint.w, minHeight: 64 }}
          >
            <span className="text-[12px] font-semibold leading-snug text-amber-100/90">{t("blueprint.dropOutHint")}</span>
          </div>
        )}
        <ReactFlow
          nodes={stagedNodes}
          edges={rfEdges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onMoveStart={onMoveStart}
          onMoveEnd={onMoveEnd}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodesDelete={onNodesDelete}
          onNodeContextMenu={onNodeContextMenu}
          onEdgeContextMenu={onEdgeContextMenu}
          onPaneContextMenu={onPaneContextMenu}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onBeforeDelete={onBeforeDelete as never}
          onEdgesDelete={onEdgesDelete}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onPaneClick={onPaneClick}
          onNodeDoubleClick={onNodeDoubleClick}
          // Blocks are laid out by the board, never by hand: where one sits says
          // nothing, and dragging them was how boards ended up overlapping.
          nodesDraggable={!readOnly}
          nodeDragThreshold={3}
          // A plain drag moves the board; Ctrl / Shift + drag draws a box.
          panOnDrag={[0, 1]}
          onNodeDragStart={onNodeDragStart}
          onNodeDragStop={onNodeDragStop}
          nodesConnectable={!readOnly}
          elevateEdgesOnSelect={false}
          connectionRadius={42}
          connectionLineStyle={{ stroke: "#d9a13f", strokeWidth: 2, strokeDasharray: "6 4" }}
          deleteKeyCode={active && !readOnly ? ["Backspace", "Delete"] : null}
          minZoom={0.12}
          maxZoom={1.75}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.2} color="rgba(235,231,222,0.09)" className="!bg-transparent" />
          {/* Smart guides: the line a dragged frame just snapped to, drawn in
              board coordinates between the two frames it aligns. */}
          {guides && (
            <ViewportPortal>
              {/* Figma's red: one screen pixel at any zoom, solid, running
                  past both boxes; the distances to the nearest neighbours
                  are drawn the same red, with the number on a pill. */}
              {guides.vertical && (
                <div
                  data-snap-guide="vertical"
                  className="pointer-events-none absolute z-[60] bg-[#ff3b5c]"
                  style={{ left: guides.vertical.x - 0.5 / guides.zoom, top: guides.vertical.from - 24, height: guides.vertical.to - guides.vertical.from + 48, width: 1 / guides.zoom }}
                />
              )}
              {guides.horizontal && (
                <div
                  data-snap-guide="horizontal"
                  className="pointer-events-none absolute z-[60] bg-[#ff3b5c]"
                  style={{ top: guides.horizontal.y - 0.5 / guides.zoom, left: guides.horizontal.from - 24, width: guides.horizontal.to - guides.horizontal.from + 48, height: 1 / guides.zoom }}
                />
              )}
              {guides.gaps.map((g) => (
                <div
                  key={`${g.axis}:${g.x1}:${g.y1}`}
                  data-snap-gap={Math.round(g.distance)}
                  className="pointer-events-none absolute z-[60] bg-[#ff3b5c]"
                  style={g.axis === "x"
                    ? { left: g.x1, top: g.y1 - 0.5 / guides.zoom, width: g.x2 - g.x1, height: 1 / guides.zoom }
                    : { left: g.x1 - 0.5 / guides.zoom, top: g.y1, width: 1 / guides.zoom, height: g.y2 - g.y1 }}
                >
                  <span
                    className="absolute left-1/2 top-1/2 whitespace-nowrap rounded bg-[#ff3b5c] font-semibold leading-none text-white"
                    style={{ fontSize: 11 / guides.zoom, padding: `${2 / guides.zoom}px ${4 / guides.zoom}px`, transform: "translate(-50%, -50%)" }}
                  >
                    {Math.round(g.distance)}
                  </span>
                </div>
              ))}
            </ViewportPortal>
          )}
          {/* Sticky notes — plans and reminders live on the canvas, not in a
              doc nobody opens. Drawn inside the viewport in flow coordinates,
              so they pan and zoom with the graph. They used to be placed with
              flowToScreenPosition during render, which only re-ran when
              something else re-rendered the panel — a pan left them behind.
              The viewport layer is pointer-events:none and user-select:none,
              so each note opts back in, and nodrag/nopan/nowheel keep a click,
              a text selection or a scroll inside it from moving the board. */}
          {notes.length > 0 && (
            <ViewportPortal>
              <StickyNoteLayer
                notes={notes}
                write={writeNotes}
                readOnly={readOnly}
                editingId={editingNoteId}
                onEdited={() => setEditingNoteId(null)}
                multi={multiSelected}
                hostOf={noteHostOf}
                layoutKey={stagedNodes}
              />
            </ViewportPortal>
          )}
          {/* Only once there is something off screen to find.
              A minimap of a board you can already see whole is furniture that
              covers it: on a card with three blocks it was sitting on two of
              them, and on a card you had just added a module to, it sat on the
              module. It earns its corner when the board outgrows the screen,
              which is also the only time it tells you anything. */}
          {marquee && (
            <div
              aria-hidden
              className="pointer-events-none absolute z-30 rounded border border-amber-400/80 bg-amber-400/10"
              style={{
                left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1),
                width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0),
              }}
            />
          )}
          {/* The batch bar: what a multi-selection can do, in one place. It
              floats above the zoom cluster so it never covers the rows it
              is about. */}
          {multiSelected.size > 0 && !readOnly && (
            <div data-blueprint-popover data-batch-bar className={cn("absolute z-30 flex -translate-x-1/2 items-center gap-1 whitespace-nowrap studio-pill rounded-xl border px-2 py-1.5 shadow-xl", !batchPos && "bottom-16 left-1/2")} style={batchPos ? { left: batchPos.x, top: batchPos.y } : undefined}>
              <span className="px-1.5 text-xs font-semibold text-amber-300">{t("blueprint.batch.selected", { count: multiSelected.size })}</span>
              <div className="mx-0.5 h-4 w-px bg-border" />
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setBatchMoveOpen((v) => !v)}
                  className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-foreground/85 transition-colors hover:bg-accent"
                >
                  <Link2 className="h-3.5 w-3.5" />
                  {t("blueprint.batch.moveTo")}
                </button>
                {batchMoveOpen && (
                  <div className="absolute bottom-full left-0 mb-1 studio-pill max-h-64 w-56 overflow-y-auto rounded-xl border p-1">
                    <button
                      type="button"
                      onClick={() => { setBatchMoveOpen(false); moveMultiTo(null); }}
                      className="flex w-full items-center rounded-lg px-2 py-1.5 text-left text-xs text-foreground/85 hover:bg-accent"
                    >
                      {t("blueprint.batch.toCore")}
                    </button>
                    {frames.filter((fr) => fr.ownerId && fr.module).map((fr) => (
                      <button
                        key={fr.id}
                        type="button"
                        onClick={() => { setBatchMoveOpen(false); moveMultiTo(fr.ownerId); }}
                        className="flex w-full items-center truncate rounded-lg px-2 py-1.5 text-left text-xs text-foreground/85 hover:bg-accent"
                      >
                        {displayTitle(fr.module!)}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                data-batch-duplicate
                onClick={duplicateMulti}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-foreground/85 transition-colors hover:bg-accent"
              >
                <CopyIcon className="h-3.5 w-3.5" />
                {t("blueprint.batch.duplicate")}
              </button>
              <button
                type="button"
                onClick={deleteMulti}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-red-300 transition-colors hover:bg-red-500/15"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {t("blueprint.batch.delete")}
              </button>
              <button
                type="button"
                onClick={() => { setMultiSelected(EMPTY_MULTI); setBatchMoveOpen(false); }}
                title={t("blueprint.batch.clear")}
                className="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {boardOverflows && (
          <MiniMap
            pannable
            zoomable
            position="bottom-right"
            style={{ width: 190, height: 128 }}
            // Only while you are moving around (see `mapAwake`). It only
            // exists when the board is bigger than the screen — which is
            // exactly when its corner has board underneath it.
            onMouseEnter={() => { mapHoverRef.current = true; wakeMap(); }}
            onMouseLeave={() => { mapHoverRef.current = false; sleepMapSoon(); }}
            className={cn(
              "!rounded-xl !border !border-border/70 overflow-hidden !shadow-[0_10px_30px_rgba(0,0,0,0.5)] transition-opacity duration-200",
              mapAwake ? "opacity-100" : "pointer-events-none opacity-0",
            )}
            bgColor="rgba(14,15,22,0.92)"
            maskColor="rgba(0,0,0,0.62)"
            maskStrokeColor="rgba(240,198,116,0.8)"
            maskStrokeWidth={3}
            // Kind-colored dots turn the minimap into a real map: you can tell
            // the module cluster from the variable spine at a glance.
            nodeColor={(n) => {
              const d = n.data as Partial<BlockNodeData & GateNodeData>;
              if (d.tint) return d.tint; // a gate wears its module's colour
              return d.block ? BLOCK_MINI[d.block.kind] : "#3f3d47";
            }}
            nodeStrokeColor="transparent"
          />
          )}
          {voiceFor && (
            <VoicePickerPopover
              title={voiceFor.title}
              value={voiceFor.entryId
                ? worldDraft.entries.find((e) => e.id === voiceFor.entryId)?.voice
                : worldDraft.settings?.narratorVoice}
              onChange={(voice) => {
                const store = useEditorStore.getState();
                if (voiceFor.entryId) store.updateEntry(voiceFor.entryId, { voice });
                else store.setField("settings", { ...store.worldDraft.settings, narratorVoice: voice });
              }}
              onClose={() => setVoiceFor(null)}
              {...(!voiceFor.entryId ? {
                inputMode: worldDraft.settings?.voiceInputMode,
                onInputModeChange: (voiceInputMode: "confirm" | "auto") => {
                  const store = useEditorStore.getState();
                  store.setField("settings", { ...store.worldDraft.settings, voiceInputMode });
                },
              } : {})}
            />
          )}
          <ZoomCluster onFit={() => {
            if (focusTimer.current) clearTimeout(focusTimer.current);
            cancelObjectCenter.current();
            overviewViewport.current = null;
            setFocusedModule(null); setSelection(null);
            void fitBetweenDocks(250, true);
          }} />
        </ReactFlow>

        {/* Anchored top-right of the canvas, clear of the command row: the
            creator reads it WHILE playing, so it must not sit where the next
            click is going.

            The inspector's width is deliberately NOT subtracted here. The
            inspector does not float over the canvas — it takes that width out
            of the element this card is positioned inside, so counting it again
            walked the card off the left edge the moment anything was selected.
            The same double count that had the whole board framed against a
            phantom twice its size. */}
        {turnContext && (
          <div
            className="absolute top-14 z-10"
            style={{ right: (edgeInsets?.right ?? 0) + 16 }}
          >
            <TurnContextCard view={turnContext} onClose={() => setShowTurnContext(false)} />
          </div>
        )}


        {/* Toolbar. The adds live on the block heads — but an EMPTY station
            renders no block at all, so a blank card had nowhere visible to add
            its first variable or behaviour (the right-click menu is where
            features go to be undiscovered). The ＋ menu is that same menu,
            standing where a person can see it. */}
        {(!readOnly || !isEmpty) && placeToolbar(
          <div className={cn(
            "z-10 flex items-center gap-0.5 overflow-visible",
            // In the stage's page row when it offers one: the board's tools on
            // the line that already says which page you are on, instead of a
            // third bar floating over the top of the canvas. No glass of its
            // own there — a blurred parent leaves its menus nothing to blur.
            toolbarHost ? "relative max-w-full" : "studio-pill absolute left-1/2 top-3 max-w-[calc(100%-24px)] -translate-x-1/2 rounded-xl border p-1 shadow-lg backdrop-blur",
          )}>
            {!readOnly && (
            <>
            <div className="relative">
              <button type="button" data-onboarding="add-content" title={t("blueprint.menu.add")} onClick={() => setAddMenuOpen((v) => !v)} className={cn(toolbarBtn, addMenuOpen && "text-amber-400")}>
                <Plus className="h-3.5 w-3.5" />
                <span className="@max-[46rem]:hidden">{t("blueprint.menu.add")}</span>
              </button>
              {addMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setAddMenuOpen(false)} />
                  {/* Everything the card can grow, in the player's words, in
                      two groups: what the story knows and what the player
                      sees. Each lands where it belongs on the board (or opens
                      the page it is made on). Nothing the old menu offered is
                      gone (the situation, settings, variables, behaviours,
                      scene images, the worker), and the openings, interface
                      pages, packs and audio that were only on their own blocks
                      or in 面板 are here too. */}
                  <div className="absolute left-0 top-full z-20 mt-1.5 max-h-[min(640px,80vh)] w-[320px] overflow-y-auto studio-pill rounded-xl border py-1">
                    {/* Added first, set up after, on the thing itself: a form in
                        between asked its questions before there was anything
                        to look at, and offered fewer answers than the thing's
                        own settings do. */}
                    <>
                    {/* The card's structure first (owner, 10/6): a place, one
                        more AI call, a note. */}
                    <div data-learn="add-module"><MenuItem icon={Boxes} tint="text-amber-400" onClick={() => { handleAddModule(); setAddMenuOpen(false); }}>
                      {t("blueprint.addMenu.module")}
                    </MenuItem></div>
                    <div data-learn="add-ai"><MenuItem icon={Bot} tint="text-pink-400" onClick={() => { addAiNow(); setAddMenuOpen(false); }}>
                      {t("blueprint.addMenu.ai")}
                    </MenuItem></div>
                    <div data-add-note=""><MenuItem icon={StickyNote} tint="text-yellow-300" onClick={() => { addStickyNote(); setAddMenuOpen(false); }}>
                      {t("blueprint.addMenu.note")}
                    </MenuItem></div>
                    <div className="mx-3 my-1 border-t border-white/[0.07]" />
                    <p className="px-3 pb-0.5 pt-1 text-[11px] font-semibold tracking-wide text-muted-foreground">{t("blueprint.addMenu.story")}</p>
                    <MenuItem icon={BookOpen} tint="text-violet-400" onClick={() => { handleAddEntry(); setAddMenuOpen(false); }}>
                      {t("blueprint.addMenu.entry")}
                    </MenuItem>
                    <MenuItem icon={MessageCircle} tint="text-emerald-400" onClick={() => { blockActionsRef.current.addOpening(); setAddMenuOpen(false); }}>
                      {t("blueprint.addMenu.opening")}
                    </MenuItem>
                    <MenuItem icon={VariableIcon} tint="text-sky-400" onClick={() => { addFromMenu("state"); setAddMenuOpen(false); }}>
                      {t("blueprint.addMenu.variable")}
                    </MenuItem>
                    <MenuItem icon={Zap} tint="text-orange-400" onClick={() => { addFromMenu("behavior"); setAddMenuOpen(false); }}>
                      {t("blueprint.addMenu.behavior")}
                    </MenuItem>
                    <div className="mx-3 my-1 border-t border-white/[0.07]" />
                    <p className="px-3 pb-0.5 pt-1 text-[11px] font-semibold tracking-wide text-muted-foreground">{t("blueprint.addMenu.screen")}</p>
                    <MenuItem icon={LayoutTemplate} tint="text-rose-400" onClick={() => { setAddMenuOpen(false); requestUiEditor({ gallery: true }); onDrillPanel("frontend"); }}>
                      {t("blueprint.addMenu.pages")}
                    </MenuItem>
                    {/* A setup screen before play: the gallery's opening,
                        name and cast pages write variables and pick the
                        opening. */}
                    <div data-add-setup=""><MenuItem icon={ListChecks} tint="text-emerald-300" onClick={() => { setAddMenuOpen(false); requestUiEditor({ gallery: true }); onDrillPanel("frontend"); }}>
                      {t("blueprint.addMenu.setup")}
                    </MenuItem></div>
                    <MenuItem icon={Images} tint="text-pink-400" onClick={() => { handleAddSceneImage(); setAddMenuOpen(false); }}>
                      {t("blueprint.addSceneImage")}
                    </MenuItem>
                    <MenuItem icon={Volume2} tint="text-teal-300" onClick={() => { setAddMenuOpen(false); pickTrayItem("audio"); }}>
                      {t("blueprint.addMenu.audio")}
                    </MenuItem>
                    {/* The picture behind the chat. Its block only stood on a
                        card that already had one, so there was no way to give
                        a card its first. */}
                    <MenuItem icon={ImageIcon} tint="text-zinc-300" onClick={() => { setAddMenuOpen(false); pickTrayItem("background"); }}>
                      {t("blueprint.addMenu.background")}
                    </MenuItem>
                    {/* Ready-made things from the community close the menu. */}
                    <div className="mx-3 my-1 border-t border-white/[0.07]" />
                    <div data-add-market=""><MenuItem icon={LayoutGrid} tint="text-orange-300" onClick={() => { setAddMenuOpen(false); onDrillPanel("marketplace"); }}>
                      {t("blueprint.addMenu.market")}
                    </MenuItem></div>
                    </>
                  </div>
                </>
              )}
            </div>
            </>
            )}
            {!readOnly && (showFinders || (!isEmpty && frames.some((fr) => fr.ownerId))) && <div className="mx-0.5 h-5 w-px bg-border" />}
            {/* The module directory: a card with twenty modules is a wall of
                small squares at 31% zoom, and the only ways in were the search
                box and the minimap. A list of modules, each a click from
                focus, plus open-all / shut-all for the whole board. */}
            {!isEmpty && frames.some((fr) => fr.ownerId) && (
              <div className="relative" data-blueprint-popover>
                <button
                  type="button"
                  onClick={() => setShowDirectory((v) => !v)}
                  title={t("blueprint.directory.title")}
                  className={cn(
                    "flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors hover:bg-accent",
                    showDirectory ? "text-amber-400" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Layers className="h-3.5 w-3.5" />
                  {t("blueprint.directory.title")}
                  <span className="rounded bg-white/10 px-1 text-[10px] text-foreground/70">{frames.filter((fr) => fr.ownerId).length}</span>
                </button>
                {showDirectory && (
                  <div className="absolute left-0 top-full z-30 studio-pill mt-1 w-64 rounded-xl border p-1">
                    <div className="flex items-center gap-1 px-1 pb-1">
                      <button
                        type="button"
                        onClick={() => setOpenFrames(new Set(frames.map((fr) => fr.id)))}
                        className="flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-foreground/80 hover:bg-accent"
                      >
                        <ChevronsUpDown className="h-3 w-3" />
                        {t("blueprint.directory.expandAll")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setOpenFrames(new Set([blockId.frame(null)]))}
                        className="flex flex-1 items-center justify-center gap-1 rounded-lg px-2 py-1 text-[11px] font-semibold text-foreground/80 hover:bg-accent"
                      >
                        <ChevronsDownUp className="h-3 w-3" />
                        {t("blueprint.directory.collapseAll")}
                      </button>
                    </div>
                    <div className="max-h-72 overflow-y-auto">
                      {/* AIs and places apart, once there are both: an AI is
                          who talks, a place is where; one list of names did
                          not say which was which. */}
                      {(() => {
                        const listed = frames.filter((fr) => fr.ownerId && fr.module);
                        const isAi = (fr: (typeof listed)[number]) => aiFrameIds.has(fr.id);
                        const groups = listed.some(isAi) && listed.some((fr) => !isAi(fr))
                          ? [{ key: "ai", title: String(t("blueprint.directory.ais")), list: listed.filter(isAi) }, { key: "place", title: String(t("blueprint.directory.places")), list: listed.filter((fr) => !isAi(fr)) }]
                          : [{ key: "all", title: "", list: listed }];
                        return groups.map((group) => (
                          <div key={group.key}>
                            {group.title && <p className="px-2 pb-0.5 pt-1.5 text-[10.5px] font-semibold tracking-wide text-muted-foreground">{group.title}</p>}
                            {group.list.map((fr) => {
                              const open = openFrames.has(fr.id);
                              return (
                                <button
                                  key={fr.id}
                                  type="button"
                                  onClick={() => { setShowDirectory(false); focusModuleRef.current(fr.id); }}
                                  className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-accent"
                                >
                                  {isAi(fr)
                                    ? <Bot className={cn("h-3 w-3 shrink-0", open ? "text-pink-300" : "text-pink-300/50")} />
                                    : <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", open ? "bg-amber-400" : "bg-white/25")} />}
                                  <span className="min-w-0 flex-1 truncate text-foreground/90">{displayTitle(fr.module!)}</span>
                                  <span className="shrink-0 text-[10px] text-muted-foreground">{t("blueprint.directory.ownCount", { count: fr.own })}</span>
                                </button>
                              );
                            })}
                          </div>
                        ));
                      })()}
                    </div>
                  </div>
                )}
              </div>
            )}
            {showFinders && (
              <div className="flex items-center gap-1.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && searchResults[0]) jumpTo(searchResults[0].id);
                    if (e.key === "Escape") setQuery("");
                  }}
                  data-learn="search"
                  placeholder={t("blueprint.searchPlaceholder")}
                  className="studio-control w-36 @max-[46rem]:w-24 rounded-lg border py-1.5 pl-8 pr-2.5 text-xs text-foreground transition-[width] placeholder:text-foreground/35 focus:w-52 focus:studio-control-focus focus:outline-none"
                />
                {query.trim() && (
                  <div className="absolute right-0 top-full mt-1 max-h-[min(420px,65vh)] w-80 max-w-[calc(100vw-40px)] studio-pill overflow-y-auto rounded-xl border py-1">
                    {searchResults.length === 0 && (
                      <div className="px-3 py-2 text-xs text-muted-foreground">{t("blueprint.searchEmpty")}</div>
                    )}
                    {searchResults.map((n) => {
                      const style = KIND_STYLE[n.kind];
                      const Icon = style.icon;
                      return (
                        <button
                          key={n.id}
                          type="button"
                          onClick={() => jumpTo(n.id)}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent"
                        >
                          <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded", style.chip)}>
                            <Icon className="h-3 w-3" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{displayTitle(n)}</span>
                            <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">{n.scope ?? t("blueprint.writing.sharedScope")}</span>
                            {n.excerpt && <span className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground/90">{n.excerpt}</span>}
                          </span>
                          <span className="shrink-0 text-[10px] uppercase text-muted-foreground/60">
                            {t(`blueprint.kinds.${n.kind}` as never)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

              </div>
              {/* Everything about how the board is shown, in one menu: wires,
                  the locked view, the legend, the context estimate and the
                  assistant rail were six buttons in a bar floating over the
                  canvas, and a first look read them all. */}
              <div className="relative" data-blueprint-popover>
                <button
                  type="button"
                  data-onboarding="connections"
                  title={t("blueprint.view.menu")}
                  onClick={() => setViewMenuOpen((v) => !v)}
                  className={cn(toolbarBtn, "text-muted-foreground hover:text-foreground", (viewMenuOpen || showAllWires || viewLocked || showLegend || showTurnContext) && "text-amber-400")}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5" />
                  <span className="@max-[46rem]:hidden">{t("blueprint.view.menu")}</span>
                  <ChevronDown className="h-3 w-3 opacity-60" />
                </button>
                {/* The legend opens under the menu it came from and shuts on a
                    press anywhere else. It used to hang 56px below the middle
                    of the floating bar; with the bar in the page row that put
                    it over the board's text with no way to close it but the
                    menu again. `w-max` + nowrap: an absolutely positioned box
                    otherwise shrinks to one CJK character per line. */}
                {!isEmpty && showLegend && !viewMenuOpen && (
                  <div ref={legendRef} className="absolute right-0 top-full z-20 mt-1.5 w-max studio-pill whitespace-nowrap rounded-xl border py-2 pl-3 pr-2">
                    <div className="mb-1 flex items-center gap-3">
                      <span className="flex-1 text-[11px] font-semibold text-foreground/85">{t("blueprint.legend.title")}</span>
                      <button type="button" onClick={() => setShowLegend(false)} aria-label={t("blueprint.legend.close")} className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground">
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                    {LEGEND_ITEMS.map((item) => (
                      <div key={item.key} className="flex items-center gap-2 py-0.5 pr-1">
                        <span className="h-0.5 w-5 shrink-0 rounded" style={{ background: item.color }} />
                        <span className="text-[11px] text-muted-foreground">
                          {t(`blueprint.legend.${item.key}` as never)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
                {viewMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setViewMenuOpen(false)} />
                    <div className="absolute right-0 top-full z-20 mt-1.5 studio-pill w-[248px] overflow-hidden rounded-xl border py-1">
                      {hasSeveralAis(roster) && (
                        <div data-learn="ai-table"><ViewMenuItem icon={Table2} on={showAiTable} onClick={() => { captureHubEvent("studio_view_toggle", { world_id: eventWorldId(), item: "ai-table", on: true }); setShowAiTable(true); setViewMenuOpen(false); }}>
                          {t("blueprint.aiTable.view")}
                        </ViewMenuItem></div>
                      )}
                      <div data-learn="all-wires"><ViewMenuItem icon={Spline} on={showAllWires} hint={t(showAllWires ? "blueprint.wires.allHint" : "blueprint.wires.litHint")} onClick={() => { captureHubEvent("studio_view_toggle", { world_id: eventWorldId(), item: "wires", on: !showAllWires }); toggleAllWires(); }}>
                        {t("blueprint.wires.all")}
                      </ViewMenuItem></div>
                      {!readOnly && (
                        <ViewMenuItem icon={viewLocked ? Lock : LockOpen} on={viewLocked} hint={t(viewLocked ? "blueprint.view.unlockHint" : "blueprint.view.lockHint")} onClick={() => { captureHubEvent("studio_view_toggle", { world_id: eventWorldId(), item: "lock", on: !viewLocked }); toggleViewLock(); }}>
                          {t("blueprint.view.lock")}
                        </ViewMenuItem>
                      )}
                      {!readOnly && Object.keys(storedPinned()).length > 0 && (
                        <ViewMenuItem icon={LayoutGrid} hint={t("blueprint.view.tidyHint")} onClick={() => { captureHubEvent("studio_view_toggle", { world_id: eventWorldId(), item: "tidy", on: true }); tidyBoard(); setViewMenuOpen(false); }}>
                          {t("blueprint.view.tidy")}
                        </ViewMenuItem>
                      )}
                      {!isEmpty && (
                        <>
                          <ViewMenuItem icon={Palette} on={showLegend} onClick={() => { captureHubEvent("studio_view_toggle", { world_id: eventWorldId(), item: "legend", on: !showLegend }); setShowLegend((v) => !v); setViewMenuOpen(false); }}>
                            {t("blueprint.legend.title")}
                          </ViewMenuItem>
                          <ViewMenuItem icon={MessageSquare} on={showTurnContext} onClick={() => { captureHubEvent("studio_view_toggle", { world_id: eventWorldId(), item: "estimate", on: !showTurnContext }); setShowTurnContext((v) => !v); setViewMenuOpen(false); }}>
                            {t("blueprint.turnCtx.estimateTitle", { defaultValue: "Context estimate" })}
                          </ViewMenuItem>
                        </>
                      )}
                      {focus && (
                        <ViewMenuItem icon={focus.active ? Minimize2 : Maximize2} on={focus.active} onClick={() => { captureHubEvent("studio_view_toggle", { world_id: eventWorldId(), item: "rail", on: !focus.active }); focus.toggle(); setViewMenuOpen(false); }}>
                          {t(focus.kind === "rail" ? "blueprint.rail.hide" : "blueprint.focusMode")}
                        </ViewMenuItem>
                      )}
                    </div>
                  </>
                )}
              </div>
                          </div>
            )}
          </div>
        )}

        {/* The AI's last turn, as an audit rather than a notification: what it
            touched stays marked on the canvas until you accept it or take it
            back. Sits above the live badge so a playtest can't bury it. */}
        {turn && (
          <div className="absolute bottom-16 left-1/2 z-20 flex max-w-[min(680px,calc(100%-32px))] -translate-x-1/2 items-center gap-3 rounded-xl border border-emerald-500/40 bg-[#12131a]/95 px-3 py-2 shadow-[0_18px_60px_rgba(0,0,0,0.55)] backdrop-blur-xl">
            <Wand2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-bold text-foreground">{t("blueprint.turn.title")}</div>
              <div className="truncate text-[11px] text-muted-foreground">
                {[
                  turn.diff.addedNodes.length + turn.diff.addedEdges.length > 0
                    ? t("blueprint.turn.summaryAdded", { count: turn.diff.addedNodes.length + turn.diff.addedEdges.length })
                    : null,
                  turn.diff.changedNodes.length > 0
                    ? t("blueprint.turn.summaryChanged", { count: turn.diff.changedNodes.length })
                    : null,
                  turn.diff.removedNodes.length + turn.diff.removedEdges.length > 0
                    ? t("blueprint.turn.summaryRemoved", { count: turn.diff.removedNodes.length + turn.diff.removedEdges.length })
                    : null,
                ].filter(Boolean).join(" · ")}
                {turn.diff.removedNodes.length > 0 && (
                  <span className="text-red-300">
                    {" — "}
                    {turn.diff.removedNodes.slice(0, 3).map((n) => n.title).join("、")}
                    {turn.diff.removedNodes.length > 3 ? "…" : ""}
                  </span>
                )}
              </div>
            </div>
            {!readOnly && (
              <button
                type="button"
                onClick={() => { void undoTurn(); }}
                disabled={undoingTurn}
                className="studio-control shrink-0 rounded-lg border px-2.5 py-1 text-[11px] font-medium text-foreground/70 transition-colors hover:text-foreground disabled:opacity-50"
              >
                {t("blueprint.turn.undo")}
              </button>
            )}
            <button
              type="button"
              onClick={dismissTurn}
              title={t("blueprint.turn.dismiss")}
              className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        {/* Live badge — the circuit is showing a running session, not the
            authored defaults. Says so, loudly but small. */}
        {isLive && (
          <div className="absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-emerald-500/50 bg-emerald-950/85 px-3 py-1.5 text-[11px] font-bold text-emerald-300 shadow-lg backdrop-blur">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
            </span>
            {t("blueprint.live.badge")}
          </div>
        )}

        {/* Search + legend — second row of the centered command cluster,
            clear of the floating docks that own both edges on the stage */}

        {active && focusEdit && <FocusEditor objId={focusEdit} onClose={() => setFocusEdit(null)} />}

        {/* Context menus */}
        {menu && (
          <BlueprintFloatingMenu keyboardTrigger={menu.keyboardTrigger} onEscape={() => setMenu(null)} x={menu.x + (containerRef.current?.getBoundingClientRect().left ?? 0)} y={menu.y + (containerRef.current?.getBoundingClientRect().top ?? 0)}>
            {menu.kind === "pane" && (
              <>
                {clipboardRef.current.length > 0 && (
                  <>
                    <MenuItem icon={ClipboardPaste} shortcut={typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘V" : "Ctrl+V"} onClick={() => { pasteInto(menu.ownerId ? `module:${menu.ownerId}` : undefined); setMenu(null); }}>
                      {t("blueprint.menu.paste")}
                    </MenuItem>
                    <div className="my-1 h-px bg-border" />
                  </>
                )}
                <MenuLabel>{t("blueprint.menu.add")}</MenuLabel>
                <MenuItem icon={MessageCircle} tint="text-emerald-400" onClick={() => { handleAddGreeting(); setMenu(null); }}>
                  {t("blueprint.addGreeting")}
                </MenuItem>
                <MenuItem icon={BookOpen} tint="text-violet-400" onClick={() => { handleAddEntry(); setMenu(null); }}>
                  {t("blueprint.addEntry")}
                </MenuItem>
                <MenuItem icon={Boxes} tint="text-amber-400" onClick={() => { handleAddModule(); setMenu(null); }}>
                  {t("blueprint.addModule")}
                </MenuItem>
                <MenuItem icon={VariableIcon} tint="text-sky-400" onClick={() => { addFromMenu("state"); setMenu(null); }}>
                  {t("blueprint.addVariable")}
                </MenuItem>
                <MenuItem icon={Zap} tint="text-orange-400" onClick={() => { addFromMenu("behavior"); setMenu(null); }}>
                  {t("blueprint.addBehavior")}
                </MenuItem>
                <MenuItem icon={LayoutTemplate} tint="text-cyan-400" onClick={() => { handleAddInterface(); setMenu(null); }}>
                  {t("blueprint.addInterface", { defaultValue: "界面" })}
                </MenuItem>
                <div className="my-1 h-px bg-border" />
                <MenuItem icon={StickyNote} tint="text-amber-400" onClick={() => { if (menu.stickOn) addNoteOn(noteTargetsFor(menu.stickOn)); else addNote(menu.flow); setMenu(null); }}>
                  {t("blueprint.menu.addNote")}
                </MenuItem>
              </>
            )}
            {menu.kind === "node" && (
              <>
                {/* An object's own page and wires. A block or the card's
                    frame is not one object, and both items did nothing there. */}
                {!menu.id.startsWith("block:") && !menu.id.startsWith("frame:") && (
                  <>
                    <MenuItem icon={ExternalLink} onClick={() => { drillObject(menu.id); setMenu(null); }}>
                      {t("blueprint.insp.openFull")}
                    </MenuItem>
                    {/* A row's own wires. This used to be a second icon on every
                        row, hovering beside a settings icon that did the same
                        thing as clicking the row — two buttons for one action and
                        one button nobody could name. It belongs in the menu. */}
                    <MenuItem icon={Network} onClick={() => { showRelationships(menu.id); setMenu(null); }}>
                      {t("blueprint.writing.showRelations")}
                    </MenuItem>
                  </>
                )}
                {menu.id.startsWith("entry:") && !readOnly && useEditorStore.getState().worldDraft.entries.find((e) => e.id === menu.id.slice("entry:".length))?.role === "character" && (
                  <MenuItem icon={Volume2} onClick={() => {
                    const entryId = menu.id.slice("entry:".length);
                    const entry = useEditorStore.getState().worldDraft.entries.find((e) => e.id === entryId);
                    setVoiceFor({ entryId, title: t("blueprint.voice.character", { name: entry?.name ?? "" }) });
                    setMenu(null);
                  }}>
                    {t("blueprint.menu.voice")}
                  </MenuItem>
                )}
                {/* Figma's order: copy, paste, duplicate; then where it
                    goes; then delete, alone at the bottom. Right-clicking one
                    of several picked things acts on all of them. */}
                {(() => {
                  const targets = multiSelected.has(menu.id) ? [...multiSelected] : [menu.id];
                  const copyable = targets.some((id) => isDeletableObject(id) && !id.startsWith("module:"));
                  const movable = gates.length > 0 && targets.some((id) => isShareableObject(id));
                  const frontable = targets.some((id) => id.startsWith("entry:") || id.startsWith("greeting:"));
                  const deletable = targets.some((id) => isDeletableObject(id));
                  const mod = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
                  const done = () => { setMenu(null); setMenuMoveOpen(false); };
                  return (
                    <>
                      {(copyable || clipboardRef.current.length > 0) && <div className="my-1 h-px bg-border" />}
                      {copyable && (
                        <MenuItem icon={CopyIcon} shortcut={`${mod}C`} onClick={() => { copyIds(targets); done(); }}>
                          {t("blueprint.menu.copy")}
                        </MenuItem>
                      )}
                      {clipboardRef.current.length > 0 && (
                        <MenuItem icon={ClipboardPaste} shortcut={`${mod}V`} onClick={() => { pasteInto(menu.ownerId ? `module:${menu.ownerId}` : ownerOf(menu.id)); done(); }}>
                          {t("blueprint.menu.paste")}
                        </MenuItem>
                      )}
                      {copyable && (
                        <MenuItem icon={CopyPlus} shortcut={`${mod}D`} onClick={() => { if (targets.length > 1) duplicateMulti(); else duplicateNodeById(menu.id); done(); }}>
                          {t("blueprint.menu.duplicate")}
                        </MenuItem>
                      )}
                      {(movable || frontable) && <div className="my-1 h-px bg-border" />}
                      {movable && (
                        <>
                          <MenuItem
                            icon={FolderInput}
                            onClick={() => setMenuMoveOpen((v) => !v)}
                            trailing={<ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", menuMoveOpen && "rotate-90")} />}
                          >
                            {t("blueprint.menu.moveTo")}
                          </MenuItem>
                          {menuMoveOpen && (
                            <div data-menu-move className="mx-2 mb-1 max-h-56 overflow-y-auto rounded-lg border border-border/60 bg-background/40 py-1">
                              <button
                                type="button"
                                onClick={() => { moveMultiTo(null, targets.filter(isShareableObject)); done(); }}
                                className="flex w-full items-center rounded px-2.5 py-1.5 text-left text-xs text-foreground/85 hover:bg-accent"
                              >
                                {t("blueprint.batch.toCore")}
                              </button>
                              {frames.filter((fr) => fr.ownerId && fr.module).map((fr) => (
                                <button
                                  key={fr.id}
                                  type="button"
                                  onClick={() => { moveMultiTo(fr.ownerId, targets.filter(isShareableObject)); done(); }}
                                  className="flex w-full items-center truncate rounded px-2.5 py-1.5 text-left text-xs text-foreground/85 hover:bg-accent"
                                >
                                  {displayTitle(fr.module!)}
                                </button>
                              ))}
                            </div>
                          )}
                        </>
                      )}
                      {frontable && (
                        <MenuItem icon={ArrowUpToLine} onClick={() => { bringToFront(targets); done(); }}>
                          {t("blueprint.menu.toFront")}
                        </MenuItem>
                      )}
                      {/* A note stuck beside this, for the assistant and for later. */}
                      {(
                        <MenuItem icon={StickyNote} tint="text-yellow-300" onClick={() => { addNoteOn(targets); done(); }}>
                          {t("blueprint.menu.addNote")}
                        </MenuItem>
                      )}
                      {deletable && (
                        <>
                          <div className="my-1 h-px bg-border" />
                          <MenuItem icon={Trash2} tint="text-destructive" danger shortcut="Del" onClick={() => {
                            deleteObjects(targets.filter((id) => isDeletableObject(id)));
                            if (targets.length > 1) setMultiSelected(EMPTY_MULTI);
                            done();
                          }}>
                            {t("blueprint.insp.delete")}
                          </MenuItem>
                        </>
                      )}
                    </>
                  );
                })()}
              </>
            )}
            {menu.kind === "edge" && (
              <>
                <MenuItem icon={Palette} onClick={() => { setSelection({ type: "edge", id: menu.id }); setMenu(null); }}>
                  {t("blueprint.menu.inspectWire")}
                </MenuItem>
                {!isDerivedEdge(menu.id) && (
                  <MenuItem icon={Trash2} tint="text-destructive" danger onClick={() => { applyGraphPatch({ op: "remove-edge", edgeId: menu.id }); setMenu(null); }}>
                    {t("blueprint.inspector.remove")}
                  </MenuItem>
                )}
              </>
            )}
          </BlueprintFloatingMenu>
        )}


        {showAiTable && hasSeveralAis(roster) && (
          <AiTable
            world={worldDraft}
            onJump={(id) => { setShowAiTable(false); jumpTo(id); }}
            onClose={() => setShowAiTable(false)}
          />
        )}

        {focusedModule && (
          <div className="absolute left-4 top-16 z-20 flex max-w-[calc(100%-2rem)] studio-pill items-center gap-2 rounded-xl border px-3 py-2">
            <button type="button" onClick={leaveModuleFocus} className="shrink-0 text-xs font-semibold text-amber-300 hover:text-amber-100">{t("blueprint.workspace.back")}</button>
            <span className="text-muted-foreground/40">/</span>
            <span className="truncate text-xs text-foreground">{graphById.get(focusedModule)?.title ?? t("blueprint.workspace.module")}</span>
          </div>
        )}

        {/* Empty state */}
        {isEmpty && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex max-w-sm flex-col items-center gap-4 text-center">
              <Layers className="h-10 w-10 text-muted-foreground/40" />
              <p className="text-sm leading-relaxed text-muted-foreground">{t("blueprint.emptyHint")}</p>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => handleAddGreeting()}
                  className="flex items-center gap-2 rounded-lg bg-amber-500 px-4 py-2 text-sm font-bold text-black transition-opacity hover:opacity-90"
                >
                  <MessageCircle className="h-4 w-4" />
                  {t("blueprint.emptyCta")}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* The selected object's editor.
          On the stage it goes into the right column — the creator is doing
          exactly one of talking to the assistant, playing the card, or editing
          what they clicked, so those three take turns in one place instead of
          a third column shoving the canvas aside. The dockview adapter has no
          column to lend, so there it stays a column of the panel. */}
      {auxiliaryPane && !inspectorHost && (visibleRelationshipId
        ? <div className="min-h-0 shrink-0 border-l border-border/70" style={{ width: inspectorWidth }}>{auxiliaryPane}</div>
        : renderInspector(true))}
      {auxiliaryPane && inspectorHost
        ? createPortal(auxiliaryPane, inspectorHost)
        : null}
    </div>
  );
}

// ── Error boundary ───────────────────────────────────────────────────
// The canvas projects raw card JSON through `toGraph` during render. That
// projection is written to be total over arbitrary JSON, but the card is
// persisted data from older builds, other branches, bundle imports and
// half-landed assistant writes — so "it cannot throw" is a goal, not a
// guarantee. What makes a throw here different from one in any other panel is
// that the blueprint is the ONLY door into an advanced card: it took the
// app-level boundary, /app/worlds/:id/edit bounced straight back into it, and
// the author was left with no way to reach their own card at all.
//
// Keeping the failure inside the canvas leaves the rest of the Studio standing
// — above all the toolbar's Full editors, which is where the bad data gets
// fixed. Matches the ErrorBoundary pattern in canvas-panel.

function BlueprintCrashCard({ error, onRetry }: { error: string; onRetry: () => void }) {
  const { t } = useTranslation("editor");
  return (
    <div className="flex h-full w-full items-center justify-center bg-background p-6">
      <div className="flex max-w-md flex-col gap-4 rounded-xl border border-destructive/30 bg-destructive/5 p-5">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-destructive">{t("blueprint.crash.title")}</p>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{t("blueprint.crash.body")}</p>
          </div>
        </div>
        <p className="max-h-24 overflow-y-auto rounded-lg bg-background/60 p-2 font-mono text-[11px] break-all whitespace-pre-wrap text-destructive/70">
          {error}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="self-start rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {t("blueprint.crash.retry")}
        </button>
      </div>
    </div>
  );
}

class BlueprintErrorBoundary extends Component<
  { children: React.ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { error: error.message || String(error) };
  }

  componentDidCatch(error: Error) {
    // The author sees a card; whoever debugs it needs the stack.
    console.error("[Studio] blueprint canvas failed to render", error);
  }

  render() {
    if (this.state.error !== null) {
      return (
        <BlueprintCrashCard
          error={this.state.error}
          onRetry={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}

/** Host-agnostic canvas — the full-bleed stage renders this directly. */
export function BlueprintCanvasCore(props: BlueprintCanvasCoreProps) {
  return (
    <BlueprintErrorBoundary>
      <ReactFlowProvider>
        <BlueprintCanvas {...props} />
      </ReactFlowProvider>
    </BlueprintErrorBoundary>
  );
}

/** Dockview adapter: drill targets the right rail, focus = group maximize. */
export function BlueprintPanel(props: IDockviewPanelProps) {
  const { t } = useTranslation("editor");

  const onDrillPanel = useCallback((panelId: string) => {
    const existing = props.containerApi.getPanel(panelId);
    if (existing) {
      existing.api.setActive();
      return;
    }
    // Drill into the right rail (live preview + classic panels) so the stage
    // stays visible; fall back to the active group when the rail is gone.
    const ownGroup = props.containerApi.getPanel("blueprint")?.group;
    const rail =
      props.containerApi.getPanel("canvas")?.group ??
      props.containerApi.groups.find(
        (g) => g.id !== ownGroup?.id && !g.panels.some((p) => p.id === "ai-chat"),
      );
    const group = rail ?? getActiveStudioGroup(props.containerApi);
    if (!group) return;
    addStudioPanelInstance({
      containerApi: props.containerApi,
      panelId,
      title: t((PANEL_TITLE_KEY[panelId] ?? panelId) as never),
      referenceGroupId: group.id,
    });
  }, [props.containerApi, t]);

  const [focusMode, setFocusMode] = useState(false);
  /** Column widths captured before maximizing — dockview restores the exit
   *  layout imperfectly (the right rail collapses to its minimum). */
  const railWidthsRef = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    const sub = props.containerApi.onDidMaximizedGroupChange(() => {
      const maxed = props.containerApi.hasMaximizedGroup();
      setFocusMode(maxed);
      if (!maxed && railWidthsRef.current) {
        const saved = railWidthsRef.current;
        railWidthsRef.current = null;
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            for (const [gid, w] of saved) {
              props.containerApi.getGroup(gid)?.api.setSize({ width: w });
            }
          });
        });
      }
    });
    return () => sub.dispose();
  }, [props.containerApi]);
  const toggleFocus = useCallback(() => {
    if (props.containerApi.hasMaximizedGroup()) {
      props.containerApi.exitMaximizedGroup();
    } else {
      const ownGroupId = props.containerApi.getPanel(props.api.id)?.group?.id;
      railWidthsRef.current = new Map(
        props.containerApi.groups
          .filter((g) => g.id !== ownGroupId && typeof g.api.width === "number")
          .map((g) => [g.id, g.api.width]),
      );
      props.api.maximize();
    }
  }, [props.containerApi, props.api]);

  return (
    <BlueprintCanvasCore
      onDrillPanel={onDrillPanel}
      focus={{ active: focusMode, toggle: toggleFocus }}
    />
  );
}
