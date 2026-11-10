import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Block } from "@yumina/engine";
import { BLOCK_W, FRAME_COLLAPSED_H, FRAME_COLLAPSED_W, FRAME_GAP, FRAME_HEADER_H, FRAME_RAIL_H } from "./board";
import {
  LETTERHEAD_GAP,
  LETTERHEAD_W,
  TILE_GAP,
  TILE_TARGET_RATIO,
  TILE_WIDTHS,
  letterheadBeside,
  letterheadRoom,
  tileBoardLayout,
  tileFrame,
  tileSections,
  type TileSection,
} from "./tile-board";

const block = (id: string, kind: Block["kind"], rows = 0): Block => ({
  id, kind, total: rows, sharedCount: 0, hiddenCount: 0, headSlots: [],
  rows: Array.from({ length: rows }, (_, i) => ({ g: { id: `${id}:${i}`, kind: "entry", title: `r${i}`, ports: [], data: {} }, slots: [] })),
});
const card = () => [
  block("block:card", "card"),
  block("block:background", "background"),
  block("block:opening:a", "opening"),
  block("block:lore:always", "lore", 5),
  block("block:context", "context"),
  block("block:frontend", "frontend"),
  block("block:state", "state", 3),
  block("block:behavior", "behavior", 2),
];
/** Heights that do not depend on width: the tile's shape then comes from
 *  the widths alone. */
const flat = (heights: Record<string, number>) => (b: Block) => heights[b.id] ?? 100;
/** Sections as ids, so a test reads the way the tile does. */
const shape = (sections: TileSection[]) => sections.map((s) => s.blocks.map((b) => b.id));

test("the player's screen leads, alone; then the opening, the lists, the memory", () => {
  assert.deepEqual(shape(tileSections(card())), [
    ["block:frontend"],
    ["block:opening:a"],
    ["block:lore:always"],
    ["block:state"],
    ["block:behavior"],
    ["block:context"],
  ]);
});

test("the face and the background are not blocks of the tile at all", () => {
  // They belong to the CARD, not to its content, and stand above the tile as
  // two blocks of their own. Inside it they were one strip that read as
  // chrome; to the left of it they were the first thing on the whole board.
  const ids = shape(tileSections(card())).flat();
  assert.ok(!ids.includes("block:card"), "the face is laid out above the tile");
  assert.ok(!ids.includes("block:background"), "so is the background");
});

test("the letterhead is a column down the right of the tile, and the packer keeps room for it", () => {
  const tile = { x: 100, y: 400, width: 1320 };
  const spots = letterheadBeside(tile, [224, 200]);
  assert.equal(spots.length, 2);
  // Beside the work, not in front of it: the top-left belongs to the opening.
  assert.equal(spots[0]!.x, 100 + 1320 + FRAME_GAP, "clear of the tile's right edge");
  assert.equal(spots[1]!.x, spots[0]!.x, "one column, so both share it");
  assert.equal(spots[0]!.y, 400, "top edge level with the tile");
  assert.equal(spots[1]!.y, 400 + 224 + LETTERHEAD_GAP, "the second sits under the first");
  assert.equal(spots[0]!.width, LETTERHEAD_W);

  // The packer lays out frames and this is not one, so it has to be told.
  const room = letterheadRoom([224, 200]);
  assert.equal(room.w, LETTERHEAD_W + FRAME_GAP);
  assert.equal(room.h, 224 + LETTERHEAD_GAP + 200);
  assert.deepEqual(letterheadRoom([]), { w: 0, h: 0 }, "a card with neither costs nothing");
});

test("a module is packed clear of the letterhead, not on top of it", () => {
  const boxes = tileBoardLayout(
    [
      { id: "frame:card", blocks: card() },
      { id: "module:a", blocks: [block("block:m:a:lore:always", "lore", 2)] },
    ],
    flat({}),
    { isOpen: () => true, rowW: 6000, reserve: (id) => (id === "frame:card" ? letterheadRoom([224, 200]) : { w: 0, h: 0 }) },
  );
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const tile = byId.get("frame:card")!;
  const module = byId.get("module:a")!;
  const spot = letterheadBeside(tile, [224, 200])[0]!;
  assert.ok(module.x >= spot.x + spot.width, `module at ${module.x} overlaps the letterhead ending at ${spot.x + spot.width}`);
});

test("the interface takes the whole width at the top, and nothing stands beside it", () => {
  const tile = tileFrame({ id: "frame:card", blocks: card() }, flat({ "block:frontend": 250 }), { widths: [720] });
  const screen = tile.blocks["block:frontend"]!;
  const opening = tile.blocks["block:opening:a"]!;
  assert.equal(screen.x, 0);
  assert.equal(screen.y, FRAME_HEADER_H, "first in the tile");
  assert.equal(screen.w, 720, "full width");
  assert.equal(screen.h, 250, "its own height, not stretched to match any writing");
  assert.equal(opening.y, screen.y! + screen.h! + TILE_GAP, "the opening is under it");
  assert.equal(opening.w, 720);
});

test("variables and behaviours each take a full row, variables first", () => {
  const heights = { "block:state": 120, "block:behavior": 80, "block:frontend": 250 };
  const tile = tileFrame({ id: "frame:card", blocks: card() }, flat(heights), { widths: [720] });
  const state = tile.blocks["block:state"]!;
  const behavior = tile.blocks["block:behavior"]!;
  assert.equal(state.w, 720);
  assert.equal(behavior.w, 720);
  assert.equal(state.x, 0, "the stack starts at the tile edge, with no gutter");
  assert.equal(behavior.y, state.y! + 120 + TILE_GAP, "behaviours stand under the variables");
  assert.equal(behavior.h, 80, "a full row keeps its own height");
  // interface 250, opening 100, lore 100, variables 120, behaviours 80, memory 100.
  assert.equal(tile.height, FRAME_HEADER_H + (250 + 100 + 100 + 120 + 80 + 100) + TILE_GAP * 5 + FRAME_RAIL_H);
});

test("half-width blocks share a row, one bottom edge, and reach the tile's edges", () => {
  const blocks = [...card(), block("block:audio", "audio", 2), block("block:image", "image", 3)];
  const heights = { "block:audio": 120, "block:image": 80 };
  const tile = tileFrame({ id: "frame:card", blocks }, flat(heights), { widths: [720] });
  const inner = 720;
  const half = Math.ceil((inner - TILE_GAP) / 2);
  const audio = tile.blocks["block:audio"]!;
  const image = tile.blocks["block:image"]!;
  assert.equal(audio.w, half);
  assert.equal(image.w, half);
  assert.equal(audio.y, image.y);
  assert.equal(audio.x, 0, "the stack starts at the tile edge, with no gutter");
  assert.equal(image.x, half + TILE_GAP);
  // The short half is stretched to the row: touching blocks with ragged
  // bottoms read as a bug.
  assert.equal(audio.h, 120);
  assert.equal(image.h, 120);
  assert.equal(tile.blocks["block:context"]!.w, inner);
});

test("more writing never moves or stretches the interface", () => {
  // The bug the old band layout kept fighting: writing beside the interface
  // made it 1159px tall around a 640px preview.
  const blocks = [...card(), block("block:lore:more", "lore", 8)];
  const tile = tileFrame({ id: "frame:card", blocks }, flat({ "block:frontend": 150, "block:lore:always": 300 }), { widths: [720] });
  const screen = tile.blocks["block:frontend"]!;
  const lore = tile.blocks["block:lore:always"]!;
  const more = tile.blocks["block:lore:more"]!;
  assert.equal(screen.y, FRAME_HEADER_H);
  assert.equal(screen.h, 150);
  assert.equal(more.y, lore.y! + lore.h! + TILE_GAP, "shelves follow one another, full width");
  assert.equal(more.w, 720);
  assert.ok(tile.blocks["block:state"]!.y! > more.y!, "the lists stay after the writing");
});

test("the width is the one that comes out closest to 3:2, and a tie goes to the narrower", () => {
  const tile = tileFrame({ id: "f", blocks: card() }, flat({}));
  const height = tile.height;
  const off = (w: number) => Math.abs(Math.log(w / height / TILE_TARGET_RATIO));
  const nearest = [...TILE_WIDTHS].sort((a, b) => off(a) - off(b) || a - b)[0];
  assert.equal(tile.width, nearest);
  assert.ok(tile.width > tile.height, "landscape, not square");
});

test("a tall card is widened, not left as a column", () => {
  // The bug this replaces: the search scored on |height - width| and stopped
  // at 720, so a card with any real content could only grow downwards —
  // 720 x 2027, a strip using a quarter of the window.
  const heightAt = (b: Block, width: number) => {
    if (b.kind === "lore") return width >= 700 ? 300 : 900;
    if (b.kind === "state") return width >= 400 ? 200 : 400;
    return 120;
  };
  const tile = tileFrame({ id: "f", blocks: card() }, heightAt);
  const ratio = tile.width / tile.height;
  assert.ok(ratio > 1, `${tile.width}x${tile.height} is still a column`);
  assert.ok(ratio > 1.1 && ratio < 2.2, `${tile.width}x${tile.height} = ${ratio.toFixed(2)} is far from ${TILE_TARGET_RATIO}`);
});

test("a narrow tile keeps the same order: the interface on top", () => {
  const tile = tileFrame({ id: "frame:card", blocks: card() }, flat({}), { widths: [440] });
  const opening = tile.blocks["block:opening:a"]!;
  const screen = tile.blocks["block:frontend"]!;
  assert.equal(opening.w, 440);
  assert.equal(screen.w, 440);
  assert.ok(screen.y! < opening.y!, "the interface is above the writing at every width");
});

test("shut frames are small squares and sit in the row beside the open ones", () => {
  const boxes = tileBoardLayout(
    [
      { id: "frame:card", blocks: card() },
      { id: "module:a", blocks: [block("block:m:a:lore:always", "lore", 2)] },
      { id: "module:b", blocks: [] },
    ],
    flat({}),
    { isOpen: (id) => id !== "module:b", rowW: 4000 },
  );
  const byId = new Map(boxes.map((b) => [b.id, b]));
  const shut = byId.get("module:b")!;
  assert.equal(shut.width, FRAME_COLLAPSED_W);
  assert.equal(shut.height, FRAME_COLLAPSED_H);
  assert.equal(shut.y, byId.get("module:a")!.y, "the shut square shares the row");
  assert.equal(shut.x, byId.get("module:a")!.x + byId.get("module:a")!.width + FRAME_GAP);
});

test("audio and scene images share a row above the memory; either one alone keeps the full width", () => {
  const both = shape(tileSections([...card(), block("block:audio", "audio", 2), block("block:image", "image", 3)]));
  assert.deepEqual(both[5], ["block:audio", "block:image"]);
  assert.deepEqual(both[6], ["block:context"], "the memory is the setting under everything the card is made of");
  const alone = shape(tileSections([...card(), block("block:image", "image", 3)]));
  assert.deepEqual(alone[5], ["block:image"]);
});

test("a module with no interface stacks its writing full width", () => {
  const sections = shape(tileSections([block("block:m:lore", "lore", 3), block("block:m:state", "state", 1)]));
  assert.deepEqual(sections, [["block:m:lore"], ["block:m:state"]]);
  const tile = tileFrame({ id: "module:a", blocks: [block("block:m:lore", "lore", 3)] }, flat({}), { widths: [BLOCK_W] });
  assert.equal(tile.blocks["block:m:lore"]!.w, BLOCK_W);
});

test("Context closes what is there on its own row; the tray of unused slots sits under it, the AIs last", () => {
  assert.deepEqual(shape(tileSections([...card(), block("block:tray", "tray", 0), block("block:ais", "ais", 0)])), [
    ["block:frontend"],
    ["block:opening:a"],
    ["block:lore:always"],
    ["block:state"],
    ["block:behavior"],
    ["block:context"],
    ["block:tray"],
    ["block:ais"],
  ]);
});

test("the tile lays out the opening in hand, named by its entry id", () => {
  const opening = (id: string): Block => ({ ...block(`block:opening:${id}`, "opening"), head: { id: `greeting:${id}`, kind: "greeting", title: id, ports: [], data: {} } });
  const blocks = [...card().filter((b) => b.kind !== "opening"), opening("a"), opening("b")];
  const ids = shape(tileSections(blocks, { openingId: "b" })).flat();
  assert.ok(ids.includes("block:opening:b"));
  assert.ok(!ids.includes("block:opening:a"));
});
