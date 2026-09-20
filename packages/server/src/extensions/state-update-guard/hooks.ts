import { registerExtensionHooks } from "../../lib/extension-hooks.js";
import { guardTurnOutput, STATE_GUARD_INSTRUCTIONS } from "./validate.js";

export function registerStateUpdateGuard(): void {
  registerExtensionHooks("state-update-guard", {
    resolveCapabilities: ({ session }) => session.stateGuardEnabled === false ? null : [],
    resolveOutputModel: ({ session }) => typeof session.stateGuardModel === "string" ? session.stateGuardModel : null,
    turnOutputInstructions: () => STATE_GUARD_INSTRUCTIONS,
    validateTurnOutput: guardTurnOutput,
  });
}
