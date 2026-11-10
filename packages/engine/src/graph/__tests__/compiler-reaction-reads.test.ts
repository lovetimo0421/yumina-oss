import { describe, it, expect } from "vitest";
import { toGraph } from "../compiler.js";
import type { Variable } from "../../types/index.js";
import type { Reaction } from "../../events/types.js";

// A behaviour that hinges on a number must have a wire to that number — the
// canvas shows dependencies as lines, and the number's own panel lists who
// depends on it from the same edges. Triggers, ONLY IF conditions and STOP
// WHEN conditions are three different wires into the same behaviour.

const hp: Variable = { id: "hp", name: "hp", type: "number", defaultValue: 100 };
const mp: Variable = { id: "mp", name: "mp", type: "number", defaultValue: 50 };
const affection: Variable = { id: "affection", name: "affection", type: "number", defaultValue: 0 };

const base: Reaction = {
  id: "R", name: "R", when: { eventType: "turn:complete" },
  conditions: [], conditionLogic: "all", then: [], priority: 0, enabled: true,
};

const world = {
  variables: [hp, mp, affection],
  rules: [],
  entries: [],
  worldbooks: [],
  reactions: [
    { ...base, id: "gated", conditions: [{ variableId: "hp", operator: "lte", value: 10 }, { variableId: "hp", operator: "gte", valueRef: "mp", value: 0 }] },
    { ...base, id: "stopped", stopConditions: [{ variableId: "mp", operator: "lte", value: 0 }] },
    { ...base, id: "threshold", when: { eventType: "state:crossed", match: { variableId: { operator: "eq", value: "affection" } } } },
    { ...base, id: "ghost", conditions: [{ variableId: "no-such-var", operator: "eq", value: 1 }] },
  ] as Reaction[],
};

describe("behaviour reads are wires", () => {
  const graph = toGraph(world as never);
  const into = (id: string) => graph.edges.filter((e) => e.to === `reaction:${id}`);

  it("an ONLY IF condition wires the variable it reads into the condition port", () => {
    const edges = into("gated");
    expect(edges.map((e) => [e.from, e.toPort])).toContainEqual(["var:hp", "condition"]);
    // The right-hand variable of a variable-vs-variable comparison is read too.
    expect(edges.map((e) => [e.from, e.toPort])).toContainEqual(["var:mp", "condition"]);
    expect(edges.filter((e) => e.from === "var:hp" && e.toPort === "condition")).toHaveLength(2);
  });

  it("a STOP WHEN condition wires into its own port", () => {
    expect(into("stopped").map((e) => [e.from, e.toPort])).toContainEqual(["var:mp", "stop"]);
  });

  it("every state:* event pinned to a variable is that variable's trigger, not just state:changed", () => {
    expect(into("threshold").map((e) => [e.from, e.toPort])).toContainEqual(["var:affection", "trigger"]);
  });

  it("a condition on a variable that does not exist draws nothing", () => {
    expect(into("ghost").filter((e) => e.toPort === "condition")).toHaveLength(0);
  });

  it("the behaviour node declares the ports the new wires land on", () => {
    const node = graph.nodes.find((n) => n.id === "reaction:gated")!;
    expect(node.ports.map((p) => p.id)).toEqual(expect.arrayContaining(["trigger", "condition", "stop", "effect"]));
  });
});
