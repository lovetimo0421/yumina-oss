import type { RuleRuntimeState } from "../types/index.js";

/** Create an empty RuleRuntimeState (cooldowns, fire counts, toggles, etc.). */
export function createEmptyRuleState(): RuleRuntimeState {
  return {
    disabledRules: [],
    activeDirectives: [],
    cooldowns: {},
    fireCounts: {},
    prevVars: {},
    toggledEntries: {},
    toggledVariables: {},
  };
}
