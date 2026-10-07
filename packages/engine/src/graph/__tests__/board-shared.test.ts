import { describe, it, expect } from "vitest";
import {
  blockHostMap,
  blockHostsMap,
  blockId,
  blockIdForNode,
  buildBoard,
  buildFrames,
} from "../board.js";
import type { CardGraph, GraphNode } from "../types.js";

// The card's own objects — the ones with no module — are not a fifth module
// called "the card". Every module's AI receives them on every turn, so the
// board draws them INSIDE every module, as the same object each time. What
// the card keeps to itself is what only exists once: its face, its openings,
// its interface.

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

describe("the card's objects live inside every module", () => {
  it("draws a core entry as a shared row in each module's lore block, and not on the card", () => {
    const blocks = buildBoard(
      graph([world, node("entry:lore", "entry", { trigger: "always" }), modA, modB]),
    );
    const inA = blocks.find((b) => b.id === blockId.lore("always", "a"))!;
    const inB = blocks.find((b) => b.id === blockId.lore("always", "b"))!;
    expect(inA.rows.map((r) => r.g.id)).toEqual(["entry:lore"]);
    expect(inB.rows.map((r) => r.g.id)).toEqual(["entry:lore"]);
    expect(inA.rows[0]!.shared).toBe(true);
    expect(blocks.find((b) => b.id === blockId.lore("always"))).toBeUndefined();
  });

  it("does the same for core variables and behaviours", () => {
    const blocks = buildBoard(graph([world, node("var:hp", "variable"), node("rule:r", "rule"), modA]));
    expect(blocks.find((b) => b.id === blockId.state("a"))!.rows.map((r) => r.g.id)).toEqual(["var:hp"]);
    expect(blocks.find((b) => b.id === blockId.behavior("a"))!.rows.map((r) => r.g.id)).toEqual(["rule:r"]);
    expect(blocks.find((b) => b.id === blockId.state())).toBeUndefined();
    expect(blocks.find((b) => b.id === blockId.behavior())).toBeUndefined();
  });

  it("keeps shared and own rows in projection order — the order the prompt sends", () => {
    const blocks = buildBoard(
      graph([
        world,
        modA,
        node("entry:one", "entry", { trigger: "always" }),
        member("entry:two", "entry", "a", { trigger: "always" }),
        node("entry:three", "entry", { trigger: "always" }),
      ]),
    );
    const inA = blocks.find((b) => b.id === blockId.lore("always", "a"))!;
    expect(inA.rows.map((r) => [r.g.id, r.shared ?? false])).toEqual([
      ["entry:one", true],
      ["entry:two", false],
      ["entry:three", true],
    ]);
  });

  it("counts shared rows apart from the module's own", () => {
    const blocks = buildBoard(
      graph([world, modA, node("var:shared", "variable"), member("var:own", "variable", "a")]),
    );
    const state = blocks.find((b) => b.id === blockId.state("a"))!;
    expect(state.total).toBe(2);
    expect(state.sharedCount).toBe(1);
  });

  it("marks nothing shared on a card with no modules — there is nobody to share with", () => {
    const blocks = buildBoard(graph([world, node("entry:lore", "entry", { trigger: "always" })]));
    const lore = blocks.find((b) => b.id === blockId.lore("always"))!;
    expect(lore.rows[0]!.shared).toBeUndefined();
    expect(lore.sharedCount).toBe(0);
  });

  it("keeps nothing on the card once it has modules: openings, audio and the interface are in every module too", () => {
    const blocks = buildBoard(
      graph([world, modA, modB, node("greeting:g", "greeting"), node("component:root", "component"), node("audio:bgm", "audio")]),
    );
    expect(blocks.some((b) => !b.ownerId)).toBe(false);
    expect(blocks.filter((b) => b.ownerId === "a").map((b) => b.kind)).toEqual(["opening", "scene", "context", "audio"]);
    // Openings are a list of shared rows in each module — the same opening,
    // drawn where the player will read it from.
    const openings = blocks.find((b) => b.id === blockId.openings("b"))!;
    expect(openings.head).toBeUndefined();
    expect(openings.rows.map((r) => [r.g.id, r.shared])).toEqual([["greeting:g", true]]);
    expect(openings.sharedCount).toBe(1);
    // Audio the same way.
    expect(blocks.find((b) => b.id === blockId.audio("b"))!.rows[0]!.shared).toBe(true);
    // The one interface is the head of every module's scene block, so its
    // variable ports are there to wire to.
    const scene = blocks.find((b) => b.id === blockId.scene("b"))!;
    expect(scene.head?.id).toBe("component:root");
    expect(scene.total).toBe(1);
  });

  it("keeps the card's own opening and interface blocks when there are no modules", () => {
    const blocks = buildBoard(graph([world, node("greeting:g", "greeting"), node("component:root", "component")]));
    expect(blocks.map((b) => b.kind)).toEqual(["card", "background", "opening", "frontend"]);
    expect(blocks.find((b) => b.kind === "opening")!.head?.id).toBe("greeting:g");
  });

  it("gives a module a scene block only when the card has a frontend", () => {
    const without = buildBoard(graph([world, modA, node("var:hp", "variable")]));
    expect(without.some((b) => b.kind === "scene")).toBe(false);
    const withFe = buildBoard(graph([world, modA, node("component:root", "component")]));
    expect(withFe.find((b) => b.kind === "scene")?.id).toBe(blockId.scene("a"));
  });

  it("gives the card no context block of its own — every module already says what it remembers", () => {
    const blocks = buildBoard(graph([world, node("var:hp", "variable"), modA]));
    expect(blocks.find((b) => b.id === blockId.context())).toBeUndefined();
    expect(blocks.find((b) => b.id === blockId.context("a"))).toBeTruthy();
  });

  it("folds each module's block on its own — a row can be shown in one module and folded in another", () => {
    // Module A is crowded with its own variables; module B holds nothing but
    // the shared one. The fold is per block, so the shared row is on screen
    // in B whatever A does with it.
    const crowd = Array.from({ length: 12 }, (_, i) => member(`var:a${i}`, "variable", "a"));
    const g = graph([world, modA, modB, ...crowd, node("var:shared", "variable")]);
    const blocks = buildBoard(g);
    const inA = blocks.find((b) => b.id === blockId.state("a"))!;
    const inB = blocks.find((b) => b.id === blockId.state("b"))!;
    expect(inA.rows.some((r) => r.g.id === "var:shared")).toBe(false);
    expect(inA.hiddenCount).toBeGreaterThan(0);
    expect(inB.rows.map((r) => r.g.id)).toEqual(["var:shared"]);
  });
});

describe("frames on a card with modules", () => {
  it("draws only the modules — the card is not a frame — and counts each module's own and shared members", () => {
    const g = graph([world, modA, node("var:shared", "variable"), member("var:own", "variable", "a"), node("greeting:g", "greeting")]);
    const frames = buildFrames(g, buildBoard(g));
    expect(frames.map((f) => f.ownerId)).toEqual(["a"]);
    const a = frames[0]!;
    expect(a.own).toBe(1);
    expect(a.shared).toBe(2);
    expect(a.total).toBe(3);
  });

  it("still gives an orphaned block somewhere to be seen: a strip, only when one exists", () => {
    // A block whose module vanished mid-edit must not disappear.
    const g = graph([world, modA]);
    const orphan = { ...buildBoard(g)[0]!, id: "block:m:gone:state", ownerId: "gone", kind: "state" as const };
    const frames = buildFrames(g, [orphan]);
    expect(frames.map((f) => [f.ownerId, f.strip])).toEqual([[null, true], ["a", false]]);
    expect(frames[0]!.blocks).toEqual([orphan]);
  });

  it("keeps the card a real frame when there are no modules", () => {
    const g = graph([world, node("var:v", "variable")]);
    const frames = buildFrames(g, buildBoard(g));
    expect(frames[0]!.strip).toBe(false);
    expect(frames[0]!.shared).toBe(0);
    expect(frames[0]!.own).toBe(frames[0]!.total);
  });
});

describe("one object, several hosts", () => {
  it("anchors a shared row in every module frame it is drawn in, naming the frame", () => {
    const g = graph([world, modA, modB, node("var:shared", "variable")]);
    const hosts = blockHostsMap(buildBoard(g), g);
    expect(hosts.get("var:shared")).toEqual([
      { host: blockId.state("a"), shown: true, ownerId: "a" },
      { host: blockId.state("b"), shown: true, ownerId: "b" },
    ]);
  });

  it("reports the fold per frame", () => {
    const crowd = Array.from({ length: 12 }, (_, i) => member(`var:a${i}`, "variable", "a"));
    const g = graph([world, modA, modB, ...crowd, node("var:shared", "variable")]);
    const hosts = blockHostsMap(buildBoard(g), g);
    const byOwner = new Map(hosts.get("var:shared")!.map((h) => [h.ownerId, h.shown]));
    expect(byOwner.get("a")).toBe(false);
    expect(byOwner.get("b")).toBe(true);
  });

  it("gives a core event source a hidden host in every module's behaviour block", () => {
    // An event is never a row, but its wire still needs an anchor — and with
    // the card's behaviour block gone, that anchor is in each module.
    const g = graph([world, modA, modB, node("rule:r", "rule"), node("event:turn", "event")]);
    const hosts = blockHostsMap(buildBoard(g), g);
    expect(hosts.get("event:turn")!.map((h) => [h.host, h.shown])).toEqual([
      [blockId.behavior("a"), false],
      [blockId.behavior("b"), false],
    ]);
  });

  it("still answers with the first host for callers that want one", () => {
    const g = graph([world, modA, modB, node("var:shared", "variable")]);
    expect(blockHostMap(buildBoard(g), g).get("var:shared")).toEqual({
      host: blockId.state("a"),
      shown: true,
      ownerId: "a",
    });
  });

  it("names a core object's block inside a given module", () => {
    expect(blockIdForNode(node("entry:x", "entry", { trigger: "always" }), "a")).toBe(blockId.lore("always", "a"));
    expect(blockIdForNode(node("var:x", "variable"), "b")).toBe(blockId.state("b"));
    // A module's own object is not re-homed by asking.
    expect(blockIdForNode(member("var:y", "variable", "a"), "b")).toBe(blockId.state("a"));
    // Inside a module the interface is that module's scene block, an opening
    // a row of its openings block; asked without a module they are the card's.
    expect(blockIdForNode(node("component:root", "component"), "a")).toBe(blockId.scene("a"));
    expect(blockIdForNode(node("component:root", "component"))).toBe(blockId.frontend);
    expect(blockIdForNode(node("greeting:g", "greeting"), "a")).toBe(blockId.openings("a"));
    expect(blockIdForNode(node("greeting:g", "greeting"))).toBe(blockId.opening("g"));
    expect(blockIdForNode(node("audio:t", "audio"), "a")).toBe(blockId.audio("a"));
  });

  it("anchors the card's opening, audio and interface in every module", () => {
    const g = graph([world, modA, modB, node("greeting:g", "greeting"), node("audio:t", "audio"), node("component:root", "component")]);
    const hosts = blockHostsMap(buildBoard(g), g);
    expect(hosts.get("greeting:g")!.map((h) => [h.host, h.shown])).toEqual([
      [blockId.openings("a"), true],
      [blockId.openings("b"), true],
    ]);
    expect(hosts.get("audio:t")!.map((h) => h.host)).toEqual([blockId.audio("a"), blockId.audio("b")]);
    expect(hosts.get("component:root")!.map((h) => [h.host, h.shown])).toEqual([
      [blockId.scene("a"), true],
      [blockId.scene("b"), true],
    ]);
  });
});
