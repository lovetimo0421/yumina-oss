import test from "node:test";
import assert from "node:assert/strict";
import type { Block, GraphNode } from "@yumina/engine";
import { findCanvasWritingSection, resolveLearningCanvasTarget } from "./learning-target";
import { JSDOM } from "jsdom";
import { lessonsOf } from "./learning-catalog";

const block = (id: string, kind: Block["kind"], patch: Partial<Block> = {}): Block => ({
  id, kind, rows: [], headSlots: [], hiddenCount: 0, total: 0, sharedCount: 0, ...patch,
});
const node = (id: string, kind: GraphNode["kind"]): GraphNode => ({ id, kind, title: id, ports: [], data: {} });

test("the tutorial starts on the opening", () => {
  assert.equal(lessonsOf("required")[0].id, "opening", "the first thing a player reads is the first thing an author meets");
});
test("empty writing lessons locate existing invitations without authoring objects", () => {
  const blocks = [block("block:starter:presets", "lore", {total: 5}), block("block:starter:opening", "opening"), block("block:starter:setting", "lore")];
  const before = structuredClone(blocks);
  assert.equal(resolveLearningCanvasTarget("opening", blocks), "block:starter:opening");
  assert.equal(resolveLearningCanvasTarget("setting", blocks), "block:starter:setting");
  assert.deepEqual(blocks, before);
});
test("existing writing resolves the actual entry while memory resolves its own block", () => {
  const blocks = [block("block:greetings", "opening", {head:node("greeting:start", "greeting"), total:1}),
    block("block:settings", "lore", {rows:[{g:node("entry:lighthouse", "entry"), slots:[]}], total:1}),
    block("block:chapter:context", "context", {ownerId:"chapter"})];
  assert.equal(resolveLearningCanvasTarget("opening", blocks), "greeting:start");
  assert.equal(resolveLearningCanvasTarget("setting", blocks), "entry:lighthouse");
  assert.equal(resolveLearningCanvasTarget("memory", blocks), "block:chapter:context");
  assert.equal(resolveLearningCanvasTarget("memory", []), undefined);
});
test("empty invitations and shared entries focus the correct canvas writing area", () => {
  const dom = new JSDOM('<div id="canvas"><div class="react-flow__node" data-id="block:starter:opening"><section data-canvas-writing-empty><textarea></textarea></section></div><div class="react-flow__node" data-id="block:a"><section data-canvas-writing-object="entry:shared"></section></div><div class="react-flow__node" data-id="block:b"><section data-canvas-writing-object="entry:shared"></section></div></div>');
  const container = dom.window.document.getElementById("canvas");
  assert.ok(findCanvasWritingSection(container,"block:starter:opening")?.querySelector("textarea"));
  assert.equal(findCanvasWritingSection(container,"entry:shared","block:b")?.parentElement?.dataset.id,"block:b");
  assert.equal(findCanvasWritingSection(container,"block:missing"),undefined);
  dom.window.close();
});
test("a lesson about the card's setting lands on the card's own, not a situation's", () => {
  const blocks = [
    block("block:m:yard:lore:always", "lore", { ownerId: "yard", rows: [{ g: node("entry:yard", "entry"), slots: [] }], total: 1 }),
    block("block:lore:always", "lore", { rows: [{ g: node("entry:keeper", "entry"), slots: [] }], total: 1 }),
  ];
  assert.equal(resolveLearningCanvasTarget("setting", blocks), "entry:keeper");
});
