import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GameStateManager, ReactionEvaluator, runReactionChain, buildTurnCompleteEvent } from "@yumina/engine";
import type { GameState, WorldDefinition } from "@yumina/engine";
import { normalizeGameState, reconcileTurnState } from "./game-state.js";
import { generationBaseline, regenerationState } from "./regeneration-state.js";

const world = { id: "w", variables: [
  { id: "meter", name: "meter", type: "number", defaultValue: 0 },
  { id: "inventory", name: "inventory", type: "json", defaultValue: { items: [] } },
  { id: "name", name: "name", type: "string", defaultValue: "", scope: "setup" },
  { id: "ui", name: "ui", type: "boolean", defaultValue: false },
], rules: [], entries: [] } as unknown as WorldDefinition;
const initial = () => normalizeGameState(world, { turnCount: 1 });
const json = (s: GameState) => s as unknown as Record<string, unknown>;
const add = (s: GameState, value: number) => {
  const engine = new GameStateManager(world, s);
  engine.applyEffects([{ variableId: "meter", operation: "add", value }]);
  return engine.getSnapshot();
};

describe("regeneration replaces the prior reply", () => {
  it("repeated rerolls start from the same baseline without advancing turns", () => {
    const baseline = initial();
    let after = add(baseline, 10);
    for (let i = 0; i < 3; i++) {
      const base = regenerationState(world, after, { generationState: json(baseline), stateSnapshot: json(after) });
      assert.equal(base.variables.meter, 0);
      after = reconcileTurnState(world, after, after, add(base, 10));
      assert.equal(after.variables.meter, 10);
      assert.equal(after.turnCount, 1);
    }
  });
  it("persists rollback even when the new response has no variable directives", () => {
    const baseline = initial(); const after = add(baseline, 10);
    const base = regenerationState(world, after, { generationState: json(baseline), stateSnapshot: json(after) });
    assert.equal(reconcileTurnState(world, after, after, base).variables.meter, 0);
  });
  it("restores JSON, rule fire counts and audio/context without mutating snapshots", () => {
    const baseline = initial(); const after = structuredClone(baseline);
    after.variables.inventory = { items: ["key"] };
    after.ruleState!.fireCounts.once = 1;
    after.ruleState!.cooldowns.once = 5;
    after.metadata.activeAudio = [{ trackId: "battle", action: "play" }];
    after.metadata.pendingContext = [{ message: "old reply" }];
    const base = regenerationState(world, after, { generationState: json(baseline), stateSnapshot: json(after) });
    assert.deepEqual(base.variables.inventory, { items: [] });
    assert.deepEqual(base.ruleState, baseline.ruleState);
    assert.equal(base.metadata.activeAudio, undefined);
    assert.equal(base.metadata.pendingContext, undefined);
    assert.equal(after.ruleState!.fireCounts.once, 1);
  });
  it("keeps subsequent UI edits and setup values", () => {
    const baseline = initial(); const after = add(baseline, 10);
    after.variables.name = "chosen";
    const live = structuredClone(after); live.variables.meter = 50; live.variables.ui = true;
    const base = regenerationState(world, live, { generationState: json(baseline), stateSnapshot: json(after) });
    assert.equal(base.variables.meter, 50);
    assert.equal(base.variables.ui, true);
    assert.equal(base.variables.name, "chosen");
  });
  it("keeps unrelated UI patches arriving while the original response streams", () => {
    const baseline = initial(); const live = structuredClone(baseline); live.variables.ui = true;
    const after = reconcileTurnState(world, live, baseline, add(baseline, 10));
    const savedBase = generationBaseline(world, live, baseline, baseline, add(baseline, 10));
    const base = regenerationState(world, after, { generationState: json(savedBase), stateSnapshot: json(after) });
    assert.equal(base.variables.meter, 0);
    assert.equal(base.variables.ui, true);
    const concurrent = structuredClone(after); concurrent.variables.name = "during regen";
    const result = reconcileTurnState(world, concurrent, after, base);
    assert.equal(result.variables.name, "during regen");
    assert.equal(result.variables.meter, 0);
  });
  it("uses the selected swipe's own baseline after switching alternatives", () => {
    const a = initial(); const b = add(a, 40); const after = add(b, 10);
    const base = regenerationState(world, after, { generationState: json(b), stateSnapshot: json(after) });
    assert.equal(add(base, 10).variables.meter, 50);
  });
  it("rewinds legacy ledgers in reverse order, including root JSON changes", () => {
    const previous = initial(); const after = add(previous, 20);
    after.variables.inventory = { items: ["key"] };
    after.ruleState!.fireCounts.once = 1;
    const base = regenerationState(world, after, { stateSnapshot: json(after), stateChanges: [
      { variableId: "meter", oldValue: 0, newValue: 10 },
      { variableId: "meter", oldValue: 10, newValue: 20 },
      { variableId: "inventory", oldValue: { items: [] }, newValue: { items: ["key"] } },
    ] }, json(previous));
    assert.equal(base.variables.meter, 0);
    assert.deepEqual(base.variables.inventory, { items: [] });
    assert.deepEqual(base.ruleState, previous.ruleState);
  });
  it("does not reset an old reply with no recoverable baseline to world defaults", () => {
    const current = add(initial(), 30);
    assert.equal(regenerationState(world, current, {}).variables.meter, 30);
  });
  it("does not adopt a concurrent write superseded by the reply", () => {
    const baseline = initial(); const live = add(baseline, 50); const final = add(baseline, 10);
    const saved = generationBaseline(world, live, baseline, baseline, final);
    assert.equal(saved.variables.meter, 0);
    assert.equal(add(regenerationState(world, final, { generationState: json(saved), stateSnapshot: json(final) }), 10).variables.meter, 10);
  });
  it("continuation keeps prior effects reversible and unrelated UI patches permanent", () => {
    const baseline = initial(); const first = add(baseline, 10);
    const request = structuredClone(first); request.variables.name = "after reply";
    const live = structuredClone(request); live.variables.ui = true;
    const continuation = add(request, 5);
    const before = regenerationState(world, request, { generationState: json(baseline), stateSnapshot: json(first) });
    const saved = generationBaseline(world, live, request, before, continuation);
    const after = reconcileTurnState(world, live, request, continuation);
    const redo = regenerationState(world, after, { generationState: json(saved), stateSnapshot: json(after) });
    assert.equal(after.variables.meter, 15);
    assert.equal(redo.variables.meter, 0);
    assert.equal(redo.variables.name, "after reply");
    assert.equal(redo.variables.ui, true);
  });
  it("restores the original queued context for each reroll without retaining discarded context", () => {
    const baseline = initial(); baseline.metadata.pendingContext = [{ message: "original instruction", role: "system" }];
    const after = add(baseline, 10); after.metadata.pendingContext = [{ message: "discarded reply instruction", role: "system" }];
    for (let i = 0; i < 2; i++) {
      const redo = regenerationState(world, after, { generationState: json(baseline), stateSnapshot: json(after) });
      assert.deepEqual(redo.metadata.pendingContext, baseline.metadata.pendingContext);
      const engine = new GameStateManager(world, redo);
      engine.setMetadata("pendingContext", undefined);
      const persisted = reconcileTurnState(world, after, after, engine.getSnapshot());
      assert.equal(persisted.metadata.pendingContext, undefined);
    }
  });
  it("a legacy reply followed by continuation can re-fire its one-shot rule", () => {
    const baseline = initial();
    const engine = new GameStateManager(world, baseline);
    const reactions = [{ id: "once", name: "Reward", enabled: true, priority: 0,
      when: { eventType: "turn:complete" }, conditions: [], conditionLogic: "all" as const,
      maxFireCount: 1, then: [{ type: "set" as const, path: "meter", operation: "add" as const, value: 10 }],
    }];
    const events = [buildTurnCompleteEvent(1)];
    const first = runReactionChain(new ReactionEvaluator(), engine, events, reactions, []);
    const after = engine.getSnapshot();
    assert.equal(after.variables.meter, 10);
    assert.equal(after.ruleState!.fireCounts.once, 1);
    const before = regenerationState(world, after, { stateSnapshot: json(after), stateChanges: first.changes }, json(baseline));
    const saved = generationBaseline(world, after, after, before, after);
    const redo = new GameStateManager(world, regenerationState(world, after, { generationState: json(saved), stateSnapshot: json(after) }));
    runReactionChain(new ReactionEvaluator(), redo, events, reactions, []);
    assert.equal(redo.get("meter"), 10);
    assert.equal(redo.getSnapshot().ruleState!.fireCounts.once, 1);
  });
});
