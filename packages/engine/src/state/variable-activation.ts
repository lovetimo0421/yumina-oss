import type { Effect, GameState, Variable, Worldbook, WorldDefinition } from "../types/index.js";
import { checkConditions } from "./condition-evaluator.js";
import { isMemberActive } from "../lorebook/worldbook.js";

/**
 * Variable activation + AI-access resolution — the single authority every
 * consumer (prompt-builder, directive filter, GamePanel/resolveComponents)
 * goes through, mirroring computeActiveWorldbookIds for worldbooks.
 *
 * Core rule: a variable's VALUE always exists regardless of activation.
 * Conditions, reactions and the sandbox keep reading values as before —
 * activation only gates exposure (prompt / player UI) and AI writability.
 * Evaluating activation conditions against raw values (never against the
 * other variable's own activation) is what keeps mutual bindings cycle-free.
 */

/** Whether the variable is currently active (exposed + gate-able).
 *  `worldbooks` is required (pass the card's worldbooks, or undefined for a
 *  card without modules) so no call site can silently skip the module gate. */
export function isVariableActive(
  variable: Variable,
  state: GameState,
  worldbooks: Worldbook[] | undefined,
): boolean {
  // Module gate: a variable belonging to an inactive worldbook (module) is
  // inactive, whatever its own gates say. Fail-open rules in isMemberActive.
  if (!isMemberActive(variable.worldbookId, worldbooks, state)) return false;

  // Enable gate: runtime toggle (via @vars.enabled.<id>) beats the authored
  // default, in both directions. Applies to every activation mode.
  const toggle = state.ruleState?.toggledVariables?.[variable.id];
  const gateOn = toggle ?? variable.enabled !== false;
  if (!gateOn) return false;

  const activation = variable.activation;
  if (!activation) return true; // undefined = always
  switch (activation.mode) {
    case "always":
    case "manual": // manual = no auto-rule; the enable gate above is the rule
      return true;
    case "conditions":
      return checkConditions(state, activation.conditions, activation.conditionLogic);
    case "greeting": {
      const current = String(state.activeGreetingId ?? "");
      return current !== "" && activation.greetingIds.includes(current);
    }
    default:
      return true;
  }
}

/** Whether the AI should see this variable in <game-state> / behavior rules. */
export function isAiReadable(
  variable: Variable,
  state: GameState,
  worldbooks: Worldbook[] | undefined,
): boolean {
  if (variable.internal) return false;
  if (!isVariableActive(variable, state, worldbooks)) return false;
  return (variable.aiAccess ?? "write") !== "none";
}

/** Whether AI directives may change this variable. */
export function isAiWritable(
  variable: Variable,
  state: GameState,
  // Optional so callers without a world at hand (main's state guard) still
  // compile; pass it wherever the world is known, or module gating is skipped.
  worldbooks?: Worldbook[],
): boolean {
  if (variable.internal) return false;
  if (!isVariableActive(variable, state, worldbooks)) return false;
  return !variable.formula && (variable.aiAccess ?? "write") === "write";
}

/** Active variable ids for a world — for UI layers that filter by id. */
export function resolveActiveVariableIds(
  world: WorldDefinition,
  state: GameState,
): Set<string> {
  const active = new Set<string>();
  for (const v of world.variables) {
    if (isVariableActive(v, state, world.worldbooks)) active.add(v.id);
  }
  return active;
}

/** Largest number of integer options the continuity judge can be offered
 *  for one variable (the decision model's per-question cap). */
export const CONTINUITY_MAX_OPTIONS = 255;

/** Whether the world's continuity judge runs at all (default on). */
export function isContinuityEnabled(world: Pick<WorldDefinition, "continuity">): boolean {
  return world.continuity?.enabled !== false;
}

/** Whether the continuity judge places this world's scene images (default on
 *  whenever the judge runs). When it does, the narrating model is not told
 *  about scene images at all: the judge picks one after the reply, from each
 *  image's "when to show" cue, so the result does not depend on whether the
 *  player's model follows directives. `continuity.images: false` hands the
 *  images back to the narrating model's `[image: id]`. */
export function isSceneImageJudgeOn(world: Pick<WorldDefinition, "continuity">): boolean {
  return isContinuityEnabled(world) && world.continuity?.images !== false;
}

/** Whether a variable's precise-tracking settings are usable as authored,
 *  independent of the world switch: numbers need a non-empty delta window
 *  that fits the option cap, strings need a value list, booleans need nothing,
 *  json is never eligible. */
export function isContinuityEligible(variable: Variable): boolean {
  if (variable.internal || variable.aiAccess === "none") return false;
  switch (variable.type) {
    case "number": {
      const down = Math.max(0, Math.floor(variable.deltaDown ?? 0));
      const up = Math.max(0, Math.floor(variable.deltaUp ?? 0));
      return down + up > 0 && down + up + 1 <= CONTINUITY_MAX_OPTIONS;
    }
    case "string":
      return (variable.options?.filter((o) => o.trim()).length ?? 0) > 0;
    case "boolean":
      return true;
    default:
      return false;
  }
}

/** What a fresh "max change per turn" window defaults to for a number
 *  variable: 15% of its range, or 10 when it has no range. */
export function suggestedContinuityDelta(variable: Pick<Variable, "min" | "max">): number {
  const range = typeof variable.min === "number" && typeof variable.max === "number" && variable.max > variable.min
    ? variable.max - variable.min
    : undefined;
  return range === undefined ? 10 : Math.max(1, Math.round(range * 0.15));
}

/**
 * A NEWLY CREATED variable with precise tracking switched on by default, so
 * the numbers a creator makes actually move in play instead of waiting on the
 * narrating model to remember a directive. Applied only where a variable is
 * born (editor add, templates, assistant, interface parts) — never to saved
 * variables, which keep whatever their author chose.
 *
 * Leaves the variable alone when its author already decided (`precise` set
 * either way), when the AI may not write it (internal / read / none — the
 * judge would be a second writer the author ruled out), when it is a
 * setup-scope choice the player makes before play, or when the type has
 * nothing for the judge to pick from (json, a string without a value list).
 * A number gets the suggested per-turn window when it has none.
 */
export function withPreciseTrackingDefault<V extends Variable>(variable: V): V {
  if (variable.precise !== undefined) return variable;
  if (variable.internal || variable.aiAccess === "none" || variable.aiAccess === "read") return variable;
  if (variable.scope === "setup") return variable;
  switch (variable.type) {
    case "number": {
      if (variable.deltaDown !== undefined || variable.deltaUp !== undefined) return { ...variable, precise: true };
      const d = suggestedContinuityDelta(variable);
      return { ...variable, precise: true, deltaDown: d, deltaUp: d };
    }
    case "boolean":
      return { ...variable, precise: true };
    case "string":
      return (variable.options?.filter((o) => o.trim()).length ?? 0) > 0 ? { ...variable, precise: true } : variable;
    default:
      return variable;
  }
}

/** Whether the continuity judge, not the narrative model, owns this variable's
 *  value. Owned variables render as read-only in the prompt and the model's
 *  directives for them are dropped — one variable, one writer. */
export function isContinuityOwned(world: Pick<WorldDefinition, "continuity">, variable: Variable): boolean {
  return isContinuityEnabled(world) && variable.precise === true && isContinuityEligible(variable);
}

/**
 * Split AI-issued effects into those targeting AI-writable variables (kept)
 * and those the AI is not allowed to change (dropped). Dot-paths resolve by
 * their root id. Unknown ids pass through — the existing unknown-variable
 * guard in GameStateManager owns that case (and its logging). Variables owned
 * by the continuity judge are dropped too: the judge writes them after the
 * reply, from its own decision.
 */
export function filterAiEffects(
  world: WorldDefinition,
  state: GameState,
  effects: Effect[],
  opts?: {
    /** False when the judge did not run this turn (timed out, failed, off
     *  server-wide). Its variables then fall back to the narrator: a
     *  directive the model wrote anyway is kept rather than lost, so a slow
     *  judge never freezes a variable. Omitted = the judge owns them. */
    judgeRan?: boolean;
  },
): { kept: Effect[]; dropped: Effect[] } {
  const judgeOwns = opts?.judgeRan !== false;
  const kept: Effect[] = [];
  const dropped: Effect[] = [];
  for (const effect of effects) {
    const rootId = effect.variableId.split(".")[0]!;
    const variable = world.variables.find((v) => v.id === rootId);
    if (!variable || (isAiWritable(variable, state, world.worldbooks) && !(judgeOwns && isContinuityOwned(world, variable)))) {
      kept.push(effect);
    } else {
      dropped.push(effect);
    }
  }
  return { kept, dropped };
}

/** Why `filterAiEffects` dropped an AI write — shown to the author in the
 *  playtest so a value that "should have changed" names its real gate. */
export type AiDropReason = "internal" | "read-only" | "inactive" | "judge";

export function aiDropReason(world: WorldDefinition, state: GameState, effect: Effect): AiDropReason | null {
  const rootId = effect.variableId.split(".")[0]!;
  const variable = world.variables.find((v) => v.id === rootId);
  if (!variable) return null;
  if (variable.internal) return "internal";
  if (!isVariableActive(variable, state, world.worldbooks)) return "inactive";
  if (variable.formula || (variable.aiAccess ?? "write") !== "write") return "read-only";
  if (isContinuityOwned(world, variable)) return "judge";
  return null;
}
