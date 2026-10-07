import { describe, it, expect } from "vitest";
import { blockHostMap, blockId, buildBoard, buildFrames } from "../board.js";
import type { CardGraph, GraphNode } from "../types.js";

// The card as the root module: with `cardFrame` the card keeps a frame of its
// own beside its modules, its objects are rows THERE, and each module carries
// them as a count in the block's header rather than as rows of its own —
// five shared entries redrawn in every module doubled the height of each.

const node = (id: string, kind: GraphNode["kind"], data: Record<string, unknown> = {}): GraphNode => ({
  id,
  kind,
  title: id,
  ports: [],
  data,
});
const member = (id: string, kind: GraphNode["kind"], moduleId: string, data: Record<string, unknown> = {}): GraphNode => ({
  ...node(id, kind, data),
  parentId: `module:${moduleId}`,
});
const graph = (nodes: GraphNode[], edges: CardGraph["edges"] = []): CardGraph => ({ nodes, edges });

const world = node("world:root", "world");
const modA = node("module:a", "module", { worldbookId: "a" });
const modB = node("module:b", "module", { worldbookId: "b" });

describe("the card as the root module", () => {
  it("draws a core entry as a row on the card and as a count in each module", () => {
    const blocks = buildBoard(
      graph([world, node("entry:lore", "entry", { trigger: "always" }), member("entry:own", "entry", "a", { trigger: "always" }), modA, modB]),
      { cardFrame: true },
    );
    const onCard = blocks.find((b) => b.id === blockId.lore("always"))!;
    expect(onCard.rows.map((r) => r.g.id)).toEqual(["entry:lore"]);
    expect(onCard.sharedCount).toBe(0);
    const inA = blocks.find((b) => b.id === blockId.lore("always", "a"))!;
    expect(inA.rows.map((r) => r.g.id)).toEqual(["entry:own"]);
    expect(inA.sharedCount).toBe(1);
    expect(inA.total).toBe(2);
    expect(inA.hiddenCount).toBe(0);
    // A module with nothing of its own still says what it counts.
    const inB = blocks.find((b) => b.id === blockId.lore("always", "b"))!;
    expect(inB.rows).toEqual([]);
    expect(inB.sharedCount).toBe(1);
  });

  it("keeps the card's face, openings and interface on the card's own frame, first", () => {
    const blocks = buildBoard(
      graph([world, node("greeting:g", "greeting"), node("frontend", "component"), node("var:hp", "variable"), modA]),
      { cardFrame: true },
    );
    const frames = buildFrames(graph([world, node("greeting:g", "greeting"), node("frontend", "component"), node("var:hp", "variable"), modA]), blocks, true);
    expect(frames[0]!.id).toBe(blockId.frame(null));
    expect(frames[0]!.strip).toBe(false);
    const cardIds = frames[0]!.blocks.map((b) => b.id);
    expect(cardIds).toContain(blockId.card);
    expect(cardIds).toContain(blockId.opening("g"));
    expect(cardIds).toContain(blockId.frontend);
    expect(cardIds).toContain(blockId.state());
    expect(frames[1]!.id).toBe(blockId.frame("a"));
  });

  it("hosts a core object on the card's block first, so its wires land on the row that is drawn", () => {
    const g = graph([world, node("var:hp", "variable"), modA, modB]);
    const blocks = buildBoard(g, { cardFrame: true });
    expect(blockHostMap(blocks, g).get("var:hp")).toEqual({ host: blockId.state(), shown: true });
  });

  it("changes nothing without the flag", () => {
    const g = graph([world, node("entry:lore", "entry", { trigger: "always" }), modA]);
    const blocks = buildBoard(g);
    expect(blocks.find((b) => b.id === blockId.lore("always"))).toBeUndefined();
    expect(blocks.find((b) => b.id === blockId.lore("always", "a"))!.rows[0]!.shared).toBe(true);
    expect(buildFrames(g, blocks)[0]!.id).toBe(blockId.frame("a"));
  });
});

describe("scene images on the board", () => {
  it("lists the card's images as rows on the card and as a count in every module", () => {
    const blocks = buildBoard(
      graph([world, modA, node("image:img1", "image", { sceneImageId: "img1", url: "@asset:x", scene: "a cat jumps" }), node("image:img2", "image")]),
      { cardFrame: true },
    );
    const onCard = blocks.find((b) => b.id === blockId.image())!;
    expect(onCard.kind).toBe("image");
    expect(onCard.rows.map((r) => r.g.id)).toEqual(["image:img1", "image:img2"]);
    expect(onCard.sharedCount).toBe(0);
    const inA = blocks.find((b) => b.id === blockId.image("a"))!;
    expect(inA.rows).toEqual([]);
    expect(inA.sharedCount).toBe(2);
    expect(inA.total).toBe(2);
  });

  it("draws no image block on a card without scene images", () => {
    const blocks = buildBoard(graph([world, node("var:hp", "variable")]), { cardFrame: true });
    expect(blocks.some((b) => b.kind === "image")).toBe(false);
  });
});

