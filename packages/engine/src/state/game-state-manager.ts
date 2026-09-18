import type { Variable, Effect, GameState, WorldDefinition, Directive, RuleRuntimeState, RuleAction } from "../types/index.js";
import { createEmptyRuleState } from "../rules/rule-state.js";
import { getByPath } from "./path-utils.js";
import { POISON_SYSTEM, poisonPeriodAdvance, settlePoisonState } from "../systems/poison-survival.js";

type VariableValue = number | string | boolean | Record<string, unknown> | unknown[];

type StateChangeCallback = (
  variableId: string,
  oldValue: VariableValue,
  newValue: VariableValue
) => void;

/**
 * Reactive game state manager.
 * Manages game variables during play — initialize from a WorldDefinition,
 * read/write variables, apply effects, snapshot/restore, and notify listeners.
 */
export class GameStateManager {
  private state: GameState;
  private variables: Map<string, Variable>;
  private nameToId: Map<string, string>;
  private listeners: Set<StateChangeCallback> = new Set();
  private worldId: string;
  private defaultVariables: Record<string, VariableValue>;
  private poisonSurvival: boolean;

  constructor(world: WorldDefinition, existingState?: GameState) {
    this.poisonSurvival = world.systems?.includes(POISON_SYSTEM) === true;
    this.variables = new Map(world.variables.map((v) => [v.id, v]));
    this.nameToId = new Map(world.variables.map((v) => [v.name, v.id]));
    this.worldId = world.id;
    this.defaultVariables = Object.fromEntries(
      world.variables.map((v) => [v.id, v.defaultValue])
    );
    this.state = this.normalizeState(existingState);
  }

  get(variableId: string): VariableValue | undefined {
    return this.state.variables[variableId];
  }

  set(variableId: string, value: VariableValue): void {
    const resolved = this.resolveVariable(variableId);
    if (!resolved) return;

    const { variable, resolvedId } = resolved;
    const oldValue = this.state.variables[resolvedId];
    if (oldValue === undefined) return;

    const coerced = this.coerceJsonWrite(variable, oldValue, value);
    if (!coerced.ok) return;

    const validated = this.validateValue(variable, coerced.value);
    if (oldValue === validated) return;

    this.state = {
      ...this.state,
      variables: { ...this.state.variables, [resolvedId]: validated },
    };

    for (const listener of this.listeners) {
      listener(resolvedId, oldValue, validated);
    }
  }

  applyEffects(effects: Effect[]): Array<{
    variableId: string;
    oldValue: VariableValue;
    newValue: VariableValue;
  }> {
    const changes: Array<{
      variableId: string;
      oldValue: VariableValue;
      newValue: VariableValue;
    }> = [];

    for (const rawEffect of effects) {
      // If the operand is a variable reference, resolve it against current state
      // to a concrete value before applying (variable-driven effects, e.g. 生命 -= 力量).
      let effect = rawEffect;
      if (rawEffect.valueRef !== undefined) {
        const operand = this.resolveOperand(rawEffect.valueRef);
        if (operand === undefined) continue; // unresolved reference → skip
        effect = { ...rawEffect, value: operand };
      }

      // Handle dot-path effects (e.g., factions.ember_court.affinity)
      if (effect.variableId.includes(".")) {
        const { rootId, applied, oldValue, newValue } = this.resolvePathEffect(effect);
        if (applied) {
          changes.push({ variableId: rootId, oldValue, newValue });
        }
        continue; // Skip normal processing
      }

      const resolved = this.resolveVariable(effect.variableId);
      if (!resolved) continue;

      const { variable, resolvedId } = resolved;
      const oldValue = this.state.variables[resolvedId];
      if (oldValue === undefined) continue;

      if (this.poisonSurvival && resolvedId === "time-period") {
        if (effect.operation !== "set" || this.state.metadata.poisonTimeTurn === this.state.turnCount) continue;
        // Free-text periods resolve to a canonical phase before the one-step
        // check, and the canonical value is what gets stored. Comparing the raw
        // string froze the clock of every save holding "深夜" / "傍晚".
        const advanced = poisonPeriodAdvance(oldValue, effect.value);
        if (advanced === null) continue;
        effect = { ...effect, value: advanced };
        this.state = { ...this.state, metadata: { ...this.state.metadata, poisonTimeTurn: this.state.turnCount } };
      }

      let newValue: VariableValue;

      switch (effect.operation) {
        case "set":
          newValue = effect.value;
          break;
        case "add":
          newValue =
            typeof oldValue === "number" && typeof effect.value === "number"
              ? oldValue + effect.value
              : oldValue;
          break;
        case "subtract":
          newValue =
            typeof oldValue === "number" && typeof effect.value === "number"
              ? oldValue - effect.value
              : oldValue;
          break;
        case "multiply":
          newValue =
            typeof oldValue === "number" && typeof effect.value === "number"
              ? oldValue * effect.value
              : oldValue;
          break;
        case "toggle":
          newValue = typeof oldValue === "boolean" ? !oldValue : oldValue;
          break;
        case "append":
          newValue =
            typeof oldValue === "string" && typeof effect.value === "string"
              ? oldValue + effect.value
              : oldValue;
          break;
        case "merge": {
          if (typeof oldValue === "object" && oldValue !== null && !Array.isArray(oldValue) &&
              typeof effect.value === "object" && effect.value !== null && !Array.isArray(effect.value)) {
            newValue = { ...oldValue, ...(effect.value as Record<string, unknown>) };
          } else {
            continue;
          }
          break;
        }
        case "push": {
          if (Array.isArray(oldValue)) {
            newValue = [...oldValue, effect.value];
          } else {
            continue;
          }
          break;
        }
        case "delete": {
          if (typeof oldValue === "object" && oldValue !== null && !Array.isArray(oldValue) && typeof effect.value === "string") {
            const copy = { ...oldValue };
            delete copy[effect.value as string];
            newValue = copy;
          } else if (Array.isArray(oldValue) && typeof effect.value === "number") {
            newValue = oldValue.filter((_, i) => i !== effect.value);
          } else {
            continue;
          }
          break;
        }
        default:
          continue;
      }

      const coerced = this.coerceJsonWrite(variable, oldValue, newValue);
      if (!coerced.ok) continue;

      const validated = this.validateValue(variable, coerced.value);
      if (oldValue !== validated) {
        changes.push({
          variableId: resolvedId,
          oldValue,
          newValue: validated,
        });
      }

      this.state = {
        ...this.state,
        variables: {
          ...this.state.variables,
          [resolvedId]: validated,
        },
      };
    }

    for (const change of changes) {
      for (const listener of this.listeners) {
        listener(change.variableId, change.oldValue, change.newValue);
      }
    }

    return changes;
  }

  getSnapshot(): GameState {
    return {
      ...this.state,
      variables: { ...this.state.variables },
      metadata: { ...this.state.metadata },
      ruleState: this.cloneRuleState(this.state.ruleState),
    };
  }

  /** Settle opted-in deterministic rules after the complete reaction chain. */
  settleSystems(): Array<{ variableId: string; oldValue: VariableValue; newValue: VariableValue }> {
    if (!this.poisonSurvival) return [];
    const before = this.state;
    this.state = settlePoisonState(before);
    return Object.entries(this.state.variables).flatMap(([variableId, newValue]) => {
      const oldValue = before.variables[variableId];
      return oldValue !== undefined && JSON.stringify(oldValue) !== JSON.stringify(newValue)
        ? [{ variableId, oldValue, newValue }] : [];
    });
  }

  loadSnapshot(state: GameState): void {
    this.state = this.normalizeState(state);
  }

  incrementTurn(): void {
    this.state = { ...this.state, turnCount: this.state.turnCount + 1 };
  }

  getMetadata(key: string): unknown {
    return this.state.metadata[key];
  }

  setMetadata(key: string, value: unknown): void {
    this.state = {
      ...this.state,
      metadata: { ...this.state.metadata, [key]: value },
    };
  }

  onChange(callback: StateChangeCallback): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  // ── RuleState Management ──

  /** Get the current rule runtime state */
  getRuleState(): RuleRuntimeState {
    return this.state.ruleState ?? createEmptyRuleState();
  }

  /** Add or replace a directive */
  injectDirective(directive: Directive): void {
    const ruleState = this.getRuleState();
    // Remove existing directive with same ID
    const filtered = ruleState.activeDirectives.filter((d) => d.id !== directive.id);
    this.state = {
      ...this.state,
      ruleState: {
        ...ruleState,
        activeDirectives: [...filtered, directive],
      },
    };
  }

  /** Remove a directive by ID */
  removeDirective(directiveId: string): void {
    const ruleState = this.getRuleState();
    this.state = {
      ...this.state,
      ruleState: {
        ...ruleState,
        activeDirectives: ruleState.activeDirectives.filter((d) => d.id !== directiveId),
      },
    };
  }

  /** Expire directives whose duration has been exceeded */
  expireDirectives(currentTurn: number): Directive[] {
    const ruleState = this.getRuleState();
    const expired: Directive[] = [];
    const remaining: Directive[] = [];

    for (const d of ruleState.activeDirectives) {
      if (d.duration !== undefined && currentTurn - d.injectedAtTurn >= d.duration) {
        expired.push(d);
      } else {
        remaining.push(d);
      }
    }

    if (expired.length > 0) {
      this.state = {
        ...this.state,
        ruleState: { ...ruleState, activeDirectives: remaining },
      };
    }

    return expired;
  }

  /** Toggle a rule's enabled state at runtime */
  toggleRule(ruleId: string, enabled: boolean): void {
    const ruleState = this.getRuleState();
    const disabledRules = enabled
      ? ruleState.disabledRules.filter((id) => id !== ruleId)
      : [...new Set([...ruleState.disabledRules, ruleId])];
    this.state = {
      ...this.state,
      ruleState: { ...ruleState, disabledRules },
    };
  }

  /** Toggle an entry's enabled state at runtime */
  toggleEntry(entryId: string, enabled: boolean): void {
    const ruleState = this.getRuleState();
    this.state = {
      ...this.state,
      ruleState: {
        ...ruleState,
        toggledEntries: { ...ruleState.toggledEntries, [entryId]: enabled },
      },
    };
  }

  /** Override a variable's enable gate at runtime (via @vars.enabled.<id>).
   *  Beats the variable's authored `enabled` default in both directions —
   *  see state/variable-activation.ts. */
  toggleVariable(variableId: string, enabled: boolean): void {
    const ruleState = this.getRuleState();
    this.state = {
      ...this.state,
      ruleState: {
        ...ruleState,
        toggledVariables: { ...(ruleState.toggledVariables ?? {}), [variableId]: enabled },
      },
    };
  }

  /** Record that a rule fired (for cooldown and fire count tracking) */
  recordRuleFired(ruleId: string, currentTurn: number, cooldownTurns?: number): void {
    const ruleState = this.getRuleState();
    const fireCounts = { ...ruleState.fireCounts };
    fireCounts[ruleId] = (fireCounts[ruleId] ?? 0) + 1;

    const cooldowns = { ...ruleState.cooldowns };
    if (cooldownTurns !== undefined && cooldownTurns > 0) {
      cooldowns[ruleId] = currentTurn + cooldownTurns;
    }

    this.state = {
      ...this.state,
      ruleState: { ...ruleState, fireCounts, cooldowns },
    };
  }

  /** Snapshot current variables for next turn's variable-crossed detection */
  snapshotPrevVars(): void {
    const ruleState = this.getRuleState();
    this.state = {
      ...this.state,
      ruleState: {
        ...ruleState,
        prevVars: { ...this.state.variables },
      },
    };
  }

  /**
   * Apply rule actions to this state manager.
   * Handles all action types: modify-variable, inject-directive, remove-directive,
   * toggle-entry, toggle-rule. Returns notifications and send-context messages.
   */
  applyRuleActions(
    actions: RuleAction[],
    firedRuleIds: string[],
    rules: { id: string; cooldownTurns?: number }[]
  ): {
    notifications: Array<{ message: string; style: string }>;
    contextMessages: Array<{ message: string; role: string }>;
  } {
    const notifications: Array<{ message: string; style: string }> = [];
    const contextMessages: Array<{ message: string; role: string }> = [];

    for (const action of actions) {
      switch (action.type) {
        case "modify-variable": {
          this.applyEffects([{
            variableId: action.variableId,
            operation: action.operation,
            value: action.value,
          }]);
          break;
        }
        case "inject-directive": {
          this.injectDirective({
            id: action.directiveId,
            content: action.content,
            position: action.position ?? "auto",
            sourceRuleId: "", // Will be set by caller if needed
            persistent: action.persistent !== false,
            injectedAtTurn: this.state.turnCount,
            duration: action.duration,
          });
          break;
        }
        case "remove-directive": {
          this.removeDirective(action.directiveId);
          break;
        }
        case "toggle-entry": {
          this.toggleEntry(action.entryId, action.enabled);
          break;
        }
        case "toggle-rule": {
          this.toggleRule(action.ruleId, action.enabled);
          break;
        }
        case "notify-player": {
          notifications.push({
            message: action.message,
            style: action.style ?? "info",
          });
          break;
        }
        case "send-context": {
          contextMessages.push({
            message: action.message,
            role: action.role ?? "system",
          });
          break;
        }
        case "play-audio": {
          // Audio effects are handled by the caller (chat store / server)
          break;
        }
      }
    }

    // Record cooldowns and fire counts for each fired rule
    const ruleMap = new Map(rules.map((r) => [r.id, r]));
    for (const ruleId of firedRuleIds) {
      const ruleDef = ruleMap.get(ruleId);
      this.recordRuleFired(ruleId, this.state.turnCount, ruleDef?.cooldownTurns);
    }

    return { notifications, contextMessages };
  }

  private resolveVariable(idOrName: string): { variable: Variable; resolvedId: string } | null {
    const variable = this.variables.get(idOrName);
    if (variable) return { variable, resolvedId: idOrName };
    // Fallback: LLM may have used the display name instead of the ID
    const mappedId = this.nameToId.get(idOrName);
    if (mappedId) {
      const mapped = this.variables.get(mappedId);
      if (mapped) return { variable: mapped, resolvedId: mappedId };
    }
    return null;
  }

  /** Resolve an effect operand reference to its current value — by variable id,
   *  display name, or nested dot-path. Returns undefined if unresolved. */
  private resolveOperand(ref: string): VariableValue | undefined {
    if (!ref.includes(".")) {
      const resolved = this.resolveVariable(ref);
      if (resolved) return this.state.variables[resolved.resolvedId] as VariableValue | undefined;
    }
    return getByPath(this.state.variables, ref) as VariableValue | undefined;
  }

  private resolvePathEffect(effect: Effect): {
    rootId: string;
    applied: boolean;
    oldValue: VariableValue;
    newValue: VariableValue;
  } {
    const dotIndex = effect.variableId.indexOf(".");
    if (dotIndex === -1) return { rootId: effect.variableId, applied: false, oldValue: 0, newValue: 0 };

    const rootId = effect.variableId.substring(0, dotIndex);
    const path = effect.variableId.substring(dotIndex + 1);
    const rootVar = this.variables.get(rootId);
    if (!rootVar || rootVar.type !== "json") return { rootId: effect.variableId, applied: false, oldValue: 0, newValue: 0 };

    const rootValue = this.state.variables[rootId];
    if (typeof rootValue !== "object" || rootValue === null) return { rootId, applied: false, oldValue: 0, newValue: 0 };

    // Deep clone the root value
    const cloned = JSON.parse(JSON.stringify(rootValue));
    const oldRoot = JSON.parse(JSON.stringify(rootValue));

    // Navigate to parent and set the leaf
    const parts = path.split(".");
    if (parts.length === 0) return { rootId, applied: false, oldValue: 0, newValue: 0 };

    let current: Record<string, unknown> = cloned as Record<string, unknown>;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i]!;
      if (current[key] === undefined || current[key] === null) {
        current[key] = {}; // auto-create intermediate objects
      }
      current = current[key] as Record<string, unknown>;
    }

    const leafKey = parts[parts.length - 1]!;

    // Apply the operation to the leaf
    switch (effect.operation) {
      case "set":
        current[leafKey] = effect.value;
        break;
      case "add":
        if (typeof current[leafKey] === "number" && typeof effect.value === "number") {
          current[leafKey] = (current[leafKey] as number) + effect.value;
        }
        break;
      case "subtract":
        if (typeof current[leafKey] === "number" && typeof effect.value === "number") {
          current[leafKey] = (current[leafKey] as number) - effect.value;
        }
        break;
      case "delete":
        if (Array.isArray(current)) {
          const idx = parseInt(leafKey);
          if (!isNaN(idx)) current.splice(idx, 1);
        } else {
          delete current[leafKey];
        }
        break;
      case "merge":
        if (typeof current[leafKey] === "object" && current[leafKey] !== null && typeof effect.value === "object" && effect.value !== null) {
          current[leafKey] = { ...(current[leafKey] as Record<string, unknown>), ...(effect.value as Record<string, unknown>) };
        }
        break;
      case "push":
        if (Array.isArray(current[leafKey])) {
          current[leafKey] = [...(current[leafKey] as unknown[]), effect.value];
        }
        break;
      default:
        current[leafKey] = effect.value;
    }

    // Update the root variable
    this.state = {
      ...this.state,
      variables: { ...this.state.variables, [rootId]: cloned },
    };

    for (const listener of this.listeners) {
      listener(rootId, oldRoot as VariableValue, cloned as VariableValue);
    }

    return { rootId, applied: true, oldValue: oldRoot as VariableValue, newValue: cloned as VariableValue };
  }

  /**
   * Writes the engine refused. Drained by the caller (the message route) so a
   * refusal is logged rather than silent — silence is how one malformed
   * directive turned a card's entire inventory into the string
   * "delete 1, delete 0" and the player's items were gone for good.
   */
  private rejectedWrites: Array<{ variableId: string; value: VariableValue }> = [];

  drainRejectedWrites(): Array<{ variableId: string; value: VariableValue }> {
    const out = this.rejectedWrites;
    this.rejectedWrites = [];
    return out;
  }

  /**
   * A `json` variable currently holding a list/object must not be replaced
   * wholesale by a bare scalar: `[items: set delete 1, delete 0]` is a model
   * fumbling the delete syntax, not an instruction to store that text over the
   * whole array. A string that PARSES to a list/object is repaired rather than
   * refused — models quote their JSON often enough to be worth healing.
   *
   * Deliberately narrow: the guard only fires when the value being replaced is
   * itself a list/object, so a card that legitimately keeps a scalar in a json
   * variable keeps working, and every non-`set` operation (push/merge/delete)
   * already has its own shape check above.
   */
  private coerceJsonWrite(
    variable: Variable,
    oldValue: VariableValue | undefined,
    newValue: VariableValue
  ): { ok: true; value: VariableValue } | { ok: false } {
    if (variable.type !== "json") return { ok: true, value: newValue };
    if (typeof newValue === "object" && newValue !== null) return { ok: true, value: newValue };
    if (typeof oldValue !== "object" || oldValue === null) return { ok: true, value: newValue };

    if (typeof newValue === "string") {
      try {
        const parsed = JSON.parse(newValue) as VariableValue;
        if (typeof parsed === "object" && parsed !== null) return { ok: true, value: parsed };
      } catch {
        // Not JSON — fall through to the refusal below.
      }
    }

    this.rejectedWrites.push({ variableId: variable.id, value: newValue });
    return { ok: false };
  }

  private validateValue(
    variable: Variable,
    value: VariableValue
  ): VariableValue {
    if (variable.type === "json") return value;
    if (variable.type === "number" && typeof value === "number") {
      let v = value;
      if (variable.min !== undefined) v = Math.max(variable.min, v);
      if (variable.max !== undefined) v = Math.min(variable.max, v);
      return v;
    }
    return value;
  }

  private normalizeState(state?: Partial<GameState>): GameState {
    const providedVariables = state?.variables ?? {};
    const knownVariables = Object.fromEntries(
      Object.entries(providedVariables).filter(([variableId]) =>
        // Keep declared variables, plus the `__lore_{slotId}` flags that the
        // frontend LoreButton/LoreSwitch/LoreGroup persist. They are NOT declared
        // in world.variables (so they never render into <game-state>, which only
        // iterates declared vars), but they ARE the source of truth for which
        // frontend lore slot is on — stripping them made the toggle reset itself
        // and the bound entry vanish from the prompt after a reply.
        this.variables.has(variableId) || variableId.startsWith("__lore_")
      )
    );

    const normalized: GameState = {
      worldId: this.worldId,
      variables: {
        ...this.defaultVariables,
        ...knownVariables,
      },
      turnCount:
        typeof state?.turnCount === "number" && Number.isFinite(state.turnCount)
          ? state.turnCount
          : 0,
      metadata: { ...(state?.metadata ?? {}) },
      ruleState: this.cloneRuleState(state?.ruleState),
    };

    if ("activeCharacterId" in (state ?? {})) {
      normalized.activeCharacterId = state?.activeCharacterId;
    }

    // The chosen opening is a session fact (worldbook greeting-mode keys off it),
    // not a declared variable — preserve it across normalization like above.
    if ("activeGreetingId" in (state ?? {})) {
      normalized.activeGreetingId = state?.activeGreetingId;
    }

    return this.poisonSurvival ? settlePoisonState(normalized) : normalized;
  }

  private cloneRuleState(ruleState?: RuleRuntimeState): RuleRuntimeState {
    const safeRuleState = ruleState ?? createEmptyRuleState();

    return {
      disabledRules: [...(safeRuleState.disabledRules ?? [])],
      activeDirectives: (safeRuleState.activeDirectives ?? []).map(
        (directive) => ({ ...directive })
      ),
      cooldowns: { ...(safeRuleState.cooldowns ?? {}) },
      fireCounts: { ...(safeRuleState.fireCounts ?? {}) },
      prevVars: { ...(safeRuleState.prevVars ?? {}) },
      toggledEntries: { ...(safeRuleState.toggledEntries ?? {}) },
      toggledVariables: { ...(safeRuleState.toggledVariables ?? {}) },
    };
  }
}

