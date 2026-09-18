import { describe, it, expect } from "vitest";
import {
  createMockVariable,
  createMockWorld,
  createMockGameState,
  createMockEntry,
  createMockRule,
  createMockCondition,
  createMockEffect,
  createMockSettings,
  resetIdCounter,
} from "./test-utils.js";
import {
  variableSchema,
  worldDefinitionSchema,
  gameStateSchema,
  worldEntrySchema,
  ruleSchema,
} from "../world/schema.js";
import { GameStateManager } from "../state/game-state-manager.js";

describe("test infrastructure sanity checks", () => {
  it("vitest runs and basic assertions work", () => {
    expect(1 + 1).toBe(2);
    expect(true).toBe(true);
  });

  it("can import engine modules", () => {
    expect(GameStateManager).toBeDefined();
    expect(typeof GameStateManager).toBe("function");
  });
});

describe("factory: createMockVariable", () => {
  it("creates a valid Variable with defaults", () => {
    const v = createMockVariable();
    expect(v.name).toBe("health");
    expect(v.type).toBe("number");
    expect(v.defaultValue).toBe(100);
    expect(v.id).toBeTruthy();
  });

  it("accepts overrides", () => {
    const v = createMockVariable({
      id: "custom-id",
      name: "gold",
      type: "number",
      defaultValue: 50,
      min: 0,
      max: 999,
    });
    expect(v.id).toBe("custom-id");
    expect(v.name).toBe("gold");
    expect(v.defaultValue).toBe(50);
    expect(v.min).toBe(0);
    expect(v.max).toBe(999);
  });

  it("passes Zod schema validation", () => {
    const v = createMockVariable();
    const result = variableSchema.safeParse(v);
    expect(result.success).toBe(true);
  });
});

describe("factory: createMockEntry", () => {
  it("creates a valid WorldEntry with defaults", () => {
    const entry = createMockEntry();
    expect(entry.role).toBe("character");
    expect(entry.position).toBe(0);
    expect(entry.content).toBeTruthy();
    expect(entry.enabled).toBe(true);
  });

  it("accepts overrides", () => {
    const entry = createMockEntry({
      role: "lore",
      position: 5,
      keywords: ["dragon", "fire"],
      alwaysSend: true,
    });
    expect(entry.role).toBe("lore");
    expect(entry.position).toBe(5);
    expect(entry.keywords).toEqual(["dragon", "fire"]);
    expect(entry.alwaysSend).toBe(true);
  });

  it("passes Zod schema validation", () => {
    const entry = createMockEntry();
    const result = worldEntrySchema.safeParse(entry);
    expect(result.success).toBe(true);
  });
});

describe("factory: createMockRule", () => {
  it("creates a valid Rule with defaults", () => {
    const rule = createMockRule();
    expect(rule.name).toBe("Test Rule");
    expect(rule.conditionLogic).toBe("all");
    expect(rule.actions).toEqual([]);
    expect(rule.priority).toBe(0);
  });

  it("passes Zod schema validation", () => {
    const rule = createMockRule({
      conditions: [createMockCondition()],
    });
    const result = ruleSchema.safeParse(rule);
    expect(result.success).toBe(true);
  });
});

describe("factory: createMockWorld", () => {
  it("creates a valid WorldDefinition with defaults", () => {
    const world = createMockWorld();
    expect(world.name).toBe("Test World");
    expect(world.entries).toEqual([]);
    expect(world.variables).toEqual([]);
    expect(world.settings.maxTokens).toBe(4000);
  });

  it("accepts overrides including nested entries and variables", () => {
    const hp = createMockVariable({ id: "hp", name: "HP" });
    const npc = createMockEntry({ name: "Goblin", role: "character" });
    const world = createMockWorld({
      name: "Adventure",
      variables: [hp],
      entries: [npc],
    });
    expect(world.name).toBe("Adventure");
    expect(world.variables).toHaveLength(1);
    expect(world.entries).toHaveLength(1);
  });

  it("passes Zod schema validation", () => {
    const world = createMockWorld();
    const result = worldDefinitionSchema.safeParse(world);
    expect(result.success).toBe(true);
  });
});

describe("factory: createMockGameState", () => {
  it("creates a valid GameState with defaults", () => {
    const state = createMockGameState();
    expect(state.worldId).toBe("world-1");
    expect(state.turnCount).toBe(0);
    expect(state.variables).toEqual({});
    expect(state.metadata).toEqual({});
  });

  it("initializes from Variable definitions via fromVariables", () => {
    const hp = createMockVariable({ id: "hp", defaultValue: 100 });
    const gold = createMockVariable({ id: "gold", defaultValue: 50 });
    const state = createMockGameState({ fromVariables: [hp, gold] });
    expect(state.variables["hp"]).toBe(100);
    expect(state.variables["gold"]).toBe(50);
  });

  it("explicit variables override fromVariables", () => {
    const hp = createMockVariable({ id: "hp", defaultValue: 100 });
    const state = createMockGameState({
      fromVariables: [hp],
      variables: { hp: 50 },
    });
    expect(state.variables["hp"]).toBe(50);
  });

  it("passes Zod schema validation", () => {
    const state = createMockGameState({
      variables: { hp: 100, name: "Hero", alive: true },
    });
    const result = gameStateSchema.safeParse(state);
    expect(result.success).toBe(true);
  });
});

describe("factory: resetIdCounter", () => {
  it("resets IDs to produce deterministic sequences", () => {
    resetIdCounter();
    const v1 = createMockVariable();
    const v2 = createMockVariable();
    expect(v1.id).toBe("var-1");
    expect(v2.id).toBe("var-2");

    resetIdCounter();
    const v3 = createMockVariable();
    expect(v3.id).toBe("var-1");
  });
});
