import type { Block } from "@yumina/engine";
import {
  BLOCK_W,
  FRAME_COLLAPSED_H,
  FRAME_COLLAPSED_W,
  FRAME_GAP,
  FRAME_HEADER_H,
  FRAME_RAIL_H,
  packFrames,
  type FrameBox,
} from "./board";

/**
 * The tile board: a module is a landscape rectangle, not a column.
 *
 * One module used to be three or four columns wide — its lore, variables,
 * behaviours and a 610px interface preview laid side by side, 1,100px across,
 * so two modules needed two screens. Then it became a single stack, which
 * fixed that and bought the opposite problem: content only ever went
 * downwards. A card with twelve variables and four shelves of lore came out
 * 720 × 2027 — a strip that used 26% of a 1600px window with the rest empty,
 * that you had to zoom in to read and out to find.
 *
 * So: content decides the AREA, and the layout picks the width that brings
 * the SHAPE closest to landscape.
 */

/** The widths a tile may take, outer. The list used to stop at 720, which is
 *  the whole reason a full card could only grow taller. */
export const TILE_WIDTHS: readonly number[] = [360, 440, 540, 640, 720, 860, 1000, 1160, 1320, 1480];
/** The card's own tile stops at 1000: its opening is read in place, and a
 *  tile wider than a laptop's canvas beside the assistant could only be
 *  shown at a zoom too small to read. Past that it grows down. */
/** And at 860: beside the assistant on a 1440 screen the board has ~880px,
 *  and a 1000px tile there could only be shown at 0.85 — blurred type. */
export const CARD_TILE_WIDTHS: readonly number[] = TILE_WIDTHS.filter((w) => w <= 860);

/**
 * Landscape, near 3:2.
 *
 * No ratio is provably the most comfortable one — preference across roughly
 * 1.3–1.8 is a broad plateau, not a spike at the golden section, and the
 * experiments claiming otherwise have never agreed with each other. The
 * reason to be landscape at all is that binocular vision is: about 200°
 * across against 130° up. A wide rectangle is taken in by moving the eyes;
 * a tall one is taken in by scrolling. 1.5 sits in the middle of the
 * plateau, and anything from 1.4 to 1.7 reads the same.
 */
export const TILE_TARGET_RATIO = 1.5;

/** Between blocks inside a tile. -1 so the two 1px borders of neighbouring
 *  blocks land on the same pixel: the parts of one module read as one
 *  surface divided by hairlines, not as cards floating in a frame. */
export const TILE_GAP = -1;

/** A block's height at a given width. Widths matter: rows go two abreast in
 *  a wide block, chips wrap, previews scale. */
export type HeightAt = (block: Block, width: number) => number;

export interface TileSlotOptions {
  /** A frontend or scene block with a real preview to show. Kept because the
   *  caller measures heights with it; the layout no longer asks — the
   *  interface takes its column whether or not it has a picture in it yet. */
  hasPreview?: (block: Block) => boolean;
  /** The card's openings are alternatives, not a list: only the one being
   *  worked on is laid out, and its block carries the switch between them.
   *  Unset (or no match) means the first. */
  openingId?: string;
}

/**
 * A run of the tile, top to bottom.
 *
 * A `row` is one block full width, or two side by side sharing a bottom edge.
 * (There used to be a `band` too — the writing with the interface standing
 * beside it in a phone-wide column. The interface has its own row at the top
 * now, so everything is rows.)
 */
export type TileSection = { kind: "row"; blocks: Block[] };

/**
 * The sections of a tile, in reading order — which is the order the work
 * happens in: left to right, then the next line's left.
 *
 * The player's screen leads, alone and full width: it is what everything
 * below it drives, and it needs the room. Then the opening, the first thing
 * the player reads and the first thing the author writes.
 *
 * The card's own face and its chat background are NOT in here. They belong to
 * the card, not to the card's content, and they stand above the tile as two
 * blocks of their own — see `letterheadAbove`. Inside the tile they had been
 * one band across the top, which made them read as chrome, as a single
 * letterhead strip rather than the two things they are.
 *
 * Then the shelves of lore, then the variables and the behaviours, a row each,
 * then the media, then what the card remembers, then the settings.
 */
export function tileSections(blocks: readonly Block[], opts: TileSlotOptions = {}): TileSection[] {
  const face = blocks.find((b) => b.kind === "card");
  const background = blocks.find((b) => b.kind === "background");
  const allOpenings = blocks.filter((b) => b.kind === "opening");
  // The player sees one opening, chosen from all of them; so does the board.
  // Five openings used to be five blocks down the tile, four of them never
  // the one in hand and nothing saying they were alternatives.
  // `openingId` is the entry's id; a block's head is the node, `greeting:<id>`.
  const chosen = allOpenings.find((b) => opts.openingId && (b.head?.id === opts.openingId || b.head?.id === `greeting:${opts.openingId}`)) ?? allOpenings[0];
  const openings = chosen ? [chosen] : [];
  const lore = blocks.filter((b) => b.kind === "lore");
  const context = blocks.find((b) => b.kind === "context");
  const screen = blocks.find((b) => b.kind === "frontend" || b.kind === "scene");
  const state = blocks.find((b) => b.kind === "state");
  const behavior = blocks.find((b) => b.kind === "behavior");
  const audio = blocks.filter((b) => b.kind === "audio");
  const images = blocks.filter((b) => b.kind === "image");
  const tray = blocks.find((b) => b.kind === "tray");
  const ais = blocks.find((b) => b.kind === "ais");
  // Every opening counts as placed, laid out or not: the ones the switch is
  // not on must not fall through to the "anything we do not know" row.
  const placed = new Set<string>([...allOpenings, ...lore, ...audio, ...images].map((b) => b.id));
  for (const b of [face, background, context, screen, state, behavior, tray, ais]) if (b) placed.add(b.id);
  // Anything this layout does not know goes full-width at the end, rather
  // than vanishing: a block that is on the board is a block someone made.
  const rest = blocks.filter((b) => !placed.has(b.id));

  const sections: TileSection[] = [];
  // The player's screen stands above everything, alone and full width. Beside
  // the opening it was a phone-wide column that the writing kept squeezing,
  // and it moved whenever the writing grew; on top it has room, it is always
  // in the same place, and the settings, variables and behaviours read below
  // it as what drives it.
  // The screen first, then the opening that is read on it (owner, 10/3:
  // the screen on top reads more naturally). An empty screen on a new card
  // is one line (frontendThin), so it no longer buries the opening.
  if (screen) sections.push({ kind: "row", blocks: [screen] });
  for (const b of [...openings, ...lore]) sections.push({ kind: "row", blocks: [b] });

  // Variables, then behaviours, each a full row (owner, 10/7). Side by side
  // each got half a tile and squeezed its rows; alone they have room to read.
  for (const b of [state, behavior]) if (b) sections.push({ kind: "row", blocks: [b] });
  // Audio beside scene images: both are what the AI reaches for mid-story,
  // and each alone is a short list. One of them alone keeps the full width.
  // They stand above the memory: music and pictures are part of what the
  // card IS, the way its variables are; how the card remembers is the
  // setting underneath all of it, and the last thing a beginner needs.
  const media = [...audio, ...images];
  if (media.length === 2) sections.push({ kind: "row", blocks: media });
  else for (const b of media) sections.push({ kind: "row", blocks: [b] });
  // Context closes what the card is made of: a full row with room kept even
  // when it says little — everything the AI here is given each turn. Then
  // the unused slots, an offer read after what is there (owner, 10/7: under
  // Context, not above it), anything this layout does not know, and the AIs
  // last: who reads all of that and answers.
  if (context) sections.push({ kind: "row", blocks: [context] });
  if (tray) sections.push({ kind: "row", blocks: [tray] });
  for (const b of rest) sections.push({ kind: "row", blocks: [b] });
  if (ais) sections.push({ kind: "row", blocks: [ais] });
  return sections;
}

/** Lay one frame's sections out as a tile at the given outer width. */
function tileAt(width: number, sections: TileSection[], heightAt: HeightAt, headerH = FRAME_HEADER_H): Pick<FrameBox, "blocks" | "height"> {
  // Edge to edge: the module's border IS the stack's border. A gutter here
  // would put the parts back in a box and undo the point of butting them.
  const inner = width;
  const half = Math.ceil((inner - TILE_GAP) / 2);
  const blocks: FrameBox["blocks"] = {};
  let y = headerH;
  let laid = 0;

  const layRow = (row: Block[]) => {
    const w = row.length > 1 ? half : inner;
    let x = 0;
    let rowH = 0;
    for (const block of row) rowH = Math.max(rowH, heightAt(block, w));
    for (const block of row) {
      // Both halves take the row's height: a ragged bottom edge reads as a
      // bug once the blocks touch.
      blocks[block.id] = { x, y, w, h: rowH };
      x += w + TILE_GAP;
    }
    y += rowH + TILE_GAP;
    laid++;
  };

  for (const section of sections) layRow(section.blocks);

  const contentH = laid ? y - TILE_GAP - headerH : 0;
  return { blocks, height: headerH + contentH + FRAME_RAIL_H };
}

/**
 * The tile for a frame: the width, out of TILE_WIDTHS, at which its content
 * comes out closest to TILE_TARGET_RATIO. Ties go to the narrower — a tile is
 * never wider than it needs to be to hold its shape.
 *
 * The distance is measured on the LOG of the ratio, so a tile twice as wide
 * as it should be and one twice as tall are equally wrong. Measured on the
 * raw difference (which is what `|height - width|` was doing), every tall
 * tile scores better than every wide one and the search never widens
 * anything — which is how a 2027px column came out of a rule that was
 * supposed to be keeping tiles square.
 */
export function tileFrame(
  frame: { id: string; blocks: readonly Block[] },
  heightAt: HeightAt,
  opts: TileSlotOptions & { widths?: readonly number[]; headerH?: number } = {},
): FrameBox & { open: true } {
  const sections = tileSections(frame.blocks, opts);
  const widths = opts.widths ?? TILE_WIDTHS;
  let best: { width: number; layout: ReturnType<typeof tileAt> } | null = null;
  let bestScore = Infinity;
  for (const width of widths) {
    const layout = tileAt(width, sections, heightAt, opts.headerH);
    const score = layout.height > 0 ? Math.abs(Math.log(width / layout.height / TILE_TARGET_RATIO)) : 0;
    if (score < bestScore) { best = { width, layout }; bestScore = score; }
  }
  const chosen = best ?? { width: widths[0] ?? BLOCK_W, layout: tileAt(widths[0] ?? BLOCK_W, sections, heightAt, opts.headerH) };
  return { id: frame.id, width: chosen.width, height: chosen.layout.height, x: 0, y: 0, blocks: chosen.layout.blocks, open: true };
}

/**
 * The whole board as tiles: open frames are landscape rectangles sized to
 * their content, shut ones are small squares, and they pack into rows the way
 * the open board's frames did.
 */
/** Between the two parts of the letterhead. A real gap, not the tile's
 *  hairline: they are two blocks about two different pictures, and butted
 *  together they read as one strip of chrome. */
export const LETTERHEAD_GAP = 14;

/** The letterhead's column. Wide enough for a 2:3 cover and the words beside
 *  it; narrow enough that it reads as a margin note rather than a second
 *  board. */
export const LETTERHEAD_W = 430;

/**
 * Where the card's letterhead stands: in a column down the RIGHT of the
 * card's tile, top edges level with it.
 *
 * It has been tried in the other two places. To the LEFT it was the first
 * thing on the whole board and the two blocks nobody could name — and it took
 * the top-left, which is where the opening has to be. ACROSS THE TOP it read
 * as one strip of chrome rather than two blocks. On the right it is beside
 * the work without being in front of it: the eye still starts on the opening,
 * and "whose card is this, what does it look like" is answered in the margin,
 * which is what that question deserves.
 *
 * The packer does not know about these, so whoever calls this must reserve
 * the room — see `packFrames`'s `reserve`.
 */
export function letterheadBeside(
  tile: Pick<FrameBox, "x" | "y" | "width">,
  heights: readonly number[],
): Array<{ x: number; y: number; width: number }> {
  const x = tile.x + tile.width + FRAME_GAP;
  let y = tile.y;
  return heights.map((h) => {
    const at = { x, y, width: LETTERHEAD_W };
    y += h + LETTERHEAD_GAP;
    return at;
  });
}

/** The room a letterhead of these heights needs beside a tile. */
export function letterheadRoom(heights: readonly number[]): { w: number; h: number } {
  if (heights.length === 0) return { w: 0, h: 0 };
  const h = heights.reduce((a, b) => a + b, 0) + LETTERHEAD_GAP * (heights.length - 1);
  return { w: LETTERHEAD_W + FRAME_GAP, h };
}

export function tileBoardLayout(
  frames: ReadonlyArray<{ id: string; blocks: readonly Block[] }>,
  heightAt: HeightAt,
  opts: TileSlotOptions & {
    isOpen: (frameId: string) => boolean;
    hasNote?: (frameId: string) => boolean;
    pinned?: Record<string, { x: number; y: number }>;
    /** How wide a row of tiles may be, in board units, before the next
     *  starts a new row. */
    rowW: number;
    /** An open frame's header, per frame: an AI frame's is taller by its
     *  line of 「它收到」 chips. */
    headerH?: number | ((frameId: string) => number);
    /** Room to keep beside a frame for something laid out by hand — the
     *  card's letterhead. */
    reserve?: (frameId: string) => { w: number; h: number };
  },
): FrameBox[] {
  const sized = frames.map((frame) =>
    opts.isOpen(frame.id)
      ? tileFrame(frame, heightAt, {
          ...opts,
          headerH: typeof opts.headerH === "function" ? opts.headerH(frame.id) : opts.headerH,
          ...(frame.id === "frame:card" ? { widths: CARD_TILE_WIDTHS } : {}),
        })
      : { id: frame.id, width: FRAME_COLLAPSED_W, height: FRAME_COLLAPSED_H, x: 0, y: 0, blocks: {}, open: false as const },
  );
  const hasNote = opts.hasNote ?? (() => false);
  return packFrames(sized, {
    rowW: opts.rowW,
    openRowW: opts.rowW,
    pinned: opts.pinned ?? {},
    // Open, a note is a pin in the header; shut, it hangs below the tile.
    noteHangs: (id) => hasNote(id) && !opts.isOpen(id),
    mixed: true,
    reserve: opts.reserve,
  });
}
