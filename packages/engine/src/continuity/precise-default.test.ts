import { describe, it, expect } from "vitest";
import { buildContinuityPlan, applyContinuityPlan } from "./index.js";
import { filterAiEffects, isContinuityOwned, suggestedContinuityDelta, withPreciseTrackingDefault } from "../state/variable-activation.js";
import { GameStateManager } from "../state/game-state-manager.js";
import type { Variable, WorldDefinition } from "../types/index.js";

const base = (over: Partial<Variable>): Variable => ({ id: "v", name: "v", type: "number", defaultValue: 0, ...over } as Variable);

describe("withPreciseTrackingDefault — new variables track precisely", () => {
  it("turns a number on with the suggested window (15% of range, else 10)", () => {
    expect(withPreciseTrackingDefault(base({ min: 0, max: 100 }))).toMatchObject({ precise: true, deltaDown: 15, deltaUp: 15 });
    expect(withPreciseTrackingDefault(base({}))).toMatchObject({ precise: true, deltaDown: 10, deltaUp: 10 });
    expect(suggestedContinuityDelta({ min: 0, max: 4 })).toBe(1);
  });

  it("keeps a window the author already gave", () => {
    expect(withPreciseTrackingDefault(base({ deltaDown: 0, deltaUp: 3 }))).toMatchObject({ precise: true, deltaDown: 0, deltaUp: 3 });
  });

  it("booleans on; strings only with options; json never", () => {
    expect(withPreciseTrackingDefault(base({ type: "boolean", defaultValue: false })).precise).toBe(true);
    expect(withPreciseTrackingDefault(base({ type: "string", defaultValue: "" })).precise).toBeUndefined();
    expect(withPreciseTrackingDefault(base({ type: "string", defaultValue: "", options: ["平静", "生气"] })).precise).toBe(true);
    expect(withPreciseTrackingDefault(base({ type: "json", defaultValue: [] })).precise).toBeUndefined();
  });

  it("never overrides an explicit choice, nor a variable the AI may not write", () => {
    expect(withPreciseTrackingDefault(base({ precise: false })).precise).toBe(false);
    expect(withPreciseTrackingDefault(base({ aiAccess: "read" })).precise).toBeUndefined();
    expect(withPreciseTrackingDefault(base({ aiAccess: "none" })).precise).toBeUndefined();
    expect(withPreciseTrackingDefault(base({ internal: true })).precise).toBeUndefined();
    expect(withPreciseTrackingDefault(base({ scope: "setup" })).precise).toBeUndefined();
  });
});

describe("a freshly created 好感度 actually moves through the continuity path", () => {
  const affinity = withPreciseTrackingDefault<Variable>({
    id: "affinity", name: "好感度", type: "number", defaultValue: 10, min: 0, max: 100,
    behaviorRules: "她被夸奖或被帮助时上升，被冒犯时下降",
  });
  const world = {
    id: "w", version: "1", name: "w", description: "", author: "", language: "zh",
    entries: [], rules: [], components: [], customUI: [], audioTracks: [],
    variables: [affinity],
  } as unknown as WorldDefinition;

  it("is owned by the judge in a world with default continuity settings", () => {
    expect(isContinuityOwned(world, affinity)).toBe(true);
  });

  it("gets a question, and the judge's answer becomes a state change", () => {
    const sm = new GameStateManager(world);
    const plan = buildContinuityPlan(world, sm.getSnapshot(), {
      playerText: "你今天真好看，我帮你把书搬上去吧", replyText: "她脸红了，小声说谢谢。", turnCount: 1,
      memory: {}, hasImageDirective: false, hasAudioDirective: false,
    });
    expect(plan).not.toBeNull();
    const q = plan!.questions["var__affinity"] as { criteria: Record<string, string> };
    expect(Object.keys(q.criteria)).toContain("+15");
    const result = applyContinuityPlan(plan!, { var__affinity: { type: "choice", probabilities: { "+5": 0.8, "+3": 0.2 } } }, 1, {});
    const changes = sm.applyEffects(result.effects);
    expect(changes.map((c) => [c.variableId, c.oldValue, c.newValue])).toEqual([["affinity", 10, 15]]);
  });

  it("falls back to the narrator's directive when the judge did not run this turn", () => {
    const sm = new GameStateManager(world);
    const effects = [{ variableId: "affinity", operation: "add" as const, value: 4 }];
    expect(filterAiEffects(world, sm.getSnapshot(), effects).kept).toEqual([]);
    expect(filterAiEffects(world, sm.getSnapshot(), effects, { judgeRan: false }).kept).toEqual(effects);
  });
});
