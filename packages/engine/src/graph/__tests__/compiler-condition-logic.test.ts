import { describe, it, expect } from "vitest";
import { toGraph } from "../compiler.js";
import type { WorldEntry, Worldbook, Variable } from "../../types/index.js";

// Two condition wires into the same target mean DIFFERENT cards depending on
// all-vs-any — the projection must carry that so the canvas can show it.

function entry(overrides: Partial<WorldEntry> & { id: string }): WorldEntry {
  return {
    name: overrides.id, content: "", role: "lore", alwaysSend: false,
    keywords: [], conditions: [], conditionLogic: "all", enabled: true,
    position: 0, section: "system-presets",
    ...overrides,
  };
}

const hp: Variable = { id: "hp", name: "hp", type: "number", defaultValue: 100 };
const mp: Variable = { id: "mp", name: "mp", type: "number", defaultValue: 50 };

const world = {
  variables: [hp, mp],
  rules: [],
  entries: [
    entry({
      id: "E2", conditionLogic: "any",
      conditions: [
        { variableId: "hp", operator: "lte", value: 10 },
        { variableId: "mp", operator: "lte", value: 5 },
      ],
    }),
    entry({ id: "E1", conditions: [{ variableId: "hp", operator: "gte", value: 1 }] }),
  ],
  worldbooks: [
    {
      id: "B2", name: "B2", order: 0,
      activation: {
        mode: "conditions",
        conditions: [
          { variableId: "hp", operator: "gte", value: 1 },
          { variableId: "mp", operator: "gte", value: 1 },
        ],
        conditionLogic: "any",
      },
    },
    {
      id: "B1", name: "B1", order: 1,
      activation: { mode: "conditions", conditions: [{ variableId: "hp", operator: "gte", value: 1 }], conditionLogic: "all" },
    },
  ] as Worldbook[],
};

const graph = toGraph(world);
const node = (id: string) => graph.nodes.find((n) => n.id === id);

describe("toGraph — conditionLogic projection", () => {
  it("multi-condition entries carry their all/any logic", () => {
    expect(node("entry:E2")?.data.conditionLogic).toBe("any");
  });

  it("single-condition entries omit it (nothing to disambiguate)", () => {
    expect(node("entry:E1")?.data.conditionLogic).toBeUndefined();
  });

  it("multi-condition modules carry their all/any logic", () => {
    expect(node("module:B2")?.data.conditionLogic).toBe("any");
  });

  it("single-condition modules omit it", () => {
    expect(node("module:B1")?.data.conditionLogic).toBeUndefined();
  });
});
