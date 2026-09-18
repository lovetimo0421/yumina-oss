import type { Condition, EffectOperation, TriggerConfig } from "../types/index.js";

// ── Events ──

/** A typed event emitted by any system. The `type` field is the event identity. */
export interface GameEvent {
  type: string;
  [key: string]: unknown;
}

// ── Event Patterns (replace hardcoded trigger types) ──

/** Operator for matching event data fields */
export type EventMatchOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "every";

/** A condition on a single event data field */
export interface EventMatchCondition {
  operator: EventMatchOperator;
  value: number | string | boolean;
}

/**
 * Pattern that matches events. Used as the WHEN clause in reactions.
 * - `eventType` matches the event's `type` field. Supports trailing wildcard: "spatial:*"
 * - `match` optionally checks event data fields against conditions
 */
export interface EventPattern {
  /** Preserves rich legacy trigger semantics when an old behavior is edited and saved. */
  _legacyTrigger?: TriggerConfig;
  eventType: string;
  match?: Record<string, EventMatchCondition>;
}

// ── Reaction Effects (replace hardcoded action types) ──

/**
 * A random value source, resolved at fire time (not compile time) so the draw
 * can read live state (e.g. the cooldown history). This is what makes "random"
 * a general VALUE rather than a bespoke action: any `set` effect can take a
 * random operand, so it composes with every operation (set/add/subtract/…) and
 * every variable. HP-jitter, gold drops, stat rolls, and character rotation are
 * all the same primitive.
 *
 * - `range`: a number in [min, max] (integer unless `integer === false`).
 * - `dice`:  NdS(+M) — `count` dice of `sides`, plus `modifier`.
 * - `list`:  pick one item (uniform or weighted), with an optional no-repeat
 *            window backed by a history variable.
 */
export type RandomSpec =
  | { kind: "range"; min: number; max: number; integer?: boolean }
  | { kind: "dice"; count: number; sides: number; modifier?: number }
  | {
      kind: "list";
      /** Candidates when reading from a fixed authored list. */
      candidates?: string[];
      /** Array variable id holding candidates instead of a fixed list. */
      candidatesVar?: string;
      /** Optional per-candidate weights, parallel to `candidates`. */
      weights?: number[];
      /** Variable holding the rolling list of recent picks (for cooldown). */
      historyVar?: string;
      /** Exclude the last N distinct picks; also the length the history is trimmed to. */
      cooldown?: number;
      /** When every candidate is on cooldown: fall back to the full set, or keep the current value. */
      onExhausted?: "full" | "keep";
    };

/**
 * A reaction effect — either a state mutation or an event emission.
 * - `set`: Modify a variable (same operations as existing applyEffects). Its
 *   value may be a literal, a `valueRef` (another variable's value), or a
 *   `valueRandom` spec resolved at fire time.
 * - `emit`: Emit a new event (triggers further reaction chains)
 */
export type ReactionEffect =
  | { type: "set"; path: string; value: number | string | boolean | Record<string, unknown> | unknown[]; operation?: EffectOperation; valueRef?: string; valueRandom?: RandomSpec }
  | { type: "emit"; event: GameEvent };

// ── Reactions (evolution of Rules) ──

/**
 * A Reaction is the extensible replacement for Rule.
 * Same WHEN/IF/THEN structure, but WHEN is a generic EventPattern
 * and THEN is generic effects (set + emit) instead of 8 hardcoded actions.
 */
export interface Reaction {
  id: string;
  name: string;
  description?: string;

  /** WHEN: event pattern to match */
  when: EventPattern;

  /** IF: state conditions that must be true (reuses existing Condition type) */
  conditions: Condition[];
  conditionLogic: "all" | "any";

  /**
   * STOP: while ANY of these conditions is true, the reaction does not fire.
   * The complement of `conditions` — "fire until X" instead of "fire when X".
   * Lets creators end a recurring behavior (e.g. every-N-turns) once a
   * variable reaches a target, without inverting their IF logic by hand.
   */
  stopConditions?: Condition[];

  /** THEN: effects to apply when the reaction fires */
  then: ReactionEffect[];

  priority: number;
  cooldownTurns?: number;
  maxFireCount?: number;
  /** Probability (0-100) that this reaction fires when it otherwise would.
   *  Undefined/100 = always. Covers "sometimes it happens" (random events). */
  chance?: number;
  enabled: boolean;

  /** Max depth for chained reactions (prevents infinite loops, default 5) */
  maxChainDepth?: number;
}

// ── Event handler types ──

export type EventHandler = (event: GameEvent) => void;
