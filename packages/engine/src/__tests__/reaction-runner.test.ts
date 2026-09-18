import { describe, it, expect } from "vitest";
import { ReactionEvaluator } from "../reactions/reaction-evaluator.js";
import { runReactionChain } from "../reactions/reaction-runner.js";
import { GameStateManager } from "../state/game-state-manager.js";
import { createMockVariable, createMockWorld, createMockGameState } from "./test-utils.js";
import type { Reaction } from "../events/types.js";

function numVar(id: string) {
  return createMockVariable({ id, name: id, type: "number", defaultValue: 0 });
}

/** A reaction that fires on state:changed of a specific variable. */
function onVarChanged(id: string, varId: string, set: { path: string; value: number }): Reaction {
  return {
    id,
    name: id,
    when: { eventType: "state:changed", match: { variableId: { operator: "eq", value: varId } } },
    conditions: [],
    conditionLogic: "all",
    then: [{ type: "set", path: set.path, value: set.value, operation: "set" }],
    priority: 0,
    enabled: true,
  };
}

describe("runReactionChain", () => {
  const evaluator = new ReactionEvaluator();

  it("cascades A→B→C across hops via state:changed", () => {
    const mgr = new GameStateManager(createMockWorld({ variables: [numVar("a"), numVar("b"), numVar("c")] }));

    const reactions: Reaction[] = [
      // RA fires on turn:complete, sets a=1
      {
        id: "RA", name: "RA", when: { eventType: "turn:complete" },
        conditions: [], conditionLogic: "all",
        then: [{ type: "set", path: "a", value: 1, operation: "set" }],
        priority: 0, enabled: true,
      },
      onVarChanged("RB", "a", { path: "b", value: 1 }), // a changed → b=1
      onVarChanged("RC", "b", { path: "c", value: 1 }), // b changed → c=1
    ];

    const result = runReactionChain(evaluator, mgr, [{ type: "turn:complete", turnCount: 1 }], reactions, []);

    const snap = mgr.getSnapshot();
    expect(snap.variables.a).toBe(1);
    expect(snap.variables.b).toBe(1); // only reachable via cascade
    expect(snap.variables.c).toBe(1); // two hops deep
    expect(result.firedIds).toEqual(["RA", "RB", "RC"]);
  });

  it("does NOT cascade with a single evaluation (control)", () => {
    const mgr = new GameStateManager(createMockWorld({ variables: [numVar("a"), numVar("b")] }));
    const reactions: Reaction[] = [
      {
        id: "RA", name: "RA", when: { eventType: "turn:complete" },
        conditions: [], conditionLogic: "all",
        then: [{ type: "set", path: "a", value: 1, operation: "set" }],
        priority: 0, enabled: true,
      },
      onVarChanged("RB", "a", { path: "b", value: 1 }),
    ];

    // One evaluation on the turn event alone never sees the state:changed(a).
    const single = evaluator.evaluateMultiple([{ type: "turn:complete", turnCount: 1 }], reactions, [], mgr.getSnapshot());
    expect(single.firedIds).toEqual(["RA"]);
  });

  it("fires a self-retriggering reaction at most once per chain (loop guard)", () => {
    const mgr = new GameStateManager(createMockWorld({ variables: [numVar("x")] }));
    const loopReaction: Reaction = {
      id: "RLoop", name: "RLoop",
      when: { eventType: "state:changed", match: { variableId: { operator: "eq", value: "x" } } },
      conditions: [], conditionLogic: "all",
      then: [{ type: "set", path: "x", value: 1, operation: "add" }], // changing x would re-trigger itself
      priority: 0, enabled: true,
    };

    const result = runReactionChain(
      evaluator, mgr,
      [{ type: "state:changed", variableId: "x", oldValue: 0, newValue: 0 }],
      [loopReaction], [],
    );

    expect(result.firedIds).toEqual(["RLoop"]); // fired exactly once, no infinite loop
    expect(mgr.getSnapshot().variables.x).toBe(1);
  });

  it("records fires so cooldown/maxFireCount can take effect", () => {
    const world = createMockWorld({ variables: [numVar("a")] });
    const mgr = new GameStateManager(world, createMockGameState({ worldId: world.id, variables: { a: 0 }, turnCount: 2 }));
    const reactions: Reaction[] = [{
      id: "RA", name: "RA", when: { eventType: "turn:complete" },
      conditions: [], conditionLogic: "all",
      then: [{ type: "set", path: "a", value: 1, operation: "set" }],
      priority: 0, cooldownTurns: 3, enabled: true,
    }];

    runReactionChain(evaluator, mgr, [{ type: "turn:complete", turnCount: 2 }], reactions, []);

    const rs = mgr.getSnapshot().ruleState!;
    expect(rs.fireCounts.RA).toBe(1);
    expect(rs.cooldowns.RA).toBe(5); // turnCount(2) + cooldownTurns(3)
  });

  it("records a broad reaction once per hop even if it matches multiple events", () => {
    const world = createMockWorld({ variables: [numVar("a"), numVar("hits")] });
    const mgr = new GameStateManager(world, createMockGameState({ worldId: world.id, variables: { a: 0, hits: 0 }, turnCount: 1 }));
    const broad: Reaction = {
      id: "RB", name: "RB",
      when: { eventType: "state:changed" }, // no variable filter → matches ANY change
      conditions: [], conditionLogic: "all",
      then: [{ type: "set", path: "hits", value: 1, operation: "add" }],
      priority: 0, enabled: true,
    };

    // Two state:changed events in the same hop both match the broad reaction.
    const result = runReactionChain(
      evaluator, mgr,
      [
        { type: "state:changed", variableId: "a", oldValue: 0, newValue: 1 },
        { type: "state:changed", variableId: "b", oldValue: 0, newValue: 1 },
      ],
      [broad], [],
    );

    // Fire-count and returned firedIds are recorded once per hop, not once per matched event.
    expect(mgr.getSnapshot().ruleState!.fireCounts.RB).toBe(1);
    expect(result.firedIds.filter((id) => id === "RB")).toHaveLength(1);
    expect(mgr.get("hits")).toBe(1);
  });

  it("advances a day once when multiple time changes share a final morning state", () => {
    const world = createMockWorld({ variables: [
      numVar("day"),
      createMockVariable({ id: "time", name: "time", type: "string", defaultValue: "night" }),
    ] });
    const mgr = new GameStateManager(world);
    mgr.set("day", 1);
    const changes = mgr.applyEffects([
      { variableId: "time", operation: "set", value: "afternoon" },
      { variableId: "time", operation: "set", value: "morning" },
    ]);
    const reaction: Reaction = {
      id: "next-day", name: "Next day", enabled: true, priority: 0,
      when: { eventType: "state:changed", match: { variableId: { operator: "eq", value: "time" } } },
      conditions: [{ variableId: "time", operator: "eq", value: "morning" }],
      conditionLogic: "all",
      then: [
        { type: "set", path: "day", operation: "add", value: 1 },
        { type: "set", path: "@ui.notification", value: "A new day" },
      ],
    };
    const result = runReactionChain(evaluator, mgr,
      changes.map(c => ({ type: "state:changed", ...c })), [reaction], []);
    expect(mgr.get("day")).toBe(2);
    expect(result.notifications).toHaveLength(1);
  });
});
