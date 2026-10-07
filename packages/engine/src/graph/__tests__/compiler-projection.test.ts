import { describe, it, expect } from "vitest";
import { toGraph } from "../compiler.js";
import type { WorldEntry, Worldbook, Variable } from "../../types/index.js";
import type { Reaction } from "../../events/types.js";

// ── Fixture: a card exercising every module-era relationship ────────
//
//  worldbooks:  B1 (conditions: g == 1)         B2 (greeting: G2)
//  variables:   g (Core)                        v1 (in B1)
//  entries:     E1 (in B1, gated by v1, bound to LoreSlot "codex")
//               E2 (Core, no relationships → folded into the summary node)
//               E3 (Core, gated by g → free node)
//  greetings:   G1 (Core, seeds g = 1)          G2 (Core, activates B2)
//  reactions:   R1 (in B1, turn:complete → v1 = 1)

const g: Variable = { id: "g", name: "g", type: "number", defaultValue: 0 };
const v1: Variable = { id: "v1", name: "v1", type: "number", defaultValue: 0, worldbookId: "B1" };

const B1: Worldbook = {
  id: "B1", name: "Kingdom", order: 0,
  activation: { mode: "conditions", conditions: [{ variableId: "g", operator: "eq", value: 1 }], conditionLogic: "all" },
};
const B2: Worldbook = { id: "B2", name: "Empire", order: 1, activation: { mode: "greeting", greetingIds: ["G2"] } };

function entry(overrides: Partial<WorldEntry> & { id: string }): WorldEntry {
  return {
    name: overrides.id, content: "", role: "lore", alwaysSend: false,
    keywords: [], conditions: [], conditionLogic: "all", enabled: true,
    position: 0, section: "system-presets",
    ...overrides,
  };
}

const E1 = entry({ id: "E1", worldbookId: "B1", conditions: [{ variableId: "v1", operator: "gte", value: 5 }] });
const E2 = entry({ id: "E2" });
const E3 = entry({ id: "E3", conditions: [{ variableId: "g", operator: "eq", value: 1 }] });
const G1 = entry({ id: "G1", role: "greeting", initialVariables: { g: 1 } });
const G2 = entry({ id: "G2", role: "greeting" });

const R1: Reaction = {
  id: "R1", name: "R1", when: { eventType: "turn:complete" },
  conditions: [], conditionLogic: "all",
  then: [{ type: "set", path: "v1", value: 1, operation: "set" }],
  priority: 0, enabled: true, worldbookId: "B1",
};

const world = {
  variables: [g, v1],
  rules: [],
  reactions: [R1],
  entries: [E1, E2, E3, G1, G2],
  worldbooks: [B1, B2],
  loreUiBindings: [{ slotId: "codex", entryId: "E1", conditions: [], conditionLogic: "all" as const }],
};

const graph = toGraph(world);
const node = (id: string) => graph.nodes.find((n) => n.id === id);
const edge = (from: string, to: string) => graph.edges.filter((e) => e.from === from && e.to === to);

describe("toGraph — module projection", () => {
  it("projects each worldbook as a module node", () => {
    expect(node("module:B1")?.kind).toBe("module");
    expect(node("module:B1")?.title).toBe("Kingdom");
    expect(node("module:B2")?.kind).toBe("module");
  });

  it("parents member variables/entries/reactions under their module node", () => {
    expect(node("var:v1")?.parentId).toBe("module:B1");
    expect(node("entry:E1")?.parentId).toBe("module:B1");
    expect(node("reaction:R1")?.parentId).toBe("module:B1");
    expect(node("var:g")?.parentId).toBeUndefined();
  });

  it("wires activation conditions as variable → module edges", () => {
    const [e] = edge("var:g", "module:B1");
    expect(e).toBeDefined();
    expect(e!.label).toContain("=");
  });

  it("wires greeting-mode activation as greeting → module edges", () => {
    expect(edge("greeting:G2", "module:B2")).toHaveLength(1);
  });

  it("projects greetings as greeting nodes and initialVariables as greeting → variable edges", () => {
    expect(node("greeting:G1")?.kind).toBe("greeting");
    const [e] = edge("greeting:G1", "var:g");
    expect(e).toBeDefined();
    expect(e!.label).toContain("1");
  });

  it("wires entry conditions as variable → entry edges", () => {
    expect(edge("var:v1", "entry:E1")).toHaveLength(1);
    expect(edge("var:g", "entry:E3")).toHaveLength(1);
  });

  it("projects the frontend as one component node with a port per LoreSlot, wired from bound entries", () => {
    const fe = node("frontend");
    expect(fe?.kind).toBe("component");
    expect(fe?.ports.some((p) => p.id === "slot:codex" && p.direction === "in")).toBe(true);
    expect(edge("entry:E1", "frontend")).toHaveLength(1);
  });

  it("exposes LoreSlots scanned from rootComponent TSX as frontend ports even before any binding exists", () => {
    const g2 = toGraph({
      variables: [], rules: [],
      rootComponent: {
        id: "rc", name: "App", entryFile: "index.tsx", updatedAt: "",
        files: { "index.tsx": `<LoreButton slotId="secret-map">Open</LoreButton>` },
      },
    });
    const fe = g2.nodes.find((n) => n.id === "frontend");
    expect(fe?.ports.some((p) => p.id === "slot:secret-map" && p.direction === "in")).toBe(true);
  });

  it("folds relationship-free Core entries into a summary node instead of one node each", () => {
    expect(node("entry:E2")).toBeUndefined();
    const summary = node("core-entries");
    expect(summary).toBeDefined();
    expect(summary!.data.count).toBe(1);
  });

  it("keeps Core entries with conditions as free entry nodes", () => {
    expect(node("entry:E3")).toBeDefined();
    expect(node("entry:E3")?.parentId).toBeUndefined();
  });

  it("projects reactions like rules: event source in, set-effect out", () => {
    expect(edge("evt:turn:complete", "reaction:R1")).toHaveLength(1);
    const [e] = edge("reaction:R1", "var:v1");
    expect(e).toBeDefined();
    expect(e!.label).toBe("set");
  });

  it("keeps every edge endpoint resolvable to a projected node", () => {
    const ids = new Set(graph.nodes.map((n) => n.id));
    for (const e of graph.edges) {
      expect(ids.has(e.from), `missing from-node ${e.from}`).toBe(true);
      expect(ids.has(e.to), `missing to-node ${e.to}`).toBe(true);
    }
  });
});
