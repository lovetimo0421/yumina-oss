import { describe, it, expect } from "vitest";
import { blockHostsMap, blockId, buildBoard, buildFrames } from "../board.js";
import type { CardGraph, GraphNode } from "../types.js";

// A brand-new entry made with no module selected is not yet anybody's: it
// stands on the canvas by itself until the creator drags it into a module
// (or says "put it in every module"). While it is loose it is drawn once,
// as its own little block outside every frame — not as a shared row in each
// module, which is what a card-level object otherwise becomes.

const node = (id: string, kind: GraphNode["kind"], data: Record<string, unknown> = {}): GraphNode => ({ id, kind, title: id, ports: [], data });
const graph = (nodes: GraphNode[], edges: CardGraph["edges"] = []): CardGraph => ({ nodes, edges });
const world = node("world:root", "world");
const modA = node("module:a", "module", { worldbookId: "a" });
const modB = node("module:b", "module", { worldbookId: "b" });

describe("loose objects", () => {
  it("draws a loose entry as its own block outside the modules, not as a shared row inside them", () => {
    const g = graph([world, modA, modB, node("entry:new", "entry", { trigger: "manual" }), node("entry:old", "entry", { trigger: "manual" })]);
    const blocks = buildBoard(g, { loose: new Set(["entry:new"]) });
    const loose = blocks.find((b) => b.id === blockId.loose("entry:new"))!;
    expect(loose).toBeTruthy();
    expect(loose.loose).toBe(true);
    expect(loose.kind).toBe("lore");
    expect(loose.ownerId).toBeUndefined();
    expect(loose.rows.map((r) => r.g.id)).toEqual(["entry:new"]);
    expect(loose.rows[0]!.shared).toBeUndefined();
    // The old entry is still the card's, shared into both modules; the new one is in neither.
    for (const owner of ["a", "b"]) {
      const lore = blocks.find((b) => b.id === blockId.lore("manual", owner))!;
      expect(lore.rows.map((r) => r.g.id)).toEqual(["entry:old"]);
    }
  });

  it("does the same for a loose variable and a loose behaviour", () => {
    const g = graph([world, modA, node("var:v", "variable"), node("rule:r", "rule")]);
    const blocks = buildBoard(g, { loose: new Set(["var:v", "rule:r"]) });
    expect(blocks.find((b) => b.id === blockId.loose("var:v"))?.kind).toBe("state");
    expect(blocks.find((b) => b.id === blockId.loose("rule:r"))?.kind).toBe("behavior");
    expect(blocks.find((b) => b.id === blockId.state("a"))).toBeUndefined();
    expect(blocks.find((b) => b.id === blockId.behavior("a"))).toBeUndefined();
  });

  it("keeps a loose block out of every frame", () => {
    const g = graph([world, modA, node("entry:new", "entry", { trigger: "manual" })]);
    const blocks = buildBoard(g, { loose: new Set(["entry:new"]) });
    const frames = buildFrames(g, blocks);
    expect(frames.map((f) => f.ownerId)).toEqual(["a"]);
    expect(frames[0]!.blocks.some((b) => b.loose)).toBe(false);
  });

  it("hosts a loose object's wires on its own block", () => {
    const g = graph([world, modA, node("var:v", "variable")]);
    const blocks = buildBoard(g, { loose: new Set(["var:v"]) });
    expect(blockHostsMap(blocks, g).get("var:v")).toEqual([{ host: blockId.loose("var:v"), shown: true }]);
  });

  it("ignores the loose flag on an object that already has a module — placing it is what ends looseness", () => {
    const g = graph([world, modA, { ...node("var:v", "variable"), parentId: "module:a" }]);
    const blocks = buildBoard(g, { loose: new Set(["var:v"]) });
    expect(blocks.find((b) => b.id === blockId.loose("var:v"))).toBeUndefined();
    expect(blocks.find((b) => b.id === blockId.state("a"))!.rows.map((r) => r.g.id)).toEqual(["var:v"]);
  });

  it("is a no-op on a card without modules — there is nowhere to be loose from", () => {
    const g = graph([world, node("var:v", "variable")]);
    const blocks = buildBoard(g, { loose: new Set(["var:v"]) });
    expect(blocks.find((b) => b.id === blockId.loose("var:v"))).toBeUndefined();
    expect(blocks.find((b) => b.id === blockId.state())!.rows.map((r) => r.g.id)).toEqual(["var:v"]);
  });
});
