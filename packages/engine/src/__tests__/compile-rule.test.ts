import { describe, it, expect } from "vitest";
import {
  compileRuleToReaction,
  compileTriggerToPattern,
  compileActionsToEffects,
  buildMessageUserEvent,
  buildTurnCompleteEvent,
  buildStateChangedEvent,
  buildStateCrossedEvent,
} from "../reactions/compile-rule.js";
import type { Rule, TriggerConfig, RuleAction } from "../types/index.js";

describe("compileTriggerToPattern", () => {
  it("compiles state-change trigger", () => {
    const pattern = compileTriggerToPattern({ type: "state-change" });
    expect(pattern.eventType).toBe("state:changed");
  });

  it("compiles every-turn trigger", () => {
    const pattern = compileTriggerToPattern({ type: "every-turn" });
    expect(pattern.eventType).toBe("turn:complete");
  });

  it("compiles session-start trigger", () => {
    const pattern = compileTriggerToPattern({ type: "session-start" });
    expect(pattern.eventType).toBe("session:start");
  });

  it("compiles variable-crossed trigger with legacy config", () => {
    const trigger: TriggerConfig = {
      type: "variable-crossed",
      variableId: "hp",
      direction: "drops-below",
      threshold: 20,
    };
    const pattern = compileTriggerToPattern(trigger);
    expect(pattern.eventType).toBe("state:changed");
    expect((pattern as any)._legacyTrigger).toBe(trigger);
  });

  it("compiles action trigger with actionId match", () => {
    const pattern = compileTriggerToPattern({ type: "action", actionId: "attack" });
    expect(pattern.eventType).toBe("action:fired");
    expect(pattern.match?.actionId).toEqual({ operator: "eq", value: "attack" });
  });

  it("compiles keyword trigger with legacy config", () => {
    const trigger: TriggerConfig = { type: "keyword", keywords: ["attack", "fight"] };
    const pattern = compileTriggerToPattern(trigger);
    expect(pattern.eventType).toBe("message:user");
    expect((pattern as any)._legacyTrigger).toBe(trigger);
  });

  it("compiles ai-keyword trigger with legacy config", () => {
    const trigger: TriggerConfig = { type: "ai-keyword", keywords: ["treasure"] };
    const pattern = compileTriggerToPattern(trigger);
    expect(pattern.eventType).toBe("message:ai");
    expect((pattern as any)._legacyTrigger).toBe(trigger);
  });

  it("compiles turn-count with atTurn", () => {
    const pattern = compileTriggerToPattern({ type: "turn-count", atTurn: 5 });
    expect(pattern.eventType).toBe("turn:complete");
    expect(pattern.match?.turnCount).toEqual({ operator: "eq", value: 5 });
  });

  it("compiles turn-count with everyNTurns as legacy", () => {
    const trigger: TriggerConfig = { type: "turn-count", everyNTurns: 3 };
    const pattern = compileTriggerToPattern(trigger);
    expect(pattern.eventType).toBe("turn:complete");
    expect((pattern as any)._legacyTrigger).toBe(trigger);
  });
});

describe("compileActionsToEffects", () => {
  it("compiles modify-variable to set effect", () => {
    const actions: RuleAction[] = [
      { type: "modify-variable", variableId: "hp", operation: "subtract", value: 10 },
    ];
    const effects = compileActionsToEffects(actions);
    expect(effects).toHaveLength(1);
    expect(effects[0]).toEqual({ type: "set", path: "hp", value: 10, operation: "subtract" });
  });

  it("compiles inject-directive to @prompt.directive set", () => {
    const actions: RuleAction[] = [
      { type: "inject-directive", directiveId: "forest", content: "You are in a dark forest" },
    ];
    const effects = compileActionsToEffects(actions);
    expect(effects).toHaveLength(1);
    expect(effects[0]!.type).toBe("set");
    expect((effects[0] as any).path).toBe("@prompt.directive.forest");
  });

  it("compiles play-audio to emit event", () => {
    const actions: RuleAction[] = [
      { type: "play-audio", trackId: "forest_bgm", action: "play" },
    ];
    const effects = compileActionsToEffects(actions);
    expect(effects).toHaveLength(1);
    expect(effects[0]!.type).toBe("emit");
    expect((effects[0] as any).event.type).toBe("audio:play");
    expect((effects[0] as any).event.trackId).toBe("forest_bgm");
  });

  it("compiles notify-player to emit event", () => {
    const actions: RuleAction[] = [
      { type: "notify-player", message: "Achievement unlocked!", style: "achievement" },
    ];
    const effects = compileActionsToEffects(actions);
    expect(effects).toHaveLength(1);
    expect(effects[0]!.type).toBe("emit");
    expect((effects[0] as any).event.type).toBe("ui:notification");
    expect((effects[0] as any).event.message).toBe("Achievement unlocked!");
  });

  it("compiles toggle-entry to @prompt.entry set", () => {
    const actions: RuleAction[] = [
      { type: "toggle-entry", entryId: "lore_01", enabled: true },
    ];
    const effects = compileActionsToEffects(actions);
    expect(effects[0]).toEqual({ type: "set", path: "@prompt.entry.lore_01", value: true, operation: "set" });
  });

  it("compiles toggle-rule to @rules.disabled set", () => {
    const actions: RuleAction[] = [
      { type: "toggle-rule", ruleId: "rule_01", enabled: false },
    ];
    const effects = compileActionsToEffects(actions);
    expect(effects[0]).toEqual({ type: "set", path: "@rules.disabled.rule_01", value: true, operation: "set" });
  });
});

describe("compileRuleToReaction", () => {
  it("preserves all rule fields in compiled reaction", () => {
    const rule: Rule = {
      id: "r1",
      name: "Test Rule",
      description: "A test",
      trigger: { type: "every-turn" },
      conditions: [{ variableId: "hp", operator: "lt", value: 50 }],
      conditionLogic: "all",
      actions: [{ type: "notify-player", message: "Low health!", style: "warning" }],
      priority: 10,
      cooldownTurns: 3,
      maxFireCount: 5,
      enabled: true,
    };

    const reaction = compileRuleToReaction(rule);
    expect(reaction.id).toBe("r1");
    expect(reaction.name).toBe("Test Rule");
    expect(reaction.description).toBe("A test");
    expect(reaction.when.eventType).toBe("turn:complete");
    expect(reaction.conditions).toEqual(rule.conditions);
    expect(reaction.conditionLogic).toBe("all");
    expect(reaction.then).toHaveLength(1);
    expect(reaction.priority).toBe(10);
    expect(reaction.cooldownTurns).toBe(3);
    expect(reaction.maxFireCount).toBe(5);
    expect(reaction.enabled).toBe(true);
  });
});

describe("event builder helpers", () => {
  it("buildMessageUserEvent", () => {
    const e = buildMessageUserEvent("hello");
    expect(e).toEqual({ type: "message:user", content: "hello" });
  });

  it("buildTurnCompleteEvent", () => {
    const e = buildTurnCompleteEvent(5);
    expect(e).toEqual({ type: "turn:complete", turnCount: 5 });
  });

  it("buildStateChangedEvent", () => {
    const e = buildStateChangedEvent("hp", 100, 80);
    expect(e.type).toBe("state:changed");
    expect(e.variableId).toBe("hp");
  });

  it("buildStateCrossedEvent", () => {
    const e = buildStateCrossedEvent("hp", "drops-below", 20, 15, 25);
    expect(e.type).toBe("state:crossed");
    expect(e.direction).toBe("drops-below");
    expect(e.threshold).toBe(20);
  });
});
