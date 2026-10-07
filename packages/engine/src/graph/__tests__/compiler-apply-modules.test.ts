import { describe, it, expect } from "vitest";
import { toGraph, applyGraphEdit } from "../compiler.js";
import type { WorldDefinition, WorldEntry, Worldbook, Variable } from "../../types/index.js";
import type { Reaction } from "../../events/types.js";

function entry(overrides: Partial<WorldEntry> & { id: string }): WorldEntry {
  return {
    name: overrides.id, content: "", role: "lore", alwaysSend: false,
    keywords: [], conditions: [], conditionLogic: "all", enabled: true,
    position: 0, section: "system-presets",
    ...overrides,
  };
}

function makeWorld(): WorldDefinition {
  const vars: Variable[] = [
    { id: "flag", name: "flag", type: "boolean", defaultValue: false },
    { id: "hp", name: "hp", type: "number", defaultValue: 100 },
  ];
  const books: Worldbook[] = [
    { id: "B1", name: "B1", order: 0, activation: { mode: "always" } },
    {
      id: "B2", name: "B2", order: 1,
      activation: { mode: "conditions", conditions: [{ variableId: "flag", operator: "eq", value: true }], conditionLogic: "all" },
    },
  ];
  const reactions: Reaction[] = [{
    id: "R1", name: "R1", when: { eventType: "turn:complete" },
    conditions: [], conditionLogic: "all", then: [], priority: 0, enabled: true,
  }];
  return {
    variables: vars,
    worldbooks: books,
    reactions,
    entries: [
      entry({ id: "E1", conditions: [{ variableId: "hp", operator: "lte", value: 10 }] }),
      entry({ id: "G1", role: "greeting" }),
    ],
    loreUiBindings: [{ slotId: "codex", entryId: "E1", conditions: [], conditionLogic: "all" }],
    rules: [],
  } as unknown as WorldDefinition;
}

const edge = (from: string, fromPort: string, to: string, toPort: string) => ({
  id: `e:${from}->${to}`, from, fromPort, to, toPort,
});

describe("applyGraphEdit — module-era edits", () => {
  it("add-edge var→module converts an always-book to conditions with a typed default", () => {
    const w = makeWorld();
    const out = applyGraphEdit(w, { op: "add-edge", edge: edge("var:flag", "read", "module:B1", "activate") });
    const b = out.worldbooks!.find((x) => x.id === "B1")!;
    expect(b.activation.mode).toBe("conditions");
    if (b.activation.mode === "conditions") {
      expect(b.activation.conditions).toEqual([{ variableId: "flag", operator: "eq", value: true }]);
    }
    // source untouched (immutability)
    expect(w.worldbooks!.find((x) => x.id === "B1")!.activation.mode).toBe("always");
  });

  it("add-edge var→module appends to an existing conditions-book", () => {
    const w = makeWorld();
    const out = applyGraphEdit(w, { op: "add-edge", edge: edge("var:hp", "read", "module:B2", "activate") });
    const b = out.worldbooks!.find((x) => x.id === "B2")!;
    if (b.activation.mode === "conditions") {
      expect(b.activation.conditions).toHaveLength(2);
      expect(b.activation.conditions[1]).toEqual({ variableId: "hp", operator: "gte", value: 1 });
    } else {
      throw new Error("expected conditions mode");
    }
  });

  it("remove-edge var→module removes the exact condition and falls back to always when none remain", () => {
    const w = makeWorld();
    const out = applyGraphEdit(w, { op: "remove-edge", edgeId: "e:var:flag->module:B2:0" });
    expect(out.worldbooks!.find((x) => x.id === "B2")!.activation.mode).toBe("always");
  });

  it("add-edge greeting→module turns an always-book into greeting activation", () => {
    const w = makeWorld();
    const out = applyGraphEdit(w, { op: "add-edge", edge: edge("greeting:G1", "select", "module:B1", "activate") });
    const b = out.worldbooks!.find((x) => x.id === "B1")!;
    expect(b.activation).toEqual({ mode: "greeting", greetingIds: ["G1"] });
  });

  it("add-edge greeting→module leaves a conditions-book untouched (no silent mode clobber)", () => {
    const w = makeWorld();
    const out = applyGraphEdit(w, { op: "add-edge", edge: edge("greeting:G1", "select", "module:B2", "activate") });
    expect(out.worldbooks!.find((x) => x.id === "B2")!.activation.mode).toBe("conditions");
  });

  it("remove-edge greeting→module removes the id and falls back to always when empty", () => {
    const w = makeWorld();
    const w2 = applyGraphEdit(w, { op: "add-edge", edge: edge("greeting:G1", "select", "module:B1", "activate") });
    const out = applyGraphEdit(w2, { op: "remove-edge", edgeId: "e:greeting:G1->module:B1" });
    expect(out.worldbooks!.find((x) => x.id === "B1")!.activation).toEqual({ mode: "always" });
  });

  it("add-edge greeting→var seeds initialVariables with the variable's default", () => {
    const w = makeWorld();
    const out = applyGraphEdit(w, { op: "add-edge", edge: edge("greeting:G1", "seeds", "var:hp", "write") });
    const g = out.entries!.find((e) => e.id === "G1")!;
    expect(g.initialVariables).toEqual({ hp: 100 });
  });

  it("remove-edge greeting→var deletes the seed", () => {
    const w = makeWorld();
    const w2 = applyGraphEdit(w, { op: "add-edge", edge: edge("greeting:G1", "seeds", "var:hp", "write") });
    const out = applyGraphEdit(w2, { op: "remove-edge", edgeId: "e:greeting:G1->var:hp" });
    expect(out.entries!.find((e) => e.id === "G1")!.initialVariables ?? {}).toEqual({});
  });

  it("add-edge var→entry appends a typed default condition", () => {
    const w = makeWorld();
    const out = applyGraphEdit(w, { op: "add-edge", edge: edge("var:flag", "read", "entry:E1", "gate") });
    const e = out.entries!.find((x) => x.id === "E1")!;
    expect(e.conditions).toHaveLength(2);
    expect(e.conditions[1]).toEqual({ variableId: "flag", operator: "eq", value: true });
  });

  it("remove-edge var→entry removes the exact condition by index", () => {
    const w = makeWorld();
    const out = applyGraphEdit(w, { op: "remove-edge", edgeId: "e:var:hp->entry:E1:0" });
    expect(out.entries!.find((x) => x.id === "E1")!.conditions).toHaveLength(0);
  });

  it("add-edge entry→frontend slot appends a loreUiBinding", () => {
    const w = makeWorld();
    const out = applyGraphEdit(w, { op: "add-edge", edge: edge("entry:E1", "show", "frontend", "slot:map") });
    expect(out.loreUiBindings).toHaveLength(2);
    expect(out.loreUiBindings![1]).toEqual({ slotId: "map", entryId: "E1", conditions: [], conditionLogic: "all" });
  });

  it("remove-edge entry→frontend removes the binding by index", () => {
    const w = makeWorld();
    const out = applyGraphEdit(w, { op: "remove-edge", edgeId: "e:entry:E1->frontend:codex:0" });
    expect(out.loreUiBindings).toHaveLength(0);
  });

  it("set-parent moves a variable into a module and back to Core", () => {
    const w = makeWorld();
    const moved = applyGraphEdit(w, { op: "set-parent", nodeId: "var:hp", parentId: "module:B1" });
    expect(moved.variables.find((v) => v.id === "hp")!.worldbookId).toBe("B1");
    const back = applyGraphEdit(moved, { op: "set-parent", nodeId: "var:hp", parentId: undefined });
    expect(back.variables.find((v) => v.id === "hp")!.worldbookId).toBeUndefined();
  });

  it("set-parent moves entries, greetings and reactions too", () => {
    const w = makeWorld();
    const a = applyGraphEdit(w, { op: "set-parent", nodeId: "entry:E1", parentId: "module:B2" });
    expect(a.entries!.find((e) => e.id === "E1")!.worldbookId).toBe("B2");
    const b = applyGraphEdit(a, { op: "set-parent", nodeId: "greeting:G1", parentId: "module:B1" });
    expect(b.entries!.find((e) => e.id === "G1")!.worldbookId).toBe("B1");
    const c = applyGraphEdit(b, { op: "set-parent", nodeId: "reaction:R1", parentId: "module:B1" });
    expect(c.reactions!.find((r) => r.id === "R1")!.worldbookId).toBe("B1");
  });

  it("add-edge reaction→var appends a set effect; remove-edge splices it", () => {
    const w = makeWorld();
    const out = applyGraphEdit(w, { op: "add-edge", edge: edge("reaction:R1", "effect", "var:hp", "write") });
    const r = out.reactions!.find((x) => x.id === "R1")!;
    expect(r.then).toHaveLength(1);
    expect(r.then[0]).toMatchObject({ type: "set", path: "hp" });
    const removed = applyGraphEdit(out, { op: "remove-edge", edgeId: "e:reaction:R1->var:hp:0" });
    expect(removed.reactions!.find((x) => x.id === "R1")!.then).toHaveLength(0);
  });

  it("round-trips: every edit is visible when re-projected with toGraph", () => {
    let w = makeWorld();
    w = applyGraphEdit(w, { op: "add-edge", edge: edge("var:flag", "read", "module:B1", "activate") });
    w = applyGraphEdit(w, { op: "add-edge", edge: edge("greeting:G1", "seeds", "var:hp", "write") });
    w = applyGraphEdit(w, { op: "set-parent", nodeId: "var:hp", parentId: "module:B1" });
    const g = toGraph(w);
    expect(g.edges.some((e) => e.from === "var:flag" && e.to === "module:B1")).toBe(true);
    expect(g.edges.some((e) => e.from === "greeting:G1" && e.to === "var:hp")).toBe(true);
    expect(g.nodes.find((n) => n.id === "var:hp")!.parentId).toBe("module:B1");
  });
});

describe("applyGraphEdit — update-edge (edge inspector)", () => {
  it("updates the exact activation condition behind a var→module edge", () => {
    const w = makeWorld();
    const out = applyGraphEdit(w, {
      op: "update-edge", edgeId: "e:var:flag->module:B2:0",
      data: { operator: "neq", value: false },
    });
    const b = out.worldbooks!.find((x) => x.id === "B2")!;
    if (b.activation.mode !== "conditions") throw new Error("expected conditions");
    expect(b.activation.conditions[0]).toEqual({ variableId: "flag", operator: "neq", value: false });
    // stale index / wrong variable guard: no-op
    const noop = applyGraphEdit(w, {
      op: "update-edge", edgeId: "e:var:hp->module:B2:0",
      data: { operator: "gt", value: 5 },
    });
    expect(noop.worldbooks).toEqual(w.worldbooks);
  });

  it("updates the exact entry condition behind a var→entry edge", () => {
    const w = makeWorld();
    const out = applyGraphEdit(w, {
      op: "update-edge", edgeId: "e:var:hp->entry:E1:0",
      data: { operator: "gte", value: 50 },
    });
    expect(out.entries!.find((e) => e.id === "E1")!.conditions[0]).toEqual({ variableId: "hp", operator: "gte", value: 50 });
  });

  it("updates the seed value behind a greeting→var edge", () => {
    const w = makeWorld();
    const seeded = applyGraphEdit(w, { op: "add-edge", edge: edge("greeting:G1", "seeds", "var:hp", "write") });
    const out = applyGraphEdit(seeded, {
      op: "update-edge", edgeId: "e:greeting:G1->var:hp",
      data: { value: 42 },
    });
    expect(out.entries!.find((e) => e.id === "G1")!.initialVariables).toEqual({ hp: 42 });
  });
});
