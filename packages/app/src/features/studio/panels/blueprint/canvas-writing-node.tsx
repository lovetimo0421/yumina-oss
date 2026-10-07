import { resolveDisplayMacros } from "@/lib/resolve-display-macros";
import { memo, useEffect, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { BookOpen, ChevronDown, FolderOpen, GripVertical, Link2, MessageCircle, MoreHorizontal, Plus, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { isPlaceholderCharacterName, portHandleId, rowHandleId, type WorldEntry } from "@yumina/engine";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import { getAssetCdnUrl } from "@/lib/asset-url";
import { DebouncedInput } from "@/features/editor/components/debounced-field";
import { useTemplateContentPlaceholder } from "@/features/editor/template-placeholders";
import { isLessonHello } from "@/lib/world-templates";
import type { BlockRowView } from "./block-node";
import { getEntryDeliverySummary } from "./entry-delivery";

export const CANVAS_WRITING_NODE_WIDTH = 420;
export const CANVAS_WRITING_NODE_HEADER_HEIGHT = 40;
/** Detail: the name, and two lines of whatever is written in it, with the
 *  line under them that says when it reaches the AI. */
export const CANVAS_WRITING_ROW_HEIGHT = 96;
/** Simple: the name alone. */
export const CANVAS_WRITING_COMPACT_ROW_HEIGHT = 40;
/** Open: the object's whole editor, in the row, at a height the board can
 *  count. The editor scrolls inside it, so typing never resizes the board. */
export const CANVAS_WRITING_OPEN_EDITOR_HEIGHT = 460;
/** An opening's editor is one body of text and a picture button. At the
 *  full height a new card's one-line opening sat in a box the height of the
 *  screen, and that box is what the board opens on. */
const OPENING_OPEN_EDITOR_HEIGHT = 320;
const openEditorHeight = (kind: CanvasWritingNodeData["kind"]) =>
  kind === "opening" ? OPENING_OPEN_EDITOR_HEIGHT : CANVAS_WRITING_OPEN_EDITOR_HEIGHT;
const ROW_HEADER_HEIGHT = 40;
const SLOT_HEIGHT = 24;

/** One of the author's own folders, as the classic editor keeps them. */
export interface WritingFolder { id: string; name: string; order: number }

export type CanvasWritingNodeData = Record<string, unknown> & {
  /** A drop on the block is a drop on the frame it stands in. */
  dropIn?: { over: (e: React.DragEvent) => void; drop: (e: React.DragEvent) => void };
  kind: "opening" | "setting";
  entries: WorldEntry[];
  rows?: BlockRowView[];
  documentKey?: string;
  title?: string;
  width?: number;
  /** Laid inside a module tile: share edges with the blocks around it. */
  flush?: boolean;
  /** The height of the row it shares, so a pair has one bottom edge. */
  fillHeight?: number;
  ownerId?: string;
  /** Openings and lore are pieces too: the header is their grab handle. */
  onPieceDrag?: (kind: "opening" | "lore" | null) => void;
  onPieceSelect?: (ids: string[], add: boolean) => void;
  /** Ctrl / ⌘ / Shift-click: add this row to the selection, or take it out. */
  onToggleMulti?: (objectId: string) => void;
  multiSelected?: ReadonlySet<string> | null;
  /**
   * The author's folders, in their order. The rows are grouped under them
   * when any entry in this block is filed in one; a click on a folder's
   * header selects everything in it, which is what a folder is FOR on a
   * board — one grab for the whole group, to drag into a module or delete.
   * The classic editor has had these folders all along; the board showed a
   * flat list and lost the author's own sorting. Openings have no folders.
   */
  folders?: WritingFolder[];
  onSelectFolder?: (ids: string[], add: boolean) => void;
  /** The official presets' group header. Given, the shelf's preset entries
   *  (`presetId`) gather under it at the end, after the author's own writing:
   *  they are every card's, they read first in the prompt, and a shelf that
   *  mixed them into the author's settings made a new card look like it
   *  already had nine things written in it. */
  presetsTitle?: string;
  /** Folders drawn as their header alone. The presets start this way: five
   *  system entries are not what a new card is about. */
  collapsedFolders?: ReadonlySet<string>;
  onToggleFolder?: (folderId: string) => void;
  compact?: boolean;
  /** Rows two abreast on a wide tile (see `rowColumns` in board.ts). */
  columns?: 1 | 2;
  /** Entries folded behind "N more"; the column lists them all. */
  hiddenCount?: number;
  /** Everything the block holds, shown or folded — the header's count. */
  total?: number;
  onMore?: () => void;
  /** In a module: how many of the card's own entries apply here too. They
   *  are rows on the card's tile; here they are one line. */
  shared?: number;
  loose?: { onShareAll: () => void };
  readOnly: boolean;
  selectedId?: string | null;
  /** Rows opened for editing in place, by object id. */
  expandedIds?: ReadonlySet<string>;
  /** The chevron on the right of every row, and the row itself. */
  onToggleExpand?: (objectId: string) => void;
  /** An open row's title is the name field: the one place it is changed, in
   *  the place it is read, rather than a second copy of it in the editor. */
  onRename?: (entryId: string, name: string) => void;
  /** What to draw inside an open row. The panel supplies it, so this node
   *  still knows nothing about the draft store or the inspector's forms. */
  renderEditor?: (objectId: string) => ReactNode;
  /** Open the object somewhere else — used by the empty invitation row and
   *  by anything that still wants the column beside the board. */
  onOpen: (objectId: string) => void;
  /** The author has put their hands on this row — a click anywhere in it,
   *  the caret landing in its text. The board brings the block to them the
   *  way it does when a row is picked, without changing what is selected. */
  onEngage?: (objectId: string) => void;
  onHoverObject?: (objectId: string | null) => void;
  onFocusEntry?: (entryId: string) => void;
  onRowContextMenu?: (objectId: string, event: MouseEvent) => void;
  onRowDrop?: (dragged: string, target: string) => void;
  onAdd?: () => void;
  /**
   * The card's openings, as the player meets them: one block, and a numbered
   * switch across its header.
   *
   * A card with five openings used to be five blocks stacked down the tile —
   * five copies of the same shelf, four of which were never the one being
   * worked on, and nothing on the board said they were alternatives to each
   * other rather than five things the player gets. The player picks one of
   * five; so does the author, from the same switch, and the interface
   * preview follows it.
   */
  openings?: { id: string; selected: boolean; title: string }[];
  onPickOpening?: (id: string) => void;
};

type WritingLayout = Pick<CanvasWritingNodeData, "kind" | "entries" | "compact" | "columns" | "hiddenCount" | "expandedIds" | "folders" | "presetsTitle" | "collapsedFolders"> & { rows?: Pick<BlockRowView, "g" | "slots">[] };
/** The "N more" row under a folded list. */
export const CANVAS_WRITING_MORE_HEIGHT = 28;
const objectIdFor = (kind: CanvasWritingNodeData["kind"], entry: WorldEntry) => `${kind === "opening" ? "greeting" : "entry"}:${entry.id}`;
/** Rows by object id, built once per rows array. Looking each entry's row up
 *  with a `find` made laying out and drawing a block quadratic in its length —
 *  a presets shelf of forty rows did 1600 comparisons per render. Keyed on the
 *  array itself, so a rebuilt node gets a fresh index and nothing goes stale. */
const rowIndexes = new WeakMap<readonly Pick<BlockRowView, "g" | "slots">[], Map<string, Pick<BlockRowView, "g" | "slots">>>();
function rowById<R extends Pick<BlockRowView, "g" | "slots">>(rows: readonly R[] | undefined, id: string): R | undefined {
  if (!rows) return undefined;
  let index = rowIndexes.get(rows);
  if (!index) {
    index = new Map();
    // First one wins, the way `find` did.
    for (const row of rows) if (!index.has(row.g.id)) index.set(row.g.id, row);
    rowIndexes.set(rows, index);
  }
  return index.get(id) as R | undefined;
}
const rowFor = (data: CanvasWritingNodeData, entry?: WorldEntry) => entry ? rowById(data.rows, objectIdFor(data.kind, entry)) : undefined;
const isOpenRow = (data: WritingLayout, entry?: WorldEntry) => Boolean(entry && data.expandedIds?.has(objectIdFor(data.kind, entry)));
/** Nothing of the author's in it yet: an empty body, or only the line the
 *  first lesson wrote. Such a row is its name alone — the
 *  template's guidance is for the moment someone opens it, and shown on the
 *  board it was most of the words on a new card's first screen. */
const isUnwritten = (entry?: WorldEntry) => !!entry && (!entry.content?.trim() || isLessonHello(entry.content));
const rowBaseHeight = (data: WritingLayout, entry?: WorldEntry) =>
  isOpenRow(data, entry) ? ROW_HEADER_HEIGHT + openEditorHeight(data.kind)
    : data.compact || isUnwritten(entry) ? CANVAS_WRITING_COMPACT_ROW_HEIGHT
    : CANVAS_WRITING_ROW_HEIGHT;
const rowHeight = (data: WritingLayout, entry?: WorldEntry) =>
  rowBaseHeight(data, entry) + (entry ? rowById(data.rows, objectIdFor(data.kind, entry))?.slots.length ?? 0 : 0) * SLOT_HEIGHT;
/** A folder's header line: one word and a count, shorter than a row. */
export const CANVAS_WRITING_FOLDER_HEIGHT = 26;
export type WritingItem =
  | { kind: "entry"; entry: WorldEntry }
  | { kind: "folder"; folder: WritingFolder; entries: WorldEntry[] };
/**
 * The block's lines, top to bottom: the entries in no folder first, exactly
 * as listed, then each folder that holds one of these entries as a header
 * followed by its entries. Unfiled first, so that a group always begins at
 * its header and ends at the next — a trailing unfiled run would read as the
 * last folder's. A block with no filed entry is the plain list it was.
 */
export const PRESETS_GROUP_ID = "__presets";
export function writingItems(data: WritingLayout): WritingItem[] {
  const opening = data.kind === "opening";
  const folders = opening ? undefined : data.folders;
  const known = new Set((folders ?? []).map(f => f.id));
  const isPreset = (e: WorldEntry) => !opening && !!data.presetsTitle && !!e.presetId;
  const filed = (e: WorldEntry) => !!e.folderId && known.has(e.folderId);
  const presets = data.entries.filter(isPreset);
  if (!presets.length && (!known.size || !data.entries.some(filed))) return data.entries.map(entry => ({ kind: "entry", entry }));
  const items: WritingItem[] = data.entries.filter(e => !isPreset(e) && !filed(e)).map(entry => ({ kind: "entry", entry }));
  // A shut folder is its header: the entries stay the folder's (a click on
  // the header still selects them all) and simply are not drawn.
  const shut = (id: string) => data.collapsedFolders?.has(id) ?? false;
  for (const folder of [...(folders ?? [])].sort((a, b) => a.order - b.order)) {
    const inside = data.entries.filter(e => !isPreset(e) && e.folderId === folder.id);
    if (!inside.length) continue;
    items.push({ kind: "folder", folder, entries: inside });
    if (!shut(folder.id)) for (const entry of inside) items.push({ kind: "entry", entry });
  }
  if (presets.length) {
    items.push({ kind: "folder", folder: { id: PRESETS_GROUP_ID, name: data.presetsTitle!, order: Number.MAX_SAFE_INTEGER }, entries: presets });
    if (!shut(PRESETS_GROUP_ID)) for (const entry of presets) items.push({ kind: "entry", entry });
  }
  return items;
}
/** The items as runs: a headerless run of unfiled entries first, then one run
 *  per folder. In two columns each run deals its own rows, so a header spans
 *  the block and its rows sit under it — dealt as one list, a header landed
 *  at the foot of the left column with its rows at the head of the right. */
/** `entries` are the rows drawn under the header; `members` are everything
 *  in the folder, drawn or not. A shut folder draws no rows but its header
 *  still counts — and selects — every member, the same number as when open. */
export type WritingSection = { folder?: WritingFolder; members?: WorldEntry[]; entries: WorldEntry[] };
export function writingSections(data: WritingLayout): WritingSection[] {
  const sections: WritingSection[] = [];
  for (const item of writingItems(data)) {
    if (item.kind === "folder") sections.push({ folder: item.folder, members: item.entries, entries: [] });
    else {
      const last = sections[sections.length - 1];
      if (last && (last.folder ? true : sections.length === 1)) last.entries.push(item.entry);
      else sections.push({ entries: [item.entry] });
    }
  }
  return sections;
}
/** The rows of one run dealt into columns. The grid shares its rows between
 *  the columns (gridAutoFlow column, rows `auto`), so each line is as tall as
 *  the taller of its cells: a short unwritten row beside a written one is
 *  stretched, and summing each column on its own came out short — the last
 *  row then hung over the block below. */
const dealtHeight = (data: WritingLayout, entries: WorldEntry[], columns: number) => {
  const perColumn = Math.ceil(entries.length / columns);
  let total = 0;
  for (let line = 0; line < perColumn; line++) {
    let tallest = 0;
    for (let column = 0; column < columns; column++) {
      const entry = entries[column * perColumn + line];
      if (entry) tallest = Math.max(tallest, rowHeight(data, entry));
    }
    total += tallest;
  }
  return total;
};
/** An open row is a full editor; beside a second column it would be half a
 *  page wide with a list of names in the other half. One open row puts the
 *  whole block back into one column. */
export const writingColumns = (data: WritingLayout): 1 | 2 =>
  data.entries.some(entry => isOpenRow(data, entry)) ? 1 : data.columns ?? 1;

/**
 * Canvas layout and the rendered node use the same fixed dimensions.
 *
 * A row is a row whatever is written in it, so typing can never resize the
 * board: the shut row is a name, the open row is a fixed-height editor that
 * scrolls inside itself. What changes the node's height is opening a row,
 * which is a click the creator made on purpose.
 */
export function canvasWritingNodeHeight(data: WritingLayout): number {
  const columns = writingColumns(data);
  const sections = writingSections(data);
  // Two columns: each run is dealt first half / second half in reading
  // order and is as tall as its taller column; a folder header is a full
  // line of its own above its run.
  const body = sections.reduce((sum, section) => sum + (section.folder ? CANVAS_WRITING_FOLDER_HEIGHT : 0) + dealtHeight(data, section.entries, columns), 0);
  return CANVAS_WRITING_NODE_HEADER_HEIGHT + 2 +
    (sections.length ? body : rowBaseHeight(data)) +
    ((data.hiddenCount ?? 0) > 0 ? CANVAS_WRITING_MORE_HEIGHT : 0);
}

const stopEditorKeys = (event: KeyboardEvent) => {
  // History and save shortcuts belong to the shared editor. Editing keys
  // such as Backspace must never reach the graph's deletion shortcuts.
  if ((event.ctrlKey || event.metaKey) && !event.altKey && /^[zys]$/i.test(event.key)) return;
  event.stopPropagation();
};
const HANDLE_CLASS = "!h-3 !w-3 !border-2 !border-[#17161d] !z-10 !cursor-crosshair";
const OBJECT_MIME = "application/yumina-object";
/** The name a new setting is given before anyone names it, in any language. */
const NEW_ENTRY_NAME = /^(新建词条|新建詞條|新词条|新詞條|new entry|新しいエントリ|nueva entrada|entrada nueva)\s*\d*$/i;

function WritingSharedMark() {
  const { t } = useTranslation("editor");
  return <span data-canvas-writing-shared title={t("blueprint.block.sharedRowHint")} aria-label={t("blueprint.block.sharedRow")} className="inline-flex shrink-0 items-center text-zinc-500">
    <Link2 className="h-3 w-3" />
  </span>;
}

/** A portrait is an `@asset:` ref until play resolves it; the board resolves it the same way. */
const portraitUrl = (ref: string) => (ref.startsWith("@asset:") ? getAssetCdnUrl(ref.slice(7)) : ref);

function CanvasWritingFolder({ data, folder, entries }: { data: CanvasWritingNodeData; folder: WritingFolder; entries: WorldEntry[] }) {
  const { t } = useTranslation("editor");
  const ids = entries.map(entry => objectIdFor(data.kind, entry));
  const selected = !!data.multiSelected && ids.length > 0 && ids.every(id => data.multiSelected!.has(id));
  const shut = data.collapsedFolders?.has(folder.id) ?? false;
  return <div
    data-canvas-writing-folder={folder.id}
    data-canvas-writing-folder-shut={shut || undefined}
    className={cn(
      "nodrag flex w-full items-center border-b border-white/[0.06] pr-3 text-[11px] font-semibold transition-colors",
      selected ? "bg-amber-400/[0.14] text-amber-100" : "bg-violet-500/[0.07] text-violet-200/90 hover:bg-violet-500/[0.14]",
    )}
    style={{ height: CANVAS_WRITING_FOLDER_HEIGHT }}
  >
    {/* The chevron opens and shuts; the name still grabs the whole folder. */}
    <button
      type="button"
      aria-expanded={!shut}
      aria-label={t(shut ? "blueprint.frame.expand" : "blueprint.frame.collapse")}
      title={t(shut ? "blueprint.frame.expand" : "blueprint.frame.collapse")}
      onKeyDown={stopEditorKeys}
      onClick={event => { event.stopPropagation(); data.onToggleFolder?.(folder.id); }}
      className="flex h-full w-7 shrink-0 items-center justify-center pl-1 opacity-70 hover:opacity-100"
    >
      <ChevronDown className={cn("h-3 w-3 transition-transform", shut && "-rotate-90")} />
    </button>
    <button
      type="button"
      aria-pressed={selected}
      title={t("blueprint.writing.folderSelect", { count: ids.length })}
      onKeyDown={stopEditorKeys}
      onClick={event => { event.stopPropagation(); data.onSelectFolder?.(ids, event.shiftKey || event.ctrlKey || event.metaKey); }}
      className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left"
    >
      <FolderOpen className="h-3 w-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{folder.name}</span>
      <span className="tabular-nums opacity-60">{ids.length}</span>
    </button>
  </div>;
}

function CanvasWritingRow({ data, entry }: { data: CanvasWritingNodeData; entry?: WorldEntry }) {
  const { t } = useTranslation("editor");
  const opening = data.kind === "opening";
  const title = t(`blueprint.starter.${data.kind}Title`);
  const objectId = entry ? objectIdFor(data.kind, entry) : undefined;
  const row = rowFor(data, entry);
  // The same context the inspector reads, so a row bound to the interface
  // says so here too instead of "not set" beside an inspector that says
  // frontend-controlled.
  const worldbooks = useEditorStore((s) => s.worldDraft.worldbooks);
  const loreUiBindings = useEditorStore((s) => s.worldDraft.loreUiBindings);
  // {{char}} reads as the character's own name, as it will when played; an
  // imported card is full of it.
  const charName = useEditorStore((s) => s.worldDraft.entries.find((e) => e.role === "character" && e.enabled !== false)?.name?.trim() || "");
  const delivery = entry && !opening ? getEntryDeliverySummary(entry, { worldbooks, loreUiBindings }) : null;
  const warning = entry?.enabled === false ? "blueprint.writing.disabled" : delivery && delivery.mode !== "always" ? "blueprint.writing.configuredDelivery" : null;
  // When the AI is ever told this, in the fewest words that are still true.
  // Keywords name themselves: "关键词：城门, 守卫" is the fact a creator is
  // actually checking for, and it is what "详细" has to be worth opening.
  const keywordList = (entry?.keywords ?? []).join("、");
  // "Every turn" is what a settings entry normally does, so it stays quiet;
  // anything conditional is the thing worth spotting down a column of twenty,
  // and gets the one accent this line is allowed.
  const deliveryPlain = entry?.enabled !== false && delivery?.mode === "always";
  const deliveryLine = !entry || !delivery ? null
    : delivery.mode === "unplaced" ? t("blueprint.writing.deliveryUnplaced")
    : entry.enabled === false ? t("blueprint.writing.deliveryOff")
    : (delivery.mode === "keywords" || delivery.mode === "keywords-and-conditions") && keywordList
      ? t("blueprint.writing.deliveryKeywords", { keywords: keywordList })
    : delivery.mode === "conditions" ? t("blueprint.writing.deliveryConditions", { count: delivery.conditionCount })
    : delivery.mode === "frontend" ? t("blueprint.writing.deliveryFrontend")
    : delivery.mode === "always" ? t("blueprint.writing.deliveryAlways")
    : t("blueprint.writing.deliveryUnset");
  // A template seeds its entries empty and carries the guidance for each one
  // separately — what a worldview is for, what a system needs to pin down. A
  // row with nothing in it shows its own guidance rather than the same
  // "nothing written yet" on every one of them.
  //
  // The whole guidance, not its first line: the first line names the block,
  // and the lines under it are the part that says what to actually write. A
  // creator who only ever sees "the first moment the player enters your
  // world" has been told the heading twice and the advice never. The row is
  // a fixed height either way, so the clamp decides how much of it lands.
  const guidance = useTemplateContentPlaceholder(entry ?? { tags: undefined });
  // The source is a bulleted list; on one run of text its dashes read as
  // punctuation that lost its line, so the separator replaces them.
  const guidanceText = guidance
    .split("\n")
    .map(line => line.trim().replace(/^[-–—•]\s*/, ""))
    .filter(Boolean)
    .join(" · ");
  const expanded = isOpenRow(data, entry);
  const picked = !!objectId && (data.selectedId === objectId || !!data.multiSelected?.has(objectId));
  // The first lesson's 「你好！Yumina」 is the lesson's line, not the author's.
  const written = !!entry?.content && !isLessonHello(entry.content);
  /** This row is in the author's hand: it stays in place, emptied out, so
   *  the list shows where it came from while it travels. */
  const [lifted, setLifted] = useState(false);
  /** Another row is held over this one: a line of light says it would land
   *  here, above this row. */
  const [landing, setLanding] = useState(false);
  // A drag can end anywhere (a drop on another row, Esc, outside the
  // window); the line goes with it.
  useEffect(() => {
    if (!landing) return;
    const off = () => setLanding(false);
    window.addEventListener("dragend", off, true);
    window.addEventListener("drop", off, true);
    return () => { window.removeEventListener("dragend", off, true); window.removeEventListener("drop", off, true); };
  }, [landing]);
  // 「角色」 on a character, and the 「新建词条」 every new setting is born
  // with, read as names nobody gave: an empty box asking for one.
  const unnamedCharacter = entry?.role === "character" && isPlaceholderCharacterName(entry.name);
  const unnamed = unnamedCharacter || (!!entry && entry.role !== "greeting" && NEW_ENTRY_NAME.test(entry.name.trim()));
  // Two ways into one object, and every row offers both. Clicking the row
  // hands it to the drawer beside the board, which is what a click has always
  // done; the chevron opens the same editor here instead, without covering
  // the board you were reading it on.
  const open = (event?: MouseEvent) => {
    if (!objectId) { data.onAdd?.(); return; }
    if (event && (event.ctrlKey || event.metaKey || event.shiftKey) && data.onToggleMulti) { data.onToggleMulti(objectId); return; }
    data.onFocusEntry?.(entry!.id);
    data.onOpen(objectId);
  };
  const toggle = () => {
    if (!objectId) { data.onAdd?.(); return; }
    data.onFocusEntry?.(entry!.id);
    data.onToggleExpand?.(objectId);
  };
  const openMore = (event: MouseEvent) => {
    if (!objectId || data.readOnly || !data.onRowContextMenu) return;
    event.preventDefault(); event.stopPropagation();
    data.onRowContextMenu(objectId, event);
  };
  const beginDrag = (event: DragEvent<HTMLButtonElement>) => {
    if (!objectId || data.readOnly) { event.preventDefault(); return; }
    event.stopPropagation();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(OBJECT_MIME, objectId);
    // What kind of row is travelling, readable before the drop: an opening
    // only lands among openings, a setting among settings.
    event.dataTransfer.setData(`application/yumina-kind-${objectId.startsWith("greeting:") ? "greeting" : "entry"}`, "1");
    // A shared entry is still owned by the card, even when its visible row
    // sits inside a module. Keep actual ownership distinct from this view.
    const sourceOwner = row?.g.parentId?.startsWith("module:") ? row.g.parentId.slice("module:".length) : entry?.worldbookId ?? "core";
    event.dataTransfer.setData(`application/yumina-from-${sourceOwner}`, "1");
    event.dataTransfer.setData(`application/yumina-view-${data.ownerId ?? "core"}`, "1");
    const ghost = document.createElement("div");
    ghost.textContent = entry?.name || title;
    ghost.style.cssText = "position:fixed;top:-1000px;left:-1000px;padding:6px 12px;border-radius:8px;background:#221c2e;color:#f5e9c8;border:1px solid #d9a13f;font:600 13px system-ui,sans-serif;white-space:nowrap";
    document.body.appendChild(ghost);
    event.dataTransfer.setDragImage(ghost, 16, 16);
    setTimeout(() => ghost.remove(), 0);
    setLifted(true);
  };

  return (
    <section
      data-canvas-writing-object={objectId}
      data-canvas-writing-empty={!entry || undefined}
      data-canvas-writing-expanded={expanded || undefined}
      data-canvas-writing-picked={picked || undefined}
      className={cn("group/writing relative border-t border-white/[0.07] transition-[background-color,box-shadow] duration-150",
        // Picked reads at a glance: a gold edge and a warm wash on the row
        // itself, the same for one row or ten.
        picked ? "bg-amber-400/[0.11] shadow-[inset_3px_0_0_#f0c674,inset_0_0_0_1px_rgba(240,198,116,0.5)]" : expanded && "bg-white/[0.025]",
        lifted && "opacity-35 outline-dashed outline-1 -outline-offset-2 outline-amber-300/60")}
      style={{ height: rowHeight(data, entry) }}
      onClickCapture={() => { if (objectId) data.onEngage?.(objectId); }}
      onFocusCapture={() => { if (objectId) data.onEngage?.(objectId); }}
      onMouseEnter={() => { if (objectId) data.onHoverObject?.(objectId); }}
      onMouseLeave={() => { if (objectId) data.onHoverObject?.(null); }}
      onDragOver={event => {
        const types = Array.from(event.dataTransfer.types);
        if (data.readOnly || !objectId || !data.onRowDrop || !types.includes(OBJECT_MIME)) return;
        const kindType = types.find((ty) => ty.startsWith("application/yumina-kind-"));
        if (kindType && kindType !== `application/yumina-kind-${objectId.startsWith("greeting:") ? "greeting" : "entry"}`) return;
        event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move";
        if (!lifted && !landing) setLanding(true);
      }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setLanding(false); }}
      onDrop={event => {
        setLanding(false);
        if (data.readOnly || !objectId || !data.onRowDrop) return;
        const dragged = event.dataTransfer.getData(OBJECT_MIME);
        if (!/^(entry|greeting):/.test(dragged) || dragged === objectId) return;
        event.preventDefault(); event.stopPropagation(); data.onRowDrop(dragged, objectId);
      }}
    >
      {landing && <div aria-hidden data-canvas-writing-landing className="pointer-events-none absolute inset-x-1.5 -top-[2px] z-10 h-[3px] rounded-full bg-amber-300 shadow-[0_0_10px_rgba(240,198,116,0.9)]"><span className="absolute -left-1 -top-[3px] h-[9px] w-[9px] rounded-full bg-amber-300" /></div>}
      {row?.hasIn && <Handle id={rowHandleId(row.g.id, "in")} type="target" position={Position.Left} isConnectable={!data.readOnly} style={{ top: ROW_HEADER_HEIGHT / 2 }} className={cn(HANDLE_CLASS, "!bg-zinc-400")} />}
      {row?.hasOut && <Handle id={rowHandleId(row.g.id, "out")} type="source" position={Position.Right} isConnectable={!data.readOnly} style={{ top: ROW_HEADER_HEIGHT / 2 }} className={cn(HANDLE_CLASS, opening ? "!bg-emerald-400" : "!bg-violet-400")} />}
      {/* The row answers for itself. Left to bubble, a click reaches React
          Flow's node handler, which for a block with no head of its own
          selects the frame the block sits in — so opening the second row of a
          settings block put the frame in the column instead of the row.
          No `nowheel` here: the wheel zooms the board over a row like
          anywhere else (zooming in is how a row's text comes back). The open
          editor below keeps its own, so a long text still scrolls. */}
      <div
        className="nodrag nokey h-full"
        onKeyDown={stopEditorKeys}
        onClick={event => event.stopPropagation()}
        onDoubleClick={event => event.stopPropagation()}
        onContextMenu={openMore}
      >
        {/* The whole bar answers a click, not only the name on it: a click in
            the gap beside a short name used to do nothing at all. */}
        <div className="relative flex items-center gap-1 px-2" style={{ height: ROW_HEADER_HEIGHT }}
          onClick={event => { if (!(event.target as Element).closest("button, input, textarea, a, [contenteditable=true]")) open(event); }}>
          {entry && !data.readOnly && <button type="button" data-canvas-writing-drag={objectId} draggable onDragStart={beginDrag} onDragEnd={() => setLifted(false)} onPointerDown={event => event.stopPropagation()} onContextMenu={openMore} title={t("blueprint.writing.dragToReorder")} aria-label={`${entry.name || title} · ${t("blueprint.writing.dragToReorder")}`} className="flex h-8 w-4 shrink-0 cursor-grab items-center justify-center rounded text-zinc-500 opacity-0 group-hover/writing:opacity-100 group-focus-within/writing:opacity-100 [@media(hover:none)]:opacity-100 hover:text-zinc-300 active:cursor-grabbing focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400">
            <GripVertical className="h-3.5 w-3.5" />
          </button>}
          {/* A character with a face shows it here: the row is where an author
              looks to see which characters are finished, and a portrait is
              the one thing about a character the board could not show. */}
          {entry?.portrait && <img src={portraitUrl(entry.portrait)} alt="" data-canvas-writing-portrait draggable={false} className="h-6 w-6 shrink-0 rounded-full object-cover ring-1 ring-white/10" />}
          {entry?.voice && <span data-canvas-writing-voice title={t("blueprint.voice.hasVoice")} aria-label={t("blueprint.voice.hasVoice")} className="inline-flex shrink-0 items-center text-teal-300/80"><Volume2 className="h-3.5 w-3.5" /></span>}
          {expanded && entry && !data.readOnly && data.onRename ? (
            // A character still under the template's name (「角色」) reads as
            // unnamed: an empty box asking for one, ringed like an unnamed card.
            // Left as 「角色」, every reply in play was labelled 「旁白」.
            <DebouncedInput
              data-canvas-writing-name={objectId}
              value={unnamed ? "" : entry.name}
              syncKey={`writing-name-${entry.id}`}
              onCommit={name => { if (name.trim() || !unnamed) data.onRename?.(entry.id, name); }}
              placeholder={t(unnamedCharacter ? "blueprint.writing.characterName" : "blueprint.writing.entryName")}
              aria-label={t(unnamedCharacter ? "blueprint.writing.characterName" : "blueprint.writing.entryName")}
              onClick={event => event.stopPropagation()}
              onDoubleClick={event => event.stopPropagation()}
              className={cn("h-8 min-w-0 flex-1 rounded border border-transparent bg-white/[0.04] px-2 text-sm font-medium text-white hover:border-white/10 focus:border-amber-500/50 focus:outline-none focus:ring-1 focus:ring-amber-500/30",
                unnamed && "ring-1 ring-amber-400/40 placeholder:text-amber-200/60")}
            />
          ) : (
            <button
              type="button"
              data-canvas-writing-open={entry?.id ?? ""}
              onClick={open}
              aria-label={entry ? `${entry.name || title} · ${t("blueprint.writing.entrySettings")}` : undefined}
              className={cn("h-8 min-w-0 flex-1 truncate rounded px-1 text-left text-sm font-medium hover:text-white focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/60",
                expanded ? "text-white" : "text-zinc-200")}
            >{entry?.name || title}</button>
          )}
          {row?.shared && <WritingSharedMark />}
          {/* Simple mode only: in detail the line under the name says the same
              thing in words, and in an open row the form spells it out. */}
          {warning && data.compact && <span title={t(warning)} aria-label={t(warning)} className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />}
          {entry && !data.readOnly && data.onRowContextMenu && <button type="button" data-canvas-writing-more={objectId} onClick={openMore} onContextMenu={openMore} title={t("shell.moreActions")} aria-label={`${t("shell.moreActions")} · ${entry.name || title}`} className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-white/5 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400",
            // Always there on the row you are editing; on the others it waits
            // for the pointer, so a list of names does not wear a ⋯ each.
            !expanded && "opacity-0 group-hover/writing:opacity-100 group-focus-within/writing:opacity-100 [@media(hover:none)]:opacity-100")}>
            <MoreHorizontal className="h-4 w-4" />
          </button>}
          {/* The one control on a row that is always visible: everything a
              row can tell you is behind it, so it cannot be a thing you have
              to hover to discover. */}
          {entry && <button
            type="button"
            data-canvas-writing-expand={objectId}
            onClick={toggle}
            aria-expanded={expanded}
            title={t(expanded ? "blueprint.writing.collapseRow" : "blueprint.writing.expandRow")}
            aria-label={`${entry.name || title} · ${t(expanded ? "blueprint.writing.collapseRow" : "blueprint.writing.expandRow")}`}
            className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded transition-colors hover:bg-white/5 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400",
              expanded ? "text-amber-300" : "text-zinc-500")}
          >
            <ChevronDown className={cn("h-4 w-4 transition-transform duration-150", expanded && "rotate-180")} />
          </button>}
        </div>
        {expanded && objectId
          ? <div
              data-canvas-writing-editor={objectId}
              // A column so the body of text takes the slack the row gives it
              // rather than leaving a hole under the last button; `nowheel` so
              // a long one scrolls instead of zooming the board.
              className="nowheel flex flex-col overflow-y-auto overscroll-contain border-t border-white/[0.07] px-3 py-3"
              style={{ height: openEditorHeight(data.kind) }}
              onWheel={event => event.stopPropagation()}
            >
              {data.renderEditor?.(objectId)}
            </div>
          : !data.compact && written && <button type="button" data-canvas-writing-preview onClick={open} className={cn("block w-full px-4 text-left hover:bg-white/[0.02]", picked && "cursor-text")} style={{ height: rowBaseHeight(data, entry) - ROW_HEADER_HEIGHT - 1 }}>
            {/* An empty row still carries its guidance, but it has to read as
                empty: the guidance in the same grey as written text, with
                「每回合都发」 under it, looked like a block already written and
                already sent. Nothing is sent until something is written, so the
                delivery line waits for the content too. */}
            <span className={cn("block overflow-hidden text-sm leading-[18px]", written ? "text-zinc-400" : "text-zinc-500/80")}
              style={{ display: "-webkit-box", WebkitLineClamp: deliveryLine && written ? 2 : 3, WebkitBoxOrient: "vertical" }}>
              {(entry?.content ? resolveDisplayMacros(entry.content, t("studio.preview.you"), charName || t("studio.preview.character")) : "") || guidanceText || t(opening ? "blueprint.writing.emptyOpening" : "blueprint.writing.emptySetting")}
            </span>
            {/* Detail mode's whole point: not just what it says, but when the
                AI is ever going to be told it. */}
            {deliveryLine && written && <span data-canvas-writing-delivery className={cn("mt-1 block truncate text-[10px] leading-4", deliveryPlain ? "text-zinc-500" : "text-amber-300/70")}>{deliveryLine}</span>}
          </button>}
        {row?.slots.map(slot => <div key={slot.portId} className="relative flex items-center border-t border-white/5 px-4 text-[10px] text-zinc-400" style={{ height: SLOT_HEIGHT }}>
          <Handle id={portHandleId(row.g.id, slot.portId)} type="target" position={Position.Left} isConnectable={!data.readOnly} className={cn(HANDLE_CLASS, "!bg-rose-400")} />
          <span className="truncate">{slot.label}</span>
        </div>)}
      </div>
    </section>
  );
}

/**
 * The card's openings and settings, as a list on the board.
 *
 * This used to be a stack of full text editors, and a card out of the template
 * was five identical blank pages twice the height of the window. Now it is a
 * list of rows: shut, a row is a name and a taste of what it says; open, it is
 * that object's whole editor, in the row, on the board it belongs to. One
 * open at a time is the creator's choice, and nothing is edited in a drawer
 * over the map you were reading.
 */
export const CanvasWritingNode = memo(function CanvasWritingNode({ data, selected }: NodeProps<Node<CanvasWritingNodeData>>) {
  const { t } = useTranslation("editor");
  const opening = data.kind === "opening";
  const Icon = opening ? MessageCircle : BookOpen;
  const title = data.title ?? t(`blueprint.starter.${data.kind}Title`);
  // The same gesture the other blocks have: the header lifts the whole
  // piece (every opening / entry it lists) into another module.
  const pieceIds = data.readOnly ? [] : (data.rows ?? []).map((r) => r.g.id)
    .filter((id) => id.startsWith("entry:") || id.startsWith("greeting:"));
  const canDragPiece = pieceIds.length > 0;
  const selectedIds = data.multiSelected;
  const inSelection = !!selectedIds && pieceIds.some((id) => selectedIds.has(id));
  const carried = inSelection ? [...new Set([...selectedIds!, ...pieceIds])] : pieceIds;
  const pieceKind = data.kind === "opening" ? "opening" : "lore";
  const piece = canDragPiece ? {
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      event.stopPropagation();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("application/yumina-objects", carried.join(","));
      event.dataTransfer.setData("application/yumina-object", carried[0]!);
      event.dataTransfer.setData(`application/yumina-piece-${pieceKind}`, "1");
      event.dataTransfer.setData(`application/yumina-from-${data.ownerId ?? "core"}`, "1");
      const ghost = document.createElement("div");
      ghost.textContent = title;
      ghost.style.cssText = "position:fixed;top:-1000px;left:-1000px;padding:6px 14px;border-radius:10px;background:#221c2e;color:#f5e9c8;border:1px solid #d9a13f;font:700 12px system-ui,sans-serif;box-shadow:0 10px 26px rgba(0,0,0,.6);white-space:nowrap";
      document.body.appendChild(ghost);
      event.dataTransfer.setDragImage(ghost, 18, 18);
      setTimeout(() => ghost.remove(), 0);
      data.onPieceDrag?.(pieceKind);
    },
    onDragEnd: () => data.onPieceDrag?.(null),
    onClick: (event: React.MouseEvent) => {
      if (!(event.shiftKey || event.ctrlKey || event.metaKey)) return;
      event.stopPropagation();
      data.onPieceSelect?.(pieceIds, !inSelection);
    },
  } : {};
  const columns = writingColumns(data);
  const sections = writingSections(data);
  const keyBase = data.documentKey ?? "canvas";
  const dealt = (entries: WorldEntry[]) => <div
    className={cn(columns === 2 && "grid grid-cols-2 [&>*:nth-child(2)]:border-l [&>*:nth-child(2)]:border-white/[0.06]")}
    style={columns === 2 ? { gridAutoFlow: "column", gridTemplateRows: `repeat(${Math.ceil(entries.length / 2)}, auto)` } : undefined}
  >
    {entries.map(entry => <CanvasWritingRow key={`${keyBase}:entry:${entry.id}`} data={data} entry={entry} />)}
  </div>;
  return <article
    onDragOver={data.dropIn?.over}
    onDrop={data.dropIn?.drop}
    data-canvas-writing-node={data.kind}
    aria-label={title}
    // The two blocks an author writes in are the loudest on the board on
    // purpose: a stronger edge, a tinted header band and a coloured glow.
    // Everything else a new card shows is either a preview of the result or a
    // shelf announcing itself, and draws quietly so these two win the eye.
    className={cn(
      "border bg-[#17161d] text-zinc-100",
      // Outside every frame it is in play nowhere: faded until placed.
      data.loose && "border-dashed opacity-55 saturate-[.35] transition-opacity hover:opacity-90",
      data.flush ? "rounded-none" : "rounded-xl",
      data.flush
        ? "border-white/[0.09]"
        : opening
        ? "border-emerald-500/60 shadow-[0_2px_22px_rgba(52,211,153,0.12)]"
        : "border-violet-500/60 shadow-[0_2px_22px_rgba(139,92,246,0.12)]",
      selected && "ring-2 ring-amber-400/65",
    )}
    style={{ width: data.width ?? CANVAS_WRITING_NODE_WIDTH, height: data.fillHeight ?? canvasWritingNodeHeight(data) }}
  >
    <header
      {...piece}
      data-block-head
      className={cn("flex cursor-grab items-center gap-2 px-3 active:cursor-grabbing", !data.flush && "rounded-t-xl",
        // Neutral head, the kind as a line down the left edge — the same
        // rule as every other block's head.
        opening ? "bg-white/[0.025] shadow-[inset_2px_0_0_#10b981]" : "bg-white/[0.025] shadow-[inset_2px_0_0_#8b5cf6]",
        canDragPiece && "nodrag", inSelection && "ring-1 ring-inset ring-amber-400/70")}
      style={{ height: CANVAS_WRITING_NODE_HEADER_HEIGHT }}
    >
      <GripVertical aria-hidden className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
      <Icon className={cn("h-4 w-4 shrink-0", opening ? "text-emerald-300" : "text-violet-300")} />
      <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold" title={title}>{title}</span>{data.loose && <span data-loose-banner className="block truncate text-[10px] leading-4 text-zinc-400" title={`${t("blueprint.loose.badge")} · ${t("blueprint.loose.hint")}`}>{t("blueprint.loose.badge")}</span>}</span>
      {(data.openings?.length ?? 0) > 1 && (
        <div className="nodrag flex shrink-0 items-center gap-0.5 rounded-md bg-black/30 p-0.5" role="tablist" aria-label={t("blueprint.starter.openingTitle")}>
          {data.openings!.map((o, i) => (
            <button
              key={o.id}
              type="button"
              role="tab"
              aria-selected={o.selected}
              title={o.title}
              onKeyDown={stopEditorKeys}
              onClick={event => { event.stopPropagation(); data.onPickOpening?.(o.id); }}
              className={cn(
                "nowheel nokey flex h-6 w-6 items-center justify-center rounded text-[11px] font-bold tabular-nums transition-colors",
                o.selected
                  ? "bg-emerald-400/25 text-emerald-100 ring-1 ring-emerald-400/60"
                  : "text-zinc-400 hover:bg-white/10 hover:text-zinc-100",
              )}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}
      {data.loose && !data.readOnly && <button type="button" data-canvas-writing-share-all className="nodrag nowheel nokey h-8 max-w-[45%] shrink-0 truncate rounded border border-white/20 bg-white/5 px-2 text-[11px] font-medium text-zinc-200 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/40" title={t("blueprint.loose.shareAll")} onKeyDown={stopEditorKeys} onClick={event => { event.stopPropagation(); data.loose?.onShareAll(); }}>{t("blueprint.loose.shareAll")}</button>}
      {data.onAdd && !data.readOnly && <button type="button" data-writing-add={data.kind} className="nodrag nowheel nokey flex h-8 w-8 shrink-0 items-center justify-center rounded text-zinc-300 hover:bg-white/5 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400" onKeyDown={stopEditorKeys} onClick={event => { event.stopPropagation(); data.onAdd?.(); }} title={t(opening ? "blueprint.writing.moreOpening" : "blueprint.writing.moreSetting")} aria-label={t(opening ? "blueprint.writing.moreOpening" : "blueprint.writing.moreSetting")}><Plus className="h-4 w-4" /></button>}
    </header>
    {/* A module with nothing of its own here says what it counts instead of
        inviting a first entry with the card's own template title. */}
    {sections.length === 0
      ? ((data.shared ?? 0) > 0
        ? <div data-canvas-writing-shared-only className="flex items-center gap-2 px-3 text-[12px] text-zinc-400" style={{ height: CANVAS_WRITING_COMPACT_ROW_HEIGHT }}><Link2 className="h-3 w-3 shrink-0 text-zinc-500" /><span className="truncate">{t("blueprint.writing.sharedOnly", { count: data.shared })}</span></div>
        : <CanvasWritingRow key={`${keyBase}:first`} data={data} entry={undefined} />)
      : sections.map((section, index) => <div key={section.folder ? `${keyBase}:folder:${section.folder.id}` : `${keyBase}:run:${index}`}>
          {section.folder && <CanvasWritingFolder data={data} folder={section.folder} entries={section.members ?? section.entries} />}
          {dealt(section.entries)}
        </div>)}
    {(data.hiddenCount ?? 0) > 0 && (
      <button
        type="button"
        onClick={event => { event.stopPropagation(); data.onMore?.(); }}
        className="nodrag flex w-full items-center gap-1.5 px-3 text-[11px] font-semibold text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
        style={{ height: CANVAS_WRITING_MORE_HEIGHT }}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
        {t("blueprint.block.more", { count: data.hiddenCount })}
      </button>
    )}
  </article>;
});
