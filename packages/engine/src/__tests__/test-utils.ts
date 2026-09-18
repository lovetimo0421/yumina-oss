/**
 * Test factory functions for creating minimal valid mock objects.
 * All factories produce objects that conform to their Zod schemas and TypeScript types.
 * Pass partial overrides to customize specific fields.
 */

import type {
  Variable,
  WorldDefinition,
  GameState,
  WorldEntry,
  WorldSettings,
  Rule,
  Condition,
  Effect,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _idCounter = 0;

/** Generate a unique ID for test objects */
function uniqueId(prefix = "test"): string {
  _idCounter++;
  return `${prefix}-${_idCounter}`;
}

/** Reset the ID counter (call in beforeEach if deterministic IDs are needed) */
export function resetIdCounter(): void {
  _idCounter = 0;
}

// ---------------------------------------------------------------------------
// createMockVariable
// ---------------------------------------------------------------------------

/**
 * Create a minimal valid Variable with sensible defaults.
 * Defaults to a number variable named "health" with value 100.
 */
export function createMockVariable(overrides: Partial<Variable> = {}): Variable {
  return {
    id: uniqueId("var"),
    name: "health",
    type: "number",
    defaultValue: 100,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createMockCondition
// ---------------------------------------------------------------------------

/** Create a minimal valid Condition. */
export function createMockCondition(overrides: Partial<Condition> = {}): Condition {
  return {
    variableId: "var-1",
    operator: "gte",
    value: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createMockEffect
// ---------------------------------------------------------------------------

/** Create a minimal valid Effect. */
export function createMockEffect(overrides: Partial<Effect> = {}): Effect {
  return {
    variableId: "var-1",
    operation: "add",
    value: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createMockRule
// ---------------------------------------------------------------------------

/** Create a minimal valid Rule. */
export function createMockRule(overrides: Partial<Rule> = {}): Rule {
  return {
    id: uniqueId("rule"),
    name: "Test Rule",
    trigger: { type: "state-change" },
    conditions: [],
    conditionLogic: "all",
    actions: [],
    priority: 0,
    enabled: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createMockEntry
// ---------------------------------------------------------------------------

/**
 * Create a minimal valid WorldEntry with position/role/content.
 * Defaults to a character entry at the "character" position.
 */
export function createMockEntry(overrides: Partial<WorldEntry> = {}): WorldEntry {
  return {
    id: uniqueId("entry"),
    name: "Test Character",
    content: "A brave adventurer.",
    role: "character",
    position: 0,
    alwaysSend: false,
    keywords: [],
    conditions: [],
    conditionLogic: "all",
    enabled: true,
    section: "system-presets",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createMockSettings
// ---------------------------------------------------------------------------

/** Create minimal valid WorldSettings. */
export function createMockSettings(overrides: Partial<WorldSettings> = {}): WorldSettings {
  return {
    maxTokens: 4000,
    temperature: 1.0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createMockWorld
// ---------------------------------------------------------------------------

/**
 * Create a minimal valid WorldDefinition.
 * All array fields default to empty. Override any field as needed.
 */
export function createMockWorld(overrides: Partial<WorldDefinition> = {}): WorldDefinition {
  return {
    id: uniqueId("world"),
    version: "1.0.0",
    name: "Test World",
    description: "A test world for unit tests.",
    author: "tester",
    entries: [],
    variables: [],
    rules: [],
    components: [],
    audioTracks: [],
    customComponents: [],
    customUI: [],
    settings: createMockSettings(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createMockGameState
// ---------------------------------------------------------------------------

/**
 * Create a minimal valid GameState.
 * Pass `variables` to pre-populate the state, or pass an array of Variable
 * objects and the state will be initialized from their defaultValues.
 */
export function createMockGameState(
  overrides: Partial<GameState> & {
    /** Convenience: initialize variables from Variable definitions */
    fromVariables?: Variable[];
  } = {},
): GameState {
  const { fromVariables, ...rest } = overrides;

  let variables: Record<string, number | string | boolean | Record<string, unknown> | unknown[]> = {};

  if (fromVariables) {
    for (const v of fromVariables) {
      variables[v.id] = v.defaultValue;
    }
  }

  // Explicit variables override fromVariables
  if (rest.variables) {
    variables = { ...variables, ...rest.variables };
  }

  return {
    worldId: "world-1",
    variables,
    turnCount: 0,
    metadata: {},
    ...rest,
    // Ensure variables always reflects the merged result
    ...(Object.keys(variables).length > 0 ? { variables } : {}),
  };
}
