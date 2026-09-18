import { describe, it, expect } from "vitest";
import {
  isVariableActive,
  isAiReadable,
  isAiWritable,
  resolveActiveVariableIds,
  filterAiEffects,
} from "../state/variable-activation.js";
import { createEmptyRuleState } from "../rules/rule-state.js";
import { variableSchema } from "../world/schema.js";
import {
  createMockVariable,
  createMockWorld,
  createMockGameState,
  createMockEffect,
} from "./test-utils.js";
import type { GameState } from "../types/index.js";

function stateWithToggles(
  base: GameState,
  toggledVariables: Record<string, boolean>,
): GameState {
  return {
    ...base,
    ruleState: { ...createEmptyRuleState(), toggledVariables },
  };
}

describe("isVariableActive", () => {
  it("treats a legacy variable (no new fields) as active", () => {
    const v = createMockVariable({ id: "hp" });
    const state = createMockGameState({ fromVariables: [v] });
    expect(isVariableActive(v, state)).toBe(true);
  });

  it("respects enabled:false as the default gate", () => {
    const v = createMockVariable({ id: "hp", enabled: false });
    const state = createMockGameState({ fromVariables: [v] });
    expect(isVariableActive(v, state)).toBe(false);
  });

  it("lets a runtime toggle override the enabled default in both directions", () => {
    const off = createMockVariable({ id: "a", enabled: false });
    const on = createMockVariable({ id: "b" });
    const base = createMockGameState({ fromVariables: [off, on] });
    const state = stateWithToggles(base, { a: true, b: false });
    expect(isVariableActive(off, state)).toBe(true);
    expect(isVariableActive(on, state)).toBe(false);
  });

  it("activates a conditions-mode variable only while its conditions pass", () => {
    const gate = createMockVariable({ id: "阶段", type: "string", defaultValue: "观察" });
    const v = createMockVariable({
      id: "直播积分",
      activation: {
        mode: "conditions",
        conditions: [{ variableId: "阶段", operator: "eq", value: "直播" }],
        conditionLogic: "all",
      },
    });
    const observing = createMockGameState({ fromVariables: [gate, v] });
    expect(isVariableActive(v, observing)).toBe(false);
    const live = { ...observing, variables: { ...observing.variables, 阶段: "直播" } };
    expect(isVariableActive(v, live)).toBe(true);
  });

  it("supports valueRef conditions (variable bound to another variable)", () => {
    const v = createMockVariable({
      id: "bonus",
      activation: {
        mode: "conditions",
        conditions: [{ variableId: "score", operator: "gte", value: 0, valueRef: "threshold" }],
        conditionLogic: "all",
      },
    });
    const state = createMockGameState({ variables: { score: 5, threshold: 10 } });
    expect(isVariableActive(v, state)).toBe(false);
    const passed = { ...state, variables: { score: 15, threshold: 10 } };
    expect(isVariableActive(v, passed)).toBe(true);
  });

  it("activates a greeting-mode variable only on a matching opening", () => {
    const v = createMockVariable({
      id: "route-b-flag",
      activation: { mode: "greeting", greetingIds: ["g-b"] },
    });
    const onB = createMockGameState({ activeGreetingId: "g-b" });
    const onA = createMockGameState({ activeGreetingId: "g-a" });
    const noOpening = createMockGameState({});
    expect(isVariableActive(v, onB)).toBe(true);
    expect(isVariableActive(v, onA)).toBe(false);
    expect(isVariableActive(v, noOpening)).toBe(false);
  });

  it("lets a runtime toggle-off kill even a passing conditions-mode variable", () => {
    const v = createMockVariable({
      id: "loot",
      activation: {
        mode: "conditions",
        conditions: [{ variableId: "in副本", operator: "eq", value: true }],
        conditionLogic: "all",
      },
    });
    const base = createMockGameState({ variables: { in副本: true } });
    expect(isVariableActive(v, base)).toBe(true);
    expect(isVariableActive(v, stateWithToggles(base, { loot: false }))).toBe(false);
  });
});

describe("AI access", () => {
  it("defaults to readable + writable for a plain active variable", () => {
    const v = createMockVariable({ id: "hp" });
    const state = createMockGameState({ fromVariables: [v] });
    expect(isAiReadable(v, state)).toBe(true);
    expect(isAiWritable(v, state)).toBe(true);
  });

  it("aiAccess:'read' is visible to the AI but not writable", () => {
    const v = createMockVariable({ id: "阶段", aiAccess: "read" });
    const state = createMockGameState({ fromVariables: [v] });
    expect(isAiReadable(v, state)).toBe(true);
    expect(isAiWritable(v, state)).toBe(false);
  });

  it("aiAccess:'none' is neither visible nor writable", () => {
    const v = createMockVariable({ id: "账本", aiAccess: "none" });
    const state = createMockGameState({ fromVariables: [v] });
    expect(isAiReadable(v, state)).toBe(false);
    expect(isAiWritable(v, state)).toBe(false);
  });

  it("internal (engine bookkeeping) variables are never AI-visible regardless of aiAccess", () => {
    const v = createMockVariable({ id: "pickhist", internal: true, aiAccess: "write" });
    const state = createMockGameState({ fromVariables: [v] });
    expect(isAiReadable(v, state)).toBe(false);
    expect(isAiWritable(v, state)).toBe(false);
  });

  it("an inactive variable is neither readable nor writable even with aiAccess:'write'", () => {
    const v = createMockVariable({ id: "loot", enabled: false });
    const state = createMockGameState({ fromVariables: [v] });
    expect(isAiReadable(v, state)).toBe(false);
    expect(isAiWritable(v, state)).toBe(false);
  });
});

describe("resolveActiveVariableIds", () => {
  it("returns the set of active ids for a mixed world", () => {
    const world = createMockWorld({
      variables: [
        createMockVariable({ id: "hp" }),
        createMockVariable({ id: "off", enabled: false }),
        createMockVariable({
          id: "gated",
          activation: {
            mode: "conditions",
            conditions: [{ variableId: "hp", operator: "gte", value: 50 }],
            conditionLogic: "all",
          },
        }),
      ],
    });
    const state = createMockGameState({ variables: { hp: 100 } });
    expect(resolveActiveVariableIds(world, state)).toEqual(new Set(["hp", "gated"]));
  });
});

describe("variableSchema", () => {
  it("parses the new gating fields", () => {
    const parsed = variableSchema.parse({
      id: "直播积分",
      name: "直播积分",
      type: "number",
      defaultValue: 0,
      aiAccess: "read",
      enabled: false,
      activation: {
        mode: "conditions",
        conditions: [{ variableId: "阶段", operator: "eq", value: "直播" }],
        conditionLogic: "all",
      },
    });
    expect(parsed.aiAccess).toBe("read");
    expect(parsed.enabled).toBe(false);
    expect(parsed.activation).toMatchObject({ mode: "conditions" });
  });

  it("parses a greeting-mode activation", () => {
    const parsed = variableSchema.parse({
      id: "route",
      name: "route",
      type: "string",
      defaultValue: "",
      activation: { mode: "greeting", greetingIds: ["g-1"] },
    });
    expect(parsed.activation).toEqual({ mode: "greeting", greetingIds: ["g-1"] });
  });

  it("keeps legacy variables valid with all new fields absent", () => {
    const parsed = variableSchema.parse({
      id: "hp",
      name: "生命",
      type: "number",
      defaultValue: 100,
    });
    expect(parsed.aiAccess).toBeUndefined();
    expect(parsed.activation).toBeUndefined();
    expect(parsed.enabled).toBeUndefined();
  });

  it("rejects an unknown aiAccess value", () => {
    expect(() =>
      variableSchema.parse({
        id: "hp",
        name: "hp",
        type: "number",
        defaultValue: 1,
        aiAccess: "readonly",
      }),
    ).toThrow();
  });
});

describe("filterAiEffects", () => {
  it("keeps effects on AI-writable variables and drops the rest", () => {
    const world = createMockWorld({
      variables: [
        createMockVariable({ id: "hp" }),
        createMockVariable({ id: "阶段", aiAccess: "read" }),
        createMockVariable({ id: "账本", aiAccess: "none" }),
        createMockVariable({ id: "loot", enabled: false }),
      ],
    });
    const state = createMockGameState({ variables: { hp: 100 } });
    const effects = [
      createMockEffect({ variableId: "hp" }),
      createMockEffect({ variableId: "阶段", operation: "set", value: "直播" }),
      createMockEffect({ variableId: "账本" }),
      createMockEffect({ variableId: "loot" }),
    ];
    const { kept, dropped } = filterAiEffects(world, state, effects);
    expect(kept.map((e) => e.variableId)).toEqual(["hp"]);
    expect(dropped.map((e) => e.variableId)).toEqual(["阶段", "账本", "loot"]);
  });

  it("resolves dot-path effects by their root variable id", () => {
    const world = createMockWorld({
      variables: [createMockVariable({ id: "npcs", type: "json", defaultValue: {}, aiAccess: "read" })],
    });
    const state = createMockGameState({ variables: { npcs: {} } });
    const effects = [createMockEffect({ variableId: "npcs.aria.affinity", operation: "add", value: 3 })];
    const { kept, dropped } = filterAiEffects(world, state, effects);
    expect(kept).toEqual([]);
    expect(dropped).toHaveLength(1);
  });

  it("passes unknown variable ids through untouched (existing guard owns them)", () => {
    const world = createMockWorld({ variables: [createMockVariable({ id: "hp" })] });
    const state = createMockGameState({ variables: { hp: 100 } });
    const effects = [createMockEffect({ variableId: "ghost" })];
    const { kept, dropped } = filterAiEffects(world, state, effects);
    expect(kept.map((e) => e.variableId)).toEqual(["ghost"]);
    expect(dropped).toEqual([]);
  });
});
