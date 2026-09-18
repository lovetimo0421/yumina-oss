import { describe, it, expect } from "vitest";
import { processSystemEffects, applySystemEffects } from "../systems/effect-processor.js";
import { GameStateManager } from "../state/game-state-manager.js";
import { isVariableActive } from "../state/variable-activation.js";
import { createMockVariable, createMockWorld } from "./test-utils.js";
import type { ReactionEffect } from "../events/types.js";

describe("@vars.enabled.* → variableToggles", () => {
  it("parses a boolean set into a variable toggle", () => {
    const effects: ReactionEffect[] = [
      { type: "set", path: "@vars.enabled.直播积分", value: true },
      { type: "set", path: "@vars.enabled.loot", value: false },
    ];
    const result = processSystemEffects(effects);
    expect(result.variableToggles).toEqual([
      { variableId: "直播积分", enabled: true },
      { variableId: "loot", enabled: false },
    ]);
    expect(result.variableEffects).toEqual([]);
  });

  it("ignores non-boolean values and empty ids", () => {
    const effects: ReactionEffect[] = [
      { type: "set", path: "@vars.enabled.loot", value: "yes" },
      { type: "set", path: "@vars.enabled.", value: true },
    ];
    const result = processSystemEffects(effects);
    expect(result.variableToggles).toEqual([]);
  });
});

describe("GameStateManager.toggleVariable", () => {
  it("records the override in ruleState.toggledVariables", () => {
    const world = createMockWorld({
      variables: [createMockVariable({ id: "loot", type: "number", defaultValue: 0 })],
    });
    const manager = new GameStateManager(world);
    manager.toggleVariable("loot", false);
    expect(manager.getSnapshot().ruleState?.toggledVariables).toEqual({ loot: false });
  });
});

describe("pipeline end-to-end", () => {
  it("a reaction toggle flips the variable's active state", () => {
    const loot = createMockVariable({ id: "loot", type: "number", defaultValue: 0 });
    const world = createMockWorld({ variables: [loot] });
    const manager = new GameStateManager(world);

    expect(isVariableActive(loot, manager.getSnapshot())).toBe(true);

    const systemResult = processSystemEffects([
      { type: "set", path: "@vars.enabled.loot", value: false },
    ]);
    applySystemEffects(manager, systemResult);

    expect(isVariableActive(loot, manager.getSnapshot())).toBe(false);
  });
});
