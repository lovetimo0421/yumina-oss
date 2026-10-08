import type { Block } from "@yumina/engine";

// Pixels and formation — the half of the board model that only means anything
// on screen. The grouping itself lives in the engine (graph/board.ts).
//
// List blocks keep a common base width. Direct writing nodes may reserve a
// wider column; columns use the widest member without changing reading order.

export const BLOCK_W = 300;
export const BLOCK_HEAD_H = 40;

/** 16:9 of the block width — the card's cover at the size it is actually seen. */
export const COVER_H = Math.round((BLOCK_W * 9) / 16);
/** One line under the background strip: the processing, and the way in. */
export const BACKGROUND_FOOT_H = 40;
/** Three clamped lines of the card's description. */
export const CARD_DESC_H = 52;
export const CARD_FOOT_H = 37;

/**
 * The card's letterhead: its cover, and the picture behind the chat.
 *
 * These two are ABOUT pictures, so the picture is the block. They spent a
 * version as 76px strips with a 40px thumbnail in one corner, and at that
 * size the one thing they exist to show was the smallest thing on them —
 * a wide empty bar that nobody could name. The cover is drawn at the 2:3 it
 * is stored and browsed at, the background at the 16:9 it is painted at, and
 * both are big enough to recognise the picture from.
 */
export const FACE_BODY_H = 182;
/** The cover, at the shape the whole platform shows it in. */
export const FACE_COVER_H = 162;
export const FACE_COVER_W = Math.round((FACE_COVER_H * 2) / 3);
/** The background strip: the full width of its block, 16:9 of what is left
 *  under the row that names it. */
export const FACE_STRIP_H = 124;

/** An opening's own text, clamped. Expanded shows a scrollable column instead
 *  of growing without bound — the longest opening in the library is 8.5k
 *  characters and would be a mile-high block. */
export const OPENING_BODY_H = 128;
export const OPENING_BODY_H_OPEN = 320;
export const OPENING_FOOT_H = 26;

/** A lore row carries the entry's name AND two lines of its actual text. */
// Header badges + two preview lines + vertical padding must all fit. At 48px
// the second preview line painted over the next entry's title in detail mode.
export const LORE_ROW_H = 68;
/** State / behaviour / audio rows are one line. */
export const PLAIN_ROW_H = 30;
/** The tray: one line of "+" for the slots a card has not used. */
export const TRAY_H = 52;
/** 「AI」: a row is one line — its name and its type. What it remembers is
 *  the frame's Context block, not the row. */
export const AI_ROW_H = 30;
/** Context never comes out shorter than this. A line or two on a half-width
 *  block read as a footnote; the room says it carries weight even on a card
 *  that has nothing special to say about it yet (owner, 10/7: taller). */
export const CONTEXT_MIN_H = 160;
export const SLOT_ROW_H = 22;
export const BLOCK_FOOT_H = 28;
/** The "add a pack" button under an empty variables / behaviours block. */
export const PACK_DOOR_H = 26;
export const BLOCK_BODY_PAD = 6;

/**
 * The live frontend preview, at the size the player's device actually is.
 *
 * It used to lay the card out at 375 and scale it to the block's width,
 * which on a 420px column meant scaling a phone layout UP by 1.12: every
 * breakpoint the card has resolved for a phone narrower than any phone
 * shipping, and everything on screen came out 12% bigger than the player
 * will ever see it. A preview that lies about the size is worse than no
 * preview, because it is the size a card's frontend is built against.
 *
 * 390 is the CSS width of the current iPhone and the middle of the Android
 * range; 1024 is the desktop layout the scene preview already used. The
 * scale is capped at 1 — the card is never blown up, only shrunk to fit,
 * and a block wider than the device letterboxes instead.
 */
export const PREVIEW_PHONE_W = 390;
export const PREVIEW_H = 396;
export const DEFAULT_CHAT_PREVIEW_H = 196;
export const DEFAULT_CHAT_HINT_H = 32;
export const COMPACT_CARD_BODY_H = 54;
export const PREVIEW_SCALE = BLOCK_W / PREVIEW_PHONE_W;
/** The player's screen on the board: the device at its real shape (a
 *  1024×640 computer, a 390×844 phone), drawn at one fixed scale and
 *  centred in its block. At 0.8 the chat's text comes out ~13px on a board
 *  opened at reading size; at 0.72 it was a few pixels on a board seen whole,
 *  and near life size the screen alone filled the first view. It used to stretch to the block's width with a
 *  height of its own, which on a wide card made the chat a letterbox strip
 *  with its text cut in half. */
// Half size since 10/5: at 0.8 the screen was the biggest thing on the board
// and read as the board's subject. It is a glance now; double-click is the
// way into the full-size page.
export const SCREEN_SCALE = 0.5;
export const SCREEN_PAD = 8;
// 10/6: the screen fills its block (owner: too much empty room around it).
// A computer is as wide as the block; a phone is as tall as that computer.
export function screenFrame(width: number, desktop: boolean): { scale: number; w: number; h: number; deviceW: number; deviceH: number } {
  const deviceW = desktop ? PREVIEW_DESKTOP_W : PREVIEW_PHONE_W;
  const deviceH = desktop ? 640 : 844;
  const fitW = Math.min(1, (width - SCREEN_PAD * 2) / PREVIEW_DESKTOP_W);
  const scale = desktop ? fitW : Math.min(1, (PREVIEW_DESKTOP_W * fitW * 640) / (PREVIEW_DESKTOP_W * 844), (width - SCREEN_PAD * 2) / deviceW);
  return { scale, w: Math.round(deviceW * scale), h: Math.round(deviceH * scale), deviceW, deviceH };
}
/** How much of the device's own layout fits in a block this wide: never more
 *  than all of it. */
export const previewScale = (width: number, deviceW: number) => Math.min(1, width / deviceW);
/** The scene block previewed at desktop width: it spans two columns, and
 *  the interface is laid out 1024 wide inside, scaled to fit. Creators
 *  build for computers first; the phone is the other look. */
export const SCENE_WIDE_W = BLOCK_W * 2 + 28;
export const PREVIEW_DESKTOP_W = 1024;
export const PREVIEW_DESKTOP_SCALE = SCENE_WIDE_W / PREVIEW_DESKTOP_W;
export const PREVIEW_DESKTOP_H = Math.round(640 * PREVIEW_DESKTOP_SCALE);
/** Two lines saying the module shows the card's default chat, in place of a
 *  preview that would show exactly that, empty. */
export const SCENE_BARE_HINT_H = 44;

/** The "new · not in a module yet" banner on a loose block. */
export const LOOSE_BANNER_H = 44;

export interface BlockChrome {
  collapsed: boolean;
  /** Opening blocks: the creator asked for the whole text. */
  expanded: boolean;
  /** Context blocks: how many lines it takes to say what this frame's AI
   *  remembers and reads. Computed by the panel from the worldbooks, since
   *  the block itself carries no rows. */
  contextRows?: number;
  /** 「这里的 AI」: how many AIs answer in this frame, the narrator counted. */
  aiRows?: number;
  /** Scene block: previewed at desktop width, two columns wide. */
  sceneWide?: boolean;
  /** Scene block with nothing of its own to preview — no scene file, on a
   *  card with no interface either. One column, no preview: a line that
   *  says so and the file picker. */
  sceneBare?: boolean;
  compactCard?: boolean;
  /** The card's interface is previewed at desktop width rather than phone. */
  frontendDesktop?: boolean;
  /** Height of the file strip under the phone (0 or absent for the stock chat). */
  frontendFilesH?: number;
  defaultChat?: boolean;
  /** The card's interface is the stock chat: one line saying so, no preview.
   *  The preview showed the stock chat with nothing in it, 200px tall, on
   *  every card that had not built a screen — which is most of them. */
  frontendThin?: boolean;
  /** The width this block is laid out at. Rows go two abreast past a few
   *  (see `rowColumns`), chips wrap to it, previews scale to it. Absent, the
   *  block is the classic 300px. */
  width?: number;
  /** The empty block carries a second door under its invitation — the pack
   *  picker. The layout has to know, or the button is drawn outside the
   *  block's computed height and clipped by the tile. */
  packDoor?: boolean;
  /** App-only start slots use the same geometry as their actual flow nodes. */
  starterHeight?: number;
  /** Rows opened for editing in place, by object id. An open row carries its
   *  object's whole editor, so it costs a fixed block of height the layout has
   *  to count — and puts the block back into one column while it is open. */
  expandedIds?: ReadonlySet<string>;
}

/** An open row's editor: fixed, and scrolled inside itself, so typing can
 *  never resize the board. Matches CANVAS_WRITING_OPEN_EDITOR_HEIGHT. */
export const OPEN_ROW_EDITOR_H = 460;
/** A variable or a behaviour is a short form (its rarer settings fold under
 *  更多), so its row opens shorter than a body of text does. */
export const OPEN_SETTING_EDITOR_H = 340;
export const openRowEditorHeight = (objectId: string) =>
  objectId.startsWith("var:") || objectId.startsWith("reaction:") ? OPEN_SETTING_EDITOR_H : OPEN_ROW_EDITOR_H;

/** Rows in a list block go two abreast once there are more than a few and
 *  the block is wide enough for two — a block of one-line rows is a table of
 *  contents, and a tall thin one is the shape a square tile cannot hold. */
export const TILE_ROWS_ABREAST_FROM = 4;
export const TILE_TWO_COLUMN_MIN_W = 400;
export function rowColumns(rowCount: number, width: number): 1 | 2 {
  return rowCount >= TILE_ROWS_ABREAST_FROM && width >= TILE_TWO_COLUMN_MIN_W ? 2 : 1;
}
/** The columns a list block actually draws. An open row is a full editor;
 *  beside a second column it would be half a page wide with a list of names
 *  in the other half, so one open row puts the block back into one column. */
export function listColumns(block: Block, chrome: Pick<BlockChrome, "width" | "expandedIds">): 1 | 2 {
  if (chrome.expandedIds?.size && block.rows.some((row) => chrome.expandedIds!.has(row.g.id))) return 1;
  return rowColumns(block.rows.length, chrome.width ?? BLOCK_W);
}
/** Rows a tile block shows before the rest fold behind "N more" — two
 *  columns of eight. Past that the block is a wall, and the column beside
 *  the board lists the rest. */
export const TILE_ROW_LIMIT = 16;

/**
 * A block's height, computed rather than measured.
 *
 * This number decides where the NEXT block starts, so anything the component
 * renders unconditionally has to be counted unconditionally. The card block
 * learned this the hard way: its cover strip was only counted when the card
 * had a cover, but a card without one still renders an "add a cover" panel of
 * exactly the same size — so on the 90% of cards with no cover the next block
 * was laid straight on top of it.
 *
 * The head is a FIXED box that already contains the cost/summary line, so
 * there is nothing to add for it — counting it separately reserved 16px per
 * block that nothing ever occupied.
 */
export function blockHeight(block: Block, chrome: BlockChrome): number {
  if (chrome.starterHeight !== undefined) return chrome.starterHeight;
  // A loose block wears a banner above its head saying it is new and not in
  // a module yet, with the way out.
  const h = BLOCK_HEAD_H + (block.loose ? LOOSE_BANNER_H : 0);
  if (block.kind === "tray") return TRAY_H;
  // Context wears the same head as the shelves above it (owner, 10/7) and
  // keeps a floor under its rows; AI has no head — a line per answerer.
  if (block.kind === "context") return Math.max(CONTEXT_MIN_H, BLOCK_HEAD_H + BLOCK_BODY_PAD * 2 + Math.max(1, chrome.contextRows ?? 1) * PLAIN_ROW_H);
  if (block.kind === "ais") return BLOCK_BODY_PAD * 2 + Math.max(1, chrome.aiRows ?? 1) * AI_ROW_H;
  if (chrome.collapsed) return h;

  switch (block.kind) {
    // The letterhead pair. Fixed whether or not there is a picture: the empty
    // state is a strip of exactly the same size saying there is none — the
    // lesson the card block's cover taught when it was only counted on the
    // 10% of cards that had one, and the next block was laid on top of it.
    case "card":
    case "background":
      return h + FACE_BODY_H;
    // The card's own opening shows its text; a module's openings are a list
    // like its lore, and fall through to the list sizing below.
    case "opening":
      if (block.head) return h + (chrome.expanded ? OPENING_BODY_H_OPEN : OPENING_BODY_H) + OPENING_FOOT_H;
      return h + listBodyHeight(block, chrome);
    case "frontend": {
      if (chrome.frontendThin) return h + DEFAULT_CHAT_HINT_H + block.headSlots.length * SLOT_ROW_H;
      // The device at its own shape (see screenFrame); its controls sit in
      // the head.
      const frame = screenFrame(chrome.width ?? BLOCK_W, chrome.frontendDesktop !== false);
      return h + frame.h + SCREEN_PAD * 2 + (chrome.frontendFilesH ?? 0) + block.headSlots.length * SLOT_ROW_H;
    }
    // The module's own live preview, then one line (the file and the way to
    // open it), then the interface's variable ports.
    case "scene":
      if (chrome.sceneBare) return h + SCENE_BARE_HINT_H + BLOCK_BODY_PAD * 2 + PLAIN_ROW_H + block.headSlots.length * SLOT_ROW_H;
      return h + (chrome.sceneWide ? desktopPreviewHeight(chrome.width ?? SCENE_WIDE_W) : PREVIEW_H) + BLOCK_BODY_PAD * 2 + PLAIN_ROW_H + block.headSlots.length * SLOT_ROW_H;
    default:
      return h + listBodyHeight(block, chrome);
  }
}

/** A desktop-width preview scaled into a block of this width: the interface
 *  is laid out 1024 wide inside, 640 tall, and shrunk to fit. */
export function desktopPreviewHeight(width: number): number {
  return Math.round(640 * (width / PREVIEW_DESKTOP_W));
}

/** The body of a list block: its rows, in one or two columns. */
function listBodyHeight(block: Block, chrome: BlockChrome): number {
  const rowH = block.kind === "lore" ? LORE_ROW_H : PLAIN_ROW_H;
  // Two columns: the rows are dealt first-half / second-half, in reading
  // order, so the block is as tall as the taller column.
  const columns = listColumns(block, chrome);
  const perColumn = Math.ceil(block.rows.length / columns);
  const heights = new Array<number>(columns).fill(0);
  block.rows.forEach((row, index) => {
    const column = Math.min(columns - 1, Math.floor(index / perColumn));
    const open = chrome.expandedIds?.has(row.g.id) ? openRowEditorHeight(row.g.id) : 0;
    heights[column] = heights[column]! + rowH + open + row.slots.length * SLOT_ROW_H;
  });
  let body = BLOCK_BODY_PAD * 2 + Math.max(0, ...heights);
  if (block.hiddenCount > 0) body += BLOCK_FOOT_H;
  if (block.rows.length === 0) body += rowH + (chrome.packDoor ? PACK_DOOR_H : 0);
  return body;
}

export const BLOCK_GAP_X = 28;
export const BLOCK_GAP_Y = 28;

/** A module frame's chrome: the header that names it and the padding that
 *  makes its contents read as "inside". */
export const FRAME_HEADER_H = 78;
/** The name bar itself; the rest of an open frame's header is the line that
 *  says whose AI this is and when it speaks (GateNode's AI line). */
export const FRAME_TITLE_H = 46;
/** An AI frame's second header line: the chips saying what it receives. */
export const AI_RECEIVES_H = 36;
export const FRAME_PAD = 14;
export const FRAME_GAP = 28;
/** A shut frame is a bar. Wide enough for a module name and its counts,
 *  narrow enough that twenty of them tile instead of listing. */
export const FRAME_COLLAPSED_W = 236;
/** A shut frame on the tile board is a small square rather than a bar: the
 *  name and when it opens on the header line, what it holds as four counts
 *  below. Twenty of them tile like a screen of icons. */
export const FRAME_COLLAPSED_H = 118;
/** A shut frame's sticky note hangs BELOW the bar, so its row has to grow by
 *  this much or the note lies across the modules underneath. Three clamped
 *  lines plus the gap the note is offset by. */
export const FRAME_NOTE_H = 56;
/**
 * The shelves — openings, lore, variables, behaviours — used to be a 58px
 * rail across the bottom of every open module: four dashed buttons with
 * their names and counts.
 *
 * They still say what a module can hold and still give a new one somewhere
 * to put things, which is why they are always drawn, empty or not. But they
 * are four icons in the module's own header bar now, not a band of their own
 * at the far end of a tile. A name a creator reads once was costing 58px on
 * every module forever, and on the card's tile it was 58px of the height the
 * shape is measured on.
 */
export const FRAME_RAIL_H = 0;

export interface FrameBox {
  id: string;
  width: number;
  height: number;
  x: number;
  y: number;
  /** Block id → position RELATIVE to the frame, for React Flow's sub-flow
   *  parenting. Empty when the frame is shut. On the tile board a block's
   *  width is the layout's to decide too (`w`); absent, it is the block's
   *  own. */
  blocks: Record<string, { x: number; y: number; w?: number; h?: number }>;
}

/**
 * Pack sized frames into the formation: shut ones flow into rows, open ones
 * share a row only with open ones and only while the row fits the screen.
 * A pinned frame is not packed — it sits where it was put — and the free
 * ones settle below whatever they would overlap.
 */
/** Where the first frame of the formation stands, in board coordinates. */
export const FORMATION_ORIGIN = { x: -550, y: 0 };

export function packFrames(
  sized: Array<Omit<FrameBox, "x" | "y"> & { open: boolean }>,
  opts: {
    rowW: number;
    openRowW: number;
    pinned: Record<string, { x: number; y: number }>;
    noteHangs: (id: string) => boolean;
    /** Open and shut frames share rows. On the tile board a shut module is
     *  a small square that sits beside the open ones, not a bar that needs
     *  a row of bars. */
    mixed?: boolean;
    /** Room this frame needs BESIDE and BELOW its own box, for something the
     *  packer does not lay out — the card's letterhead stands to the right of
     *  the card's tile in board coordinates, and without this the next module
     *  in the row was packed straight on top of it. */
    reserve?: (id: string) => { w: number; h: number };
  },
): FrameBox[] {
  const { rowW, openRowW, pinned, noteHangs, mixed = false, reserve } = opts;
  const room = (id: string) => reserve?.(id) ?? { w: 0, h: 0 };
  const out: FrameBox[] = [];
  let y = 0;
  let rowX = 0;
  let rowH = 0;
  const endRow = () => {
    if (rowH > 0) y += rowH + FRAME_GAP;
    rowX = 0;
    rowH = 0;
  };

  let rowKind: "open" | "shut" | null = null;
  for (const f of sized) {
    if (pinned[f.id]) continue;
    if (f.open || mixed) {
      // Open frames share a row only with open frames, and only while the
      // row stays within what the screen can show them at.
      const kept = room(f.id);
      if ((!mixed && rowKind !== "open") || (rowX > 0 && rowX + f.width + kept.w > openRowW)) endRow();
      rowKind = "open";
      out.push({ ...f, x: rowX, y });
      rowX += f.width + kept.w + FRAME_GAP;
      rowH = Math.max(rowH, f.height + (!f.open && noteHangs(f.id) ? FRAME_NOTE_H : 0), kept.h);
      continue;
    }
    if (rowKind !== "shut") endRow();
    rowKind = "shut";
    if (rowX > 0 && rowX + f.width > rowW) endRow();
    out.push({ ...f, x: rowX, y });
    rowX += f.width + FRAME_GAP;
    // The note hangs past the bar, so the ROW grows — not the frame, which
    // would put a border around empty space.
    rowH = Math.max(rowH, f.height + (noteHangs(f.id) ? FRAME_NOTE_H : 0));
  }
  endRow();

  // The formation hangs from one fixed point. It used to be centred on the
  // origin by its own size (and the row width follows the window and the
  // docks), so every block that grew or shrank — a row opened, a setting
  // dragged out, the screen folded, the assistant shut — slid the whole
  // board, the card the author was looking at included. Pinned frames were
  // stored in board coordinates, so they are added after and never move.
  const dx = FORMATION_ORIGIN.x;
  const dy = FORMATION_ORIGIN.y;
  const placed: FrameBox[] = out.map((f) => ({ ...f, x: f.x + dx, y: f.y + dy }));
  for (const f of sized) {
    const at = pinned[f.id];
    if (at) placed.push({ ...f, x: at.x, y: at.y });
  }
  return settle(placed, noteHangs, new Set(Object.keys(pinned)));
}

/**
 * The free frames never overlap anything. Frames are visited top to bottom;
 * a free one that would land on a frame already placed above it (sharing
 * any horizontal span) moves down to just below it.
 *
 * A PINNED frame is where the creator put it and is not moved by this pass,
 * whatever it lies on — the way a slide's boxes stay where they are dropped.
 * Dragging used to shove the neighbours below out of the way on every drop,
 * which read as "I moved one and three others jumped". Now the canvas shows
 * an overlap while it is being made (the frames turn red under the drag)
 * and leaves the decision with the creator; 整理 pulls every pin and lets
 * the formation lay the board out again.
 */
function settle(boxes: FrameBox[], hasNote: (frameId: string) => boolean, pinnedIds: ReadonlySet<string> = new Set()): FrameBox[] {
  // Pinned frames are obstacles from the start, wherever they are in the
  // order; the free ones are then placed top to bottom around them.
  const done: FrameBox[] = boxes.filter((b) => pinnedIds.has(b.id));
  const free = boxes.filter((b) => !pinnedIds.has(b.id)).sort((a, b) => a.y - b.y || a.x - b.x);
  for (const f of free) {
    // Only a frame it would actually land ON pushes it — sharing columns is not
    // enough. Checking the horizontal span alone sent a free frame sitting
    // well above a pin down to below it. One push can land it on another
    // frame, so keep going until nothing it overlaps is left (y only grows,
    // so this ends).
    const ownH = f.height + (hasNote(f.id) ? FRAME_NOTE_H : 0);
    let y = f.y;
    for (let moved = true; moved;) {
      moved = false;
      for (const p of done) {
        const overlapX = f.x < p.x + p.width && p.x < f.x + f.width;
        if (!overlapX) continue;
        const bottom = p.y + p.height + (hasNote(p.id) ? FRAME_NOTE_H : 0) + FRAME_GAP;
        const overlapY = y < bottom && p.y < y + ownH + FRAME_GAP;
        if (overlapY) { y = bottom; moved = true; }
      }
    }
    done.push({ ...f, y });
  }
  // Back in the caller's order, so ids map the same way they came in.
  const byId = new Map(done.map((f) => [f.id, f]));
  return boxes.map((f) => byId.get(f.id)!);
}

