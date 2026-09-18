import type { Rule, RuleAction, TriggerConfig } from "../types/index.js";
import type { Reaction, ReactionEffect, EventPattern, GameEvent } from "../events/types.js";

/**
 * Compile a legacy Rule into a Reaction.
 * Preserves all semantics — the Reaction is functionally identical to the Rule.
 */
export function compileRuleToReaction(rule: Rule): Reaction {
  return {
    id: rule.id,
    name: rule.name,
    description: rule.description,
    when: compileTriggerToPattern(rule.trigger),
    conditions: rule.conditions,
    conditionLogic: rule.conditionLogic,
    then: compileActionsToEffects(rule.actions),
    priority: rule.priority,
    cooldownTurns: rule.cooldownTurns,
    maxFireCount: rule.maxFireCount,
    chance: rule.chance,
    enabled: rule.enabled,
  };
}

/**
 * Compile an array of Rules into Reactions.
 */
export function compileRulesToReactions(rules: Rule[]): Reaction[] {
  return rules.map(compileRuleToReaction);
}

/**
 * Compile a TriggerConfig into an EventPattern.
 *
 * For complex triggers (keyword matching with fuzzy/secondary logic),
 * we encode the full config as `_legacyTrigger` on the event pattern
 * so the evaluator can delegate to the rich matching engine.
 */
export function compileTriggerToPattern(trigger: TriggerConfig): EventPattern {
  switch (trigger.type) {
    case "state-change":
      return { eventType: "state:changed" };

    case "variable-crossed":
      // Delegate to legacy trigger matching — the evaluator detects threshold
      // crossings from state:changed events using oldValue/newValue fields.
      return {
        eventType: "state:changed",
        _legacyTrigger: trigger,
      } as EventPattern & { _legacyTrigger: TriggerConfig };

    case "turn-count": {
      const pattern: EventPattern = { eventType: "turn:complete" };
      if (trigger.atTurn !== undefined) {
        pattern.match = { turnCount: { operator: "eq", value: trigger.atTurn } };
      }
      // everyNTurns requires modulo logic — encoded as _legacyTrigger for the evaluator
      if (trigger.everyNTurns !== undefined) {
        (pattern as any)._legacyTrigger = trigger;
      }
      return pattern;
    }

    case "session-start":
      return { eventType: "session:start" };

    case "keyword":
      // Keyword matching is complex (fuzzy, whole-word, secondary keywords).
      // Encode the full trigger config for the evaluator's rich matching engine.
      return {
        eventType: "message:user",
        _legacyTrigger: trigger,
      } as EventPattern & { _legacyTrigger: TriggerConfig };

    case "ai-keyword":
      return {
        eventType: "message:ai",
        _legacyTrigger: trigger,
      } as EventPattern & { _legacyTrigger: TriggerConfig };

    case "action":
      return {
        eventType: "action:fired",
        match: trigger.actionId
          ? { actionId: { operator: "eq", value: trigger.actionId } }
          : undefined,
      };

    case "manual":
      // Manual rules fire on state:changed — conditions do the actual filtering
      return { eventType: "state:changed" };

    case "every-turn":
      return { eventType: "turn:complete" };

    default:
      return { eventType: "state:changed" };
  }
}

/**
 * Compile RuleActions into ReactionEffects.
 *
 * Each hardcoded action type maps to a `set` (state mutation) or `emit` (event emission).
 * This preserves full backward compatibility while normalizing to the two primitives.
 */
export function compileActionsToEffects(actions: RuleAction[]): ReactionEffect[] {
  const effects: ReactionEffect[] = [];

  for (const action of actions) {
    switch (action.type) {
      case "modify-variable":
        effects.push({
          type: "set",
          path: action.variableId,
          value: action.value,
          operation: action.operation,
          valueRef: action.valueRef,
        });
        break;

      case "inject-directive":
        // Store directive metadata as a JSON value under @prompt.directive.<id>
        effects.push({
          type: "set",
          path: `@prompt.directive.${action.directiveId}`,
          value: {
            content: action.content,
            position: action.position ?? "auto",
            persistent: action.persistent !== false,
            duration: action.duration,
          } as unknown as Record<string, unknown>,
          operation: "set",
        });
        break;

      case "remove-directive":
        effects.push({
          type: "set",
          path: `@prompt.directive.${action.directiveId}`,
          value: false as unknown as boolean,
          operation: "set",
        });
        break;

      case "send-context":
        effects.push({
          type: "emit",
          event: {
            type: "ai:context",
            message: action.message,
            role: action.role ?? "system",
          },
        });
        break;

      case "toggle-entry":
        effects.push({
          type: "set",
          path: `@prompt.entry.${action.entryId}`,
          value: action.enabled,
          operation: "set",
        });
        break;

      case "toggle-rule":
        effects.push({
          type: "set",
          path: `@rules.disabled.${action.ruleId}`,
          value: !action.enabled,
          operation: "set",
        });
        break;

      case "notify-player":
        effects.push({
          type: "emit",
          event: {
            type: "ui:notification",
            message: action.message,
            style: action.style ?? "info",
          },
        });
        break;

      case "play-audio":
        effects.push({
          type: "emit",
          event: {
            type: "audio:play",
            trackId: action.trackId,
            action: action.action,
            volume: action.volume,
            fadeDuration: action.fadeDuration,
          },
        });
        break;
    }
  }

  return effects;
}

/**
 * Build a GameEvent from the current context (for use by the server/client
 * when emitting events that the ReactionEvaluator will process).
 */
export function buildTurnCompleteEvent(turnCount: number): GameEvent {
  return { type: "turn:complete", turnCount };
}

export function buildMessageUserEvent(content: string): GameEvent {
  return { type: "message:user", content };
}

export function buildMessageAIEvent(content: string): GameEvent {
  return { type: "message:ai", content };
}

export function buildSessionStartEvent(): GameEvent {
  return { type: "session:start" };
}

export function buildActionFiredEvent(actionId: string): GameEvent {
  return { type: "action:fired", actionId };
}

export function buildStateChangedEvent(variableId: string, oldValue?: unknown, newValue?: unknown): GameEvent {
  return { type: "state:changed", variableId, oldValue, newValue };
}

export function buildStateCrossedEvent(
  variableId: string,
  direction: "rises-above" | "drops-below",
  threshold: number,
  currentValue: number,
  previousValue: number,
): GameEvent {
  return { type: "state:crossed", variableId, direction, threshold, currentValue, previousValue };
}
