import { describe, expect, it } from "vitest";
import { GameStateManager } from "../state/game-state-manager.js";
import { aiDropReason, filterAiEffects, isContinuityEligible, withPreciseTrackingDefault } from "../state/variable-activation.js";
import { buildContinuityPlan, applyContinuityPlan } from "../continuity/index.js";
import { variableSchema } from "../world/schema.js";
import { createMockVariable, createMockWorld } from "./test-utils.js";

describe("one AI writer per variable", () => {
  it("the judge respects read-only and formula ownership even with precise enabled", () => {
    for (const over of [{ aiAccess: "read" as const }, { formula: "1 + 1" }]) {
      const v = createMockVariable({ id: "counter", precise: true, deltaDown: 5, deltaUp: 5, ...over });
      expect(isContinuityEligible(v)).toBe(false);
      const w = createMockWorld({ variables: [v] });
      const sm = new GameStateManager(w);
      expect(buildContinuityPlan(w, sm.getSnapshot(), {
        playerText: "Continue.", replyText: "A quiet moment.", turnCount: 1,
        memory: {}, hasAudioDirective: false, hasImageDirective: false,
      })).toBeNull();
    }
    expect(withPreciseTrackingDefault(createMockVariable({ formula: "1 + 1" })).precise).toBeUndefined();
  });

  it("display-name and bracket writes cannot bypass ownership", () => {
    const w = createMockWorld({ variables: [
      createMockVariable({ id: "count", name: "Round counter", aiAccess: "read" }),
      createMockVariable({ id: "items", name: "Items", type: "json", defaultValue: [1], aiAccess: "read" }),
      createMockVariable({ id: "aff", name: "Affinity", precise: true, deltaDown: 5, deltaUp: 5 }),
    ] });
    const sm = new GameStateManager(w);
    const effects = [
      { variableId: "Round counter", operation: "add" as const, value: 1 },
      { variableId: "items[0]", operation: "set" as const, value: 0 },
      { variableId: "Affinity", operation: "add" as const, value: 3 },
    ];
    expect(filterAiEffects(w, sm.getSnapshot(), effects).kept).toEqual([]);
    expect(effects.map(e => aiDropReason(w, sm.getSnapshot(), e))).toEqual(["read-only", "read-only", "judge"]);
    expect(filterAiEffects(w, sm.getSnapshot(), effects, { judgeRan: false }).kept).toEqual([effects[2]]);
  });

  it("name lookup follows the engine's ID-first, last-name-wins contract", () => {
    const w = createMockWorld({ variables: [
      createMockVariable({ id: "one", name: "duplicate" }),
      createMockVariable({ id: "two", name: "duplicate", aiAccess: "read" }),
      createMockVariable({ id: "collision", name: "one", aiAccess: "read" }),
    ] });
    const sm = new GameStateManager(w);
    const effects = [
      { variableId: "duplicate", operation: "add" as const, value: 1 },
      { variableId: "one", operation: "add" as const, value: 1 },
    ];
    expect(filterAiEffects(w, sm.getSnapshot(), effects).kept).toEqual([effects[1]]);
  });
});

describe("explicit once-true flags", () => {
  const flag = () => variableSchema.parse({
    id: "confessed", name: "Ever accepted", type: "boolean", defaultValue: false, onceTrue: true,
    precise: true, behaviorRules: "Once accepted, this fact stays true.",
  });

  it("survives import and blocks later AI or rule writes in the same and subsequent turns", () => {
    const v = flag();
    expect(v).toHaveProperty("onceTrue", true);
    const sm = new GameStateManager(createMockWorld({ variables: [v] }));
    expect(sm.applyEffects([
      { variableId: v.id, operation: "set", value: true },
      { variableId: v.id, operation: "set", value: false },
      { variableId: v.id, operation: "toggle", value: false },
    ])).toEqual([{ variableId: v.id, oldValue: false, newValue: true }]);
    sm.incrementTurn();
    sm.set("Ever accepted", false);
    expect(sm.get(v.id)).toBe(true);
    expect(sm.drainBlockedWrites().map(b => b.reason)).toEqual(["once-true", "once-true", "once-true"]);
    expect(sm.drainBlockedWrites()).toEqual([]);
  });

  it("a later rejected confession cannot erase an earlier accepted one", () => {
    const v = flag();
    const w = createMockWorld({ variables: [v] });
    const sm = new GameStateManager(w);
    sm.set(v.id, true);
    const plan = buildContinuityPlan(w, sm.getSnapshot(), {
      playerText: "I confess to another character.", replyText: "She refuses because I already have a partner.",
      turnCount: 2, memory: {}, hasAudioDirective: false, hasImageDirective: false,
    })!;
    const out = applyContinuityPlan(plan, { var__confessed: { noul: 0.01 } }, 2, {});
    sm.applyEffects(out.effects);
    expect(sm.get(v.id)).toBe(true);
  });

  it("ordinary booleans stay reversible, and rewind restores the earlier timeline", () => {
    const w = createMockWorld({ variables: [flag(), createMockVariable({ id: "door", type: "boolean", defaultValue: true })] });
    const sm = new GameStateManager(w);
    const before = sm.getSnapshot();
    sm.set("confessed", true);
    sm.applyEffects([{ variableId: "door", operation: "toggle", value: false }]);
    expect(sm.get("door")).toBe(false);
    sm.loadSnapshot(before);
    expect(sm.get("confessed")).toBe(false);
  });

  it("derived boolean facts stay true after their input falls again", () => {
    const w = createMockWorld({ variables: [
      { ...flag(), formula: "{score} >= 10" },
      createMockVariable({ id: "score", defaultValue: 0 }),
    ] });
    const sm = new GameStateManager(w);
    sm.applyEffects([{ variableId: "score", operation: "set", value: 10 }]);
    expect(sm.get("confessed")).toBe(true);
    sm.applyEffects([{ variableId: "score", operation: "set", value: 0 }]);
    expect(sm.get("confessed")).toBe(true);
  });
});
