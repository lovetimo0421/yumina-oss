import { describe, it, expect } from "vitest";
import { toGraph } from "../compiler.js";
import type { Rule, Variable } from "../../types/index.js";

const hp: Variable = { id: "hp", name: "HP", type: "number", defaultValue: 100 };
const rule: Rule = {
  id: "r1", name: "praise", trigger: { type: "keyword", keywords: ["hi"] },
  conditions: [], conditionLogic: "all",
  actions: [{ type: "modify-variable", variableId: "hp", operation: "add", value: 5 }],
  priority: 0, enabled: true,
};

describe("toGraph", () => {
  it("creates a variable node per variable", () => {
    const g = toGraph({ rules: [], variables: [hp] });
    expect(g.nodes.find((n) => n.id === "var:hp")?.kind).toBe("variable");
  });

  it("creates a rule node and an event source for a keyword trigger", () => {
    const g = toGraph({ rules: [rule], variables: [hp] });
    expect(g.nodes.find((n) => n.id === "rule:r1")?.kind).toBe("rule");
    expect(g.nodes.find((n) => n.id === "evt:user")?.kind).toBe("event");
  });

  it("wires event→rule and rule→variable for a modify-variable action", () => {
    const g = toGraph({ rules: [rule], variables: [hp] });
    expect(g.edges.some((e) => e.from === "evt:user" && e.to === "rule:r1")).toBe(true);
    expect(g.edges.some((e) => e.from === "rule:r1" && e.to === "var:hp")).toBe(true);
  });

  it("wires variable→rule for a variable-crossed trigger", () => {
    const crossed: Rule = { ...rule, id: "r2", trigger: { type: "variable-crossed", variableId: "hp", direction: "drops-below", threshold: 10 }, actions: [] };
    const g = toGraph({ rules: [crossed], variables: [hp] });
    expect(g.edges.some((e) => e.from === "var:hp" && e.to === "rule:r2")).toBe(true);
  });
});
