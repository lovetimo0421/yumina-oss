import { describe, it, expect } from "vitest";
import { toGraph } from "../compiler.js";
import type { Reaction } from "../../events/types.js";
import type { Variable, WorldEntry } from "../../types/index.js";

// The wire the RFC was written for: "which variable drives this HUD?" — and
// its darker twin, "this HUD reads a variable that can never change."

function variable(over: Partial<Variable> & { id: string }): Variable {
  return { name: over.id, type: "number", defaultValue: 0, ...over };
}

const frontendWith = (src: string) => ({
  id: "root",
  name: "Frontend",
  entryFile: "index.tsx",
  files: { "index.tsx": src },
  updatedAt: "2026-08-19T00:00:00.000Z",
});

const node = (g: ReturnType<typeof toGraph>, id: string) => g.nodes.find((n) => n.id === id);

describe("toGraph — variable → frontend reads", () => {
  it("gives the frontend a port and a wire per variable it reads", () => {
    const g = toGraph({
      variables: [variable({ id: "health" }), variable({ id: "gold" }), variable({ id: "unused" })],
      rules: [],
      rootComponent: frontendWith(`<div>{api.variables.health} {api.variables.gold}</div>`),
    });
    const fe = node(g, "frontend")!;
    expect(fe.ports.filter((p) => p.id.startsWith("read:")).map((p) => p.id).sort())
      .toEqual(["read:gold", "read:health"]);
    expect(fe.ports.some((p) => p.id === "read:unused")).toBe(false);

    const wires = g.edges.filter((e) => e.to === "frontend" && e.toPort.startsWith("read:"));
    expect(wires.map((e) => e.from).sort()).toEqual(["var:gold", "var:health"]);
    expect(wires.every((e) => e.fromPort === "read")).toBe(true);
  });

  it("resolves a read by display name when it is not an id", () => {
    const g = toGraph({
      variables: [variable({ id: "v_1", name: "affection" })],
      rules: [],
      rootComponent: frontendWith(`{api.variables.affection}`),
    });
    expect(g.edges.some((e) => e.from === "var:v_1" && e.toPort === "read:v_1")).toBe(true);
  });

  it("ignores reads that match no declared variable", () => {
    const g = toGraph({
      variables: [variable({ id: "health" })],
      rules: [],
      rootComponent: frontendWith(`{api.variables.ghost}`),
    });
    expect(node(g, "frontend")!.ports.filter((p) => p.id.startsWith("read:"))).toHaveLength(0);
  });

  it("reports computed reads instead of hiding them", () => {
    const g = toGraph({
      variables: [variable({ id: "health" })],
      rules: [],
      rootComponent: frontendWith(`{api.variables[key]} {api.variables.health}`),
    });
    expect(node(g, "frontend")!.data.dynamicReads).toBe(1);
  });

  it("marks the variables the UI reads", () => {
    const g = toGraph({
      variables: [variable({ id: "health" }), variable({ id: "gold" })],
      rules: [],
      rootComponent: frontendWith(`{api.variables.health}`),
    });
    expect(node(g, "var:health")!.data.readByUi).toBe(true);
    expect(node(g, "var:gold")!.data.readByUi).toBeUndefined();
  });
});

describe("toGraph — the dead-binding warning", () => {
  const ui = frontendWith(`{api.variables.health}`);

  it("flags a UI read that nothing can ever write", () => {
    const g = toGraph({
      variables: [variable({ id: "health", aiAccess: "read" })],
      rules: [],
      rootComponent: ui,
    });
    expect(node(g, "var:health")!.data.uiReadNeverWritten).toBe(true);
  });

  it("stays quiet when a behavior writes it", () => {
    const writer: Reaction = {
      id: "r1", name: "heal", enabled: true, priority: 0,
      when: { eventType: "turn:complete" },
      conditions: [], conditionLogic: "all",
      then: [{ type: "set", path: "health", value: 1, operation: "add" }],
    };
    const g = toGraph({
      variables: [variable({ id: "health", aiAccess: "read" })],
      rules: [], reactions: [writer],
      rootComponent: ui,
    });
    expect(node(g, "var:health")!.data.uiReadNeverWritten).toBeUndefined();
  });

  it("stays quiet when the AI may write it (the default)", () => {
    const g = toGraph({
      variables: [variable({ id: "health" })],
      rules: [],
      rootComponent: ui,
    });
    expect(node(g, "var:health")!.data.uiReadNeverWritten).toBeUndefined();
  });

  it("stays quiet when an opening seeds it", () => {
    const greeting: WorldEntry = {
      id: "g1", name: "Start", content: "", role: "greeting", alwaysSend: false,
      keywords: [], conditions: [], conditionLogic: "all", enabled: true,
      position: 0, section: "system-presets",
      initialVariables: { health: 50 },
    };
    const g = toGraph({
      variables: [variable({ id: "health", aiAccess: "none" })],
      rules: [], entries: [greeting],
      rootComponent: ui,
    });
    expect(node(g, "var:health")!.data.uiReadNeverWritten).toBeUndefined();
  });

  it("stays quiet for a variable the UI never reads", () => {
    const g = toGraph({
      variables: [variable({ id: "hidden", aiAccess: "none" })],
      rules: [],
      rootComponent: ui,
    });
    expect(node(g, "var:hidden")!.data.uiReadNeverWritten).toBeUndefined();
  });

  it("stays quiet when a legacy rule writes it", () => {
    const g = toGraph({
      variables: [variable({ id: "health", aiAccess: "none" })],
      rules: [{
        id: "r1", name: "heal",
        trigger: { type: "every-turn" },
        conditions: [], conditionLogic: "all",
        actions: [{ type: "modify-variable", variableId: "health", operation: "add", value: 1 }],
        priority: 0, enabled: true,
      }],
      rootComponent: ui,
    });
    expect(node(g, "var:health")!.data.uiReadNeverWritten).toBeUndefined();
  });
});
