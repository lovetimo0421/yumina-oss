import { isAiWritable } from "@yumina/engine";
import { registerExtensionHooks } from "../../lib/extension-hooks.js";
import { guardTurnOutput, STATE_GUARD_INSTRUCTIONS } from "./validate.js";
import { stateGuardDefaultApplies } from "./activation.js";

export function registerStateUpdateGuard(): void {
  registerExtensionHooks("state-update-guard", {
    // On by default for cards with AI-writable variables (see activation.ts).
    activeByDefault: ({ world }) => stateGuardDefaultApplies(world),
    resolveCapabilities: ({ session }) => session.stateGuardEnabled === false ? null : [],
    resolveOutputModel: ({ session }) => typeof session.stateGuardModel === "string" ? session.stateGuardModel : null,
    // Omit the receipt contract when this prompt snapshot has no AI writes.
    // The validation hook stays active in case the model proposes a rogue write.
    turnOutputInstructions: ({ world, state }) => world.variables.some(v => isAiWritable(v, state)) ? STATE_GUARD_INSTRUCTIONS : "",
    validateTurnOutput: guardTurnOutput,
  });
}
