import { describe, it, expect } from "vitest";
import {
  BLOCK_ROW_LIMIT,
  blockHostMap,
  blockId,
  blockIdForNode,
  buildBoard,
  buildFrames,
  entryTrigger,
  frameIdForNode,
  parseRowHandle,
  rowHandleId,
} from "../board.js";
import type { CardGraph, GraphNode } from "../types.js";

const node = (id: string, kind: GraphNode["kind"], data: Record<string, unknown> = {}): GraphNode => ({
  id,
  kind,
  title: id,
  ports: [],
  data,
});

const graph = (nodes: GraphNode[], edges: CardGraph["edges"] = []): CardGraph => ({ nodes, edges });

describe("entryTrigger", () => {
  it("reads the persisted shape rather than trusting a type union", () => {
    expect(entryTrigger({ alwaysSend: true, keywords: ["x"] })).toBe("always");
    expect(entryTrigger({ conditions: [{}] })).toBe("conditions");
    expect(entryTrigger({ keywords: ["x"] })).toBe("keywords");
    expect(entryTrigger({})).toBe("manual");
    // Imports and older builds hand us nulls where the type promises arrays.
    expect(entryTrigger({ keywords: null, conditions: null })).toBe("manual");
  });
});

describe("buildBoard", () => {
  it("gives a bare card only the two blocks every card has — not five stations, three of them empty", () => {
    // The face and its background. Both are the card's own picture, both are
    // drawn at zero on purpose: a slot a creator can see is a slot they can
    // fill. Everything else still has to earn its block by having content.
    const blocks = buildBoard(graph([node("world:root", "world")]));
    expect(blocks.map((b) => b.id)).toEqual([blockId.card, blockId.background]);
  });

  it("omits every block that has nothing in it", () => {
    const blocks = buildBoard(
      graph([
        node("world:root", "world"),
        node("greeting:g1", "greeting"),
        node("entry:e1", "entry", { trigger: "always" }),
      ]),
    );
    expect(blocks.map((b) => b.kind)).toEqual(["card", "background", "opening", "lore"]);
    expect(blocks.some((b) => b.kind === "state")).toBe(false);
    expect(blocks.some((b) => b.kind === "behavior")).toBe(false);
    expect(blocks.some((b) => b.kind === "frontend")).toBe(false);
  });

  it("gives every opening its own block", () => {
    const blocks = buildBoard(
      graph([node("world:root", "world"), node("greeting:a", "greeting"), node("greeting:b", "greeting")]),
    );
    const openings = blocks.filter((b) => b.kind === "opening");
    expect(openings.map((b) => b.id)).toEqual([blockId.opening("a"), blockId.opening("b")]);
    expect(openings.every((b) => b.head)).toBe(true);
  });

  it("groups entries by how they reach the prompt", () => {
    const blocks = buildBoard(
      graph([
        node("world:root", "world"),
        node("entry:a", "entry", { trigger: "always" }),
        node("entry:b", "entry", { trigger: "keywords" }),
        node("entry:c", "entry", { trigger: "always" }),
      ]),
    );
    const lore = blocks.filter((b) => b.kind === "lore");
    expect(lore.map((b) => b.trigger)).toEqual(["always", "keywords"]);
    expect(lore[0]!.total).toBe(2);
    expect(lore[1]!.total).toBe(1);
  });

  it("treats an unclassified entry as manual rather than dropping it", () => {
    const blocks = buildBoard(graph([node("world:root", "world"), node("entry:x", "entry")]));
    const lore = blocks.find((b) => b.kind === "lore");
    expect(lore?.trigger).toBe("manual");
    expect(lore?.rows).toHaveLength(1);
  });

  it("folds a long list but never folds a row that carries a wire", () => {
    const many = Array.from({ length: BLOCK_ROW_LIMIT.lore + 6 }, (_, i) =>
      node(`entry:e${i}`, "entry", { trigger: "always" }),
    );
    const wiredId = `entry:e${many.length - 1}`; // last in the list, would fold on order alone
    const g = graph([node("world:root", "world"), ...many], [
      { id: "w", from: "var:v", fromPort: "read", to: wiredId, toPort: "gate" },
    ]);
    const lore = buildBoard(g).find((b) => b.kind === "lore")!;
    expect(lore.rows.length).toBe(BLOCK_ROW_LIMIT.lore);
    expect(lore.hiddenCount).toBe(many.length - BLOCK_ROW_LIMIT.lore);
    expect(lore.rows.some((r) => r.g.id === wiredId)).toBe(true);
  });

  it("keeps a forced row on screen and shows every row once expanded", () => {
    const many = Array.from({ length: 20 }, (_, i) => node(`var:v${i}`, "variable"));
    const g = graph([node("world:root", "world"), ...many]);
    const forced = buildBoard(g, { forced: new Set(["var:v19"]) }).find((b) => b.kind === "state")!;
    expect(forced.rows.some((r) => r.g.id === "var:v19")).toBe(true);

    const expanded = buildBoard(g, { expanded: new Set([blockId.state()]) }).find((b) => b.kind === "state")!;
    expect(expanded.rows).toHaveLength(20);
    expect(expanded.hiddenCount).toBe(0);
  });

  it("prefers the caller's nominations over plain rows when there is room", () => {
    const many = Array.from({ length: 20 }, (_, i) => node(`var:v${i}`, "variable"));
    const block = buildBoard(graph([node("world:root", "world"), ...many]), {
      preferred: new Set(["var:v18"]),
    }).find((b) => b.kind === "state")!;
    expect(block.rows.some((r) => r.g.id === "var:v18")).toBe(true);
  });

  it("never reorders rows — a row that gains a wire keeps its place", () => {
    const g = graph(
      [node("world:root", "world"), node("var:a", "variable"), node("var:b", "variable"), node("var:c", "variable")],
      [{ id: "w", from: "var:c", fromPort: "read", to: "var:a", toPort: "write" }],
    );
    const block = buildBoard(g).find((b) => b.kind === "state")!;
    expect(block.rows.map((r) => r.g.id)).toEqual(["var:a", "var:b", "var:c"]);
  });

  it("keeps event sources out of the rows — a trigger is not an object", () => {
    // An event source is a projection, not something the creator made. On its
    // own the row said nothing; the behaviour it fires carries the name.
    const g = graph(
      [node("world:root", "world"), node("reaction:r", "rule"), node("evt:turn", "event")],
      [{ id: "e", from: "evt:turn", fromPort: "fires", to: "reaction:r", toPort: "trigger" }],
    );
    const behavior = buildBoard(g).find((b) => b.kind === "behavior")!;
    expect(behavior.rows.map((r) => r.g.id)).toEqual(["reaction:r"]);
    expect(behavior.total).toBe(1);

    // It still needs somewhere to anchor, or its wire has a dangling end.
    const hosts = blockHostMap(buildBoard(g), g);
    expect(hosts.get("evt:turn")).toEqual({ host: blockId.behavior(), shown: false });
  });

  it("carries the frontend's LoreSlots on the block head, individually addressable", () => {
    const frontend: GraphNode = {
      id: "frontend",
      kind: "component",
      title: "UI",
      ports: [
        { id: "slot:intro", type: "entry", direction: "in", label: "Intro" },
        { id: "read:v1", type: "state", direction: "in" },
      ],
      data: {},
    };
    const block = buildBoard(graph([node("world:root", "world"), frontend])).find((b) => b.kind === "frontend")!;
    expect(block.headSlots).toEqual([{ portId: "slot:intro", label: "Intro" }]);
    expect(block.rows).toHaveLength(0);
  });

  it("leaves modules out of the blocks — a gate is not a station", () => {
    const blocks = buildBoard(graph([node("world:root", "world"), node("module:m", "module")]));
    // The module contributes no LIST block of its own; the one context block
    // is the module's memory. The card gets nothing at all — with modules on
    // the board there are only the modules.
    expect(blocks.map((b) => b.id)).toEqual([blockId.context("m")]);
    expect(blockIdForNode(node("module:m", "module"))).toBeNull();
  });
});

describe("blockHostMap", () => {
  it("anchors a folded row on its block so its wires are never dropped", () => {
    const many = Array.from({ length: BLOCK_ROW_LIMIT.state + 5 }, (_, i) => node(`var:v${i}`, "variable"));
    const g = graph([node("world:root", "world"), ...many]);
    const blocks = buildBoard(g);
    const hosts = blockHostMap(blocks, g);

    const shownRow = blocks.find((b) => b.kind === "state")!.rows[0]!.g.id;
    expect(hosts.get(shownRow)).toEqual({ host: blockId.state(), shown: true });

    const foldedId = `var:v${many.length - 1}`;
    expect(hosts.get(foldedId)).toEqual({ host: blockId.state(), shown: false });
  });

  it("refuses to anchor an object whose block is not on the canvas", () => {
    // A projection can hand us a node whose block produced no rows at all
    // (nothing does today) — pointing a wire at a node that does not exist
    // would leave React Flow drawing to nowhere.
    const g = graph([node("world:root", "world")]);
    const hosts = blockHostMap(buildBoard(g), graph([node("world:root", "world"), node("var:orphan", "variable")]));
    expect(hosts.has("var:orphan")).toBe(false);
  });
});

describe("row handles", () => {
  it("round-trip the object id, so the write-back contract is unchanged", () => {
    expect(parseRowHandle(rowHandleId("var:abc", "out"))).toEqual({ objId: "var:abc" });
    expect(parseRowHandle("frontend@slot:intro")).toEqual({ objId: "frontend", port: "slot:intro" });
    expect(parseRowHandle(null)).toBeNull();
    expect(parseRowHandle("@out")).toBeNull();
  });
});


// ── frames: a module is a complete thing ──

/** A member node that lives inside a module. */
const member = (id: string, kind: GraphNode["kind"], moduleId: string, data: Record<string, unknown> = {}): GraphNode => ({
  id,
  kind,
  title: id,
  ports: [],
  parentId: `module:${moduleId}`,
  data,
});

describe("a module is a complete thing, not a label on scattered rows", () => {
  const world = node("world:root", "world");
  const mod = node("module:d1", "module", { worldbookId: "d1" });

  it("puts a module's own lore, variables and behaviours in its own blocks", () => {
    const blocks = buildBoard(
      graph([
        world,
        mod,
        member("entry:a", "entry", "d1", { trigger: "always" }),
        member("var:hp", "variable", "d1"),
        member("rule:r", "rule", "d1"),
      ]),
    );
    // Not "block:lore:always" — that address belongs to the CARD's always-on
    // lore, and a module's entries are not the card's.
    expect(blocks.map((b) => b.id)).toContain(blockId.lore("always", "d1"));
    expect(blocks.map((b) => b.id)).toContain(blockId.state("d1"));
    expect(blocks.map((b) => b.id)).toContain(blockId.behavior("d1"));
    for (const b of blocks.filter((x) => x.id.startsWith("block:m:"))) {
      expect(b.ownerId).toBe("d1");
    }
  });

  it("keeps a module's own rows out of every other module — only the card's are shared", () => {
    const blocks = buildBoard(
      graph([
        world,
        mod,
        node("module:d2", "module", { worldbookId: "d2" }),
        node("var:global", "variable"),
        member("var:private", "variable", "d1"),
      ]),
    );
    const d1 = blocks.find((b) => b.id === blockId.state("d1"))!;
    const d2 = blocks.find((b) => b.id === blockId.state("d2"))!;
    expect(d1.rows.map((r) => r.g.id)).toEqual(["var:global", "var:private"]);
    expect(d2.rows.map((r) => r.g.id)).toEqual(["var:global"]);
    expect(blocks.find((b) => b.id === blockId.state())).toBeUndefined();
  });

  it("addresses a folded row inside its own module, not the card's list", () => {
    // Getting this wrong re-anchors a folded row's wires onto a block in
    // somebody else's module.
    expect(blockIdForNode(member("var:x", "variable", "d1"))).toBe(blockId.state("d1"));
    expect(blockIdForNode(node("var:y", "variable"))).toBe(blockId.state());
  });

  it("puts the one frontend at the head of every module's scene block", () => {
    // One frontend per card; with modules it is not a block of its own but
    // the face of each module.
    const blocks = buildBoard(graph([world, mod, node("component:root", "component")]));
    expect(blocks.find((b) => b.kind === "frontend")).toBeUndefined();
    const scene = blocks.find((b) => b.kind === "scene")!;
    expect(scene.ownerId).toBe("d1");
    expect(scene.head?.id).toBe("component:root");
  });
});

describe("buildFrames", () => {
  const world = node("world:root", "world");
  const d1 = node("module:d1", "module", { worldbookId: "d1" });
  const d2 = node("module:d2", "module", { worldbookId: "d2" });

  it("gives every module a frame of its own, and the card none", () => {
    const g = graph([world, d1, d2, member("var:a", "variable", "d1")]);
    const frames = buildFrames(g, buildBoard(g));
    expect(frames.map((f) => f.ownerId)).toEqual(["d1", "d2"]);
    expect(frames[0]!.total).toBe(1);
  });

  it("keeps an empty module's frame — it is where things go", () => {
    // Hiding an empty module hides the place to put things, which is exactly
    // what a creator opening a fresh module is trying to do.
    const g = graph([world, d2]);
    const frames = buildFrames(g, buildBoard(g));
    expect(frames.find((f) => f.ownerId === "d2")).toBeTruthy();
    expect(frames.find((f) => f.ownerId === "d2")!.total).toBe(0);
  });

  it("lands an orphaned block on the card rather than dropping it", () => {
    // A module deleted mid-edit leaves members pointing at nothing. An orphan
    // you can see is one you can re-home.
    const g = graph([world, member("var:lost", "variable", "gone")]);
    const frames = buildFrames(g, buildBoard(g));
    const ids = frames.flatMap((f) => f.blocks.flatMap((b) => b.rows.map((r) => r.g.id)));
    expect(ids).toContain("var:lost");
    expect(frames).toHaveLength(1);
  });

  it("names the frame an object belongs to", () => {
    expect(frameIdForNode(member("entry:a", "entry", "d1"))).toBe(blockId.frame("d1"));
    expect(frameIdForNode(node("entry:b", "entry"))).toBe(blockId.frame(null));
  });

  it("makes a module's frame BE the module node", () => {
    // Spelled literally, because both sides of the assertion above go through
    // blockId.frame and would agree on a wrong answer. Every activation and
    // context wire already points at `module:<id>`; giving the frame its own
    // id drops all of them off the canvas without an error anywhere.
    expect(blockId.frame("d1")).toBe("module:d1");
    expect(blockId.frame(null)).toBe("frame:card");
  });
});

describe("context block", () => {
  const world = node("world:root", "world");
  const mod = (id: string) => node(`module:${id}`, "module", { worldbookId: id, activationMode: "always" });
  const inMod = (id: string, kind: GraphNode["kind"], owner: string) => ({ ...node(id, kind), parentId: `module:${owner}` });

  it("is absent on a card with no modules — one AI, one memory, nothing to say", () => {
    const blocks = buildBoard(graph([world, node("var:hp", "variable")]));
    expect(blocks.some((b) => b.kind === "context")).toBe(false);
  });

  it("appears in every module frame, empty module included", () => {
    const blocks = buildBoard(graph([world, mod("a"), mod("b"), inMod("var:x", "variable", "a")]));
    expect(blocks.filter((b) => b.kind === "context").map((b) => b.id)).toEqual([
      blockId.context("a"),
      blockId.context("b"),
    ]);
  });

  it("gives the card none even once a module exists — the card is a strip beside the modules, not a frame", () => {
    const blocks = buildBoard(graph([world, node("var:hp", "variable"), mod("a")]));
    expect(blocks.some((b) => b.id === blockId.context())).toBe(false);
  });

  it("counts for nothing: a frame's member total is its objects, not its memory", () => {
    const blocks = buildBoard(graph([world, mod("a"), inMod("var:x", "variable", "a")]));
    const frames = buildFrames(graph([world, mod("a"), inMod("var:x", "variable", "a")]), blocks);
    expect(frames.find((f) => f.ownerId === "a")!.total).toBe(1);
  });

  it("hosts nothing — no object lives in it, so no wire can anchor to it", () => {
    const g = graph([world, mod("a"), inMod("var:x", "variable", "a")]);
    const host = blockHostMap(buildBoard(g), g);
    expect([...host.values()].some((h) => h.host === blockId.context("a"))).toBe(false);
  });
});
