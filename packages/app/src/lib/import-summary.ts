import type { WorldDefinition } from "@yumina/engine";

/** Modern behaviors and interfaces do not live in the legacy rule/component
 * arrays. Report each representation explicitly without claiming zero import. */
export function worldImportCounts(world: WorldDefinition) {
  return {
    entries: world.entries.length,
    variables: world.variables.length,
    modules: world.worldbooks?.length ?? 0,
    behaviors: world.reactions?.length ?? 0,
    rules: world.rules.length,
    components: world.components.length,
    interfacePages: world.uiDoc?.pages.length ?? 0,
    interfaceFiles: Object.keys(world.rootComponent?.files ?? {}).length,
    legacyInterfaces: world.customUI?.length ?? 0,
    audio: world.audioTracks?.length ?? 0,
  };
}
