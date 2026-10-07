import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Block, GraphNode } from "@yumina/engine";
import { BLOCK_HEAD_H, OPEN_ROW_EDITOR_H, PREVIEW_DESKTOP_W, PREVIEW_PHONE_W, blockHeight, listColumns, previewScale } from "./board";
import { tileSections } from "./tile-board";

const node = (id: string, title: string): GraphNode => ({ id, kind: "entry", title, ports: [], data: {} });
const block = (titles: string[], hidden = 0): Block => ({
  id: "block:m:a:lore:always",
  kind: "lore",
  ownerId: "a",
  headSlots: [],
  rows: titles.map((t, i) => ({ g: node(`entry:${i}`, t), slots: [] })),
  hiddenCount: hidden,
  total: titles.length + hidden,
  sharedCount: 0,
});

test("collapsed is the head alone, whatever the mode", () => {
  assert.equal(blockHeight(block(["血量", "金钱"]), { collapsed: true, expanded: false }), BLOCK_HEAD_H);
});

/**
 * A row opened for editing in place carries its object's whole editor, at a
 * fixed height. The layout has to count it, or the block below is drawn on top
 * of the form — and one open row puts the block back into a single column,
 * because an editor in one of two columns is half a page wide.
 */
test("an open row adds its editor's height, and collapses the block to one column", () => {
  const wide = { collapsed: false, expanded: false, width: 480 };
  const b = block(["血量", "金钱", "道具", "钥匙"]);
  assert.equal(listColumns(b, wide), 2, "four rows on a wide tile go two abreast");
  const shut = blockHeight(b, wide);
  const open = { ...wide, expandedIds: new Set(["entry:1"]) };
  assert.equal(listColumns(b, open), 1);
  // One column plus the editor: taller than the two-column shut block by more
  // than the editor alone, which is the whole point of counting it.
  assert.ok(blockHeight(b, open) >= shut + OPEN_ROW_EDITOR_H, `open ${blockHeight(b, open)} vs shut ${shut}`);
});

test("expanding a row of another block changes nothing here", () => {
  const chrome = { collapsed: false, expanded: false, width: 480 };
  const b = block(["血量", "金钱"]);
  assert.equal(
    blockHeight(b, { ...chrome, expandedIds: new Set(["var:elsewhere"]) }),
    blockHeight(b, chrome),
  );
});

test("the preview is shrunk to fit a block, never blown up past the device", () => {
  // A 420px column used to scale a 375-wide phone layout UP by 1.12: every
  // breakpoint resolved for a phone narrower than any that ships, and
  // everything on screen 12% bigger than the player will ever see it.
  assert.equal(previewScale(300, PREVIEW_PHONE_W), 300 / PREVIEW_PHONE_W);
  assert.equal(previewScale(PREVIEW_PHONE_W, PREVIEW_PHONE_W), 1);
  assert.equal(previewScale(420, PREVIEW_PHONE_W), 1, "a wider block letterboxes, it does not magnify");
  assert.equal(previewScale(1480, PREVIEW_DESKTOP_W), 1);
  assert.ok(previewScale(410, PREVIEW_DESKTOP_W) < 0.5, "a desktop screen in a phone column is shrunk, not cropped");
});

test("the interface takes a row of its own above the writing, on a phone or a desktop", () => {
  const blocks: Block[] = [
    { id: "block:opening", kind: "opening", total: 1, sharedCount: 0, hiddenCount: 0, headSlots: [], rows: [] },
    { id: "block:frontend", kind: "frontend", total: 1, sharedCount: 0, hiddenCount: 0, headSlots: [], rows: [] },
  ];
  assert.deepEqual(tileSections(blocks).map((s) => s.blocks.map((b) => b.id)), [["block:frontend"], ["block:opening"]]);
});
