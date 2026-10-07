import { describe, it, expect } from "vitest";
import { toGraph } from "../compiler.js";
import type { WorldEntry, Worldbook } from "../../types/index.js";

// A just-created entry has no conditions, no binding, nothing pointing at it —
// so the fold rules would swallow it into a summary node the instant it is
// born, and the creator watches their new entry vanish. `pinned` keeps named
// entries materialized: the canvas pins whatever it just created.

function entry(overrides: Partial<WorldEntry> & { id: string }): WorldEntry {
  return {
    name: overrides.id, content: "", role: "lore", alwaysSend: false,
    keywords: [], conditions: [], conditionLogic: "all", enabled: true,
    position: 0, section: "system-presets",
    ...overrides,
  };
}

const B: Worldbook = { id: "B", name: "Big", order: 0, activation: { mode: "always" } };

describe("toGraph — pinned entries", () => {
  it("keeps a pinned relationship-free Core entry out of the core fold", () => {
    const world = {
      variables: [], rules: [],
      entries: [entry({ id: "c1" }), entry({ id: "c2" }), entry({ id: "fresh" })],
    };
    const graph = toGraph(world, { pinnedEntryIds: ["fresh"] });
    expect(graph.nodes.find((n) => n.id === "entry:fresh")).toBeDefined();
    expect(graph.nodes.find((n) => n.id === "core-entries")!.data.count).toBe(2);
  });

  it("keeps a pinned member entry visible inside a folding module", () => {
    const world = {
      variables: [], rules: [],
      entries: [
        ...["b1", "b2", "b3", "b4", "b5"].map((id) => entry({ id, worldbookId: "B" })),
        entry({ id: "fresh", worldbookId: "B" }),
      ],
      worldbooks: [B],
    };
    const graph = toGraph(world, { pinnedEntryIds: ["fresh"] });
    const pinned = graph.nodes.find((n) => n.id === "entry:fresh");
    expect(pinned).toBeDefined();
    expect(pinned!.parentId).toBe("module:B");
    // the five plain siblings still fold, and the pinned one is not counted
    expect(graph.nodes.find((n) => n.id === "module-entries:B")!.data.count).toBe(5);
  });

  it("a pinned entry does not push a module over the fold threshold", () => {
    const world = {
      variables: [], rules: [],
      entries: [
        ...["b1", "b2", "b3", "b4"].map((id) => entry({ id, worldbookId: "B" })),
        entry({ id: "fresh", worldbookId: "B" }),
      ],
      worldbooks: [B],
    };
    const graph = toGraph(world, { pinnedEntryIds: ["fresh"] });
    expect(graph.nodes.find((n) => n.id === "module-entries:B")).toBeUndefined();
    for (const id of ["b1", "b2", "b3", "b4", "fresh"]) {
      expect(graph.nodes.find((n) => n.id === `entry:${id}`)).toBeDefined();
    }
  });

  it("pinning an id that no longer exists is harmless", () => {
    const world = { variables: [], rules: [], entries: [entry({ id: "c1" }), entry({ id: "c2" })] };
    const graph = toGraph(world, { pinnedEntryIds: ["ghost"] });
    expect(graph.nodes.find((n) => n.id === "entry:ghost")).toBeUndefined();
    expect(graph.nodes.find((n) => n.id === "core-entries")!.data.count).toBe(2);
  });

  it("greetings are unaffected by pinning (they never fold)", () => {
    const world = {
      variables: [], rules: [],
      entries: [entry({ id: "g1", role: "greeting" })],
    };
    const graph = toGraph(world, { pinnedEntryIds: ["g1"] });
    expect(graph.nodes.find((n) => n.id === "greeting:g1")).toBeDefined();
  });
});
