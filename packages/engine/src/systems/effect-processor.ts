import type { Effect, AudioEffect } from "../types/index.js";
import type { ReactionEffect, GameEvent } from "../events/types.js";
import type { GameStateManager } from "../state/game-state-manager.js";

/**
 * Result of processing @ system effects from reactions.
 * Separates system-level side effects from regular game variable changes.
 */
export interface SystemEffectResult {
  /** Regular game variable effects (non-@ paths) — apply via GameStateManager */
  variableEffects: Effect[];

  /** Audio effects extracted from @audio.* and audio:play events */
  audioEffects: AudioEffect[];

  /** Directives extracted from @prompt.directive.* */
  directives: Array<{
    id: string;
    content: string;
    position: string;
    persistent: boolean;
    duration?: number;
  }>;

  /** Directive removals from @prompt.directive.* set to false */
  directiveRemovals: string[];

  /** Entry toggles from @prompt.entry.* */
  entryToggles: Array<{ entryId: string; enabled: boolean }>;

  /** Rule toggles from @rules.disabled.* */
  ruleToggles: Array<{ ruleId: string; enabled: boolean }>;

  /** Variable enable-gate toggles from @vars.enabled.* */
  variableToggles: Array<{ variableId: string; enabled: boolean }>;

  /** Notifications from ui:notification events and @ui.notification */
  notifications: Array<{ message: string; style: string }>;

  /** Context messages from ai:context events */
  contextMessages: Array<{ message: string; role: string }>;
}

/**
 * Process reaction effects and separate them into system-level side effects.
 *
 * This is the bridge between the generic "set any @ path" model and the
 * concrete systems that need to act on those values. Each @ prefix maps
 * to a specific system:
 *
 *   @audio.*           → AudioSystem (play/stop tracks)
 *   @prompt.directive.* → PromptSystem (inject/remove directives)
 *   @prompt.entry.*     → PromptSystem (toggle entries)
 *   @prompt.context     → PromptSystem (one-shot context)
 *   @rules.disabled.*   → RuleSystem (toggle rules)
 *   @ui.notification    → UISystem (show toast)
 *   @ai.context         → AISystem (context message)
 */
export function processSystemEffects(effects: ReactionEffect[]): SystemEffectResult {
  const result: SystemEffectResult = {
    variableEffects: [],
    audioEffects: [],
    directives: [],
    directiveRemovals: [],
    entryToggles: [],
    ruleToggles: [],
    variableToggles: [],
    notifications: [],
    contextMessages: [],
  };

  for (const effect of effects) {
    if (effect.type === "set") {
      processSetEffect(effect, result);
    } else if (effect.type === "emit") {
      processEmitEffect(effect.event, result);
    }
  }

  return result;
}

function processSetEffect(
  effect: Extract<ReactionEffect, { type: "set" }>,
  result: SystemEffectResult,
): void {
  const { path, value, operation, valueRef } = effect;

  // Non-@ paths are regular game variable effects
  if (!path.startsWith("@")) {
    result.variableEffects.push({
      variableId: path,
      operation: operation ?? "set",
      value,
      valueRef,
    });
    return;
  }

  // @audio.bgm / @audio.sfx / @audio.ambient → play audio
  if (path === "@audio.bgm" || path === "@audio.sfx" || path === "@audio.ambient") {
    if (typeof value === "string" && value) {
      result.audioEffects.push({ trackId: value, action: "play" });
    }
    return;
  }

  // @audio.stop → stop audio
  if (path === "@audio.stop") {
    if (typeof value === "string" && value) {
      result.audioEffects.push({ trackId: value, action: "stop" });
    }
    return;
  }

  // @prompt.directive.<id> → inject or remove directive
  if (path.startsWith("@prompt.directive.")) {
    const directiveId = path.slice("@prompt.directive.".length);
    if (!directiveId) return;

    // value=false means remove
    if (value === false) {
      result.directiveRemovals.push(directiveId);
      return;
    }

    // value is a string → simple directive content
    if (typeof value === "string") {
      result.directives.push({
        id: directiveId,
        content: value,
        position: "auto",
        persistent: true,
      });
      return;
    }

    // value is an object → full directive config { content, position, persistent, duration }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      if (typeof obj.content === "string") {
        result.directives.push({
          id: directiveId,
          content: obj.content,
          position: (obj.position as string) ?? "auto",
          persistent: obj.persistent !== false,
          duration: typeof obj.duration === "number" ? obj.duration : undefined,
        });
      }
      return;
    }
    return;
  }

  // @prompt.entry.<id> → toggle entry
  if (path.startsWith("@prompt.entry.")) {
    const entryId = path.slice("@prompt.entry.".length);
    if (entryId && typeof value === "boolean") {
      result.entryToggles.push({ entryId, enabled: value });
    }
    return;
  }

  // @prompt.context → one-shot context message
  if (path === "@prompt.context") {
    if (typeof value === "string" && value) {
      result.contextMessages.push({ message: value, role: "system" });
    }
    return;
  }

  // @vars.enabled.<id> → variable enable-gate override (see variable-activation.ts)
  if (path.startsWith("@vars.enabled.")) {
    const variableId = path.slice("@vars.enabled.".length);
    if (variableId && typeof value === "boolean") {
      result.variableToggles.push({ variableId, enabled: value });
    }
    return;
  }

  // @rules.disabled.<id> → toggle rule (value=true means disabled)
  if (path.startsWith("@rules.disabled.")) {
    const ruleId = path.slice("@rules.disabled.".length);
    if (ruleId && typeof value === "boolean") {
      result.ruleToggles.push({ ruleId, enabled: !value });
    }
    return;
  }

  // @ui.notification → show notification
  if (path === "@ui.notification") {
    if (typeof value === "string" && value) {
      result.notifications.push({ message: value, style: "info" });
    }
    return;
  }

  // @ai.context → one-shot context for AI
  if (path === "@ai.context") {
    if (typeof value === "string" && value) {
      result.contextMessages.push({ message: value, role: "system" });
    }
    return;
  }

  // Unknown @ path — ignore silently (future systems will handle their own)
}

function processEmitEffect(event: GameEvent, result: SystemEffectResult): void {
  switch (event.type) {
    case "audio:play":
      if (typeof event.trackId === "string") {
        result.audioEffects.push({
          trackId: event.trackId,
          action: (event.action as AudioEffect["action"]) ?? "play",
          volume: typeof event.volume === "number" ? event.volume : undefined,
          fadeDuration: typeof event.fadeDuration === "number" ? event.fadeDuration : undefined,
          chainTo: typeof event.chainTo === "string" ? event.chainTo : undefined,
          maxDuration: typeof event.maxDuration === "number" ? event.maxDuration : undefined,
        });
      }
      break;

    case "ui:notification":
      if (typeof event.message === "string") {
        result.notifications.push({
          message: event.message,
          style: (event.style as string) ?? "info",
        });
      }
      break;

    case "ai:context":
      if (typeof event.message === "string") {
        result.contextMessages.push({
          message: event.message,
          role: (event.role as string) ?? "system",
        });
      }
      break;

    // Unknown event types — future systems handle these
  }
}

/**
 * Apply the system effects to a GameStateManager.
 * Handles directives, entry/rule toggles, and variable effects.
 * Returns the variable changes (for persistence).
 */
export function applySystemEffects(
  stateManager: GameStateManager,
  systemResult: SystemEffectResult,
): Array<{ variableId: string; oldValue: unknown; newValue: unknown }> {
  // Apply directives
  for (const directive of systemResult.directives) {
    stateManager.injectDirective({
      id: directive.id,
      content: directive.content,
      position: directive.position as any,
      sourceRuleId: "",
      persistent: directive.persistent,
      injectedAtTurn: stateManager.getSnapshot().turnCount,
      duration: directive.duration,
    });
  }

  // Remove directives
  for (const directiveId of systemResult.directiveRemovals) {
    stateManager.removeDirective(directiveId);
  }

  // Toggle entries
  for (const toggle of systemResult.entryToggles) {
    stateManager.toggleEntry(toggle.entryId, toggle.enabled);
  }

  // Toggle rules
  for (const toggle of systemResult.ruleToggles) {
    stateManager.toggleRule(toggle.ruleId, toggle.enabled);
  }

  // Toggle variable enable gates
  for (const toggle of systemResult.variableToggles) {
    stateManager.toggleVariable(toggle.variableId, toggle.enabled);
  }

  // Apply variable effects
  return stateManager.applyEffects(systemResult.variableEffects);
}
