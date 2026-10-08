import { memo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Handle, Position, useStore, type Node, type NodeProps } from "@xyflow/react";
import { OpeningHoverRing, OpeningOnScreenEditor } from "../inspector/screen-first";
import { PREVIEW_GREETING_ATTR } from "@/features/editor/components/preview/live-frontend-preview";
import { useTranslation } from "react-i18next";
import {
  Activity,
  AlertTriangle,
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  BookOpen,
  Brain,
  Cog,
  Layers,
  Boxes,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsDownUp,
  ChevronsUpDown,
  Clapperboard,
  CornerDownRight,
  Flame,
  ImagePlus,
  Image as ImageIcon,
  Images,
  KeyRound,
  Link2,
  MessageCircle,
  Monitor,
  MonitorSmartphone,
  MoreHorizontal,
  Music,
  Maximize2,
  MessageSquare,
  Pencil,
  Pin,
  Plus,
  Radio,
  Smartphone,
  Variable as VariableIcon,
  Zap,
  Sparkles,
  Store,
  Upload,
  Volume2,
  MessageSquareText,
  Eye,
  Bot,
} from "lucide-react";
import { resolveImageUrl } from "@/lib/asset-url";
import {
  portHandleId,
  rowHandleId,
  type Block,
  type BlockSlot,
  type GraphNode,
} from "@yumina/engine";
import { cn } from "@/lib/utils";
import { DebouncedInput, DebouncedTextarea } from "@/features/editor/components/debounced-field";
import { KIND_STYLE, ROW_TONE } from "./style";
import { FrontendFilesStrip } from "./frontend-files-strip";
import type { FrontendFileFacts } from "@yumina/engine";
import { PieceSeams } from "./piece-seam";
import {
  AI_RECEIVES_H,
  BLOCK_BODY_PAD,
  BLOCK_HEAD_H,
  BLOCK_W,
  DEFAULT_CHAT_HINT_H,
  LOOSE_BANNER_H,
  LORE_ROW_H,
  OPENING_BODY_H,
  OPENING_BODY_H_OPEN,
  PLAIN_ROW_H,
  TRAY_H,
  AI_ROW_H,
  PREVIEW_DESKTOP_W,
  PREVIEW_H,
  SCENE_BARE_HINT_H,
  SCENE_WIDE_W,
  desktopPreviewHeight,
  listColumns,
  openRowEditorHeight,
  SLOT_ROW_H,
  PREVIEW_PHONE_W,
  previewScale,
  screenFrame,
  SCREEN_PAD,
  FACE_BODY_H,
  FACE_COVER_H,
  FACE_COVER_W,
  FACE_STRIP_H,
} from "./board";
import type { TrayItem } from "./starter-board";
import type { PlaceAis } from "./place-ais";
import type { AiVoice, ReceiveChip } from "./ai-roster";
import { formatTokens, type RowCost } from "@/features/editor/lib/context-budget";
import type { ShortWhy } from "../../lib/turn-explain";

/** Block accent by kind. A block wears the colour of what it holds, so a
 *  wire's colour and the block it lands in agree. */
/**
 * A block's colour, and where it is spent.
 *
 * `band` is the header's wash. The writing blocks have painted their headers
 * since the tile board began (emerald for an opening, violet for a shelf of
 * lore) and nothing else did, so on a card's tile the openings and the lore
 * were colours and the interface, the memory, the variables and the
 * behaviours were four identical dark bars with a small icon on each. Inside
 * a tile the blocks are flush — no gutter, no card edge — so the header band
 * is the only place a block's kind can be read at a glance.
 */
/**
 * The empty picture slot, on both letterhead blocks.
 *
 * It used to be the button's own near-black, which on a dark board is a hole
 * — the two places a card's pictures go looked like the two places nothing
 * would ever go. A soft warm wash reads as a slot waiting to be filled, and
 * it is the same wash on both so they are plainly a pair.
 */
const EMPTY_PICTURE = "border border-dashed border-zinc-300/30 bg-[#f6f1e8]/[0.07] text-zinc-300/70";

/**
 * A block with nothing in it yet: its own colour, turned down.
 *
 * An empty variables or behaviours block used to be drawn NEUTRAL, so the two
 * shelves a card gets its mechanics from were grey until the first row landed
 * and then suddenly blue and orange. The colour is what says which shelf you
 * are looking at, and it is needed most before there is any content to tell
 * them apart by. Dimmed, not drained — the same rule the rows follow.
 */
const BLOCK_FAINT: Partial<Record<Block["kind"], { band: string; chip: string }>> = {
  state: { band: "bg-white/[0.015] shadow-[inset_2px_0_0_#0ea5e966]", chip: "bg-sky-500/[0.08] text-sky-300/50" },
  behavior: { band: "bg-white/[0.015] shadow-[inset_2px_0_0_#f9731666]", chip: "bg-orange-500/[0.08] text-orange-300/50" },
  audio: { band: "bg-white/[0.015] shadow-[inset_2px_0_0_#14b8a666]", chip: "bg-teal-500/[0.08] text-teal-300/50" },
  image: { band: "bg-white/[0.015] shadow-[inset_2px_0_0_#ec489966]", chip: "bg-pink-500/[0.08] text-pink-300/50" },
  lore: { band: "bg-white/[0.015] shadow-[inset_2px_0_0_#8b5cf666]", chip: "bg-violet-500/[0.08] text-violet-300/50" },
};

/** What the guide calls each block when it points at one. */
const BLOCK_ONBOARDING: Partial<Record<Block["kind"], string>> = {
  card: "card-face",
  background: "background",
  frontend: "player-interface",
  scene: "scene",
  state: "variables",
  behavior: "behaviors",
  context: "memory",
  audio: "audio",
  image: "scene-images",
};

// The head is neutral and the kind is a 2px line down its left edge and the
// icon's chip: eight tinted bands down one tile were eight colours shouting
// at once, and the icon alone already says which shelf it is.
const BLOCK_STYLE: Record<Block["kind"], { accent: string; chip: string; band: string; icon: typeof Zap }> = {
  // The card's own two blocks keep the neutral — they ARE the card, not a
  // department of it — but at a weight you can see. At 7% the band was
  // invisible and they read as chrome rather than as blocks.
  card: { accent: "border-zinc-300/45", chip: "bg-zinc-300/20 text-zinc-100", band: "bg-white/[0.025] shadow-[inset_2px_0_0_#d4d4d8]", icon: KIND_STYLE.world.icon },
  // The same neutral as the card: it is the card's own picture, not a fifth
  // department. A colour of its own would claim a rank it does not have —
  // and with the picture drawn at size, the picture is the colour.
  background: { accent: "border-zinc-300/45", chip: "bg-zinc-300/20 text-zinc-100", band: "bg-white/[0.025] shadow-[inset_2px_0_0_#d4d4d8]", icon: ImageIcon },
  opening: { accent: "border-emerald-500/40", chip: "bg-emerald-500/15 text-emerald-300", band: "bg-white/[0.025] shadow-[inset_2px_0_0_#10b981]", icon: MessageCircle },
  lore: { accent: "border-violet-500/40", chip: "bg-violet-500/15 text-violet-300", band: "bg-white/[0.025] shadow-[inset_2px_0_0_#8b5cf6]", icon: BookOpen },
  behavior: { accent: "border-orange-500/40", chip: "bg-orange-500/15 text-orange-300", band: "bg-white/[0.025] shadow-[inset_2px_0_0_#f97316]", icon: Zap },
  state: { accent: "border-sky-500/40", chip: "bg-sky-500/15 text-sky-300", band: "bg-white/[0.025] shadow-[inset_2px_0_0_#0ea5e9]", icon: VariableIcon },
  frontend: { accent: "border-rose-500/40", chip: "bg-rose-500/15 text-rose-300", band: "bg-white/[0.025] shadow-[inset_2px_0_0_#f43f5e]", icon: Smartphone },
  audio: { accent: "border-teal-500/40", chip: "bg-teal-500/15 text-teal-300", band: "bg-white/[0.025] shadow-[inset_2px_0_0_#14b8a6]", icon: Music },
  image: { accent: "border-pink-500/40", chip: "bg-pink-500/15 text-pink-300", band: "bg-white/[0.025] shadow-[inset_2px_0_0_#ec4899]", icon: Images },
  // Memory is lime, after two goes at it. Amber was wrong because amber is
  // this board's attention colour (selected, recent, added, the module gate
  // that is on), so a memory block wore the highlight permanently. Indigo was
  // wrong because the two blocks it sits nearest — lore in violet, variables
  // in sky — are the same blue-purple family, and a third one between them
  // reads as a shade of those rather than a kind of its own. Lime is the only
  // family this palette has not spent, and it is 76 degrees off emerald.
  context: { accent: "border-lime-500/40", chip: "bg-lime-500/15 text-lime-300", band: "bg-white/[0.025] shadow-[inset_2px_0_0_#84cc16]", icon: Brain },
  // A module's scene is a piece of the frontend, so it wears the same rose.
  scene: { accent: "border-rose-500/40", chip: "bg-rose-500/15 text-rose-300", band: "bg-white/[0.025] shadow-[inset_2px_0_0_#f43f5e]", icon: Clapperboard },
  // Not a department either: a line of invitations at the foot of the tile.
  tray: { accent: "border-white/10", chip: "bg-white/[0.06] text-muted-foreground", band: "bg-transparent", icon: Plus },
  // The AIs answering here wear the pink every AI on the board wears.
  ais: { accent: "border-pink-400/45", chip: "bg-pink-400/15 text-pink-300", band: "bg-white/[0.025] shadow-[inset_2px_0_0_#f472b6]", icon: Bot },
};

/** Minimap dots — the map stays readable as coloured slabs. */
export const BLOCK_MINI: Record<Block["kind"], string> = {
  card: KIND_STYLE.world.mini,
  background: KIND_STYLE.world.mini,
  opening: KIND_STYLE.greeting.mini,
  lore: KIND_STYLE.entry.mini,
  behavior: KIND_STYLE.rule.mini,
  state: KIND_STYLE.variable.mini,
  frontend: KIND_STYLE.component.mini,
  audio: KIND_STYLE.audio.mini,
  image: KIND_STYLE.image.mini,
  context: "#a3e635",
  scene: KIND_STYLE.component.mini,
  tray: "#3f3f46",
  ais: "#f472b6",
};

/** Module tints — a row wears its module's colour so membership reads without
 *  the module having to be a box that swallows the row. */
export const GATE_TINTS = ["#d9a13f", "#a78bfa", "#2dd4bf", "#f472b6", "#84cc16", "#60a5fa", "#fb923c", "#c084fc"];
export const gateTint = (index: number) => GATE_TINTS[index % GATE_TINTS.length]!;

const HANDLE_BASE =
  "!h-3 !w-3 !border-2 !border-[#0e0d11] transition-transform hover:!scale-150 !cursor-crosshair !z-10";

export interface BlockRowView {
  g: GraphNode;
  title: string;
  /** What this object actually says: the entry's own text, a variable's value,
   *  a behaviour's trigger. The whole reason the board replaced the rack. */
  preview?: string;
  /** What this row ships on every turn, and how it gets in. Entries only. */
  cost?: RowCost;
  /** Wires touching this row. Nothing is drawn until a row is lit, so this
   *  count is the only sign that the row is connected at all. */
  links?: { in: number; out: number };
  /** What fires this row, when the answer lives in the SAME block — an event
   *  source, or the behaviour whose emit it listens for. A wire would have to
   *  leave the block and loop back to say this, so the row says it instead.
   *  Cross-block triggers (a variable) are already drawn as wires. */
  firedBy?: string;
  hasIn: boolean;
  hasOut: boolean;
  slots: BlockSlot[];
  tint?: string;
  moduleTitle?: string;
  live?: { value?: string; delta?: string; active?: boolean; why?: ShortWhy };
  /** What this object did on the turn that just ran.
   *
   *  "used" is only ever set from what the server reported actually happening
   *  — the engine can say which entries COULD fire, never which did, because
   *  only the words the player said decide. Absent means the turn did not
   *  report, which is different from "did not fire" and must not dim. */
  ranThisTurn?: "used" | "idle";
  turn?: "added" | "changed";
  recent?: boolean;
  disabled?: boolean;
  readByUi?: boolean;
  deadRead?: boolean;
  /** Summary rows (folded core entries) carry a count instead of a wire. */
  count?: number;
  /** Variable rows: the declared type, so the value chip knows how to edit. */
  varType?: "number" | "string" | "boolean" | "json";
  /** What kind of thing this row is, in a word or two, worn as chips after
   *  its name: a variable's type and whether the judge tracks it, a track's
   *  kind. The board used to leave all of that to the inspector, and a
   *  beginner reading "好感 0" learned nothing about what a variable can be.
   *  `accent` marks the ones that are a setting turned on, not a kind. */
  tags?: Array<{ text: string; accent?: boolean }>;
  /** The one line that says what the row is FOR, in the author's words: a
   *  variable's rules for when it changes, a track's cue for when the AI
   *  plays it, a scene image's cue for when the AI shows it. Grey, after
   *  the name, truncated — the inspector has the whole of it. */
  note?: string;
  /** The row has no cue and so the AI will never reach for it on its own:
   *  the note says so in the row's own quiet voice. */
  noteQuiet?: boolean;
  /** The entry exists but nobody wrote it yet — previewed as an invitation,
   *  visually quieter than rows that carry real prose. */
  emptyContent?: boolean;
  /** The card's object, drawn inside a module because this module's AI
   *  receives it. The same row, the same object, in every module. */
  shared?: boolean;
}

/**
 * One line of a context block.
 *
 * These are facts about the frame's AI — what it remembers, who it reads, who
 * reads it, what the card shares in — not objects the creator made. So they
 * carry no handles and cannot be dragged; clicking one opens the module they
 * are about, which is where the wiring is actually declared.
 */
export type ContextRowView = {
  key: string;
  icon: "memory" | "in" | "out" | "both" | "shared" | "trap" | "worker" | "judge" | "wake" | "does" | "scene";
  /** Which part of the AI call this row answers — drawn as a word before it,
   *  so the block reads 叫醒 / 记得 / 读 / 能做 top to bottom. */
  slot?: "wake" | "remember" | "sees" | "reads" | "does";
  text: string;
  title?: string;
  onClick?: () => void;
  /** The memory pool this row is about, as a colour. Two modules that
   *  remember each other's runs get the same one, and a second pool on the
   *  same card gets a different one — which is what turns "A and B share a
   *  memory, C and D share another" from two sentences into something the
   *  board says without being read. */
  tint?: string;
};

/**
 * A tool on a block's header: the way this block's slot gets filled from
 * outside the board. Every media block wears the same three in the same
 * order — upload · generate · market — and shows only the ones it has, so an
 * author learns them once. `generate` opens the image popover for the slot;
 * `upload` takes a file; `market` opens the bundle browser filtered to what
 * this block holds.
 */
export interface BlockTool {
  id: "upload" | "generate" | "market" | "voice" | "open";
  label: string;
  onClick: () => void;
}

export type BlockNodeData = {
  /** A drop on the block is a drop on the frame it stands in. */
  dropIn?: { over: (e: React.DragEvent) => void; drop: (e: React.DragEvent) => void };
  block: Block;
  title: string;
  /** The cost / count line under the title. */
  subtitle?: string;
  rows: BlockRowView[];
  collapsed: boolean;
  /** Opening blocks: show the whole text rather than the first lines. */
  expanded: boolean;
  hiddenCount: number;
  emptyLabel: string;
  /** Opens the mechanic-pack picker. Present only on the card's own empty
   *  variables / behaviours blocks — the two places a new creator stalls,
   *  because the "+" there leads to a form that asks for a variable name
   *  before it has shown them what a variable is. */
  onOpenPacks?: () => void;
  addLabel?: string;
  /** The block's header tools, in the fixed order upload · generate · market. */
  tools?: BlockTool[];
  selectedId?: string | null;
  /** Rows picked up with Shift / Ctrl-click or a marquee, beside the one
   *  the inspector is open on. They light up the same way, and Delete or the
   *  batch bar acts on all of them. */
  multiSelected?: ReadonlySet<string> | null;
  /** Ids wired to the current selection — everything else greys back. */
  focusIds?: ReadonlySet<string> | null;
  readOnly: boolean;
  /** Simple mode: list blocks are name chips; no previews, costs or counts. */
  /** The board is zoomed out to see the whole card: a row is its name and
   *  its kind, and the note, value and link counts wait for a zoom you can
   *  read them at. */
  /** The tray's line of "+": which unused slots it offers, and what a click
   *  on one does (bring the slot out as its block, or open a page). */
  tray?: { items: readonly TrayItem[]; onPick: (item: TrayItem, anchor?: DOMRect) => void };
  glance?: boolean;
  /** Rows opened for editing in place, by object id. A click on a row still
   *  opens the drawer; this is the second way in. */
  expandedIds?: ReadonlySet<string>;
  /** The chevron at the right of every row whose object has an editor. */
  onToggleRowExpand?: (objectId: string) => void;
  /** Whether this object HAS one. An audio track and a legacy rule do not, so
   *  their rows show no chevron rather than one onto an empty box. */
  canExpandRow?: (objectId: string) => boolean;
  /** What to draw inside an open row. Supplied by the panel, so this node
   *  keeps knowing nothing about the draft store or the inspector's forms. */
  renderEditor?: (objectId: string) => React.ReactNode;
  /** This block is on the board to say it EXISTS, not because it holds
   *  anything yet — an empty variables shelf, the card's own memory. It draws
   *  in neutral so the two blocks the author actually writes in are the loudest
   *  things on a card that has just been made. */
  quiet?: boolean;
  /** Nothing in it yet: its own hue, turned down. See BLOCK_FAINT. */
  faint?: boolean;
  /** The width the tile laid this block out at. Absent, the classic 300. */
  width?: number;
  /** Laid inside a module tile: share edges with the blocks around it. */
  flush?: boolean;
  /** The height of the row it shares, so a pair has one bottom edge. */
  fillHeight?: number;
  /** Which edges of this piece are seams with another piece, not the
   *  module's own border — that is where the knob goes. */
  seamTop?: boolean;
  seamLeft?: boolean;
  /** The module this block belongs to, for the drag payload. */
  ownerId?: string | null;
  /** Piece picked up / put down, so the board can open a slot for it. */
  onPieceDrag?: (kind: Block["kind"] | null) => void;
  /** Shift-click on a head: take the whole piece into the selection. */
  onPieceSelect?: (ids: string[], add: boolean) => void;
  /** "N more" on a tile: the column lists the whole block, the tile stays
   *  a tile. Absent, the rows unfold in place. */
  onMore?: () => void;

  /** kind === "card" */
  card?: {
    compact?: boolean;
    name: string;
    description: string;
    coverUrl?: string;
    onCommitName: (v: string) => void;
    onCommitDescription: (v: string) => void;
    /** A secondary variant: its name and blurb belong to the primary. */
    locked?: boolean;
    /** Where a cover actually gets set (upload / crop / pick). */
    onOpenCover: () => void;
    onOpenAssets: () => void;
    onOpenOverview: () => void;
    /** The card's own properties (name, blurb, what the AI reads). Every
     *  content row has a Settings button; the card face must not be the one
     *  node whose settings hide behind the outline. */
    onOpenSettings: () => void;
    /** On a card with modules the card has no shelves (it is a strip), so
     *  the one thing only the card can hold — an opening — is added here. */
    onAddOpening?: () => void;
  };
  background?: {
    /** Already resolved and absolute — the strip shows the picture the
     *  player will actually see, at the blur and dim the author chose. */
    url?: string;
    blur: number;
    /** 0–80, as the author set it (not the 0–1 the renderer takes). */
    dim: number;
    /** 10–100, the picture's own alpha. Black over it is `dim`; this is how
     *  much of the picture there is. */
    opacity: number;
    count: number;
    /** Whether a cover exists to make one from. */
    canUseCover: boolean;
    onUseCover: () => void;
    onOpen: () => void;
  };
  /** kind === "opening" */
  opening?: {
    entryId: string;
    /** The opening's own text, rendered the way the player will read it. */
    html: string;
    empty: boolean;
    /** The raw text behind the rendered html — what the textarea edits. */
    raw: string;
    onCommitName: (v: string) => void;
    onCommitContent: (v: string) => void;
    seedCount: number;
  };
  /** kind === "frontend" */
  frontend?: {
    openingPicker?: React.ReactNode;
    /** Layout and theme, on the block: the two choices the preview answers. */
    lookPicker?: React.ReactNode;
    /** Open the interface's visual editor (the full player-interface page,
     *  edit mode on). The one obvious way in, rather than the header's ⤢. */
    onEdit?: () => void;
    /** The screen's pages, in order, as chips that open the editor on one —
     *  and the way to add a page without first finding the editor. */
    pages?: { list: Array<{ id: string; name: string; entry: boolean }>; onOpen: (pageId: string) => void; onNew: () => void };
    /** How many openings the card has — the preview's opening picker only
     *  shows when there is a choice to make. */
    openingCount?: number;
    defaultChat?: boolean;
    /** The stock chat: one line saying so, no preview of an empty chat. */
    thin?: boolean;
    /** Folded by the author: one line that opens the preview again. */
    folded?: boolean;
    onToggleFold?: () => void;
    emptyOpening?: boolean;
    /** The opening the screen is playing: clicking it on the screen edits it
     *  there. Absent when the board is read-only. */
    openingId?: string;
    /** Live render of the card's TSX. Paused while something else owns it. */
    render: React.ReactNode | null;
    pausedLabel?: string;
    readNames: string[];
    dynamicReads: number;
    /** The interface's files, what each reads/writes/asks the AI — the strip
     *  under the phone. Absent or empty for the stock chat. */
    files?: FrontendFileFacts[];
    entryFile?: string;
    aiCalls?: number;
    onOpenFile?: (file: string, line: number) => void;
    /** Which device the preview is laid out for. The player sees one or the
     *  other, so the block has to be able to show either. */
    device?: "desktop" | "phone";
    onToggleDevice?: () => void;
  };
  /** kind === "context" */
  context?: { rows: ContextRowView[] };
  /** kind === "ais": who answers in this frame. */
  ais?: PlaceAis & {
    /** The row whose settings are open in the column, lit like a selected row. */
    openKey: string | null;
    /** Open a row's settings in the column; `bookId` names a situation's AI,
     *  none the card's own. */
    onToggle: (key: string, memory?: boolean, bookId?: string) => void;
    onRemove?: (bookId: string) => void;
    /** Stick a note beside this block. */
    onNote?: () => void;
    /** A situation with AIs of its own: keep the narrator talking here too. */
    onKeepNarrator?: (keep: boolean) => void;
  };
  /** A loose block: a new card-level object standing on the canvas until it
   *  is dragged into a module — or sent to all of them with this. */
  loose?: { onShareAll: () => void };
  /** kind === "scene" */
  scene?: {
    openingPicker?: React.ReactNode;
    file?: string;
    files: string[];
    /** Nothing of its own to preview (no file, and the card has no interface
     *  either): a line saying so and the picker, no preview. */
    bare?: boolean;
    /** This module's live preview — the interface in the state that opens
     *  the module. Null while the dock or a playtest owns the screen. */
    render: React.ReactNode | null;
    pausedLabel?: string;
    /** Previewed at desktop width (two columns) or phone width (one). */
    device: "desktop" | "phone";
    onToggleDevice: () => void;
    onPick: (file: string | undefined) => void;
    onEdit: () => void;
  };

  /** The row whose in-place editor is open. One at a time, board-wide: two
   *  open editors is two places to look, which is the problem this fixes. */

  onToggleCollapse: () => void;
  onToggleExpand: () => void;
  onExpandRows: () => void;
  onAdd?: (anchor?: DOMRect) => void;
  /** Fills the assistant's composer with a request scoped to this block.
   *  Absent on blocks the assistant has no tool for. */
  onAsk?: () => void;
  /** State blocks: commit a variable's starting value edited on its row. */
  onCommitVariableValue?: (variableId: string, raw: string | boolean) => void;
  /** Open the big centred editor on this object's text — writing a scene into
   *  a 300px block is possible the way writing in a car park is possible. */
  onFocusEdit?: (objId: string) => void;
  onRowClick: (objId: string, e: React.MouseEvent) => void;
  /** Pointing at a row lights its wires — nothing is drawn until you do. */
  onRowHover: (objId: string | null) => void;
  onRowDoubleClick: (objId: string) => void;
  onRowContextMenu: (objId: string, e: React.MouseEvent) => void;
  /** Put `dragged` where `target` sits. Absent while read-only. */
  onRowDrop?: (dragged: string, target: string) => void;
};

export type BlockFlowNode = Node<BlockNodeData>;

// ── shared bits ─────────────────────────────────────────────────────

/** Editing happens on the board, not in a drawer. A title reads as a title
 *  until you click it, and the field it becomes occupies exactly the same box
 *  — so nothing shifts, and the block's height stays what the layout computed. */
const INLINE_FIELD =
  "nodrag w-full min-w-0 rounded border border-transparent bg-transparent px-1 -mx-1 text-foreground " +
  "transition-colors hover:border-border/70 hover:bg-black/25 focus:border-[rgba(240,198,116,0.5)] focus:bg-black/40 focus:outline-none";

function InlineTitle({
  value,
  syncKey,
  onCommit,
  readOnly,
  placeholder,
}: {
  value: string;
  syncKey: string;
  onCommit: (v: string) => void;
  readOnly: boolean;
  placeholder?: string;
}) {
  if (readOnly) {
    return <div className="truncate px-1 -mx-1 text-[12px] font-bold leading-tight tracking-tight">{value}</div>;
  }
  return (
    <DebouncedInput
      value={value}
      syncKey={syncKey}
      onCommit={onCommit}
      placeholder={placeholder}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      className={cn(INLINE_FIELD, "text-[12px] font-bold leading-tight tracking-tight")}
    />
  );
}

/** The card's object, drawn here because this module's AI receives it. The
 *  same mark on the same row in every module is what says "one object". */
function SharedMark() {
  const { t } = useTranslation("editor");
  return (
    <span
      title={t("blueprint.block.sharedRowHint")}
      className="flex shrink-0 items-center gap-0.5 rounded bg-zinc-500/15 px-1 py-0.5 text-[8px] font-bold text-zinc-300/80"
    >
      <Link2 className="h-2.5 w-2.5" />
      {t("blueprint.block.sharedRow")}
    </span>
  );
}

function LinkCounts({ links }: { links?: { in: number; out: number } }) {
  const total = (links?.in ?? 0) + (links?.out ?? 0);
  if (total === 0) return null;
  return (
    <span className="shrink-0 rounded bg-white/[0.06] px-1 text-[9px] font-bold tabular-nums text-muted-foreground/70">
      {total}
    </span>
  );
}

function CostBadge({ cost }: { cost?: RowCost }) {
  const { t } = useTranslation("editor");
  if (cost?.alwaysOn) {
    return (
      <span
        title={t("blueprint.cost.alwaysOnHint")}
        className={cn(
          "flex shrink-0 items-center gap-1 rounded px-1 py-0.5 font-mono text-[10px] tabular-nums",
          // Only a HOT cost earns colour. A pin on every row is a poster wall;
          // a quiet number is a label.
          cost.hot ? "bg-red-500/15 font-bold text-red-300 ring-1 ring-red-500/40" : "text-muted-foreground/45",
        )}
      >
        {cost.hot ? <Flame className="h-2.5 w-2.5" /> : <Pin className="h-2.5 w-2.5 opacity-60" />}~{formatTokens(cost.tokens)}
      </span>
    );
  }
  if (cost?.trigger === "keywords") {
    return (
      <span title={t("blueprint.cost.keywordHint")} className="shrink-0 rounded p-0.5 text-muted-foreground/40">
        <KeyRound className="h-2.5 w-2.5" />
      </span>
    );
  }
  return null;
}

const whyTone: Record<ShortWhy["tone"], string> = {
  ai: "border-amber-500/40 text-amber-300",
  judge: "border-sky-400/40 text-sky-300",
  rule: "border-violet-400/40 text-violet-300",
  fix: "border-emerald-400/40 text-emerald-300",
  warn: "border-red-400/45 text-red-300",
  plain: "border-border text-muted-foreground",
};

function LiveBadge({ live }: { live?: BlockRowView["live"] }) {
  const { t } = useTranslation("editor");
  if (!live || (!live.why && live.value === undefined)) return null;
  return (
    <>
    {live.why && <span className={cn("shrink-0 rounded border px-1 text-[9.5px] leading-4", whyTone[live.why.tone])}>
      {t(`studio.why.${live.why.key}` as "studio.why.src.ai")}</span>}
    {live.value !== undefined && <span
      className={cn(
        "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold tabular-nums transition-colors",
        live.delta ? "bg-[rgba(240,198,116,0.18)] text-[#f5d48a] ring-1 ring-[rgba(240,198,116,0.55)]" : "bg-emerald-500/12 text-emerald-300",
      )}
    >
      {live.delta && <Activity className="h-2.5 w-2.5" />}
      {live.value}
      {live.delta && <span className="text-[#f5d48a]/90">{live.delta}</span>}
    </span>}
    </>
  );
}

function TurnBadge({ turn }: { turn?: "added" | "changed" }) {
  const { t } = useTranslation("editor");
  if (!turn) return null;
  return (
    <span
      className={cn(
        "shrink-0 rounded px-1 py-0.5 text-[9px] font-bold",
        turn === "added" ? "bg-emerald-500/20 text-emerald-300" : "bg-[rgba(240,198,116,0.18)] text-[#f5d48a]",
      )}
    >
      {t(turn === "added" ? "blueprint.turn.added" : "blueprint.turn.changed")}
    </span>
  );
}

function RowHandles({ row }: { row: BlockRowView }) {
  const style = KIND_STYLE[row.g.kind];
  return (
    <>
      {row.hasIn && (
        <Handle
          id={rowHandleId(row.g.id, "in")}
          type="target"
          position={Position.Left}
          className={cn(HANDLE_BASE, "!bg-zinc-500", !row.links?.in && "!opacity-0 group-hover/row:!opacity-70")}
        />
      )}
      {row.hasOut && (
        <Handle
          id={rowHandleId(row.g.id, "out")}
          type="source"
          position={Position.Right}
          className={cn(HANDLE_BASE, style.port, !row.links?.out && "!opacity-0 group-hover/row:!opacity-70")}
        />
      )}
    </>
  );
}

/** Module membership: a coloured spine, not a box around the row. */
function ModuleSpine({ tint, title }: { tint?: string; title?: string }) {
  return (
    <span
      className="absolute inset-y-0 left-0 w-[3px]"
      style={{ background: tint ?? "transparent" }}
      title={title}
    />
  );
}

/** The little "new" mark on something that just appeared or just landed —
 *  the pulse alone is easy to miss on a busy board. */
function NewTag() {
  const { t } = useTranslation("editor");
  return (
    <span className="ml-1 shrink-0 rounded bg-[#f0c674] px-1 text-[9px] font-bold leading-4 text-black">{t("blueprint.loose.newTag")}</span>
  );
}

function rowInteractions(data: BlockNodeData, objId: string) {
  return {
    // A row is a div (its drag and its handles rule out <button>), so the
    // keyboard reaches it the ARIA way: focusable, announced as a button,
    // Enter/Space select it. Delete on a focused row is the panel's key
    // handler, which recognises rows by the same `data-row-anchor`.
    tabIndex: 0,
    role: "button" as const,
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      data.onRowClick(objId, e as unknown as React.MouseEvent);
    },
    onClick: (e: React.MouseEvent) => data.onRowClick(objId, e),
    onDoubleClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      data.onRowDoubleClick(objId);
    },
    onContextMenu: (e: React.MouseEvent) => data.onRowContextMenu(objId, e),
    onMouseEnter: () => data.onRowHover(objId),
    onMouseLeave: () => data.onRowHover(null),
    // Native drag-and-drop rather than React Flow's node drag: a row is not a
    // node, and this is the gesture that answers "how do I put this variable
    // inside that module?" — without it a creator can see the grouping and
    // has no way to change it.
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/yumina-object", objId);
      // Its kind too, so a row only offers to take rows of its own kind.
      e.dataTransfer.setData(`application/yumina-kind-${objId.slice(0, objId.indexOf(":"))}`, "1");
      // Where it comes from rides along as a MIME type (the only thing a
      // drop target may read before the drop), so the frame under the
      // pointer can say "only in this module" vs "move here".
      const row = data.rows.find((r) => r.g.id === objId);
      const from = row?.g.parentId?.startsWith("module:") ? row.g.parentId.slice("module:".length) : "core";
      e.dataTransfer.setData(`application/yumina-from-${from}`, "1");
      // What you drag is the chip, not a screenshot of half the block.
      const ghost = document.createElement("div");
      ghost.textContent = row?.g.title ?? objId;
      ghost.style.cssText =
        "position:fixed;top:-1000px;left:-1000px;padding:5px 12px;border-radius:8px;background:#221c2e;color:#f5e9c8;border:1px solid #d9a13f;font:600 12px system-ui,sans-serif;box-shadow:0 8px 22px rgba(0,0,0,.55);white-space:nowrap";
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 16, 16);
      setTimeout(() => ghost.remove(), 0);
      // Held, the row stays in place emptied out (studio-material.css
      // [data-row-lifted]); a row it would land above shows a line of light
      // ([data-row-landing]).
      (e.currentTarget as HTMLElement).setAttribute("data-row-lifted", "");
    },
    onDragEnd: (e: React.DragEvent) => {
      (e.currentTarget as HTMLElement).removeAttribute("data-row-lifted");
      document.querySelectorAll("[data-row-landing]").forEach((el) => el.removeAttribute("data-row-landing"));
    },
    // A row is also a place to drop one. Dragging onto a FRAME re-homes the
    // object; dragging onto a row in the same block puts it there — which is
    // what a list is for, and the order a block shows is the order the prompt
    // sends. Stop the event so the frame underneath does not also claim it and
    // re-home something that never left.
    onDragOver: (e: React.DragEvent) => {
      if (!data.onRowDrop) return;
      const kindType = Array.from(e.dataTransfer.types).find((ty) => ty.startsWith("application/yumina-kind-"));
      const sameKind = !kindType || kindType === `application/yumina-kind-${objId.slice(0, objId.indexOf(":"))}`;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      const el = e.currentTarget as HTMLElement;
      if (sameKind && !el.hasAttribute("data-row-lifted") && !el.hasAttribute("data-row-landing")) el.setAttribute("data-row-landing", "");
    },
    onDragLeave: (e: React.DragEvent) => {
      const el = e.currentTarget as HTMLElement;
      if (!el.contains(e.relatedTarget as globalThis.Node | null)) el.removeAttribute("data-row-landing");
    },
    onDrop: (e: React.DragEvent) => {
      (e.currentTarget as HTMLElement).removeAttribute("data-row-landing");
      if (!data.onRowDrop) return;
      const dragged = e.dataTransfer.getData("application/yumina-object");
      if (!dragged || dragged === objId) return;
      e.preventDefault();
      e.stopPropagation();
      data.onRowDrop(dragged, objId);
    },
  };
}

/** Is this row open in place? */
const rowOpen = (data: BlockNodeData, objId: string) => Boolean(data.expandedIds?.has(objId));

/**
 * The chevron every row that can be edited carries, on the right, always
 * visible.
 *
 * It is the second way into an object, beside the click that opens the drawer:
 * the same editor, without a column over the board. Always visible because
 * everything the row holds is behind it — a control you have to hover to find
 * is a control nobody knows is there.
 */
function RowExpandToggle({ data, objId }: { data: BlockNodeData; objId: string }) {
  const { t } = useTranslation("editor");
  if (!data.onToggleRowExpand || !data.renderEditor) return null;
  if (data.canExpandRow && !data.canExpandRow(objId)) return null;
  const open = rowOpen(data, objId);
  return (
    <button
      type="button"
      data-row-expand={objId}
      aria-expanded={open}
      title={t(open ? "blueprint.writing.collapseRow" : "blueprint.writing.expandRow")}
      aria-label={t(open ? "blueprint.writing.collapseRow" : "blueprint.writing.expandRow")}
      onClick={(e) => { e.stopPropagation(); data.onToggleRowExpand!(objId); }}
      onPointerDown={(e) => e.stopPropagation()}
      className={cn(
        "nodrag flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-white/10 hover:text-foreground",
        open ? "text-[#f5d48a]" : "text-muted-foreground/60",
      )}
    >
      <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-150", open && "rotate-180")} />
    </button>
  );
}

/** The open row's body: the object's own editor, at the fixed height the
 *  layout counted, scrolling inside itself so typing never resizes the board. */
function RowInlineEditor({ data, objId }: { data: BlockNodeData; objId: string }) {
  if (!rowOpen(data, objId) || !data.renderEditor) return null;
  if (data.canExpandRow && !data.canExpandRow(objId)) return null;
  return (
    <div
      data-row-editor={objId}
      // `nowheel` so a long form scrolls instead of zooming the board; a
      // column so the body of text takes the slack rather than leaving a hole.
      className="nodrag nowheel nokey flex flex-col overflow-y-auto overscroll-contain border-t border-white/[0.07] bg-white/[0.02] px-3 py-3"
      style={{ height: openRowEditorHeight(objId) }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && !e.altKey && /^[zys]$/i.test(e.key)) return;
        e.stopPropagation();
      }}
    >
      {data.renderEditor(objId)}
    </div>
  );
}

/** A row is OFF when it is switched off or the run says it is inactive. Not
 *  when it is merely quiet: a row nobody reads is still on. */
export const rowIsOff = (row: BlockRowView) => Boolean(row.disabled) || row.live?.active === false;

const rowStateClass = (row: BlockRowView, selected: boolean, dimmed: boolean) => {
  const tone = ROW_TONE[row.g.kind];
  const off = rowIsOff(row);
  return cn(
    // `nodrag`: a row has its own drag (into a module) and its own click.
    // Without it, pressing a row would start dragging the whole module.
    "nodrag group/row relative flex cursor-pointer items-center gap-2 px-2.5 transition-colors hover:bg-white/[0.06]",
    // Rows carry no wash of their kind any more — the block's edge and the
    // icon say that. Switched-off ones go dim IN THEIR OWN COLOUR (the title
    // picks up `tone.dim`). Never `saturate-0` — see ROW_TONE.
    off && "opacity-70",
    // The selected row is lit, not painted: a warm wash and a line of light
    // down its left edge (studio-material.css).
    // Strong enough to find again across the board: one row or ten.
    selected && "bg-amber-400/[0.11] shadow-[inset_3px_0_0_#f0c674,inset_0_0_0_1px_rgba(240,198,116,0.5)]",
    dimmed && "opacity-30",
    // Only ever on a turn that reported. Dimming a row because the server
    // said nothing would read as "this does not work".
    row.ranThisTurn === "idle" && "opacity-45",
    // The turn it fires, the same hue at full — a behaviour lights orange, a
    // variable lights blue, so what moved says what KIND of thing moved.
    row.ranThisTurn === "used" && tone.hot,
    row.recent && "animate-pulse bg-[rgba(240,198,116,0.18)]",
    // Added / changed stay green and amber for every kind: that pair is the
    // diff's language, not the kind's, and it only shows in the change view.
    row.turn === "added" && "bg-emerald-500/10",
    row.turn === "changed" && "bg-[rgba(240,198,116,0.08)]",
  );
};


/** A lore row: the entry's name, and two lines of what it actually says. */
function LoreRow({ row, data, selected, dimmed }: { row: BlockRowView; data: BlockNodeData; selected: boolean; dimmed: boolean }) {
  const { t } = useTranslation("editor");
  return (
    <>
      <div
        {...rowInteractions(data, row.g.id)}
        // The panel centres the viewport on this element when its editor opens.
        data-row-anchor={row.g.id}
        className={cn(
          rowStateClass(row, selected, dimmed),
          "!items-start py-1.5",
          // An inset hairline, not a border: borders add a pixel and the block
          // height model counts every pixel. This is what stops one row's
          // preview from visually crashing into the next row's title.
          "shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]",
        )}
        style={{ height: LORE_ROW_H }}
      >
        <RowHandles row={row} />
        <ModuleSpine tint={row.tint} title={row.moduleTitle} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[12px] font-semibold leading-none",
                selected
                  ? "text-foreground"
                  : rowIsOff(row)
                    ? ROW_TONE[row.g.kind].dim
                    : row.shared
                      ? "text-foreground/70"
                      : "text-foreground/90",
              )}
            >
              {row.title}
            </span>
            {row.recent && <NewTag />}
            {row.shared && <SharedMark />}
            {row.ranThisTurn === "used" && (
          <span
            title={t("blueprint.xray.usedHint")}
            className="shrink-0 rounded bg-emerald-500/15 px-1 py-px text-[9px] font-semibold text-emerald-300"
          >
            {t("blueprint.xray.used")}
          </span>
        )}
        <TurnBadge turn={row.turn} />
            <LinkCounts links={row.links} />
            <CostBadge cost={row.cost} />
          </div>
          {/* The entry's own words. A name tells you which entry it is; this
              tells you whether it is the one you meant. Unwritten entries are
              an invitation, not content — they whisper. */}
          <div
            className={cn(
              "mt-1 line-clamp-2 text-[10.5px] leading-[1.45]",
              row.emptyContent ? "italic text-muted-foreground/35" : "text-muted-foreground/55",
            )}
          >
            {row.preview}
          </div>
        </div>
        {typeof row.count === "number" && (
          <span className="mt-0.5 shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] font-bold text-muted-foreground">
            ×{row.count}
          </span>
        )}
        <RowExpandToggle data={data} objId={row.g.id} />
      </div>
      <RowInlineEditor data={data} objId={row.g.id} />
    </>
  );
}

/** A one-line row: a variable, a behaviour, an audio track. */
const CONTEXT_ICON = {
  memory: Brain,
  in: ArrowDownLeft,
  out: ArrowUpRight,
  both: ArrowLeftRight,
  shared: Layers,
  trap: AlertTriangle,
  worker: Cog,
  judge: Sparkles,
  wake: Zap,
  does: MessageSquareText,
  scene: Eye,
} as const;
const CONTEXT_CHIP: Record<ContextRowView["icon"], string> = {
  memory: "bg-lime-500/15 text-lime-300",
  in: "bg-sky-500/15 text-sky-300",
  out: "bg-violet-500/15 text-violet-300",
  both: "bg-lime-500/15 text-lime-300",
  shared: "bg-zinc-500/15 text-zinc-300",
  trap: "bg-rose-500/15 text-rose-300",
  worker: "bg-violet-500/15 text-violet-300",
  // The judge is the platform's own AI at work, so it wears the platform's
  // gold — amber stays the board's attention colour (new, selected).
  judge: "bg-primary/15 text-primary",
  wake: "bg-amber-500/15 text-amber-300",
  does: "bg-rose-500/15 text-rose-300",
  scene: "bg-orange-500/15 text-orange-300",
};

/** The context block's body: the frame's memory, drawn in the same rows as
 *  the lore and variables beside it, so the three read as peers. */
/**
 * 「这里的 AI」: one row per AI answering in this frame — its name and what it
 * does on the first line, what it remembers and what passes between it and
 * the other AIs on the second. A click opens its settings. The card's
 * narrator, in a situation whose own AIs answer instead, is a faded row with
 * the way to keep it.
 */
/** The three kinds of AI, each its own quiet colour. */
const AI_TYPE_CHIP: Record<"turn" | "ui" | "code" | "custom", string> = {
  turn: "bg-pink-400/15 text-pink-200",
  ui: "bg-sky-400/15 text-sky-200",
  code: "bg-violet-400/15 text-violet-200",
  custom: "bg-amber-400/15 text-amber-200",
};

function AisBody({ data }: { data: BlockNodeData }) {
  const { t } = useTranslation("editor");
  const ais = data.ais!;
  // Right-click: open it, or remove it. One menu at a time, beside its row.
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  return (
    <div className="group/ais relative" style={{ paddingBlock: BLOCK_BODY_PAD }}>

      {ais.rows.map((row) => {
        // Every row opens in the column: an AI on its own settings, the card's
        // own AI on its judge — the same place every object on the board opens.
        const open = (memory?: boolean) => ais.onToggle(row.key, memory, row.bookId ?? undefined);
        const isOpen = ais.openKey === row.key;
        return (
          <div key={row.key}>
          <div
            data-place-ai={row.key}
            role="button"
            tabIndex={0}
            // An AI can be carried to another scenario or the card; the
            // card's own AI belongs to the card.
            draggable={!!row.bookId && !data.readOnly}
            onDragStart={row.bookId ? (e) => {
              e.stopPropagation();
              e.dataTransfer.setData("application/yumina-ai", row.bookId!);
              e.dataTransfer.effectAllowed = "move";
            } : undefined}
            onClick={(e) => { e.stopPropagation(); setMenu(null); open(); }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ key: row.key, x: e.clientX, y: e.clientY });
            }}
            className={cn(
              "nodrag flex w-full cursor-pointer flex-col justify-center gap-1 px-2.5 text-left transition-colors hover:bg-white/[0.06]",
              (row.away || row.off) && "opacity-55",
              isOpen && "bg-pink-400/[0.08] shadow-[inset_3px_0_0_#f472b6]",
            )}
            style={{ height: AI_ROW_H }}
          >
            <div className="flex min-w-0 items-center gap-2" title={row.job}>
              <Bot className="h-3.5 w-3.5 shrink-0 text-pink-300" />
              <span className="min-w-0 truncate text-[12.5px] font-semibold text-foreground/90">{row.name}</span>
              <span data-ai-type={row.type} className={cn("shrink-0 rounded px-1.5 text-[10.5px] font-semibold leading-[18px]", AI_TYPE_CHIP[row.type])}>{t(`blueprint.aiType.${row.type}`)}</span>
              {row.off && <span className="shrink-0 text-[10.5px] text-muted-foreground">{t("blueprint.placeAis.off")}</span>}
              <span className="flex-1" />
              {row.away && ais.onKeepNarrator && (
                <button
                  type="button"
                  className="nodrag shrink-0 rounded border border-white/15 px-1.5 text-[10.5px] leading-[18px] text-foreground/80 hover:border-white/30"
                  onClick={(e) => { e.stopPropagation(); ais.onKeepNarrator!(true); }}
                >
                  {t("blueprint.placeAis.keepNarrator")}
                </button>
              )}
              {row.key === "narrator" && !row.away && ais.canKeepNarrator && ais.onKeepNarrator && (
                <button
                  type="button"
                  className="nodrag shrink-0 rounded border border-white/10 px-1.5 text-[10.5px] leading-[18px] text-muted-foreground hover:border-white/30 hover:text-foreground"
                  onClick={(e) => { e.stopPropagation(); ais.onKeepNarrator!(false); }}
                >
                  {t("blueprint.placeAis.dropNarrator")}
                </button>
              )}
            </div>
          </div>
          </div>
        );
      })}
      {menu && (() => {
        const row = ais.rows.find((r) => r.key === menu.key);
        if (!row) return null;
        const item = "nodrag block w-full px-3 py-1.5 text-left text-[12px] hover:bg-white/[0.08]";
        // On the page, not in the block: the block clips what hangs past its foot.
        return createPortal(
          <>
          <div className="fixed inset-0 z-[90]" onClick={() => setMenu(null)} onContextMenu={(e) => { e.preventDefault(); setMenu(null); }} />
          <div
            data-place-ai-menu
            className="fixed z-[91] min-w-[128px] overflow-hidden rounded-md border border-white/10 bg-[#1c1b22] py-1 shadow-xl"
            style={{ left: menu.x, top: menu.y }}
            onClick={(e) => e.stopPropagation()}
          >
            <button type="button" className={item} onClick={() => { setMenu(null); if (ais.openKey !== row.key) ais.onToggle(row.key); }}>
              {t("blueprint.placeAis.open")}
            </button>
            {ais.onNote && (
              <button type="button" data-place-ai-note className={item} onClick={() => { setMenu(null); ais.onNote!(); }}>
                {t("blueprint.menu.addNote")}
              </button>
            )}
            {row.bookId && ais.onRemove && (
              <button type="button" data-place-ai-remove className={cn(item, "text-rose-300")} onClick={() => { setMenu(null); ais.onRemove!(row.bookId!); }}>
                {t("blueprint.aiForm.remove")}
              </button>
            )}
          </div>
          </>,
          document.body,
        );
      })()}
    </div>
  );
}

function ContextBody({ data }: { data: BlockNodeData }) {
  const { t } = useTranslation("editor");
  const rows = data.context?.rows ?? [];
  return (
    <div style={{ paddingBlock: BLOCK_BODY_PAD }}>
      {rows.map((row) => {
        const Icon = CONTEXT_ICON[row.icon];
        // A pooled row wears its pool's colour instead of the generic amber,
        // so two pools on one card are two colours rather than two readings.
        const Tag = row.onClick ? "button" : "div";
        return (
          <Tag
            key={row.key}
            type={row.onClick ? "button" : undefined}
            title={row.title}
            onClick={
              row.onClick
                ? (e) => {
                    e.stopPropagation();
                    row.onClick!();
                  }
                : undefined
            }
            className={cn(
              "nodrag flex w-full items-center gap-2 px-2.5 text-left",
              row.onClick && "cursor-pointer transition-colors hover:bg-white/[0.06]",
              row.tint && "border-l-2",
            )}
            style={{ height: PLAIN_ROW_H, ...(row.tint ? { borderLeftColor: row.tint, background: `${row.tint}14` } : {}) }}
          >
            {row.slot && <span className="w-7 shrink-0 text-[11px] leading-none text-muted-foreground">{t(`blueprint.ai.slot.${row.slot}`)}</span>}
            <span
              className={cn("flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded", !row.tint && CONTEXT_CHIP[row.icon])}
              style={row.tint ? { background: `${row.tint}26`, color: row.tint } : undefined}
            >
              <Icon className="h-3 w-3" />
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[12px] font-medium leading-none",
                row.icon === "trap" ? "text-rose-200/90" : "text-foreground/85",
              )}
            >
              {row.text}
            </span>
          </Tag>
        );
      })}
    </div>
  );
}

function PlainRow({ row, data, selected, dimmed }: { row: BlockRowView; data: BlockNodeData; selected: boolean; dimmed: boolean }) {
  const { t } = useTranslation("editor");
  const style = KIND_STYLE[row.g.kind];
  const Icon = row.g.kind === "event" ? Radio : style.icon;
  return (
    <>
      <div
        {...rowInteractions(data, row.g.id)}
        // Same anchor the lore rows carry: the panel's marquee and its
        // centre-on-row both find a row by this attribute.
        data-row-anchor={row.g.id}
        title={row.preview}
        className={rowStateClass(row, selected, dimmed)}
        style={{ height: PLAIN_ROW_H }}
      >
        <RowHandles row={row} />
        <ModuleSpine tint={row.tint} title={row.moduleTitle} />
        {row.g.kind === "image" && typeof row.g.data.url === "string" && row.g.data.url ? (
          // A scene image row shows the picture itself where other rows show
          // their kind's icon: the thumbnail is the fastest way to tell two
          // images apart.
          <img
            src={resolveImageUrl(row.g.data.url)}
            alt=""
            loading="lazy"
            className="h-[18px] w-[18px] shrink-0 rounded object-cover"
          />
        ) : (
          <span className={cn("flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded", style.chip)}>
            <Icon className="h-3 w-3" />
          </span>
        )}
        <span
          className={cn(
            // Never squeezed to nothing: in a two-column block the note and
            // chips give way first, the name keeps its first few characters.
            "min-w-[3.5rem] flex-1 truncate text-[12px] font-medium leading-none",
            selected
              ? "text-foreground"
              : rowIsOff(row)
                ? ROW_TONE[row.g.kind].dim
                : row.shared
                  ? "text-foreground/65"
                  : "text-foreground/85",
          )}
        >
          {row.title}
        </span>
        {row.tags?.map((tag) => (
          <span
            key={tag.text}
            className={cn(
              "shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold leading-none",
              tag.accent ? "bg-primary/15 text-primary" : "bg-white/[0.06] text-muted-foreground/80",
            )}
          >
            {tag.text}
          </span>
        ))}
        {row.note && !data.glance && (
          <span data-row-extra="" className={cn("min-w-0 flex-[2] truncate text-[10.5px] leading-none", row.noteQuiet ? "text-muted-foreground/45" : "text-muted-foreground/75")}>
            {row.note}
          </span>
        )}
        {row.recent && <NewTag />}
        {row.shared && <SharedMark />}
        {row.deadRead ? (
          <span
            title={t("blueprint.deadReadHint")}
            className="flex shrink-0 items-center gap-1 rounded bg-red-500/15 px-1 py-0.5 text-[9px] font-bold text-red-300"
          >
            <AlertTriangle className="h-2.5 w-2.5" />
            {t("blueprint.deadRead")}
          </span>
        ) : row.readByUi ? (
          <span title={t("blueprint.readByUiHint")} className="shrink-0 rounded bg-cyan-500/15 p-0.5 text-cyan-300">
            <MonitorSmartphone className="h-2.5 w-2.5" />
          </span>
        ) : null}
        {row.firedBy && !data.glance && (
          <span
            data-row-extra=""
            title={t("blueprint.block.firedByHint", { name: row.firedBy })}
            className="flex min-w-0 shrink items-center gap-0.5 rounded bg-white/[0.05] px-1 py-0.5 text-[9px] font-semibold text-muted-foreground/75"
          >
            <CornerDownRight className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">{row.firedBy}</span>
          </span>
        )}
        <TurnBadge turn={row.turn} />
        {!data.glance && <LinkCounts links={row.links} />}
        {!data.glance && row.live?.value === undefined && (row.g.kind === "rule"
          // A behaviour's summary is long; at half width it gives way to the name.
          ? <span data-row-extra="" className="contents"><AuthoredValue row={row} data={data} /></span>
          : <AuthoredValue row={row} data={data} />)}
        <LiveBadge live={row.live} />
        <RowExpandToggle data={data} objId={row.g.id} />
      </div>
      <RowInlineEditor data={data} objId={row.g.id} />
      {row.slots.map((slot) => (
        <div
          key={slot.portId}
          className={cn("relative flex items-center gap-2 pl-8 pr-2.5", dimmed && "opacity-30")}
          style={{ height: SLOT_ROW_H }}
        >
          <Handle
            id={portHandleId(row.g.id, slot.portId)}
            type="target"
            position={Position.Left}
            className={cn(HANDLE_BASE, "!h-2.5 !w-2.5 !bg-rose-400")}
          />
          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{slot.label}</span>
        </div>
      ))}
    </>
  );
}

/**
 * The authored value at the end of a variable row — and, for a variable, the
 * place you CHANGE it. A starting value is exactly the kind of edit that
 * should not cost a drawer: click the number, type the number, done. Booleans
 * toggle on click; json stays read-only here because a truncated 92px input
 * is where a json value goes to get corrupted (the inspector edits it whole).
 */
function AuthoredValue({ row, data }: { row: BlockRowView; data: BlockNodeData }) {
  const { t } = useTranslation("editor");
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState("");
  const commit = data.onCommitVariableValue;
  const editable =
    !data.readOnly && !!commit && row.g.kind === "variable" && !!row.varType && row.varType !== "json";

  if (!editable) {
    if (!row.preview) return null;
    return (
      <span className="max-w-[92px] shrink-0 truncate font-mono text-[10px] text-muted-foreground/55">
        {row.preview}
      </span>
    );
  }

  const variableId = row.g.id.slice(row.g.id.indexOf(":") + 1);

  if (row.varType === "boolean") {
    const on = row.preview === "true";
    return (
      <button
        type="button"
        title={t("blueprint.block.valueToggleHint")}
        onClick={(e) => {
          e.stopPropagation();
          commit!(variableId, !on);
        }}
        className={cn(
          "nodrag shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors",
          on ? "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25" : "bg-white/[0.06] text-muted-foreground/70 hover:bg-white/10",
        )}
      >
        {t(on ? "firstMessage.true" : "firstMessage.false")}
      </button>
    );
  }

  if (editing) {
    const done = () => {
      commit!(variableId, val);
      setEditing(false);
    };
    return (
      <input
        autoFocus
        value={val}
        type={row.varType === "number" ? "number" : "text"}
        onChange={(e) => setVal(e.target.value)}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") done();
          if (e.key === "Escape") setEditing(false);
        }}
        onBlur={done}
        className="nodrag h-[18px] w-[92px] shrink-0 rounded border border-[rgba(240,198,116,0.5)] bg-black/40 px-1 font-mono text-[10px] text-foreground outline-none"
      />
    );
  }

  return (
    <button
      type="button"
      data-learn="var-value"
      title={t("blueprint.block.valueEditHint")}
      onClick={(e) => {
        e.stopPropagation();
        setVal(row.preview ?? "");
        setEditing(true);
      }}
      className="nodrag max-w-[92px] shrink-0 truncate rounded px-1 py-0.5 font-mono text-[10px] text-muted-foreground/55 transition-colors hover:bg-white/10 hover:text-foreground"
    >
      {row.preview || "—"}
    </button>
  );
}

// ── the block ───────────────────────────────────────────────────────

/** A block whose body is its rows. */
const isListBlock = (block: Block) =>
  block.kind === "lore" ||
  block.kind === "state" ||
  block.kind === "behavior" ||
  block.kind === "audio" ||
  block.kind === "image" ||
  (block.kind === "opening" && !block.head);

/** The object kinds a module can actually own. `set-parent` writes a
 *  worldbookId onto entries, openings, variables, behaviours and reactions;
 *  audio, scene images and the interface belong to the card whatever the
 *  board draws, so those blocks are not pieces — offering to drag one would
 *  show a slot and then do nothing. */
const MOVABLE = ["entry:", "greeting:", "var:", "rule:", "reaction:"];

/** Every object the block would take with it. A block is a projection of
 *  its module's objects, so moving the piece means re-homing all of them. */
function pieceObjectIds(data: BlockNodeData): string[] {
  const ids = data.rows.map((r) => r.g.id).filter((id) => MOVABLE.some((p) => id.startsWith(p)));
  return [...new Set(ids)].filter(Boolean);
}

function BlockHead({ data }: { data: BlockNodeData }) {
  const { t } = useTranslation("editor");
  const { block, collapsed } = data;
  const style = BLOCK_STYLE[block.kind];
  const Icon = style.icon;
  const isOpening = block.kind === "opening" && Boolean(block.head);

  // Pick the piece up by its head. Native drag-and-drop, like a row's:
  // React Flow's node drag is spoken for (grabbing a block drags its
  // module), and a piece has to be able to leave its module anyway, which
  // a child node cannot do.
  const pieceIds = data.readOnly || block.kind === "card" ? [] : pieceObjectIds(data);
  // 「这里的 AI」 is not a piece to carry: its head opens and shuts it.
  const canDragPiece = pieceIds.length > 0 && block.kind !== "ais";
  // Several pieces at once: if any of this block's objects is in the
  // multi-selection, the drag carries the whole selection. Picking up a
  // piece that is part of a selection and moving only that piece would be
  // the one gesture that ignores what is selected.
  const selected = data.multiSelected;
  const inSelection = !!selected && pieceIds.some((id) => selected.has(id));
  const carried = inSelection ? [...new Set([...selected!, ...pieceIds])] : pieceIds;
  const piece = canDragPiece ? {
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      e.stopPropagation();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("application/yumina-objects", carried.join(","));
      // The single-object channel keeps every existing drop target working.
      e.dataTransfer.setData("application/yumina-object", carried[0]!);
      // Only MIME TYPES are readable before the drop, so the kind rides as
      // one: it is what lets a module reserve the right slot while the
      // piece is still in the air.
      e.dataTransfer.setData(`application/yumina-piece-${block.kind}`, "1");
      const from = data.ownerId ?? "core";
      e.dataTransfer.setData(`application/yumina-from-${from}`, "1");
      const ghost = document.createElement("div");
      ghost.textContent = data.title;
      ghost.style.cssText =
        "position:fixed;top:-1000px;left:-1000px;padding:6px 14px;border-radius:10px;background:#221c2e;color:#f5e9c8;border:1px solid #d9a13f;font:700 12px system-ui,sans-serif;box-shadow:0 10px 26px rgba(0,0,0,.6);white-space:nowrap";
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 18, 18);
      setTimeout(() => ghost.remove(), 0);
      data.onPieceDrag?.(block.kind);
    },
    onDragEnd: () => data.onPieceDrag?.(null),
    onClick: (e: React.MouseEvent) => {
      if (!(e.shiftKey || e.ctrlKey || e.metaKey)) return;
      e.stopPropagation();
      data.onPieceSelect?.(pieceIds, !inSelection);
    },
  } : {};

  return (
    <div
      {...piece}
      data-block-head
      className={cn("flex items-center gap-2 px-2.5",
        data.quiet
          ? "border-b border-transparent"
          : cn("border-b border-border/40", (data.faint && BLOCK_FAINT[block.kind]?.band) || style.band),
        // `nodrag`: the head carries the piece. Without it React Flow also
        // starts its own drag on the same press and the module slides away
        // under the piece being lifted off it.
        canDragPiece && "nodrag cursor-grab active:cursor-grabbing",
        inSelection && "bg-amber-400/[0.08] ring-1 ring-inset ring-[rgba(240,198,116,0.75)]")}
      style={{ height: BLOCK_HEAD_H }}
    >
      <span className={cn("flex h-6 w-6 shrink-0 items-center justify-center rounded-lg",
        data.quiet ? "bg-white/[0.06] text-muted-foreground" : (data.faint && BLOCK_FAINT[block.kind]?.chip) || style.chip)}>
        <Icon className="h-3.5 w-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        {/* The card block's header used to be the card's NAME, which is the
            one thing it could say that does not answer "what is this block".
            Someone meeting the board saw a name floating above the tile and
            had no way to learn it was where the cover lives. The name is
            content: it is edited in the body, at the size a name deserves. */}
        {block.kind === "opening" && data.opening ? (
          <InlineTitle
            value={data.title}
            syncKey={`board-opening-${data.opening.entryId}`}
            onCommit={data.opening.onCommitName}
            readOnly={data.readOnly}
          />
        ) : (
          <div className="truncate text-[12px] font-bold leading-tight tracking-tight">{data.title}</div>
        )}
        {data.subtitle && (
          <div className="truncate px-1 -mx-1 text-[9px] font-medium tabular-nums text-muted-foreground/60">
            {data.subtitle}
          </div>
        )}
      </div>
      {isOpening && !collapsed && (
        <button
          type="button"
          title={t(data.expanded ? "blueprint.block.showLess" : "blueprint.block.showMore")}
          onClick={(e) => {
            e.stopPropagation();
            data.onToggleExpand();
          }}
          className="nodrag shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {data.expanded ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
        </button>
      )}
      {data.onAdd && (
        <button
          type="button"
          data-block-add={data.block.kind}
          title={data.addLabel}
          onClick={(e) => {
            e.stopPropagation();
            data.onAdd!(e.currentTarget.getBoundingClientRect());
          }}
          className="nodrag shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      )}
      {/* Words, not bare icons: an unlabeled upload arrow or speaker on a
          header was a thing you had to hover to learn about. */}
      {data.tools?.map((tool) => {
        const Icon = tool.id === "upload" ? Upload : tool.id === "market" ? Store : tool.id === "voice" ? Volume2 : tool.id === "open" ? Maximize2 : ImagePlus;
        return (
          <button
            key={tool.id}
            type="button"
            data-block-tool={tool.id}
            onClick={(e) => { e.stopPropagation(); tool.onClick(); }}
            className="nodrag flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            <Icon className="h-3 w-3" />
            {tool.label}
          </button>
        );
      })}
      {/* A block inside a card is not folded on its own any more — the card is
          what folds. The control stays only on a block folded before, so it
          can be opened again. */}
      {collapsed && (
        <button
          type="button"
          title={t("blueprint.block.expand")}
          onClick={(e) => {
            e.stopPropagation();
            data.onToggleCollapse();
          }}
          className="nodrag shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/**
 * The background block: the picture as the player will meet it.
 *
 * The strip is not a thumbnail of the source file — it carries the author's
 * blur and dim, because a background is only ever seen processed, and a
 * preview that skips the processing answers a question nobody asked. The
 * empty state is the same height as a filled one, so the block under it does
 * not move the first time a card gets a background.
 */
/**
 * The chat background, as one line of the letterhead: the picture as it will
 * actually look behind the text, what was done to it, and the way in.
 *
 * It used to be a 300-wide block with a full 16:9 strip, parked under the
 * face off the left edge of the board. Nobody could tell what it was, because
 * nothing beside it said so — the label is doing as much work here as the
 * thumbnail.
 */
/**
 * The chat background: the picture, at the shape and treatment the player
 * gets, with a line of the card's own text over it.
 *
 * The only question this block has to answer is "what will the chat look
 * like, and can it still be read", so it is almost entirely the picture.
 * It spent a version as a 76px strip with a 107px thumbnail in the corner,
 * which answered neither.
 */
function BackgroundBody({ data }: { data: BlockNodeData }) {
  const { t } = useTranslation("editor");
  const bg = data.background!;
  return (
    <div className="flex flex-col gap-2 px-2.5 pb-2.5 pt-2" style={{ height: FACE_BODY_H }}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); if (bg.url || !bg.canUseCover) bg.onOpen(); else bg.onUseCover(); }}
        className={cn("nodrag relative w-full shrink-0 overflow-hidden rounded-lg border transition-colors hover:border-zinc-300/70", bg.url ? "border-border/60 bg-black" : "border-transparent")}
        style={{ height: FACE_STRIP_H }}
      >
        {bg.url ? (
          <>
            <img
              key={bg.url}
              src={bg.url}
              alt=""
              draggable={false}
              className="h-full w-full object-cover"
              style={{ filter: `blur(${Math.round(bg.blur / 2)}px)`, transform: "scale(1.15)", opacity: bg.opacity / 100 }}
              onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
            />
            <div className="absolute inset-0 bg-black" style={{ opacity: bg.dim / 100 }} />
            {/* A line of the card's own text over it: the block answers the
                only question that matters, which is whether this can still
                be read. */}
            <span className="absolute inset-x-3 bottom-2.5 line-clamp-2 text-left text-[11px] leading-snug text-white/95 drop-shadow-[0_1px_3px_rgba(0,0,0,0.7)]">
              {t("blueprint.block.backgroundSample")}
            </span>
          </>
        ) : (
          <span className={cn("flex h-full w-full flex-col items-center justify-center gap-1.5 rounded-lg", EMPTY_PICTURE)}>
            <ImageIcon className="h-6 w-6" />
            <span className="px-4 text-center text-[11px] font-semibold leading-snug">
              {bg.canUseCover
                ? t("blueprint.block.backgroundUseCover", { defaultValue: "Use the cover" })
                : t("blueprint.block.backgroundAdd", { defaultValue: "Add a background" })}
            </span>
          </span>
        )}
      </button>
      <div className="flex min-h-0 flex-1 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground/75">
          {bg.url
            ? t("blueprint.block.backgroundProcessing", {
                blur: bg.blur, dim: bg.dim, opacity: bg.opacity,
                defaultValue: "{{blur}}px blur · {{dim}}% dark · {{opacity}}% opaque",
              })
            : t("blueprint.block.backgroundBlurb", { defaultValue: "Behind the chat" })}
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); bg.onOpen(); }}
          className="nodrag shrink-0 rounded-md border border-border/70 bg-black/30 px-2.5 py-1 text-[10.5px] font-semibold text-muted-foreground transition-colors hover:border-zinc-300/70 hover:text-foreground"
        >
          {bg.count > 1
            ? t("blueprint.block.backgroundCount", { count: bg.count, defaultValue: "{{count}} backgrounds" })
            : t("blueprint.block.backgroundOpen", { defaultValue: "Open" })}
        </button>
      </div>
    </div>
  );
}

/**
 * The card's own front: its cover at 2:3, its name, its one-line blurb.
 *
 * This is what a player meets in Discover before anything else on the board
 * exists, so it is drawn the way they will meet it — a cover you could
 * recognise, with the name under it — rather than as a settings row with a
 * 40px thumbnail on the end.
 */

function CardBody({ data }: { data: BlockNodeData }) {
  const { t } = useTranslation("editor");
  const card = data.card!;
  return (
    <div className="flex gap-2.5 px-2.5 pb-2.5 pt-2" style={{ height: FACE_BODY_H }}>
      <button
        type="button"
        data-learn="card-cover"
        onClick={(e) => { e.stopPropagation(); card.onOpenCover(); }}
        title={card.coverUrl ? t("blueprint.block.identity") : t("blueprint.block.addCover")}
        className={cn("nodrag relative shrink-0 overflow-hidden rounded-lg border transition-colors hover:border-zinc-300/70", card.coverUrl ? "border-border/60 bg-black/40" : "border-transparent")}
        style={{ width: FACE_COVER_W, height: FACE_COVER_H }}
      >
        {card.coverUrl ? (
          <img
            key={card.coverUrl}
            src={card.coverUrl}
            alt=""
            draggable={false}
            className="h-full w-full object-cover"
            onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          />
        ) : (
          // Ten percent of stored cards have no cover. It says so at the size
          // the cover would be, because that is the one place it matters.
          <span className={cn("flex h-full w-full flex-col items-center justify-center gap-1.5 rounded-lg", EMPTY_PICTURE)}>
            <ImagePlus className="h-6 w-6" />
            <span className="px-2 text-center text-[10.5px] font-semibold leading-snug">{t("blueprint.block.addCover")}</span>
          </span>
        )}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <InlineTitle
          value={card.name}
          syncKey="board-card-name"
          onCommit={card.onCommitName}
          readOnly={Boolean(data.readOnly || card.locked)}
          placeholder={t("blueprint.nodes.untitledCard")}
        />
        {/* Zoomed out, the blurb waits like every row's text does: four
            lines of it at 51% were the last wall of unreadable type left on
            a first look. The name stays. */}
        {data.glance ? (
          <div className="flex-1" />
        ) : data.readOnly || card.locked ? (
          <span className="line-clamp-4 text-[10.5px] leading-[1.5] text-muted-foreground/75">{card.description}</span>
        ) : (
          <DebouncedTextarea
            value={card.description}
            syncKey="board-card-description"
            onCommit={card.onCommitDescription}
            placeholder={t("blueprint.block.blurbPlaceholder")}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            className={cn(
              "nodrag nowheel block w-full flex-1 resize-none rounded border border-transparent",
              "bg-transparent px-1 text-[10.5px] leading-[1.5] text-muted-foreground/85 transition-colors",
              "placeholder:text-muted-foreground/35 hover:border-border/70 hover:bg-black/25",
              "focus:border-[rgba(240,198,116,0.5)] focus:bg-black/40 focus:text-foreground/90 focus:outline-none",
            )}
          />
        )}
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {/* 卡片信息, 素材 and the language chip all opened the card's
              details, which a click on the cover already does. */}
          {card.onAddOpening && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); card.onAddOpening!(); }}
              title={t("blueprint.frame.shelfAdd", { what: t("blueprint.frame.shelf.opening") })}
              className="nodrag flex items-center gap-1 rounded-md border border-dashed border-emerald-500/40 bg-black/30 px-2 py-1 text-[10px] font-semibold text-emerald-300/80 transition-colors hover:border-emerald-400/70 hover:text-emerald-200"
            >
              <Plus className="h-3 w-3" />
              {t("blueprint.frame.shelf.opening")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function OpeningBody({ data }: { data: BlockNodeData }) {
  const { t } = useTranslation("editor");
  const opening = data.opening!;
  const row = data.rows[0];
  const [writing, setWriting] = useState(false);
  const height = data.expanded ? OPENING_BODY_H_OPEN : OPENING_BODY_H;

  return (
    <>
      {writing && !data.readOnly ? (
        <DebouncedTextarea
          autoFocus
          value={opening.raw}
          syncKey={`board-opening-body-${opening.entryId}`}
          onCommit={opening.onCommitContent}
          onBlur={() => setWriting(false)}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          placeholder={t("blueprint.block.openingPlaceholder")}
          className="nodrag nowheel block w-full resize-none border-y border-[rgba(240,198,116,0.35)] bg-black/45 px-3 py-2.5 text-[11.5px] leading-[1.65] text-foreground/90 placeholder:text-muted-foreground/35 focus:outline-none"
          style={{ height }}
        />
      ) : (
        <div
          onClick={(e) => {
            if (data.readOnly) return;
            e.stopPropagation();
            setWriting(true);
          }}
          className={cn(
            "nowheel overflow-y-auto px-3 py-2.5 transition-colors",
            data.expanded ? "" : "overflow-hidden",
            !data.readOnly && "cursor-text hover:bg-white/[0.03]",
          )}
          style={{ height }}
        >
          {opening.empty ? (
            <div className="text-[11px] italic text-muted-foreground/45">{t("blueprint.nodes.emptyContent")}</div>
          ) : (
            // Rendered the way the player will actually read it — this block is
            // the first thing anyone who opens the card will see. The markdown
            // pipeline is the chat's, DOMPurify and all.
            <div
              className="prose-opening text-[11.5px] leading-[1.65] text-foreground/85"
              dangerouslySetInnerHTML={{ __html: opening.html }}
            />
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5 border-t border-border/30 px-2.5 py-1">
        {opening.seedCount > 0 && (
          <span className="rounded bg-emerald-500/12 px-1.5 py-0.5 text-[9px] font-bold text-emerald-300">
            {t("blueprint.block.seeds", { count: opening.seedCount })}
          </span>
        )}
        {data.onFocusEdit && row && (
          <button
            type="button"
            title={t("blueprint.rowEdit.expand")}
            onClick={(e) => {
              e.stopPropagation();
              data.onFocusEdit!(row.g.id);
            }}
            className="nodrag ml-auto flex items-center gap-1 rounded px-1 py-0.5 text-[9px] font-semibold text-muted-foreground/60 transition-colors hover:bg-white/10 hover:text-foreground"
          >
            <Maximize2 className="h-2.5 w-2.5" />
            {t("blueprint.rowEdit.expand")}
          </button>
        )}
        <span className="flex-1" />
        {row && <LinkCounts links={row.links} />}
        {row && <TurnBadge turn={row.turn} />}
      </div>
    </>
  );
}

/** A module's face: its own live preview (the interface in the state that
 *  opens this module), the scene file and the way to open it, and the
 *  interface's variable ports. Every open module shows its own, side by
 *  side — that is the point of having faces. */
function SceneBody({ data }: { data: BlockNodeData }) {
  const { t } = useTranslation("editor");
  const scene = data.scene!;
  const desktop = scene.device === "desktop";
  // Scaled to the width the tile gave the block, not to a fixed column.
  const width = data.width ?? (desktop ? SCENE_WIDE_W : BLOCK_W);
  const previewH = (desktop ? desktopPreviewHeight(width) : PREVIEW_H) - (scene.openingPicker ? 32 : 0);
  const innerW = desktop ? PREVIEW_DESKTOP_W : PREVIEW_PHONE_W;
  const scale = previewScale(width, innerW);
  if (scene.bare) {
    return (
      <>
        <div className="flex items-center gap-2 px-3 text-[11px] leading-snug text-muted-foreground" style={{ height: SCENE_BARE_HINT_H }}>
          <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-60" />
          <span className="line-clamp-2">{t("blueprint.scene.bare")}</span>
        </div>
        <SceneFileRow data={data} />
      </>
    );
  }
  return (
    <>
      {scene.openingPicker}
      {(
        <div className="relative overflow-hidden bg-black/40" style={{ height: previewH }}>
          {scene.render ? (
            // The card's real interface, running — laid out at desktop
            // width (or the 375px phone), scaled to the block.
            <div
              className="nodrag nowheel absolute left-0 top-0 origin-top-left"
              style={{
                width: innerW,
                height: Math.round(previewH / scale),
                transform: `scale(${scale})`,
              }}
            >
              {scene.render}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground/45">
              <Smartphone className="h-6 w-6" />
              <span className="px-4 text-center text-[10px] leading-relaxed">
                {scene.pausedLabel ?? t("blueprint.block.previewPaused")}
              </span>
            </div>
          )}
        </div>
      )}
      <SceneFileRow data={data} />
      {/* The variables this interface reads, as ports you can wire to. */}
      {data.block.headSlots.map((slot) => (
        <div key={slot.portId} className="relative flex items-center gap-2 pl-8 pr-2.5" style={{ height: SLOT_ROW_H }}>
          <Handle
            id={portHandleId(data.block.head!.id, slot.portId)}
            type="target"
            position={Position.Left}
            className={cn(HANDLE_BASE, "!h-2.5 !w-2.5 !bg-rose-400")}
          />
          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{slot.label}</span>
        </div>
      ))}
    </>
  );
}

function SceneFileRow({ data }: { data: BlockNodeData }) {
  const { t } = useTranslation("editor");
  const scene = data.scene!;
  return (
    <div className="nodrag flex items-center gap-1.5 px-2" style={{ height: PLAIN_ROW_H + BLOCK_BODY_PAD * 2 }}>
      <select
        aria-label={t("blueprint.scene.pick")}
        value={scene.file ?? ""}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => scene.onPick(e.target.value || undefined)}
        className={cn(
          "h-6 min-w-0 flex-1 rounded border border-border/60 bg-black/30 px-1.5 text-[11px] text-foreground outline-none focus:border-rose-400/60",
          !scene.file && "text-muted-foreground",
        )}
      >
        <option value="">{t("blueprint.scene.none")}</option>
        {scene.files.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <button
        type="button"
        title={t(scene.device === "desktop" ? "blueprint.scene.phone" : "blueprint.scene.desktop")}
        aria-label={scene.device === "desktop" ? "desktop" : "phone"}
        onClick={(e) => {
          e.stopPropagation();
          scene.onToggleDevice();
        }}
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-border/60 text-muted-foreground hover:bg-white/5 hover:text-foreground"
      >
        {scene.device === "desktop" ? <Monitor className="h-3 w-3" /> : <Smartphone className="h-3 w-3" />}
      </button>
      <button
        type="button"
        disabled={!scene.file}
        title={t("blueprint.scene.editHint")}
        onClick={(e) => {
          e.stopPropagation();
          scene.onEdit();
        }}
        className="flex h-6 shrink-0 items-center gap-1 rounded border border-border/60 px-1.5 text-[10px] text-muted-foreground hover:bg-white/5 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <Pencil className="h-3 w-3" />
        {t("blueprint.scene.edit")}
      </button>
    </div>
  );
}

function FrontendBody({ data }: { data: BlockNodeData }) {
  const { t } = useTranslation("editor");
  const frontend = data.frontend!;
  const width = data.width ?? BLOCK_W;
  // The device the player is on, at its real shape and one fixed scale,
  // centred: see screenFrame.
  const frame = screenFrame(width, frontend.device !== "phone");
  const { scale, deviceW, deviceH } = frame;
  // The opening is typed where it shows, as on the 玩家界面 page: hover rings
  // it, a click opens a box over it. Positions are in the block's own pixels
  // (the board's zoom divided out), since the box is drawn inside the node.
  type Box = { left: number; top: number; width: number; height: number };
  const screenRef = useRef<HTMLDivElement>(null);
  const [openingHover, setOpeningHover] = useState<Box | null>(null);
  const [openingEdit, setOpeningEdit] = useState<Box | null>(null);
  const canEditOpening = !!frontend.openingId && !data.readOnly;
  const boxOf = (node: Element): Box | null => {
    const host = screenRef.current;
    if (!host) return null;
    const h = host.getBoundingClientRect();
    const k = host.offsetWidth ? h.width / host.offsetWidth : 1;
    const r = node.getBoundingClientRect();
    return { left: (r.left - h.left) / k, top: (r.top - h.top) / k, width: r.width / k, height: r.height / k };
  };
  const openingNode = (event: { nativeEvent: Event }): Element | null => {
    if (!canEditOpening) return null;
    for (const node of event.nativeEvent.composedPath()) {
      if (node instanceof Element && (node.hasAttribute(PREVIEW_GREETING_ATTR) || node.hasAttribute("data-screen-empty-opening"))) return node;
    }
    return null;
  };
  // The stock chat, in a line: there is nothing in a preview of it that the
  // line does not say.
  if (frontend.thin) {
    return (
      <>
        {frontend.folded && frontend.onToggleFold ? (
          <button
            type="button"
            data-screen-unfold
            onClick={(e) => { e.stopPropagation(); frontend.onToggleFold!(); }}
            className="nodrag flex w-full items-center gap-1.5 px-3 text-left text-[11.5px] text-muted-foreground transition-colors hover:bg-white/[0.04] hover:text-foreground"
            style={{ height: DEFAULT_CHAT_HINT_H }}
          >
            <ChevronRight className="h-3.5 w-3.5" />{t("blueprint.writing.screenUnfold")}
          </button>
        ) : (
          <div className="flex items-center px-3 text-[11px] text-muted-foreground" style={{ height: DEFAULT_CHAT_HINT_H }}>{t(frontend.emptyOpening ? "blueprint.moments.screenWaiting" : "blueprint.starter.defaultChatReady")}</div>
        )}
        {data.block.headSlots.map((slot) => (
          <div key={slot.portId} className="relative flex items-center gap-2 pl-8 pr-2.5" style={{ height: SLOT_ROW_H }}>
            <Handle id={portHandleId(data.block.head!.id, slot.portId)} type="target" position={Position.Left} className={cn(HANDLE_BASE, "!h-2.5 !w-2.5 !bg-rose-400")} />
            <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{slot.label}</span>
          </div>
        ))}
      </>
    );
  }
  return (
    <>
      {/* The screen itself: the device's shape, framed and centred, the
          same size whatever the card around it is. */}
      <div ref={screenRef} className="relative flex shrink-0 items-center justify-center" style={{ height: frame.h + SCREEN_PAD * 2 }}>
      {/* Its controls, as icons in the head's right corner: which device,
          fold, and the way into the player-screen page. */}
      <div className="absolute right-2 z-20 flex items-center gap-0.5" style={{ top: -BLOCK_HEAD_H + (BLOCK_HEAD_H - 26) / 2 }}>
        {frontend.onToggleDevice && (["phone", "desktop"] as const).map((d) => {
          const on = (frontend.device ?? "phone") === d;
          return (
            <button
              key={d}
              type="button"
              data-testid={d === "phone" ? "screen-device" : undefined}
              aria-pressed={on}
              title={t(d === "phone" ? "blueprint.scene.devicePhone" : "blueprint.scene.deviceDesktop")}
              onClick={(e) => { e.stopPropagation(); if (!on) frontend.onToggleDevice!(); }}
              className={cn("nodrag flex h-[26px] w-[26px] items-center justify-center rounded-md transition-colors", on ? "bg-white/10 text-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {d === "phone" ? <Smartphone className="h-3.5 w-3.5" /> : <Monitor className="h-3.5 w-3.5" />}
            </button>
          );
        })}
        {frontend.onToggleFold && (
          <button
            type="button"
            data-screen-fold
            onClick={(e) => { e.stopPropagation(); frontend.onToggleFold!(); }}
            title={t("blueprint.writing.screenFold")}
            aria-label={t("blueprint.writing.screenFold")}
            className="nodrag flex h-[26px] w-[26px] items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>
        )}
        {frontend.onEdit && (
          <button
            type="button"
            data-testid="edit-interface"
            title={t("blueprint.look.editInterface")}
            aria-label={t("blueprint.look.editInterface")}
            onClick={(e) => { e.stopPropagation(); frontend.onEdit!(); }}
            className="nodrag ml-0.5 flex h-[26px] w-[26px] items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div
        className="relative overflow-hidden rounded-lg border border-white/[0.09] bg-black/40 shadow-[0_8px_24px_rgba(0,0,0,0.35)]"
        style={{ width: frame.w, height: frame.h }}
        onMouseMoveCapture={canEditOpening && !openingEdit ? (event) => {
          const node = openingNode(event);
          const box = node ? boxOf(node) : null;
          setOpeningHover((prev) => (box && prev && prev.top === box.top && prev.left === box.left && prev.height === box.height ? prev : box));
        } : undefined}
        onMouseLeave={canEditOpening ? () => setOpeningHover(null) : undefined}
        onClickCapture={canEditOpening ? (event) => {
          const node = openingNode(event);
          const box = node ? boxOf(node) : null;
          if (!box) return;
          event.preventDefault();
          event.stopPropagation();
          setOpeningHover(null);
          setOpeningEdit(box);
        } : undefined}
      >
        {/* Which opening the preview plays — only when there is more than one. */}
        {frontend.openingPicker && (frontend.openingCount ?? 0) > 1 && (
          <div className="absolute left-2 top-2 z-10 w-[190px] overflow-hidden rounded-md border border-white/10 shadow-lg">{frontend.openingPicker}</div>
        )}
        {frontend.render ? (
          // The card's real interface, running. Scaled from the 375px phone
          // width the sandbox lays out at, so what is in the block is what the
          // player sees — not a screenshot, not an icon, not the word
          // "Frontend". The inner box is divided by the scale so that after
          // scaling it comes out exactly the height of its container.
          <div
            className="nodrag nowheel absolute left-0 top-0 origin-top-left"
            style={{ width: deviceW, height: deviceH, transform: `scale(${scale})` }}
          >
            {frontend.render}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground/45">
            <Smartphone className="h-6 w-6" />
            <span className="px-4 text-center text-[10px] leading-relaxed">
              {frontend.pausedLabel ?? t("blueprint.block.previewPaused")}
            </span>
          </div>
        )}
        {frontend.defaultChat && frontend.emptyOpening && frontend.render && (
          <div data-screen-empty-opening="" className={cn("absolute inset-x-3 top-10 rounded-md text-center text-xs leading-relaxed text-muted-foreground", canEditOpening ? "cursor-text" : "pointer-events-none")}>
            {t("blueprint.starter.previewEmpty")}<br />{t("blueprint.starter.playerCanStart")}
          </div>
        )}
      </div>
      {openingHover && !openingEdit && <OpeningHoverRing rect={openingHover} />}
      {openingEdit && frontend.openingId && (
        <div className="nodrag nowheel nopan absolute inset-0">
          <OpeningOnScreenEditor key={frontend.openingId} entryId={frontend.openingId} rect={openingEdit} onDone={() => setOpeningEdit(null)} />
        </div>
      )}
      </div>


      {/* What the code does, file by file. Each row is a canvas object a note
          can stick to (file:<name>) and a click opens the file. */}
      {frontend.files && frontend.files.length > 0 && (
        <FrontendFilesStrip files={frontend.files} entryFile={frontend.entryFile} aiCalls={frontend.aiCalls ?? 0} onOpenFile={frontend.onOpenFile} />
      )}

      {/* The variables this interface reads, as ports you can wire to. */}
      {data.block.headSlots.map((slot) => (
        <div key={slot.portId} className="relative flex items-center gap-2 pl-8 pr-2.5" style={{ height: SLOT_ROW_H }}>
          <Handle
            id={portHandleId(data.block.head!.id, slot.portId)}
            type="target"
            position={Position.Left}
            className={cn(HANDLE_BASE, "!h-2.5 !w-2.5 !bg-rose-400")}
          />
          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">{slot.label}</span>
        </div>
      ))}
    </>
  );
}


/** The banner on a loose block: it is new, it is in no module yet, and the
 *  two ways out — drag it into a module, or put it in every module. */
function LooseBanner({ onShareAll, readOnly }: { onShareAll: () => void; readOnly: boolean }) {
  const { t } = useTranslation("editor");
  return (
    <div
      className="flex items-center gap-2 bg-white/[0.06] px-2.5 text-[11px] text-zinc-300"
      style={{ height: LOOSE_BANNER_H }}
      data-loose-banner
    >
      <span className="min-w-0 flex-1 truncate">
        <span className="font-semibold">{t("blueprint.loose.badge")}</span>
        <span className="text-zinc-400"> · {t("blueprint.loose.hint")}</span>
      </span>
      {!readOnly && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onShareAll();
          }}
          className="nodrag shrink-0 rounded border border-white/20 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-200 hover:bg-white/10"
        >
          {t("blueprint.loose.shareAll")}
        </button>
      )}
    </div>
  );
}

const TRAY_TINT: Record<TrayItem, string> = {
  state: "text-sky-300",
  behavior: "text-orange-300",
  audio: "text-teal-300",
  image: "text-pink-300",
  background: "text-zinc-300",
  packs: "text-orange-300",
};

/**
 * The slots a card has not used, as one line at the foot of its tile. Each
 * was an empty block of its own saying "nothing yet" — three of them on a new
 * card, a third of what a creator saw first. A slot is still one click from
 * being there: the click brings its block out.
 */
function TrayBlock({ data }: { data: BlockNodeData }) {
  const { t } = useTranslation("editor");
  const tray = data.tray;
  return (
    <div
      data-onboarding="tray"
      className="nodrag flex items-center gap-2 overflow-hidden px-4 studio-glass-flush relative rounded-none border-0"
      style={{ width: data.width ?? BLOCK_W, height: data.fillHeight ?? TRAY_H }}
    >
      {data.flush && <PieceSeams top={data.seamTop} left={data.seamLeft} />}
      <span className="shrink-0 text-[12px] text-muted-foreground/70">{t("blueprint.tray.label")}</span>
      {tray?.items.map((item) => (
        <button
          key={item}
          type="button"
          data-tray-item={item}
          disabled={data.readOnly}
          onClick={(e) => { e.stopPropagation(); tray.onPick(item, e.currentTarget.getBoundingClientRect()); }}
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-dashed border-white/15 bg-white/[0.02] px-3 py-1.5 text-[12.5px] text-foreground/80 transition-colors hover:border-white/30 hover:bg-white/[0.06] hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <Plus className={cn("h-3 w-3", TRAY_TINT[item])} />
          {t(`blueprint.tray.${item}` as const)}
        </button>
      ))}
    </div>
  );
}

function BlockNodeInner({ data, selected }: NodeProps<BlockFlowNode>) {
  const { t } = useTranslation("editor");
  const { block, collapsed, rows, hiddenCount, selectedId, focusIds } = data;
  if (block.kind === "tray") return <TrayBlock data={data} />;
  const style = BLOCK_STYLE[block.kind];
  const headId = block.head?.id;
  const headSelected = Boolean(headId && selectedId === headId);
  const headDimmed = Boolean(focusIds && headId && !focusIds.has(headId));
  const headRow = headId ? rows.find((r) => r.g.id === headId) : undefined;
  // A shelf with nothing on it yet draws as a dashed outline, the way a blank
  // slot is drawn everywhere else. Blocks that show something — a preview, the
  // card's memory — stay solid; they are quiet, not empty.
  const hollow = data.quiet && isListBlock(block) && rows.length === 0;

  return (
    <div
      data-onboarding={BLOCK_ONBOARDING[data.block.kind]}
      className={cn(
        // Frosted glass under a lamp (studio-material.css): a sheet of its
        // own outside a tile, a region of the tile's sheet inside one.
        "overflow-hidden border text-foreground",
        "transition-[box-shadow,border-color,opacity] duration-150",
        // Given a height by the tile, the block is a column: whichever body
        // part is built to stretch takes the slack. Without this the tile's
        // band stretched the interface and left the extra as black.
        data.flush && data.fillHeight ? "flex flex-col" : "",
        // Inside a module the blocks are one surface: no corner, no lift.
        data.flush ? "studio-glass-flush relative rounded-none" : "studio-glass rounded-xl",
        !data.flush && !data.quiet && style.accent,
        hollow && "border-dashed bg-transparent shadow-none",
        // Selected: the lamp's light, not a painted ring.
        (selected || headSelected) && "studio-lamp-ring relative z-[1]",
        headDimmed && "opacity-35",
        headRow?.recent && "ring-2 ring-[rgba(240,198,116,0.6)]",
        headRow?.turn === "added" && "ring-2 ring-emerald-400/70",
        headRow?.turn === "changed" && "ring-2 ring-[rgba(240,198,116,0.5)]",
        // Outside every frame it is in play nowhere: faded until placed.
        data.loose && "border-dashed opacity-55 saturate-[.35] transition-opacity hover:opacity-90",
      )}
      style={{
        width: data.width ?? (block.kind === "scene" && data.scene?.device === "desktop" && !data.scene.bare ? SCENE_WIDE_W : BLOCK_W),
        ...(data.flush && data.fillHeight ? { height: data.fillHeight } : {}),
      }}
      onDragOver={data.dropIn?.over}
      onDrop={data.dropIn?.drop}
      // The player's screen is a picture of the game: lighting its wires on
      // hover slashed them across that picture every time the pointer passed
      // over it. Selecting it still shows them.
      onMouseEnter={headId && block.kind !== "frontend" && block.kind !== "scene" ? () => data.onRowHover(headId) : undefined}
      onMouseLeave={headId && block.kind !== "frontend" && block.kind !== "scene" ? () => data.onRowHover(null) : undefined}
    >
      {data.flush && <PieceSeams top={data.seamTop} left={data.seamLeft} />}
      {data.loose && <LooseBanner onShareAll={data.loose.onShareAll} readOnly={data.readOnly} />}
      {/* Context wears the same head as the shelves above it (owner, 10/7):
          its own quiet title line read as a footnote. The AIs stay a line or
          two with no title (owner, 10/6). */}
      {block.kind !== "ais" && <BlockHead data={data} />}

      {/* Blocks that ARE an object carry that object's handles on the head, so
          a wire lands on the block itself rather than on an invisible row. */}
      {headRow?.hasIn && (
        <Handle
          id={rowHandleId(headId!, "in")}
          type="target"
          position={Position.Left}
          className={cn(HANDLE_BASE, "!bg-zinc-500")}
          style={{ top: BLOCK_HEAD_H / 2 }}
        />
      )}
      {headRow?.hasOut && (
        <Handle
          id={rowHandleId(headId!, "out")}
          type="source"
          position={Position.Right}
          className={cn(HANDLE_BASE, KIND_STYLE[headRow.g.kind].port)}
          style={{ top: BLOCK_HEAD_H / 2 }}
        />
      )}

      {/* A shut block still has to accept the wires of everything inside it. */}
      <Handle
        id="block-in"
        type="target"
        position={Position.Left}
        className={cn(HANDLE_BASE, "!bg-zinc-500", !collapsed && "!pointer-events-none !opacity-0")}
        style={{ top: BLOCK_HEAD_H / 2 }}
      />
      <Handle
        id="block-out"
        type="source"
        position={Position.Right}
        className={cn(HANDLE_BASE, "!bg-zinc-400", !collapsed && "!pointer-events-none !opacity-0")}
        style={{ top: BLOCK_HEAD_H / 2 }}
      />

      {(!collapsed || block.kind === "context" || block.kind === "ais") && (
        <>
          {block.kind === "card" && data.card && <CardBody data={data} />}
          {block.kind === "background" && data.background && <BackgroundBody data={data} />}
          {block.kind === "opening" && block.head && data.opening && <OpeningBody data={data} />}
          {block.kind === "frontend" && data.frontend && <FrontendBody data={data} />}
          {block.kind === "context" && data.context && <ContextBody data={data} />}
          {block.kind === "ais" && data.ais && <AisBody data={data} />}
          {block.kind === "scene" && data.scene && <SceneBody data={data} />}

          {/* List blocks: lore, state, behaviour, audio — and a module's
              openings, which are a list too (the card's own opening block,
              the one with a head, shows its text instead). */}
          {isListBlock(block) && (
            <div className="py-1.5">
              {rows.length === 0 && (
                <div
                  className="px-2.5 py-2 text-[11px] text-muted-foreground/55"
                  style={data.onOpenPacks ? undefined : { height: block.kind === "lore" ? LORE_ROW_H : PLAIN_ROW_H }}
                >
                  <div>{data.emptyLabel}</div>
                  {data.onOpenPacks && (
                    <button
                      type="button"
                      className="nodrag mt-1.5 rounded border border-white/15 bg-white/[0.04] px-2 py-0.5 text-[10.5px] font-medium text-foreground/80 transition-colors hover:border-white/30 hover:bg-white/[0.08]"
                      onClick={(e) => { e.stopPropagation(); data.onOpenPacks!(); }}
                    >
                      {t("blueprint.blocks.addPack")}
                    </button>
                  )}
                </div>
              )}
              {/* Two abreast on a wide tile: the rows are dealt first half /
                  second half, the way the layout counted them. */}
              <div
                // Half width: a row keeps its icon, name and counts; its note and
                // "fired by" chip would push it into the next column.
                className={cn(listColumns(block, data) === 2 && "grid grid-cols-2 [&>*:nth-child(2)]:border-l [&>*:nth-child(2)]:border-white/[0.06] [&_[data-row-extra]]:hidden")}
                style={listColumns(block, data) === 2 ? { gridAutoFlow: "column", gridTemplateRows: `repeat(${Math.ceil(rows.length / 2)}, auto)` } : undefined}
              >
              {rows.map((row) =>
                block.kind === "lore" ? (
                  <LoreRow
                    key={row.g.id}
                    row={row}
                    data={data}
                    selected={selectedId === row.g.id || Boolean(data.multiSelected?.has(row.g.id))}
                    dimmed={Boolean(focusIds) && !focusIds!.has(row.g.id)}
                  />
                ) : (
                  <PlainRow
                    key={row.g.id}
                    row={row}
                    data={data}
                    selected={selectedId === row.g.id || Boolean(data.multiSelected?.has(row.g.id))}
                    dimmed={Boolean(focusIds) && !focusIds!.has(row.g.id)}
                  />
                ),
              )}
              </div>
              {hiddenCount > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    (data.onMore ?? data.onExpandRows)();
                  }}
                  className="nodrag flex w-full items-center gap-1.5 px-2.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
                  style={{ height: 28 }}
                >
                  <MoreHorizontal className="h-3.5 w-3.5" />
                  {t("blueprint.block.more", { count: hiddenCount })}
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** The live frontend preview re-renders whenever this node's data object is
 *  replaced, and the panel rebuilds node data on every draft keystroke. Memo
 *  keeps a block still unless its own data actually changed. */
export const BlockNode = memo(BlockNodeInner);

// ── Module gate ─────────────────────────────────────────────────────

/** A module, drawn as what it is.
 *
 *  It used to be a small gate: a switch on the canvas whose members lived in
 *  global lists somewhere else, wearing a coloured stripe to say where they
 *  belonged. That was true when a module was a way to group lore. A module is
 *  an AI now — its own entries, variables, behaviours and lifecycle — so it is
 *  one complete thing you can open, and what is inside is inside.
 *
 *  The node keeps its `module:<id>` identity, so every activation and context
 *  wire already pointing at it stays pointed at it. */
export type FrameChrome = {
  width: number;
  height: number;
  open: boolean;
  onToggle: () => void;
  onFocus?: () => void;
  /** The graph id the frame's own page opens for (a situation's or AI's
   *  `module:` id, the card's `world:root`): double-clicking the title bar
   *  goes there, as double-clicking a row opens that row's page. */
  drillId?: string;
  onOpenPage?: () => void;
  /** Members across every block inside — the shut header's whole content. */
  total: number;
  /** ...split into the module's own and the card's shared in. When anything
   *  is shared the header says both, because "5 items" would hide that four
   *  of them are the same four in every module. */
  own?: number;
  shared?: number;
  /** The card on a card with modules: a strip above them, no header, no
   *  rail, never shut. It still takes a drop — dropping a row on it is how a
   *  module's own object becomes the card's, shared with every module. */
  strip?: boolean;
  /** The only frame on the board — the card's own. Nothing to tell it apart
   *  from, and its name is already in the title bar. */
  sole?: boolean;
  /** Simple mode: the header says when the module opens and whose memory
   *  it shares, and nothing about counts or wiring. */
  /** Narrators only: the one memory fact, already in words. */
  memory?: string;
  /** A row is being dragged over this frame. A drop target nobody can see is
   *  a gesture nobody will try. */
  dropping?: boolean;
  /** What dropping here would do, in words — shown while a row hovers. */
  dropLabel?: string;
  /** This frame is being dragged, or lies under the one being dragged: the
   *  overlap is shown while it is being made, not discovered afterwards. */
  overlapping?: boolean;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  /** The shelves an open module always ends with. Absent on the card's frame,
   *  which is never empty and has the toolbar over it. */
  shelves?: Array<{ kind: "opening" | "lore" | "state" | "behavior"; count: number; onAdd: () => void }>;
  /** Shut, a tile is a small square that says what it holds: these four
   *  counts under the name. */
  counts?: Record<"opening" | "lore" | "state" | "behavior", number>;
};

const SHELF_ICON = { opening: MessageCircle, lore: BookOpen, state: VariableIcon, behavior: Zap } as const;

/**
 * Who this module reads, and who reads it — the small thing on the frame.
 *
 * A context wire is stored on the module doing the reading, so before this the
 * SOURCE module said nothing about it: you could not stand on A and see that B
 * was drinking from it, which is exactly the fact the module model exists to
 * let a creator arrange. Both directions are shown from either end, and when
 * both ends declare one it collapses to a single mark — 互通 as one symbol
 * rather than two panels to compare by hand.
 */
export type ContextChip = {
  otherId: string;
  dir: "in" | "out" | "both";
  label: string;
  /** The whole sentence, for hover. Built where the strings live. */
  title: string;
};

export type FrameContext = {
  chips: ContextChip[];
  /** Set when this module has no context of its own — it is content that joins
   *  whoever is narrating. Only ever set on a card that HAS a station, because
   *  on every other card the distinction does not exist yet. */
  plain?: string;
  onPick?: (otherId: string) => void;
};

export type GateNodeData = {
  /** Absent on the card's own frame, which has no module behind it. */
  g?: GraphNode;
  frame: FrameChrome;
  title: string;
  tint: string;
  activationLabel?: string;
  /** The module's sticky note (便签). */
  note?: string;
  live?: { active?: boolean };
  turn?: "added" | "changed";
  recent?: boolean;
  dimmed?: boolean;
  context?: FrameContext;
  /** How finished the card is. Only ever on the card's own frame — a module
   *  is a part, and parts are not published. The same numbers the publish
   *  flow shows, so the last step never introduces a surprise. */
  readiness?: { done: number; total: number; nextLabel?: string };
  /** This frame is an AI: who it talks to and when (the line under its
   *  name), who reads it, and what it receives from outside, as chips. */
  ai?: { voice: AiVoice; line: string; gives?: string; givesWarn?: boolean; receives: ReceiveChip[] };
  /** The pointer is on one of the AI's chips (its sources), or left them. */
  onReceiveHover?: (sources: string[] | null) => void;
  /** A place on a card with more than one AI: who its entries go to. */
  placeGives?: string;
  /** The pointer is on a chip that names this frame as a source. */
  aiLit?: boolean;
};
export type GateFlowNode = Node<GateNodeData>;

/**
 * 「它收到」: what reaches an AI from outside its own frame, one chip per
 * source. The pointer on a chip lights the frames it comes from, so the
 * board needs no wires to say where an AI's knowledge is.
 */
function AiReceives({ chips, onHover }: { chips: ReceiveChip[]; onHover?: (sources: string[] | null) => void }) {
  const { t } = useTranslation("editor");
  return (
    <div data-ai-receives className="flex items-center gap-1.5 overflow-hidden px-3" style={{ height: AI_RECEIVES_H }}>
      <span className="shrink-0 text-[11px] font-semibold text-pink-200/80">{t("blueprint.aiFrame.receives")}</span>
      {chips.map((chip) => (
        <span
          key={chip.key}
          onMouseEnter={() => chip.sources.length && onHover?.(chip.sources)}
          onMouseLeave={() => onHover?.(null)}
          className={cn(
            "nodrag flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 text-[11.5px]",
            chip.warn
              ? "border-amber-400/40 bg-amber-400/[0.08] text-amber-200"
              : "cursor-default border-white/10 bg-white/[0.04] text-zinc-300 hover:border-pink-400/50 hover:bg-pink-400/10 hover:text-white",
          )}
        >
          <b className="font-semibold text-zinc-100">{chip.label}</b>
          {chip.detail && <span className="text-zinc-400">{chip.detail}</span>}
        </span>
      ))}
    </div>
  );
}

const DIR_MARK = { in: "←", out: "→", both: "⇄" } as const;

/**
 * One wire, one mark.
 *
 * Open, a frame is hundreds of pixels wide and the modules deserve their
 * names. Shut, twenty bars have to stay scannable across a wall, so the names
 * give way to counts and only the direction survives — which is the thing
 * being scanned for.
 */
function ContextMarks({ context, open }: { context: FrameContext; open: boolean }) {
  if (context.chips.length === 0) return null;
  if (!open) {
    const counts = { both: 0, in: 0, out: 0 };
    for (const c of context.chips) counts[c.dir] += 1;
    return (
      <span className="flex shrink-0 items-center gap-1 text-[9px] font-semibold text-muted-foreground">
        {(["both", "in", "out"] as const)
          .filter((d) => counts[d] > 0)
          .map((d) => (
            <span key={d} className={d === "both" ? "text-lime-300" : undefined}>
              {DIR_MARK[d]}
              {counts[d]}
            </span>
          ))}
      </span>
    );
  }
  const shown = context.chips.slice(0, 4);
  return (
    <div className="flex shrink-0 items-center gap-1">
      {shown.map((c) => (
        <button
          key={c.otherId}
          type="button"
          title={c.title}
          onClick={(e) => {
            e.stopPropagation();
            context.onPick?.(c.otherId);
          }}
          className={cn(
            "nodrag flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-[9px] font-semibold transition-colors",
            // One accent, spent on the case worth spotting: a wire both ends
            // declared. Everything else is quiet.
            c.dir === "both"
              ? "bg-lime-500/15 text-lime-300 hover:bg-lime-500/25"
              : "bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-foreground",
          )}
        >
          <span>{DIR_MARK[c.dir]}</span>
          <span className="max-w-[92px] truncate">{c.label}</span>
        </button>
      ))}
      {context.chips.length > shown.length && (
        <span className="shrink-0 text-[9px] text-muted-foreground">
          +{context.chips.length - shown.length}
        </span>
      )}
    </div>
  );
}

/**
 * The module's name written ABOVE its frame, at a size that does not change
 * with the zoom — the way a design tool labels an artboard.
 *
 * Scaling the name inside the header was the wrong answer: a big name next
 * to unscaled counts and badges is ugly, and it grew over its neighbours.
 * Outside the frame there is nothing to collide with, and at overview zoom
 * the names are the only thing you need to read.
 *
 * It answers "which module is this one", so a board with a single frame —
 * a card that has no modules — gets none: there the label was the same two
 * words as the header 25px below it.
 */
const NAME_ZOOM = 0.75;
function FrameName({ title, tint }: { title: string; tint: string }) {
  const zoom = useStore((s) => s.transform[2]);
  if (zoom >= NAME_ZOOM) return null;
  const k = Math.min(4, NAME_ZOOM / zoom);
  return (
    <div
      className="pointer-events-none absolute bottom-full left-0 mb-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[12px] font-bold"
      style={{ transform: `scale(${k})`, transformOrigin: "left bottom", color: tint, background: "rgba(12,11,15,0.82)" }}
    >
      {title}
    </div>
  );
}

export function GateNode({ data, selected }: NodeProps<GateFlowNode>) {
  const { t } = useTranslation("editor");
  const { g, frame, title, tint, activationLabel, note, live, turn, recent, dimmed, context, ai, onReceiveHover, placeGives, aiLit } = data;
  const enabled = !g || g.data.enabled !== false;
  // A place, as opposed to an AI: its border is drawn dashed.
  const place = !!g && !ai;

  // The card's strip: nothing to see until a row is dragged over it, and
  // then it says what dropping there means. Its blocks are React Flow
  // children and draw themselves.
  if (frame.strip) {
    return (
      <div
        onDragOver={frame.onDragOver}
        onDragLeave={frame.onDragLeave}
        onDrop={frame.onDrop}
        className={cn(
          "relative rounded-xl border-2 border-dashed transition-colors duration-150",
          frame.dropping ? "border-sky-400 bg-sky-400/[0.06]" : "border-transparent",
          dimmed && "opacity-30",
        )}
        style={{ width: frame.width, height: frame.height }}
      >
        {frame.dropping && (
          <span className="absolute -top-7 left-1 rounded bg-sky-500/20 px-2 py-1 text-[11px] font-semibold text-sky-200">
            {t("blueprint.frame.stripDrop")}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      data-ai-frame={ai ? "" : undefined}
      onDragOver={frame.onDragOver}
      onDragLeave={frame.onDragLeave}
      onDrop={frame.onDrop}
      className={cn(
        "rounded-xl transition-[box-shadow,border-color] duration-150",
        frame.open ? "border" : "border-2",
        place && "border-dashed",
        // Open, the frame is the sheet of glass its blocks are regions of;
        // shut, it is a solid tile of the same glass.
        frame.open ? "studio-glass-frame" : "studio-glass",
        // Dimmed, never drained: a switched-off module keeps the tint its
        // own rows are marked with, or you cannot tell which module the
        // greyed-out block on the board belongs to.
        !enabled && "opacity-55",
        live?.active === true && "shadow-[0_0_20px_rgba(52,211,153,0.25)]",
        live?.active === false && "opacity-45",
        dimmed && "opacity-30",
        selected && "ring-2 ring-[rgba(240,198,116,0.7)]",
        recent && "animate-pulse ring-2 ring-[rgba(240,198,116,0.6)]",
        turn === "added" && "ring-2 ring-emerald-400/70",
        turn === "changed" && "ring-2 ring-[rgba(240,198,116,0.5)]",
        frame.dropping && "ring-2 ring-sky-400",
        frame.overlapping && "ring-2 ring-rose-500 shadow-[0_0_24px_rgba(244,63,94,0.35)]",
        aiLit && "ring-2 ring-pink-400/70 shadow-[0_0_24px_rgba(244,114,182,0.22)]",
      )}
      style={{
        width: frame.width,
        height: frame.height,
        borderColor: frame.overlapping ? "#f43f5e" : live?.active === true ? "#34d399" : ai ? "rgba(244,114,182,0.55)" : `${tint}99`,
      }}
    >
      {frame.open && !frame.sole && <FrameName title={title} tint={tint} />}
      {frame.dropping && frame.dropLabel && (
        // In the frame's own title bar, right side: above the frame it sat on
        // the group's title (「一直在」); lower down the blocks cover it.
        <span className="pointer-events-none absolute right-12 top-[9px] z-30 whitespace-nowrap rounded-lg border border-sky-300/60 bg-[#0f1a24] px-2.5 py-1 text-[12px] font-semibold text-sky-100 shadow-lg">
          {frame.dropLabel}
        </span>
      )}
      <div
        data-frame-drill={frame.drillId}
        className={cn("flex h-[46px] items-center gap-2 px-2.5", ai && "rounded-t-xl bg-gradient-to-r from-pink-500/[0.14] to-pink-500/[0.03]")}
        onDoubleClick={(e) => {
          e.stopPropagation();
          // Its own page, as for a row; the chevron folds it.
          if (frame.onOpenPage) frame.onOpenPage();
          else frame.onToggle();
        }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            frame.onToggle();
          }}
          className="nodrag shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
          title={t(frame.open ? "blueprint.frame.collapse" : "blueprint.frame.expand")}
        >
          {frame.open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        {ai
          ? <span className="flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] bg-pink-400/25 text-pink-100"><Bot className="h-3 w-3" /></span>
          : <Boxes className="h-4 w-4 shrink-0" style={{ color: tint }} />}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 leading-tight">
            <span className="truncate text-[13px] font-bold">{title}</span>
            {ai?.gives && (
              <span className={cn("ml-auto shrink-0 truncate pl-2 text-[11px]", ai.givesWarn ? "text-amber-300/80" : "text-pink-200/80")}>{ai.gives}</span>
            )}
            {/* Open, a hanging sticky would lie across the contents. The pin
                keeps the note reachable without moving anything. */}
            {note && frame.open && (
              <Pin className="h-3 w-3 shrink-0 text-[#f0c674]/80" aria-label={note} />
            )}
          </div>
          {/* The marks share the line that says what this module IS, not the
              one that says what it is CALLED. Put beside the title they won
              the width fight against the name, and a module you cannot read
              the name of is worse than one whose wiring you have to look
              twice for. */}
            <div className="flex items-center gap-1.5 overflow-hidden">
              {/* When a situation applies, and nothing else: an item count and a
                  readiness meter were numbers nobody acted on. */}
              {ai
                ? <span className="truncate text-[11px] font-medium text-muted-foreground/80" title={ai.line}>{ai.line}</span>
                : activationLabel && <span className="shrink-0 text-[11px] font-medium text-muted-foreground/75">{activationLabel}</span>}
              {placeGives && <span className="truncate text-[11px] text-muted-foreground/70">· {placeGives}</span>}
              {context && <ContextMarks context={context} open={frame.open} />}
              {context?.plain && frame.open && (
                <span
                  className="shrink-0 rounded bg-white/5 px-1 py-px text-[9px] text-muted-foreground/70"
                  title={context.plain}
                >
                  {context.plain}
                </span>
              )}
            </div>
        </div>
        {/* What a module is made of, in its own header: four icons and their
            counts, each one the way to add another. This was a 58px rail
            across the bottom of every open module with the words "openings",
            "lore", "variables", "behaviours" spelled out — a label a creator
            reads once, charged to every module forever. The icon and the
            number are what is read after that, and they cost nothing here. */}
        {frame.onFocus && <button type="button" onClick={(e) => { e.stopPropagation(); frame.onFocus?.(); }} title={t("blueprint.workspace.focus")} aria-label={t("blueprint.workspace.focusNamed", { name: title })} className="nodrag shrink-0 rounded-md border border-white/10 p-1.5 text-muted-foreground transition-colors hover:border-[rgba(240,198,116,0.4)] hover:bg-[rgba(240,198,116,0.1)] hover:text-[#f5d48a]"><Maximize2 className="h-3.5 w-3.5" /></button>}
        {live?.active !== undefined && (
          <span
            className={cn(
              "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold",
              live.active ? "bg-emerald-500/20 text-emerald-300" : "bg-zinc-700/50 text-zinc-400",
            )}
          >
            <Activity className="h-2.5 w-2.5" />
            {t(live.active ? "blueprint.live.on" : "blueprint.live.off")}
          </span>
        )}
        {g && (
          <>
            <Handle
              id="activate"
              type="target"
              position={Position.Left}
              className={cn(HANDLE_BASE, "!h-3.5 !w-3.5")}
              style={{ background: tint, top: 23 }}
            />
            <Handle
              id="governs"
              type="source"
              position={Position.Right}
              className={cn(HANDLE_BASE, "!h-3.5 !w-3.5")}
              style={{ background: tint, top: 23 }}
            />
          </>
        )}
      </div>

      {frame.open && ai && <AiReceives chips={ai.receives} onHover={onReceiveHover} />}

      {/* Shut, the tile says what it holds — four counts in a 2×2, so
          twenty shut modules read as a screen of icons you can pick from
          rather than a list of names. */}
      {!frame.open && frame.counts && (
        <div className="nodrag grid grid-cols-2 gap-x-2 gap-y-1 px-3 pb-2 pt-0.5">
          {(["opening", "lore", "state", "behavior"] as const).map((kind) => {
            const Icon = SHELF_ICON[kind];
            const count = frame.counts![kind];
            return (
              <span key={kind} className={cn("flex items-center gap-1.5 text-[10px] font-semibold", count > 0 ? "text-muted-foreground" : "text-muted-foreground/40")}>
                <Icon className="h-3 w-3 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{t(`blueprint.frame.shelf.${kind}` as never)}</span>
                <span className="tabular-nums">{count}</span>
              </span>
            );
          })}
        </div>
      )}

      {/* The sticky note (便签): the creator's memo about what this module IS.
          Shut, it hangs below the bar where the band layout reserves room. */}
      {note && !frame.open && (
        <div
          className={cn(
            "absolute left-2 right-2 -rotate-[0.6deg] cursor-pointer rounded-sm px-2 py-1.5",
            "bg-[#f3dc8f] text-[#3a2f14] shadow-[0_3px_8px_rgba(0,0,0,0.45)]",
            "text-[10px] font-medium leading-[1.4]",
            dimmed && "opacity-30",
          )}
          style={{ top: frame.height + 8 }}
          title={note}
        >
          <span
            className="block overflow-hidden"
            style={{ display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" }}
          >
            {note}
          </span>
          <span className="absolute -top-1.5 left-1/2 h-3 w-3 -translate-x-1/2 rounded-full border border-black/30 bg-[#d4a955] shadow" />
        </div>
      )}
    </div>
  );
}
