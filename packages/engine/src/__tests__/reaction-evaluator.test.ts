import { describe, it, expect, vi, afterEach } from "vitest";
import { ReactionEvaluator, resolveDynamicEffect } from "../reactions/reaction-evaluator.js";
import type { Reaction, ReactionEffect } from "../events/types.js";
import type { Rule, GameState } from "../types/index.js";

function makeState(vars: GameState["variables"] = {}, turnCount = 0): GameState {
  return {
    worldId: "test",
    variables: vars,
    turnCount,
    metadata: {},
  };
}

describe("ReactionEvaluator", () => {
  const evaluator = new ReactionEvaluator();

  describe("basic event matching", () => {
    it("fires a reaction when event matches pattern", () => {
      const reactions: Reaction[] = [{
        id: "r1",
        name: "On Turn",
        when: { eventType: "turn:complete" },
        conditions: [],
        conditionLogic: "all",
        then: [{ type: "set", path: "counter", value: 1, operation: "add" }],
        priority: 0,
        enabled: true,
      }];

      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 1 },
        reactions, [], makeState()
      );

      expect(result.firedIds).toContain("r1");
      expect(result.legacyEffects).toHaveLength(1);
      expect(result.legacyEffects[0]!.variableId).toBe("counter");
    });

    it("does not fire when event type doesn't match", () => {
      const reactions: Reaction[] = [{
        id: "r1",
        name: "On Turn",
        when: { eventType: "session:start" },
        conditions: [],
        conditionLogic: "all",
        then: [{ type: "set", path: "x", value: 1 }],
        priority: 0,
        enabled: true,
      }];

      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 1 },
        reactions, [], makeState()
      );

      expect(result.firedIds).toHaveLength(0);
    });

    it("matches event data fields with conditions", () => {
      const reactions: Reaction[] = [{
        id: "r1",
        name: "HP Crossed",
        when: {
          eventType: "state:crossed",
          match: {
            variableId: { operator: "eq", value: "hp" },
            direction: { operator: "eq", value: "drops-below" },
          },
        },
        conditions: [],
        conditionLogic: "all",
        then: [{ type: "emit", event: { type: "ui:notification", message: "Low HP!" } }],
        priority: 0,
        enabled: true,
      }];

      const result = evaluator.evaluate(
        { type: "state:crossed", variableId: "hp", direction: "drops-below", threshold: 20 },
        reactions, [], makeState()
      );

      expect(result.firedIds).toContain("r1");
      expect(result.notifications).toHaveLength(1);
      expect(result.notifications[0]!.message).toBe("Low HP!");
    });
  });

  describe("stopConditions (STOP clause)", () => {
    const makeReaction = (overrides: Partial<Reaction> = {}): Reaction => ({
      id: "r1",
      name: "Every 2 turns until done",
      when: {
        eventType: "turn:complete",
        match: { turnCount: { operator: "every", value: 2 } },
      },
      conditions: [],
      conditionLogic: "all",
      then: [{ type: "set", path: "counter", value: 1, operation: "add" }],
      priority: 0,
      enabled: true,
      ...overrides,
    });

    it("fires while no stop condition is met", () => {
      const reactions = [makeReaction({
        stopConditions: [{ variableId: "好感度", operator: "gte", value: 100 }],
      })];
      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 4 },
        reactions, [], makeState({ 好感度: 50 }, 4)
      );
      expect(result.firedIds).toContain("r1");
    });

    it("stops firing once a stop condition is met", () => {
      const reactions = [makeReaction({
        stopConditions: [{ variableId: "好感度", operator: "gte", value: 100 }],
      })];
      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 4 },
        reactions, [], makeState({ 好感度: 100 }, 4)
      );
      expect(result.firedIds).toHaveLength(0);
    });

    it("ANY stop condition met suppresses the reaction", () => {
      const reactions = [makeReaction({
        stopConditions: [
          { variableId: "好感度", operator: "gte", value: 100 },
          { variableId: "结局", operator: "eq", value: true },
        ],
      })];
      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 2 },
        reactions, [], makeState({ 好感度: 10, 结局: true }, 2)
      );
      expect(result.firedIds).toHaveLength(0);
    });

    it("empty stopConditions behaves like no stop conditions", () => {
      const reactions = [makeReaction({ stopConditions: [] })];
      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 2 },
        reactions, [], makeState({}, 2)
      );
      expect(result.firedIds).toContain("r1");
    });

    it("a stop condition on an undefined variable never suppresses", () => {
      const reactions = [makeReaction({
        stopConditions: [{ variableId: "不存在", operator: "gte", value: 1 }],
      })];
      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 2 },
        reactions, [], makeState({}, 2)
      );
      expect(result.firedIds).toContain("r1");
    });

    it("works together with maxFireCount on an every-turn reaction", () => {
      // "Every turn, stop after firing twice" — maxFireCount handles the
      // repeat cap; here we verify the third evaluation is suppressed.
      const reactions = [makeReaction({
        when: { eventType: "turn:complete" },
        maxFireCount: 2,
      })];
      const state = makeState({}, 3);
      state.ruleState = {
        disabledRules: [],
        activeDirectives: [],
        cooldowns: {},
        fireCounts: { r1: 2 },
        prevVars: {},
        toggledEntries: {},
      };
      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 3 },
        reactions, [], state
      );
      expect(result.firedIds).toHaveLength(0);
    });
  });

  describe("conditions (IF clause)", () => {
    it("fires when all conditions pass (conditionLogic=all)", () => {
      const reactions: Reaction[] = [{
        id: "r1",
        name: "Test",
        when: { eventType: "turn:complete" },
        conditions: [
          { variableId: "hp", operator: "lt", value: 50 },
          { variableId: "combat", operator: "eq", value: true },
        ],
        conditionLogic: "all",
        then: [{ type: "set", path: "warned", value: true }],
        priority: 0,
        enabled: true,
      }];

      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 1 },
        reactions, [],
        makeState({ hp: 30, combat: true })
      );
      expect(result.firedIds).toContain("r1");
    });

    it("does not fire when one condition fails (conditionLogic=all)", () => {
      const reactions: Reaction[] = [{
        id: "r1",
        name: "Test",
        when: { eventType: "turn:complete" },
        conditions: [
          { variableId: "hp", operator: "lt", value: 50 },
          { variableId: "combat", operator: "eq", value: true },
        ],
        conditionLogic: "all",
        then: [{ type: "set", path: "warned", value: true }],
        priority: 0,
        enabled: true,
      }];

      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 1 },
        reactions, [],
        makeState({ hp: 30, combat: false })
      );
      expect(result.firedIds).toHaveLength(0);
    });

    it("fires when any condition passes (conditionLogic=any)", () => {
      const reactions: Reaction[] = [{
        id: "r1",
        name: "Test",
        when: { eventType: "turn:complete" },
        conditions: [
          { variableId: "hp", operator: "lt", value: 50 },
          { variableId: "mp", operator: "lt", value: 10 },
        ],
        conditionLogic: "any",
        then: [{ type: "set", path: "warned", value: true }],
        priority: 0,
        enabled: true,
      }];

      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 1 },
        reactions, [],
        makeState({ hp: 80, mp: 5 })
      );
      expect(result.firedIds).toContain("r1");
    });
  });

  describe("legacy Rule backward compatibility", () => {
    it("evaluates legacy Rules alongside Reactions", () => {
      const rules: Rule[] = [{
        id: "legacy1",
        name: "Legacy Every Turn",
        trigger: { type: "every-turn" },
        conditions: [],
        conditionLogic: "all",
        actions: [{ type: "modify-variable", variableId: "gold", operation: "add", value: 5 }],
        priority: 0,
        enabled: true,
      }];

      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 1 },
        [], rules, makeState({ gold: 100 })
      );

      expect(result.firedIds).toContain("legacy1");
      expect(result.legacyEffects).toHaveLength(1);
      expect(result.legacyEffects[0]!.variableId).toBe("gold");
      expect(result.legacyEffects[0]!.operation).toBe("add");
      expect(result.legacyEffects[0]!.value).toBe(5);
    });

    it("evaluates legacy keyword triggers via keyword matching engine", () => {
      const rules: Rule[] = [{
        id: "kw1",
        name: "Attack Keyword",
        trigger: { type: "keyword", keywords: ["attack", "fight"] },
        conditions: [],
        conditionLogic: "all",
        actions: [{ type: "modify-variable", variableId: "combat", operation: "set", value: true }],
        priority: 0,
        enabled: true,
      }];

      const result = evaluator.evaluate(
        { type: "message:user", content: "I attack the goblin" },
        [], rules, makeState()
      );

      expect(result.firedIds).toContain("kw1");
    });

    it("does not fire keyword rule when no keyword matches", () => {
      const rules: Rule[] = [{
        id: "kw1",
        name: "Attack Keyword",
        trigger: { type: "keyword", keywords: ["attack", "fight"] },
        conditions: [],
        conditionLogic: "all",
        actions: [{ type: "modify-variable", variableId: "combat", operation: "set", value: true }],
        priority: 0,
        enabled: true,
      }];

      const result = evaluator.evaluate(
        { type: "message:user", content: "I pick up the flower" },
        [], rules, makeState()
      );

      expect(result.firedIds).toHaveLength(0);
    });

    it("evaluates legacy play-audio actions as emitted events", () => {
      const rules: Rule[] = [{
        id: "audio1",
        name: "Play Battle Music",
        trigger: { type: "every-turn" },
        conditions: [{ variableId: "combat", operator: "eq", value: true }],
        conditionLogic: "all",
        actions: [{ type: "play-audio", trackId: "battle_bgm", action: "play" }],
        priority: 0,
        enabled: true,
      }];

      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 1 },
        [], rules, makeState({ combat: true })
      );

      expect(result.firedIds).toContain("audio1");
      expect(result.legacyAudioEffects).toHaveLength(1);
      expect(result.legacyAudioEffects[0]!.trackId).toBe("battle_bgm");
    });

    it("evaluates legacy turn-count with everyNTurns", () => {
      const rules: Rule[] = [{
        id: "tc1",
        name: "Every 3 Turns",
        trigger: { type: "turn-count", everyNTurns: 3 },
        conditions: [],
        conditionLogic: "all",
        actions: [{ type: "modify-variable", variableId: "regen", operation: "add", value: 1 }],
        priority: 0,
        enabled: true,
      }];

      // Turn 3 — should fire
      const r3 = evaluator.evaluate(
        { type: "turn:complete", turnCount: 3 },
        [], rules, makeState({}, 3)
      );
      expect(r3.firedIds).toContain("tc1");

      // Turn 4 — should not fire
      const r4 = evaluator.evaluate(
        { type: "turn:complete", turnCount: 4 },
        [], rules, makeState({}, 4)
      );
      expect(r4.firedIds).toHaveLength(0);

      // Turn 6 — should fire
      const r6 = evaluator.evaluate(
        { type: "turn:complete", turnCount: 6 },
        [], rules, makeState({}, 6)
      );
      expect(r6.firedIds).toContain("tc1");
    });

    it("evaluates legacy variable-crossed rises-above via state:changed oldValue/newValue", () => {
      const rules: Rule[] = [{
        id: "vc1",
        name: "HP Above 50",
        trigger: { type: "variable-crossed", variableId: "hp", direction: "rises-above", threshold: 50 },
        conditions: [],
        conditionLogic: "all",
        actions: [{ type: "notify-player", message: "HP recovered!", style: "info" }],
        priority: 0,
        enabled: true,
      }];

      // Crosses above 50: 40 → 60
      const r1 = evaluator.evaluate(
        { type: "state:changed", variableId: "hp", oldValue: 40, newValue: 60 },
        [], rules, makeState({ hp: 60 })
      );
      expect(r1.firedIds).toContain("vc1");
      expect(r1.notifications).toHaveLength(1);

      // Does not cross: 60 → 70 (already above)
      const r2 = evaluator.evaluate(
        { type: "state:changed", variableId: "hp", oldValue: 60, newValue: 70 },
        [], rules, makeState({ hp: 70 })
      );
      expect(r2.firedIds).toHaveLength(0);

      // Does not cross: 30 → 45 (still below)
      const r3 = evaluator.evaluate(
        { type: "state:changed", variableId: "hp", oldValue: 30, newValue: 45 },
        [], rules, makeState({ hp: 45 })
      );
      expect(r3.firedIds).toHaveLength(0);
    });

    it("evaluates legacy variable-crossed drops-below via state:changed oldValue/newValue", () => {
      const rules: Rule[] = [{
        id: "vc2",
        name: "HP Below 20",
        trigger: { type: "variable-crossed", variableId: "hp", direction: "drops-below", threshold: 20 },
        conditions: [],
        conditionLogic: "all",
        actions: [{ type: "notify-player", message: "Danger!", style: "warning" }],
        priority: 0,
        enabled: true,
      }];

      // Crosses below 20: 25 → 15
      const r1 = evaluator.evaluate(
        { type: "state:changed", variableId: "hp", oldValue: 25, newValue: 15 },
        [], rules, makeState({ hp: 15 })
      );
      expect(r1.firedIds).toContain("vc2");

      // Does not cross: 15 → 10 (already below)
      const r2 = evaluator.evaluate(
        { type: "state:changed", variableId: "hp", oldValue: 15, newValue: 10 },
        [], rules, makeState({ hp: 10 })
      );
      expect(r2.firedIds).toHaveLength(0);
    });

    it("variable-crossed ignores wrong variable", () => {
      const rules: Rule[] = [{
        id: "vc3",
        name: "HP Threshold",
        trigger: { type: "variable-crossed", variableId: "hp", direction: "rises-above", threshold: 50 },
        conditions: [],
        conditionLogic: "all",
        actions: [{ type: "notify-player", message: "test", style: "info" }],
        priority: 0,
        enabled: true,
      }];

      const result = evaluator.evaluate(
        { type: "state:changed", variableId: "gold", oldValue: 40, newValue: 60 },
        [], rules, makeState({ gold: 60 })
      );
      expect(result.firedIds).toHaveLength(0);
    });

    it("variable-crossed boundary: oldValue exactly at threshold, rises-above", () => {
      const rules: Rule[] = [{
        id: "vc4",
        name: "HP Boundary",
        trigger: { type: "variable-crossed", variableId: "hp", direction: "rises-above", threshold: 50 },
        conditions: [],
        conditionLogic: "all",
        actions: [{ type: "notify-player", message: "test", style: "info" }],
        priority: 0,
        enabled: true,
      }];

      // oldValue == threshold (50), newValue > threshold (51) → should fire
      const r1 = evaluator.evaluate(
        { type: "state:changed", variableId: "hp", oldValue: 50, newValue: 51 },
        [], rules, makeState({ hp: 51 })
      );
      expect(r1.firedIds).toContain("vc4");

      // oldValue == threshold (50), newValue == threshold (50) → no crossing
      const r2 = evaluator.evaluate(
        { type: "state:changed", variableId: "hp", oldValue: 50, newValue: 50 },
        [], rules, makeState({ hp: 50 })
      );
      expect(r2.firedIds).toHaveLength(0);
    });
  });

  describe("effect classification", () => {
    it("classifies non-@ set effects as legacy effects", () => {
      const reactions: Reaction[] = [{
        id: "r1",
        name: "Test",
        when: { eventType: "turn:complete" },
        conditions: [],
        conditionLogic: "all",
        then: [{ type: "set", path: "hp", value: 10, operation: "subtract" }],
        priority: 0,
        enabled: true,
      }];

      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 1 },
        reactions, [], makeState()
      );

      expect(result.legacyEffects).toHaveLength(1);
      expect(result.legacyEffects[0]!.variableId).toBe("hp");
      expect(result.legacyEffects[0]!.operation).toBe("subtract");
    });

    it("does not classify @ set effects as legacy effects", () => {
      const reactions: Reaction[] = [{
        id: "r1",
        name: "Test",
        when: { eventType: "turn:complete" },
        conditions: [],
        conditionLogic: "all",
        then: [{ type: "set", path: "@audio.bgm", value: "forest_theme" }],
        priority: 0,
        enabled: true,
      }];

      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 1 },
        reactions, [], makeState()
      );

      expect(result.legacyEffects).toHaveLength(0);
      expect(result.effects).toHaveLength(1);
    });

    it("classifies ui:notification emit as notification", () => {
      const reactions: Reaction[] = [{
        id: "r1",
        name: "Test",
        when: { eventType: "turn:complete" },
        conditions: [],
        conditionLogic: "all",
        then: [{ type: "emit", event: { type: "ui:notification", message: "Hello!", style: "info" } }],
        priority: 0,
        enabled: true,
      }];

      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 1 },
        reactions, [], makeState()
      );

      expect(result.notifications).toHaveLength(1);
      expect(result.notifications[0]!.message).toBe("Hello!");
    });

    it("classifies ai:context emit as context message", () => {
      const reactions: Reaction[] = [{
        id: "r1",
        name: "Test",
        when: { eventType: "turn:complete" },
        conditions: [],
        conditionLogic: "all",
        then: [{ type: "emit", event: { type: "ai:context", message: "Be dramatic", role: "system" } }],
        priority: 0,
        enabled: true,
      }];

      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 1 },
        reactions, [], makeState()
      );

      expect(result.contextMessages).toHaveLength(1);
      expect(result.contextMessages[0]!.message).toBe("Be dramatic");
    });
  });

  describe("priority ordering", () => {
    it("fires higher priority reactions first", () => {
      const reactions: Reaction[] = [
        {
          id: "low",
          name: "Low Priority",
          when: { eventType: "turn:complete" },
          conditions: [],
          conditionLogic: "all",
          then: [{ type: "set", path: "order", value: "low" }],
          priority: 1,
          enabled: true,
        },
        {
          id: "high",
          name: "High Priority",
          when: { eventType: "turn:complete" },
          conditions: [],
          conditionLogic: "all",
          then: [{ type: "set", path: "order", value: "high" }],
          priority: 10,
          enabled: true,
        },
      ];

      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 1 },
        reactions, [], makeState()
      );

      expect(result.firedIds).toEqual(["high", "low"]);
    });
  });

  describe("disabled reactions", () => {
    it("skips disabled reactions", () => {
      const reactions: Reaction[] = [{
        id: "r1",
        name: "Disabled",
        when: { eventType: "turn:complete" },
        conditions: [],
        conditionLogic: "all",
        then: [{ type: "set", path: "x", value: 1 }],
        priority: 0,
        enabled: false,
      }];

      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 1 },
        reactions, [], makeState()
      );

      expect(result.firedIds).toHaveLength(0);
    });

    it("skips runtime-disabled reactions via ruleState", () => {
      const reactions: Reaction[] = [{
        id: "r1",
        name: "Test",
        when: { eventType: "turn:complete" },
        conditions: [],
        conditionLogic: "all",
        then: [{ type: "set", path: "x", value: 1 }],
        priority: 0,
        enabled: true,
      }];

      const state = makeState();
      state.ruleState = {
        disabledRules: ["r1"],
        activeDirectives: [],
        cooldowns: {},
        fireCounts: {},
        prevVars: {},
        toggledEntries: {},
      };

      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 1 },
        reactions, [], state
      );

      expect(result.firedIds).toHaveLength(0);
    });
  });

  describe("evaluateMultiple", () => {
    it("processes multiple events and merges results", () => {
      const reactions: Reaction[] = [
        {
          id: "r1",
          name: "On User Message",
          when: { eventType: "message:user" },
          conditions: [],
          conditionLogic: "all",
          then: [{ type: "set", path: "msg_count", value: 1, operation: "add" }],
          priority: 0,
          enabled: true,
        },
        {
          id: "r2",
          name: "On Turn",
          when: { eventType: "turn:complete" },
          conditions: [],
          conditionLogic: "all",
          then: [{ type: "set", path: "turn_count", value: 1, operation: "add" }],
          priority: 0,
          enabled: true,
        },
      ];

      const result = evaluator.evaluateMultiple(
        [
          { type: "message:user", content: "hello" },
          { type: "turn:complete", turnCount: 1 },
        ],
        reactions, [], makeState()
      );

      expect(result.firedIds).toContain("r1");
      expect(result.firedIds).toContain("r2");
      expect(result.legacyEffects).toHaveLength(2);
    });
  });

  describe("synthetic state:crossed from state:changed", () => {
    function crossReaction(direction: "drops-below" | "rises-above", threshold: number): Reaction {
      return {
        id: "cross",
        name: "HP Cross",
        when: {
          eventType: "state:crossed",
          match: {
            variableId: { operator: "eq", value: "hp" },
            direction: { operator: "eq", value: direction },
            threshold: { operator: "eq", value: threshold },
          },
        },
        conditions: [],
        conditionLogic: "all",
        then: [{ type: "set", path: "alarm", value: 1 }],
        priority: 0,
        enabled: true,
      };
    }

    it("fires when variable drops below threshold", () => {
      const result = evaluator.evaluate(
        { type: "state:changed", variableId: "hp", oldValue: 30, newValue: 15 },
        [crossReaction("drops-below", 20)], [], makeState(),
      );
      expect(result.firedIds).toContain("cross");
    });

    it("does not fire when variable stays above threshold", () => {
      const result = evaluator.evaluate(
        { type: "state:changed", variableId: "hp", oldValue: 50, newValue: 40 },
        [crossReaction("drops-below", 20)], [], makeState(),
      );
      expect(result.firedIds).toHaveLength(0);
    });

    it("does not fire on the wrong variable", () => {
      const result = evaluator.evaluate(
        { type: "state:changed", variableId: "mp", oldValue: 30, newValue: 15 },
        [crossReaction("drops-below", 20)], [], makeState(),
      );
      expect(result.firedIds).toHaveLength(0);
    });

    it("fires when variable rises above threshold", () => {
      const result = evaluator.evaluate(
        { type: "state:changed", variableId: "hp", oldValue: 10, newValue: 25 },
        [crossReaction("rises-above", 20)], [], makeState(),
      );
      expect(result.firedIds).toContain("cross");
    });

    it("does not fire when rising stays below threshold", () => {
      const result = evaluator.evaluate(
        { type: "state:changed", variableId: "hp", oldValue: 10, newValue: 15 },
        [crossReaction("rises-above", 20)], [], makeState(),
      );
      expect(result.firedIds).toHaveLength(0);
    });

    it("fires either direction when direction is omitted", () => {
      const reaction: Reaction = {
        id: "cross",
        name: "Any cross",
        when: {
          eventType: "state:crossed",
          match: {
            variableId: { operator: "eq", value: "hp" },
            threshold: { operator: "eq", value: 50 },
          },
        },
        conditions: [],
        conditionLogic: "all",
        then: [{ type: "set", path: "alarm", value: 1 }],
        priority: 0,
        enabled: true,
      };
      const up = evaluator.evaluate(
        { type: "state:changed", variableId: "hp", oldValue: 40, newValue: 60 },
        [reaction], [], makeState(),
      );
      const down = evaluator.evaluate(
        { type: "state:changed", variableId: "hp", oldValue: 60, newValue: 40 },
        [reaction], [], makeState(),
      );
      expect(up.firedIds).toContain("cross");
      expect(down.firedIds).toContain("cross");
    });
  });

  describe("synthetic every-N-turns via 'every' operator", () => {
    function everyN(n: number): Reaction {
      return {
        id: "every",
        name: "Every N",
        when: {
          eventType: "turn:complete",
          match: {
            turnCount: { operator: "every", value: n },
          },
        },
        conditions: [],
        conditionLogic: "all",
        then: [{ type: "set", path: "tick", value: 1 }],
        priority: 0,
        enabled: true,
      };
    }

    it("fires at multiples of N", () => {
      const r = everyN(5);
      for (const tc of [5, 10, 15, 20]) {
        const result = evaluator.evaluate(
          { type: "turn:complete", turnCount: tc },
          [r], [], makeState({}, tc),
        );
        expect(result.firedIds).toContain("every");
      }
    });

    it("does not fire at non-multiples", () => {
      const r = everyN(5);
      for (const tc of [1, 2, 3, 4, 6, 7, 11]) {
        const result = evaluator.evaluate(
          { type: "turn:complete", turnCount: tc },
          [r], [], makeState({}, tc),
        );
        expect(result.firedIds).toHaveLength(0);
      }
    });

    it("does not fire on turn 0", () => {
      const r = everyN(3);
      const result = evaluator.evaluate(
        { type: "turn:complete", turnCount: 0 },
        [r], [], makeState({}, 0),
      );
      expect(result.firedIds).toHaveLength(0);
    });
  });

  describe("random value (set.valueRandom)", () => {
    afterEach(() => vi.restoreAllMocks());

    type ListSpec = Extract<import("../events/types.js").RandomSpec, { kind: "list" }>;
    const listPick = (over: Partial<ListSpec> = {}): ReactionEffect => ({
      type: "set",
      path: "今日拷问官",
      operation: "set",
      value: "",
      valueRandom: { kind: "list", candidates: ["霜月", "锦织", "白医生", "小诗", "尤希"], ...over },
    });
    const asSet = (e: ReactionEffect) => e as Extract<ReactionEffect, { type: "set" }>;

    it("picks one candidate and writes it into the target variable", () => {
      const out = resolveDynamicEffect(listPick(), makeState());
      expect(out).toHaveLength(1);
      const set = asSet(out[0]!);
      expect(set.path).toBe("今日拷问官");
      expect(set.valueRandom).toBeUndefined(); // resolved to a concrete value
      expect(["霜月", "锦织", "白医生", "小诗", "尤希"]).toContain(set.value);
    });

    it("never draws a candidate inside the cooldown window", () => {
      const state = makeState({ 登场历史: ["霜月", "锦织", "白医生"] });
      for (let i = 0; i < 200; i++) {
        const out = resolveDynamicEffect(listPick({ historyVar: "登场历史", cooldown: 3 }), state);
        const picked = asSet(out[0]!).value;
        expect(["霜月", "锦织", "白医生"]).not.toContain(picked);
        expect(["小诗", "尤希"]).toContain(picked);
      }
    });

    it("rolls the history forward, trimmed to the cooldown length", () => {
      const state = makeState({ 登场历史: ["霜月", "锦织"] });
      const out = resolveDynamicEffect(listPick({ historyVar: "登场历史", cooldown: 3 }), state);
      expect(out).toHaveLength(2);
      const hist = asSet(out[1]!);
      expect(hist.path).toBe("登场历史");
      const arr = hist.value as string[];
      expect(arr).toHaveLength(3);
      expect(arr.slice(0, 2)).toEqual(["霜月", "锦织"]);
    });

    it("falls back to the full set when everyone is on cooldown (onExhausted=full)", () => {
      const state = makeState({ 登场历史: ["霜月", "锦织", "白医生", "小诗", "尤希"] });
      const out = resolveDynamicEffect(listPick({ historyVar: "登场历史", cooldown: 5, onExhausted: "full" }), state);
      expect(out).toHaveLength(2);
      expect(asSet(out[0]!).value).toBeTruthy();
    });

    it("emits nothing when exhausted and onExhausted=keep", () => {
      const state = makeState({ 登场历史: ["霜月", "锦织", "白医生", "小诗", "尤希"] });
      const out = resolveDynamicEffect(listPick({ historyVar: "登场历史", cooldown: 5, onExhausted: "keep" }), state);
      expect(out).toHaveLength(0);
    });

    it("reads candidates from an array variable", () => {
      const state = makeState({ 角色池: ["A", "B", "C"] });
      const out = resolveDynamicEffect(
        { type: "set", path: "选中", operation: "set", value: "", valueRandom: { kind: "list", candidatesVar: "角色池" } },
        state,
      );
      expect(["A", "B", "C"]).toContain(asSet(out[0]!).value);
    });

    it("honours weights (heavy weight dominates)", () => {
      const counts: Record<string, number> = { A: 0, B: 0 };
      for (let i = 0; i < 300; i++) {
        const out = resolveDynamicEffect(
          { type: "set", path: "x", operation: "set", value: "", valueRandom: { kind: "list", candidates: ["A", "B"], weights: [9, 1] } },
          makeState(),
        );
        counts[asSet(out[0]!).value as string]!++;
      }
      expect(counts.A!).toBeGreaterThan(counts.B!);
    });

    it("range: keeps the operation, replaces value with a number in [min,max]", () => {
      for (let i = 0; i < 200; i++) {
        const out = resolveDynamicEffect(
          { type: "set", path: "生命值", operation: "subtract", value: 0, valueRandom: { kind: "range", min: 5, max: 15 } },
          makeState(),
        );
        const set = asSet(out[0]!);
        expect(set.operation).toBe("subtract"); // HP jitter composes with subtract
        expect(typeof set.value).toBe("number");
        expect(set.value as number).toBeGreaterThanOrEqual(5);
        expect(set.value as number).toBeLessThanOrEqual(15);
        expect(Number.isInteger(set.value)).toBe(true);
      }
    });

    it("dice: rolls NdS within [count+mod, count*sides+mod]", () => {
      for (let i = 0; i < 200; i++) {
        const out = resolveDynamicEffect(
          { type: "set", path: "力量", operation: "set", value: 0, valueRandom: { kind: "dice", count: 3, sides: 6, modifier: 2 } },
          makeState(),
        );
        const v = asSet(out[0]!).value as number;
        expect(v).toBeGreaterThanOrEqual(3 * 1 + 2);
        expect(v).toBeLessThanOrEqual(3 * 6 + 2);
      }
    });

    it("expands through the evaluator on a real event", () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const reaction: Reaction = {
        id: "daily", name: "每日抽拷问官",
        when: { eventType: "state:changed" }, conditions: [], conditionLogic: "all",
        then: [listPick({ historyVar: "登场历史", cooldown: 2 })],
        priority: 0, enabled: true,
      };
      const result = evaluator.evaluate(
        { type: "state:changed", variableId: "天数", oldValue: 1, newValue: 2 },
        [reaction], [], makeState({ 登场历史: [] }),
      );
      expect(result.firedIds).toContain("daily");
      const targets = result.legacyEffects.map((e) => e.variableId);
      expect(targets).toContain("今日拷问官");
      expect(targets).toContain("登场历史");
    });
  });

  describe("behavior probability (chance)", () => {
    afterEach(() => vi.restoreAllMocks());
    const mk = (chance?: number): Reaction => ({
      id: "evt", name: "遇袭", when: { eventType: "turn:complete" },
      conditions: [], conditionLogic: "all",
      then: [{ type: "set", path: "x", value: 1, operation: "add" }],
      priority: 0, chance, enabled: true,
    });

    it("chance=0 never fires", () => {
      vi.spyOn(Math, "random").mockReturnValue(0); // 0*100=0 >= 0 → skip
      const r = evaluator.evaluate({ type: "turn:complete", turnCount: 1 }, [mk(0)], [], makeState({}, 1));
      expect(r.firedIds).toHaveLength(0);
    });

    it("chance=100 (or undefined) always fires", () => {
      vi.spyOn(Math, "random").mockReturnValue(0.99);
      expect(evaluator.evaluate({ type: "turn:complete", turnCount: 1 }, [mk(100)], [], makeState({}, 1)).firedIds).toContain("evt");
      expect(evaluator.evaluate({ type: "turn:complete", turnCount: 1 }, [mk()], [], makeState({}, 1)).firedIds).toContain("evt");
    });

    it("chance=30 fires below the threshold, skips above", () => {
      vi.spyOn(Math, "random").mockReturnValue(0.10); // 10 < 30 → fire
      expect(evaluator.evaluate({ type: "turn:complete", turnCount: 1 }, [mk(30)], [], makeState({}, 1)).firedIds).toContain("evt");
      vi.restoreAllMocks();
      vi.spyOn(Math, "random").mockReturnValue(0.50); // 50 >= 30 → skip
      expect(evaluator.evaluate({ type: "turn:complete", turnCount: 1 }, [mk(30)], [], makeState({}, 1)).firedIds).toHaveLength(0);
    });
  });
});
