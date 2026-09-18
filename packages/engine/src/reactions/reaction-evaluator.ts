import type { GameState, Rule, Condition, Effect, AudioEffect, TriggerConfig } from "../types/index.js";
import type { GameEvent, Reaction, ReactionEffect, EventPattern, RandomSpec } from "../events/types.js";
import { matchesEventPattern } from "../events/event-matcher.js";
import { compileRuleToReaction } from "./compile-rule.js";
import { keywordMatches } from "../lorebook/keyword-matcher.js";
import { createEmptyRuleState } from "../rules/rule-state.js";
import { getByPath } from "../state/path-utils.js";

/** Result of reaction evaluation */
export interface ReactionEvalResult {
  /** All effects from fired reactions */
  effects: ReactionEffect[];
  /** IDs of reactions that fired */
  firedIds: string[];
  /** Legacy compat: extracted Effect[] from "set" effects on non-@ paths */
  legacyEffects: Effect[];
  /** Legacy compat: extracted AudioEffect[] from "audio:play" emit effects */
  legacyAudioEffects: AudioEffect[];
  /** Emitted events from "emit" effects (for chaining) */
  emittedEvents: GameEvent[];
  /** Notifications from "ui:notification" emit effects */
  notifications: Array<{ message: string; style: string }>;
  /** Context messages from "ai:context" emit effects */
  contextMessages: Array<{ message: string; role: string }>;
}

const EMPTY_RESULT: ReactionEvalResult = {
  effects: [],
  firedIds: [],
  legacyEffects: [],
  legacyAudioEffects: [],
  emittedEvents: [],
  notifications: [],
  contextMessages: [],
};

/**
 * Evaluates reactions against a GameEvent.
 *
 * Accepts both Reaction[] (new) and Rule[] (legacy, auto-compiled).
 * Pure function — no mutation, no side effects.
 *
 * For legacy keyword triggers, delegates to the lorebook keyword matching engine
 * to preserve full fuzzy/whole-word/secondary keyword behavior.
 */
export class ReactionEvaluator {
  /**
   * Evaluate reactions for a given event.
   *
   * @param event - The event that occurred
   * @param reactions - Reactions to evaluate (new format)
   * @param rules - Legacy rules to evaluate (auto-compiled to reactions)
   * @param state - Current game state
   * @param chainDepth - Current chain depth (for preventing infinite loops)
   */
  evaluate(
    event: GameEvent,
    reactions: Reaction[],
    rules: Rule[],
    state: GameState,
    chainDepth: number = 0,
  ): ReactionEvalResult {
    const maxChain = 5;
    if (chainDepth >= maxChain) return EMPTY_RESULT;

    // Merge: compile rules to reactions + add explicit reactions
    const compiled = rules.map(compileRuleToReaction);
    const allReactions = [...compiled, ...reactions];

    const ruleState = state.ruleState ?? createEmptyRuleState();
    const sorted = [...allReactions].sort((a, b) => b.priority - a.priority);

    const allEffects: ReactionEffect[] = [];
    const firedIds: string[] = [];

    for (const reaction of sorted) {
      if (!reaction.enabled) continue;

      // Check runtime disabled
      if (ruleState.disabledRules.includes(reaction.id)) continue;

      // Check event pattern match
      if (!this.matchesEvent(event, reaction.when, state)) continue;

      // Check IF conditions
      if (!this.checkConditions(state, reaction.conditions, reaction.conditionLogic)) continue;

      // Check STOP conditions — while ANY is true, the reaction is suppressed
      // ("fire until X"). Complements IF without hand-inverted operators.
      if (reaction.stopConditions && reaction.stopConditions.length > 0) {
        if (reaction.stopConditions.some((c) => this.evaluateCondition(state, c))) continue;
      }

      // Check cooldown
      if (ruleState.cooldowns[reaction.id] !== undefined) {
        const turnCount = state.turnCount ?? 0;
        if (ruleState.cooldowns[reaction.id]! > turnCount) continue;
      }

      // Check max fire count
      if (reaction.maxFireCount !== undefined) {
        const count = ruleState.fireCounts[reaction.id] ?? 0;
        if (count >= reaction.maxFireCount) continue;
      }

      // Probability gate: "sometimes it happens" random events. Rolled last so
      // it only spends the roll on reactions that otherwise pass every gate.
      if (reaction.chance !== undefined && reaction.chance < 100) {
        if (Math.random() * 100 >= reaction.chance) continue;
      }

      // Reaction fires. Dynamic effects (random values) are resolved HERE, at
      // fire time, so a draw can read the current cooldown history from state.
      for (const effect of reaction.then) {
        allEffects.push(...resolveDynamicEffect(effect, state));
      }
      firedIds.push(reaction.id);
    }

    // Classify effects for legacy compat and chaining
    return this.classifyEffects(allEffects, firedIds);
  }

  /**
   * Evaluate reactions for multiple events at once (convenience for turn-end processing).
   * Events are processed in order; results are merged.
   */
  evaluateMultiple(
    events: GameEvent[],
    reactions: Reaction[],
    rules: Rule[],
    state: GameState,
    options?: { oncePerReaction?: boolean },
  ): ReactionEvalResult {
    const merged: ReactionEvalResult = {
      effects: [],
      firedIds: [],
      legacyEffects: [],
      legacyAudioEffects: [],
      emittedEvents: [],
      notifications: [],
      contextMessages: [],
    };

    const fired = new Set<string>();
    for (const event of events) {
      // Chains promise one firing per reaction. Retire it before evaluating the
      // next event, rather than deduping only bookkeeping after effects merge.
      const activeReactions = options?.oncePerReaction ? reactions.filter(r => !fired.has(r.id)) : reactions;
      const activeRules = options?.oncePerReaction ? rules.filter(r => !fired.has(r.id)) : rules;
      const result = this.evaluate(event, activeReactions, activeRules, state);
      for (const id of result.firedIds) fired.add(id);
      merged.effects.push(...result.effects);
      merged.firedIds.push(...result.firedIds);
      merged.legacyEffects.push(...result.legacyEffects);
      merged.legacyAudioEffects.push(...result.legacyAudioEffects);
      merged.emittedEvents.push(...result.emittedEvents);
      merged.notifications.push(...result.notifications);
      merged.contextMessages.push(...result.contextMessages);
    }

    return merged;
  }

  /** Check if an event matches a reaction's EventPattern, including legacy trigger support */
  private matchesEvent(
    event: GameEvent,
    pattern: EventPattern,
    state: GameState,
  ): boolean {
    // Check for legacy trigger config (compiled from old Rule format)
    const legacyTrigger = (pattern as any)?._legacyTrigger as TriggerConfig | undefined;

    if (legacyTrigger) {
      // Delegate to legacy trigger matching for complex cases (keyword, everyNTurns)
      return this.checkLegacyTrigger(event, legacyTrigger, state);
    }

    // Synthetic crossing: state:crossed patterns are satisfied by state:changed
    // events when the variable actually crosses the configured threshold.
    // The runtime only emits state:changed (with oldValue/newValue); state:crossed
    // is derived here so creators can write a "var crosses N" reaction without the
    // server having to know which thresholds matter.
    if (pattern.eventType === "state:crossed" && event.type === "state:changed") {
      return this.matchesCrossing(event, pattern);
    }

    // Synthetic every-N-turns: turn:complete patterns with a `turnCount.every`
    // marker fire when turnCount > 0 && turnCount % N === 0. Encoded on the
    // pattern so the editor doesn't need a separate event type.
    if (pattern.eventType === "turn:complete" && event.type === "turn:complete") {
      const turnCountCond = pattern.match?.turnCount;
      if (turnCountCond && (turnCountCond.operator as string) === "every") {
        const n = Number(turnCountCond.value);
        const turnCount = (event.turnCount as number) ?? state.turnCount ?? 0;
        if (!Number.isFinite(n) || n <= 0) return false;
        return turnCount > 0 && turnCount % n === 0;
      }
    }

    // Generic event pattern matching
    return matchesEventPattern(event, pattern);
  }

  /** Detect a threshold crossing from a state:changed event */
  private matchesCrossing(event: GameEvent, pattern: EventPattern): boolean {
    const match = pattern.match;
    if (!match) return false;

    // variableId must match if specified
    const expectedVarId = match.variableId?.value;
    if (expectedVarId !== undefined && event.variableId !== expectedVarId) return false;

    const threshold = match.threshold?.value;
    if (typeof threshold !== "number") return false;

    const oldVal = event.oldValue;
    const newVal = event.newValue;
    if (typeof oldVal !== "number" || typeof newVal !== "number") return false;

    const direction = match.direction?.value;
    if (direction === "rises-above") {
      return oldVal <= threshold && newVal > threshold;
    }
    if (direction === "drops-below") {
      return oldVal >= threshold && newVal < threshold;
    }
    // No direction specified — fire on either crossing
    return (
      (oldVal <= threshold && newVal > threshold) ||
      (oldVal >= threshold && newVal < threshold)
    );
  }

  /** Legacy trigger matching — preserves full keyword/turn-count/variable-crossed behavior */
  private checkLegacyTrigger(
    event: GameEvent,
    trigger: TriggerConfig,
    state: GameState,
  ): boolean {
    switch (trigger.type) {
      case "keyword": {
        if (event.type !== "message:user") return false;
        const text = event.content as string | undefined;
        if (!text || !trigger.keywords || trigger.keywords.length === 0) return false;
        return this.matchesKeywords(text, trigger);
      }

      case "ai-keyword": {
        if (event.type !== "message:ai") return false;
        const text = event.content as string | undefined;
        if (!text || !trigger.keywords || trigger.keywords.length === 0) return false;
        return this.matchesKeywords(text, trigger);
      }

      case "turn-count": {
        if (event.type !== "turn:complete") return false;
        const turnCount = (event.turnCount as number) ?? state.turnCount ?? 0;
        if (trigger.atTurn !== undefined && turnCount === trigger.atTurn) return true;
        if (trigger.everyNTurns !== undefined && trigger.everyNTurns > 0) {
          return turnCount > 0 && turnCount % trigger.everyNTurns === 0;
        }
        return false;
      }

      case "variable-crossed": {
        // Detect threshold crossings from state:changed events using oldValue/newValue
        if (event.type !== "state:changed") return false;
        if (trigger.variableId && event.variableId !== trigger.variableId) return false;
        const oldVal = event.oldValue;
        const newVal = event.newValue;
        if (typeof oldVal !== "number" || typeof newVal !== "number") return false;
        if (trigger.threshold === undefined) return false;
        if (trigger.direction === "rises-above") {
          return oldVal <= trigger.threshold && newVal > trigger.threshold;
        }
        if (trigger.direction === "drops-below") {
          return oldVal >= trigger.threshold && newVal < trigger.threshold;
        }
        return false;
      }

      default:
        return false;
    }
  }

  /** Keyword matching using the lorebook keyword engine (preserves whole-word/secondary) */
  private matchesKeywords(text: string, trigger: TriggerConfig): boolean {
    const keywords = trigger.keywords ?? [];
    if (keywords.length === 0) return false;

    const wholeWord = trigger.matchWholeWords ?? false;

    const primaryMatch = keywords.some((kw) =>
      keywordMatches(text, kw, wholeWord)
    );
    if (!primaryMatch) return false;

    const secondary = trigger.secondaryKeywords ?? [];
    if (secondary.length === 0) return true;

    const logic = trigger.secondaryKeywordLogic ?? "AND_ANY";
    const secondaryMatches = secondary.map((kw) =>
      keywordMatches(text, kw, wholeWord)
    );

    switch (logic) {
      case "AND_ANY": return secondaryMatches.some(Boolean);
      case "AND_ALL": return secondaryMatches.every(Boolean);
      case "NOT_ANY": return !secondaryMatches.some(Boolean);
      case "NOT_ALL": return !secondaryMatches.every(Boolean);
      default: return true;
    }
  }

  /** Check IF conditions against state (same logic as RulesEngine) */
  private checkConditions(state: GameState, conditions: Condition[], logic: "all" | "any"): boolean {
    if (conditions.length === 0) return true;
    if (logic === "all") return conditions.every((c) => this.evaluateCondition(state, c));
    return conditions.some((c) => this.evaluateCondition(state, c));
  }

  private evaluateCondition(state: GameState, condition: Condition): boolean {
    // LHS supports nested dot-paths (e.g. "背包.金币").
    const current = getByPath(state.variables, condition.variableId);
    if (current === undefined) return false;

    // RHS is another variable's current value (valueRef) or the literal.
    const target = condition.valueRef !== undefined
      ? getByPath(state.variables, condition.valueRef)
      : condition.value;
    if (target === undefined) return false;

    switch (condition.operator) {
      case "eq": return current === target;
      case "neq": return current !== target;
      case "gt": return typeof current === "number" && typeof target === "number" && current > target;
      case "gte": return typeof current === "number" && typeof target === "number" && current >= target;
      case "lt": return typeof current === "number" && typeof target === "number" && current < target;
      case "lte": return typeof current === "number" && typeof target === "number" && current <= target;
      case "contains":
        // Array membership (e.g. 旗标 contains "见过国王") or string substring.
        if (Array.isArray(current)) return current.includes(target);
        return typeof current === "string" && typeof target === "string" && current.includes(target);
      default: return false;
    }
  }

  /** Classify effects into legacy compat buckets and emitted events */
  private classifyEffects(effects: ReactionEffect[], firedIds: string[]): ReactionEvalResult {
    const legacyEffects: Effect[] = [];
    const legacyAudioEffects: AudioEffect[] = [];
    const emittedEvents: GameEvent[] = [];
    const notifications: Array<{ message: string; style: string }> = [];
    const contextMessages: Array<{ message: string; role: string }> = [];

    for (const effect of effects) {
      if (effect.type === "set") {
        // Non-@ paths are regular game variable effects
        if (!effect.path.startsWith("@")) {
          legacyEffects.push({
            variableId: effect.path,
            operation: effect.operation ?? "set",
            value: effect.value,
          });
        }
        // @ paths are system state — handled by respective systems
      } else if (effect.type === "emit") {
        emittedEvents.push(effect.event);

        // Classify well-known emitted events for legacy compat
        if (effect.event.type === "audio:play") {
          legacyAudioEffects.push({
            trackId: effect.event.trackId as string,
            action: effect.event.action as AudioEffect["action"],
            volume: effect.event.volume as number | undefined,
            fadeDuration: effect.event.fadeDuration as number | undefined,
          });
        } else if (effect.event.type === "ui:notification") {
          notifications.push({
            message: effect.event.message as string,
            style: (effect.event.style as string) ?? "info",
          });
        } else if (effect.event.type === "ai:context") {
          contextMessages.push({
            message: effect.event.message as string,
            role: (effect.event.role as string) ?? "system",
          });
        }
      }
    }

    return { effects, firedIds, legacyEffects, legacyAudioEffects, emittedEvents, notifications, contextMessages };
  }
}

/**
 * Resolve a single reaction effect into concrete effects.
 *
 * All effects pass through unchanged EXCEPT a `set` whose value is random
 * (`valueRandom`). That is resolved against current state at fire time:
 *   - range/dice → a concrete number replaces `value` (the operation still
 *     applies, so `生命值 subtract range(5,15)` subtracts the roll);
 *   - list       → a picked item replaces `value`, plus a second `set` rolls
 *     the trimmed cooldown history forward.
 *
 * The list draw is uniform by default, weighted when parallel `weights` are
 * given, and excludes any candidate seen in the last `cooldown` history
 * entries. When every candidate is on cooldown, `onExhausted` decides whether
 * to fall back to the full set ("full", default) or keep the current value
 * ("keep", emits nothing).
 */
export function resolveDynamicEffect(effect: ReactionEffect, state: GameState): ReactionEffect[] {
  if (effect.type !== "set" || !effect.valueRandom) return [effect];
  const spec = effect.valueRandom;

  // Numeric sources: replace value with the roll, keep the operation.
  if (spec.kind === "range") {
    const value = rollRange(spec.min, spec.max, spec.integer !== false);
    return [{ ...effect, value, valueRandom: undefined }];
  }
  if (spec.kind === "dice") {
    const value = rollDice(spec.count, spec.sides, spec.modifier ?? 0);
    return [{ ...effect, value, valueRandom: undefined }];
  }

  // List source: uniform/weighted pick with an optional no-repeat window.
  let candidates: string[];
  let weights: number[] | undefined;
  if (spec.candidatesVar) {
    const raw = getByPath(state.variables, spec.candidatesVar);
    candidates = Array.isArray(raw) ? raw.map(String).filter((s) => s.length > 0) : [];
  } else {
    candidates = (spec.candidates ?? []).map(String).filter((s) => s.length > 0);
    weights = spec.weights;
  }
  if (candidates.length === 0) return [];

  const cooldown = spec.cooldown ?? 0;
  let recent: string[] = [];
  if (cooldown > 0 && spec.historyVar) {
    const raw = getByPath(state.variables, spec.historyVar);
    if (Array.isArray(raw)) recent = raw.map(String);
  }
  const recentSet = new Set(recent.slice(-cooldown));
  let eligible = candidates.filter((c) => !recentSet.has(c));
  if (eligible.length === 0) {
    if ((spec.onExhausted ?? "full") === "keep") return [];
    eligible = candidates; // fall back to the full set
  }

  const haveWeights =
    weights !== undefined &&
    weights.length === candidates.length &&
    weights.every((w) => typeof w === "number" && w >= 0);
  const eligibleWeights = haveWeights
    ? eligible.map((c) => weights![candidates.indexOf(c)]!)
    : undefined;
  const picked = weightedPick(eligible, eligibleWeights);

  const out: ReactionEffect[] = [{ ...effect, value: picked, valueRandom: undefined }];
  if (cooldown > 0 && spec.historyVar) {
    const nextHistory = [...recent, picked].slice(-cooldown);
    out.push({ type: "set", path: spec.historyVar, value: nextHistory, operation: "set" });
  }
  return out;
}

/**
 * Sample a RandomSpec once — for UI previews ("roll it"). Static candidates
 * only; ignores cooldown history and candidatesVar (there's no live state), so
 * a list preview is a plain uniform/weighted draw over the authored list.
 */
export function sampleRandomSpec(spec: RandomSpec): string | number {
  if (spec.kind === "range") return rollRange(spec.min, spec.max, spec.integer !== false);
  if (spec.kind === "dice") return rollDice(spec.count, spec.sides, spec.modifier ?? 0);
  const candidates = (spec.candidates ?? []).map(String).filter((s) => s.length > 0);
  if (candidates.length === 0) return "";
  const weights = spec.weights && spec.weights.length === candidates.length ? spec.weights : undefined;
  return weightedPick(candidates, weights);
}

/** Random integer (or float) in [min, max] inclusive. */
function rollRange(min: number, max: number, integer: boolean): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  if (integer) return lo + Math.floor(Math.random() * (hi - lo + 1));
  return lo + Math.random() * (hi - lo);
}

/** Roll `count` dice of `sides`, plus a flat `modifier`. */
function rollDice(count: number, sides: number, modifier: number): number {
  let total = modifier;
  const n = Math.max(0, Math.floor(count));
  const s = Math.max(1, Math.floor(sides));
  for (let i = 0; i < n; i++) total += 1 + Math.floor(Math.random() * s);
  return total;
}

/** Uniform pick, or weighted pick when a valid parallel weight array is given. */
function weightedPick(items: string[], weights?: number[]): string {
  if (items.length === 1) return items[0]!;
  if (weights && weights.length === items.length) {
    const total = weights.reduce((a, b) => a + (b > 0 ? b : 0), 0);
    if (total > 0) {
      let r = Math.random() * total;
      for (let i = 0; i < items.length; i++) {
        r -= weights[i]! > 0 ? weights[i]! : 0;
        if (r < 0) return items[i]!;
      }
    }
  }
  return items[Math.floor(Math.random() * items.length)]!;
}
