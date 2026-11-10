import { GameStateManager, type GameState, type WorldDefinition } from "@yumina/engine";
import { resolvePreviewOpening } from "./preview-opening";

export type PreviewVariables = GameState["variables"];

/** Match session-start seeds (including legacy display-name keys and numeric
 * bounds), then apply the author's temporary preview controls. Module scene
 * overrides are applied by LiveFrontendPreview after this shared base. */
export function resolvePreviewVariables(
  world: WorldDefinition,
  greetingId?: string,
  overrides: PreviewVariables = {},
): PreviewVariables {
  const state = new GameStateManager(world);
  const opening = resolvePreviewOpening(world.entries, greetingId);
  for (const [key, value] of Object.entries(opening?.initialVariables ?? {})) {
    // The engine ignores removed or unrecognized variable keys.
    state.set(key, value);
  }
  const variables = state.getSnapshot().variables;
  for (const variable of world.variables) {
    if (Object.prototype.hasOwnProperty.call(overrides, variable.id)) {
      variables[variable.id] = overrides[variable.id]!;
    }
  }
  return variables;
}
