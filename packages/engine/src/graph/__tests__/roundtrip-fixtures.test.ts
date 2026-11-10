import { describe, it, expect } from "vitest";
import { toGraph } from "../../index.js";
import type { Rule, Variable, WorldDefinition } from "../../types/index.js";

// ── Shared variables ────────────────────────────────────────────────
const hp: Variable = { id: "hp", name: "HP", type: "number", defaultValue: 100 };
const warning: Variable = { id: "warning", name: "Warning", type: "boolean", defaultValue: false };
const gold: Variable = { id: "gold", name: "Gold", type: "number", defaultValue: 0 };
const exp: Variable = { id: "exp", name: "EXP", type: "number", defaultValue: 0 };
const mood: Variable = { id: "mood", name: "Mood", type: "string", defaultValue: "calm" };

// ── Fixture A: keyword-trigger rule with a modify-variable action ───
const ruleA: Rule = {
  id: "r-kw", name: "Attack Hit",
  trigger: { type: "keyword", keywords: ["attack", "hit"] },
  conditions: [], conditionLogic: "all",
  actions: [{ type: "modify-variable", variableId: "hp", operation: "subtract", value: 10 }],
  priority: 0, enabled: true,
};
const worldA = { rules: [ruleA], variables: [hp] } as unknown as WorldDefinition;

// ── Fixture B: variable-crossed rule (wires var → rule, no evt node) ─
const ruleB: Rule = {
  id: "r-cross", name: "Low HP Warning",
  trigger: { type: "variable-crossed", variableId: "hp", direction: "drops-below", threshold: 20 },
  conditions: [], conditionLogic: "all",
  actions: [{ type: "modify-variable", variableId: "warning", operation: "set", value: true }],
  priority: 1, enabled: true,
};
const worldB = { rules: [ruleB], variables: [hp, warning] } as unknown as WorldDefinition;

// ── Fixture C: rule with multiple actions (one rule → two vars) ──────
const ruleC: Rule = {
  id: "r-multi", name: "Loot Chest",
  trigger: { type: "keyword", keywords: ["loot", "open"] },
  conditions: [], conditionLogic: "all",
  actions: [
    { type: "modify-variable", variableId: "gold", operation: "add", value: 50 },
    { type: "modify-variable", variableId: "exp", operation: "add", value: 100 },
  ],
  priority: 0, enabled: true,
};
const worldC = { rules: [ruleC], variables: [gold, exp] } as unknown as WorldDefinition;

// ── Fixture D: rule with both toggle-entry and play-audio actions ────
const ruleD: Rule = {
  id: "r-audio", name: "Unlock Door",
  trigger: { type: "keyword", keywords: ["unlock"] },
  conditions: [], conditionLogic: "all",
  actions: [
    { type: "toggle-entry", entryId: "door-lore", enabled: true },
    { type: "play-audio", trackId: "unlock-sfx", action: "play" },
  ],
  priority: 0, enabled: true,
};
const worldD = { rules: [ruleD], variables: [] } as unknown as WorldDefinition;

// ── Fixture E: session-start trigger (distinct evt:session source) ───
const ruleE: Rule = {
  id: "r-start", name: "Session Init",
  trigger: { type: "session-start" },
  conditions: [], conditionLogic: "all",
  actions: [{ type: "modify-variable", variableId: "mood", operation: "set", value: "calm" }],
  priority: 0, enabled: true,
};
const worldE = { rules: [ruleE], variables: [mood] } as unknown as WorldDefinition;

// Every card projects a "world:root" node for the card itself. These fixtures
// are about the logic projection, so they count everything but that node — and
// assert its constant presence once, below.
const logicNodes = (g: { nodes: Array<{ id: string }> }) =>
  g.nodes.filter((n) => n.id !== "world:root");

// ── Tests ────────────────────────────────────────────────────────────

describe("graph fixture round-trip", () => {
  it("projects the card root on every fixture", () => {
    for (const w of [worldA, worldB, worldC, worldD, worldE]) {
      expect(toGraph(w).nodes.find((n) => n.id === "world:root")).toBeDefined();
    }
  });

  describe("Fixture A — keyword-trigger + modify-variable", () => {
    it("produces exactly 3 nodes (evt:user, rule, var) and 2 edges", () => {
      const g = toGraph(worldA);
      expect(logicNodes(g)).toHaveLength(3);
      expect(g.edges).toHaveLength(2);
    });

    it("includes the correct stable node ids", () => {
      const g = toGraph(worldA);
      const ids = logicNodes(g).map((n) => n.id);
      expect(ids).toContain("evt:user");
      expect(ids).toContain("rule:r-kw");
      expect(ids).toContain("var:hp");
    });

    it("wires evt:user→rule:r-kw and rule:r-kw→var:hp with operation label", () => {
      const g = toGraph(worldA);
      expect(g.edges.some((e) => e.from === "evt:user" && e.to === "rule:r-kw")).toBe(true);
      const effectEdge = g.edges.find((e) => e.from === "rule:r-kw" && e.to === "var:hp");
      expect(effectEdge).toBeDefined();
      expect(effectEdge!.label).toBe("subtract");
    });
  });

  describe("Fixture B — variable-crossed rule", () => {
    it("produces 3 nodes (2 vars + 1 rule) and 2 edges, with no event-source node", () => {
      const g = toGraph(worldB);
      expect(logicNodes(g)).toHaveLength(3);
      expect(g.edges).toHaveLength(2);
      expect(g.nodes.some((n) => n.kind === "event")).toBe(false);
    });

    it("wires var:hp→rule:r-cross (threshold) and rule:r-cross→var:warning (effect)", () => {
      const g = toGraph(worldB);
      expect(g.edges.some((e) => e.from === "var:hp" && e.to === "rule:r-cross")).toBe(true);
      expect(g.edges.some((e) => e.from === "rule:r-cross" && e.to === "var:warning")).toBe(true);
    });
  });

  describe("Fixture C — rule with multiple actions", () => {
    it("produces exactly 4 nodes and 3 edges", () => {
      const g = toGraph(worldC);
      expect(logicNodes(g)).toHaveLength(4);
      expect(g.edges).toHaveLength(3);
    });

    it("emits one effect edge per action, both sourced from rule:r-multi", () => {
      const g = toGraph(worldC);
      const ruleEdges = g.edges.filter((e) => e.from === "rule:r-multi");
      expect(ruleEdges).toHaveLength(2);
      const targets = ruleEdges.map((e) => e.to).sort();
      expect(targets).toEqual(["var:exp", "var:gold"]);
    });
  });

  describe("Fixture D — toggle-entry + play-audio actions", () => {
    it("produces exactly 4 nodes (rule, evt, entry, audio) and 3 edges", () => {
      const g = toGraph(worldD);
      expect(logicNodes(g)).toHaveLength(4);
      expect(g.edges).toHaveLength(3);
    });

    it("creates entry and audio nodes with the correct kinds", () => {
      const g = toGraph(worldD);
      expect(g.nodes.find((n) => n.id === "entry:door-lore")?.kind).toBe("entry");
      expect(g.nodes.find((n) => n.id === "audio:unlock-sfx")?.kind).toBe("audio");
    });

    it("wires rule→entry with label 'unlock' and rule→audio with label 'play'", () => {
      const g = toGraph(worldD);
      const entryEdge = g.edges.find((e) => e.to === "entry:door-lore");
      expect(entryEdge?.from).toBe("rule:r-audio");
      expect(entryEdge?.label).toBe("unlock");
      const audioEdge = g.edges.find((e) => e.to === "audio:unlock-sfx");
      expect(audioEdge?.from).toBe("rule:r-audio");
      expect(audioEdge?.label).toBe("play");
    });
  });

  describe("Fixture E — session-start event source", () => {
    it("produces exactly 3 nodes (evt:session, rule, var) and 2 edges", () => {
      const g = toGraph(worldE);
      expect(logicNodes(g)).toHaveLength(3);
      expect(g.edges).toHaveLength(2);
    });

    it("uses evt:session (not evt:user) as the event-source node", () => {
      const g = toGraph(worldE);
      expect(g.nodes.some((n) => n.id === "evt:session" && n.kind === "event")).toBe(true);
      expect(g.nodes.some((n) => n.id === "evt:user")).toBe(false);
      expect(g.edges.some((e) => e.from === "evt:session" && e.to === "rule:r-start")).toBe(true);
    });
  });
});
