import { describe, it, expect } from "vitest";
import { toGraph, applyGraphEdit } from "../compiler.js";
import type { WorldDefinition, WorldEntry, Variable } from "../../types/index.js";

// Opening-seed edges must stay editable for legacy cards whose
// initialVariables are keyed by variable NAME, and re-drawing a wire must
// never clobber an existing seed value back to the variable default.

function entry(overrides: Partial<WorldEntry> & { id: string }): WorldEntry {
  return {
    name: overrides.id, content: "", role: "greeting", alwaysSend: false,
    keywords: [], conditions: [], conditionLogic: "all", enabled: true,
    position: 0, section: "system-presets",
    ...overrides,
  };
}

const gold: Variable = { id: "v9", name: "gold", type: "number", defaultValue: 0 };

function makeWorld(): WorldDefinition {
  return {
    variables: [gold],
    rules: [],
    reactions: [],
    entries: [
      entry({ id: "G1", initialVariables: { gold: 5 } }), // legacy: keyed by name
      entry({ id: "G2", initialVariables: { v9: 3 } }),   // keyed by id
      entry({ id: "G3" }),
    ],
    worldbooks: [],
  } as unknown as WorldDefinition;
}

describe("seed edges — name-keyed initialVariables", () => {
  it("projects a name-keyed seed as a greeting→var edge", () => {
    const graph = toGraph(makeWorld());
    expect(graph.edges.find((e) => e.id === "e:greeting:G1->var:v9")).toBeDefined();
  });

  it("remove-edge deletes a name-keyed seed", () => {
    const out = applyGraphEdit(makeWorld(), { op: "remove-edge", edgeId: "e:greeting:G1->var:v9" });
    expect(out.entries!.find((e) => e.id === "G1")!.initialVariables).toEqual({});
  });

  it("update-edge edits a name-keyed seed in place", () => {
    const out = applyGraphEdit(makeWorld(), { op: "update-edge", edgeId: "e:greeting:G1->var:v9", data: { value: 9 } });
    expect(out.entries!.find((e) => e.id === "G1")!.initialVariables).toEqual({ gold: 9 });
  });
});

describe("seed edges — add must not clobber", () => {
  it("re-drawing a wire over an id-keyed seed keeps the existing value", () => {
    const out = applyGraphEdit(makeWorld(), {
      op: "add-edge",
      edge: { id: "", from: "greeting:G2", fromPort: "seeds", to: "var:v9", toPort: "write" },
    });
    expect(out.entries!.find((e) => e.id === "G2")!.initialVariables).toEqual({ v9: 3 });
  });

  it("re-drawing a wire over a name-keyed seed keeps the value and adds no duplicate key", () => {
    const out = applyGraphEdit(makeWorld(), {
      op: "add-edge",
      edge: { id: "", from: "greeting:G1", fromPort: "seeds", to: "var:v9", toPort: "write" },
    });
    expect(out.entries!.find((e) => e.id === "G1")!.initialVariables).toEqual({ gold: 5 });
  });

  it("a fresh wire still seeds the variable default", () => {
    const out = applyGraphEdit(makeWorld(), {
      op: "add-edge",
      edge: { id: "", from: "greeting:G3", fromPort: "seeds", to: "var:v9", toPort: "write" },
    });
    expect(out.entries!.find((e) => e.id === "G3")!.initialVariables).toEqual({ v9: 0 });
  });
});
