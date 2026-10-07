import { describe, it, expect } from "vitest";
import {
  isVariableActive,
  isAiReadable,
  isAiWritable,
  resolveActiveVariableIds,
  filterAiEffects,
} from "../state/variable-activation.js";
import { isMemberActive } from "../lorebook/worldbook.js";
import { ReactionEvaluator } from "../reactions/reaction-evaluator.js";
import { runReactionChain } from "../reactions/reaction-runner.js";
import { GameStateManager } from "../state/game-state-manager.js";
import { variableSchema, ruleSchema, reactionSchema } from "../world/schema.js";
import {
  createMockVariable,
  createMockWorld,
  createMockGameState,
  createMockEffect,
  createMockRule,
} from "./test-utils.js";
import type { Worldbook } from "../types/index.js";
import type { Reaction } from "../events/types.js";

/** A conditions-mode worldbook active while `gateVar` equals `value`. */
function conditionsBook(id: string, gateVar: string, value: number): Worldbook {
  return {
    id,
    name: id,
    activation: {
      mode: "conditions",
      conditions: [{ variableId: gateVar, operator: "eq", value }],
      conditionLogic: "all",
    },
    order: 0,
  };
}

const alwaysBook = (id: string): Worldbook => ({ id, name: id, activation: { mode: "always" }, order: 0 });

describe("isMemberActive", () => {
  it("treats no-worldbookId members as always-on Core", () => {
    const state = createMockGameState({ fromVariables: [] });
    expect(isMemberActive(undefined, [conditionsBook("b", "g", 1)], state)).toBe(true);
  });

  it("fails open for an orphaned worldbookId", () => {
    const state = createMockGameState({ fromVariables: [] });
    expect(isMemberActive("ghost", [alwaysBook("real")], state)).toBe(true);
  });

  it("passes through when the card has no worldbooks at all", () => {
    const state = createMockGameState({ fromVariables: [] });
    expect(isMemberActive("anything", undefined, state)).toBe(true);
    expect(isMemberActive("anything", [], state)).toBe(true);
  });

  it("gates members of an inactive conditions-book", () => {
    const gate = createMockVariable({ id: "g", type: "number", defaultValue: 0 });
    const state = createMockGameState({ fromVariables: [gate] });
    expect(isMemberActive("b", [conditionsBook("b", "g", 1)], state)).toBe(false);
  });

  it("gates members of a disabled book regardless of activation mode", () => {
    const state = createMockGameState({ fromVariables: [] });
    const off: Worldbook = { ...alwaysBook("b"), enabled: false };
    expect(isMemberActive("b", [off], state)).toBe(false);
  });
});

describe("variable module gating", () => {
  it("deactivates a variable whose worldbook is inactive", () => {
    const gate = createMockVariable({ id: "g", type: "number", defaultValue: 0 });
    const v = createMockVariable({ id: "v", worldbookId: "b" });
    const state = createMockGameState({ fromVariables: [gate, v] });
    expect(isVariableActive(v, state, [conditionsBook("b", "g", 1)])).toBe(false);
  });

  it("keeps a variable active when its worldbook is active (AND with its own gates)", () => {
    const gate = createMockVariable({ id: "g", type: "number", defaultValue: 1 });
    const v = createMockVariable({ id: "v", worldbookId: "b" });
    const state = createMockGameState({ fromVariables: [gate, v] });
    const books = [conditionsBook("b", "g", 1)];
    expect(isVariableActive(v, state, books)).toBe(true);
    // own enable gate still applies on top of the module gate
    const disabled = createMockVariable({ id: "v2", worldbookId: "b", enabled: false });
    expect(isVariableActive(disabled, state, books)).toBe(false);
  });

  it("evaluates book conditions against RAW values — an inactive gate variable still opens its book (layered evaluation, no cycles)", () => {
    // gate itself is deactivated (enabled:false) but holds raw value 1.
    const gate = createMockVariable({ id: "g", type: "number", defaultValue: 1, enabled: false });
    const v = createMockVariable({ id: "v", worldbookId: "b" });
    const state = createMockGameState({ fromVariables: [gate, v] });
    expect(isVariableActive(v, state, [conditionsBook("b", "g", 1)])).toBe(true);
  });

  it("fails open when the variable's worldbook no longer exists", () => {
    const v = createMockVariable({ id: "v", worldbookId: "ghost" });
    const state = createMockGameState({ fromVariables: [v] });
    expect(isVariableActive(v, state, [alwaysBook("real")])).toBe(true);
  });

  it("blocks AI read and write for a module-gated variable", () => {
    const gate = createMockVariable({ id: "g", type: "number", defaultValue: 0 });
    const v = createMockVariable({ id: "v", worldbookId: "b" });
    const state = createMockGameState({ fromVariables: [gate, v] });
    const books = [conditionsBook("b", "g", 1)];
    expect(isAiReadable(v, state, books)).toBe(false);
    expect(isAiWritable(v, state, books)).toBe(false);
  });

  it("resolveActiveVariableIds excludes module-gated variables", () => {
    const gate = createMockVariable({ id: "g", type: "number", defaultValue: 0 });
    const inBook = createMockVariable({ id: "in-book", worldbookId: "b" });
    const core = createMockVariable({ id: "core" });
    const world = createMockWorld({
      variables: [gate, inBook, core],
      worldbooks: [conditionsBook("b", "g", 1)],
    });
    const state = createMockGameState({ fromVariables: world.variables });
    const active = resolveActiveVariableIds(world, state);
    expect(active.has("core")).toBe(true);
    expect(active.has("in-book")).toBe(false);
  });

  it("filterAiEffects drops AI writes to module-gated variables", () => {
    const gate = createMockVariable({ id: "g", type: "number", defaultValue: 0 });
    const v = createMockVariable({ id: "v", worldbookId: "b" });
    const world = createMockWorld({
      variables: [gate, v],
      worldbooks: [conditionsBook("b", "g", 1)],
    });
    const state = createMockGameState({ fromVariables: world.variables });
    const { kept, dropped } = filterAiEffects(world, state, [
      createMockEffect({ variableId: "v" }),
      createMockEffect({ variableId: "g" }),
    ]);
    expect(dropped.map((e) => e.variableId)).toEqual(["v"]);
    expect(kept.map((e) => e.variableId)).toEqual(["g"]);
  });
});

describe("reaction/rule module gating", () => {
  const evaluator = new ReactionEvaluator();

  function reactionOn(id: string, eventType: string, set: { path: string; value: number }, worldbookId?: string): Reaction {
    return {
      id,
      name: id,
      when: { eventType },
      conditions: [],
      conditionLogic: "all",
      then: [{ type: "set", path: set.path, value: set.value, operation: "set" }],
      priority: 0,
      enabled: true,
      worldbookId,
    };
  }

  const numVar = (id: string, value = 0) =>
    createMockVariable({ id, name: id, type: "number", defaultValue: value });

  it("does not fire a reaction whose worldbook is inactive", () => {
    const world = createMockWorld({ variables: [numVar("g"), numVar("out")] });
    const mgr = new GameStateManager(world);
    const reactions = [reactionOn("R", "turn:complete", { path: "out", value: 1 }, "b")];
    const result = runReactionChain(
      evaluator, mgr, [{ type: "turn:complete", turnCount: 1 }], reactions, [],
      { worldbooks: [conditionsBook("b", "g", 1)] },
    );
    expect(result.firedIds).toEqual([]);
    expect(mgr.getSnapshot().variables.out).toBe(0);
  });

  it("fires normally when no worldbooks are passed (back-compat)", () => {
    const world = createMockWorld({ variables: [numVar("out")] });
    const mgr = new GameStateManager(world);
    const reactions = [reactionOn("R", "turn:complete", { path: "out", value: 1 }, "b")];
    const result = runReactionChain(evaluator, mgr, [{ type: "turn:complete", turnCount: 1 }], reactions, []);
    expect(result.firedIds).toEqual(["R"]);
  });

  it("lets a module activated mid-chain join later hops", () => {
    // RA (Core) opens the gate; RB lives in book b which becomes active only
    // after RA's write — RB must still fire on the resulting state:changed hop.
    const world = createMockWorld({ variables: [numVar("g"), numVar("out")] });
    const mgr = new GameStateManager(world);
    const reactions: Reaction[] = [
      reactionOn("RA", "turn:complete", { path: "g", value: 1 }),
      {
        ...reactionOn("RB", "state:changed", { path: "out", value: 1 }, "b"),
        when: { eventType: "state:changed", match: { variableId: { operator: "eq", value: "g" } } },
      },
    ];
    const result = runReactionChain(
      evaluator, mgr, [{ type: "turn:complete", turnCount: 1 }], reactions, [],
      { worldbooks: [conditionsBook("b", "g", 1)] },
    );
    expect(result.firedIds).toEqual(["RA", "RB"]);
    expect(mgr.getSnapshot().variables.out).toBe(1);
  });

  it("gates legacy rules by worldbook too", () => {
    const world = createMockWorld({ variables: [numVar("g"), numVar("out")] });
    const mgr = new GameStateManager(world);
    const rule = createMockRule({
      id: "LR",
      trigger: { type: "every-turn" },
      actions: [{ type: "modify-variable", variableId: "out", operation: "set", value: 1 }],
      worldbookId: "b",
    });
    const result = runReactionChain(
      evaluator, mgr, [{ type: "turn:complete", turnCount: 1 }], [], [rule],
      { worldbooks: [conditionsBook("b", "g", 1)] },
    );
    expect(result.firedIds).toEqual([]);
    expect(mgr.getSnapshot().variables.out).toBe(0);
  });
});

describe("schema round-trip of worldbookId", () => {
  it("variableSchema preserves worldbookId", () => {
    const parsed = variableSchema.parse({
      id: "v", name: "v", type: "number", defaultValue: 0, worldbookId: "b",
    });
    expect(parsed.worldbookId).toBe("b");
  });

  it("ruleSchema preserves worldbookId", () => {
    const parsed = ruleSchema.parse({
      id: "r", name: "r", trigger: { type: "every-turn" },
      conditions: [], conditionLogic: "all", actions: [], priority: 0, enabled: true,
      worldbookId: "b",
    });
    expect(parsed.worldbookId).toBe("b");
  });

  it("reactionSchema preserves worldbookId", () => {
    const parsed = reactionSchema.parse({
      id: "r", name: "r", when: { eventType: "turn:complete" },
      conditions: [], conditionLogic: "all", then: [], priority: 0, enabled: true,
      worldbookId: "b",
    });
    expect(parsed.worldbookId).toBe("b");
  });
});
