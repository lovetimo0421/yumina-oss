import { describe, it, expect } from "vitest";
import { toGraph } from "../compiler.js";
import type { WorldEntry, Variable } from "../../types/index.js";
import type { Reaction } from "../../events/types.js";

// A switched-off entry or behavior must look switched off on the canvas —
// otherwise the picture claims the card does something it doesn't.

function entry(overrides: Partial<WorldEntry> & { id: string }): WorldEntry {
  return {
    name: overrides.id, content: "", role: "lore", alwaysSend: false,
    keywords: [], conditions: [], conditionLogic: "all", enabled: true,
    position: 0, section: "system-presets",
    ...overrides,
  };
}

const hp: Variable = { id: "hp", name: "hp", type: "number", defaultValue: 100 };

const offReaction: Reaction = {
  id: "Roff", name: "Roff", when: { eventType: "turn:complete" },
  conditions: [], conditionLogic: "all", then: [], priority: 0, enabled: false,
};
const onReaction: Reaction = { ...offReaction, id: "Ron", name: "Ron", enabled: true };

const world = {
  variables: [hp],
  rules: [],
  reactions: [offReaction, onReaction],
  entries: [
    entry({ id: "Eoff", enabled: false, conditions: [{ variableId: "hp", operator: "gte", value: 1 }] }),
    entry({ id: "Eon", conditions: [{ variableId: "hp", operator: "gte", value: 1 }] }),
    entry({ id: "Goff", role: "greeting", enabled: false }),
  ],
  worldbooks: [],
};

const graph = toGraph(world);
const node = (id: string) => graph.nodes.find((n) => n.id === id);

describe("toGraph — disabled flag", () => {
  it("marks disabled entries", () => {
    expect(node("entry:Eoff")?.data.disabled).toBe(true);
  });

  it("leaves enabled entries unmarked", () => {
    expect(node("entry:Eon")?.data.disabled).toBeUndefined();
  });

  it("marks disabled greetings", () => {
    expect(node("greeting:Goff")?.data.disabled).toBe(true);
  });

  it("marks disabled behaviors", () => {
    expect(node("reaction:Roff")?.data.disabled).toBe(true);
    expect(node("reaction:Ron")?.data.disabled).toBeUndefined();
  });
});
