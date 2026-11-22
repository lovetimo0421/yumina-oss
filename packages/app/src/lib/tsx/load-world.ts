import type { World, WorldKit, WorldOptions } from "./world-kit";

let kit: Promise<WorldKit> | null = null;

function loadKit(): Promise<WorldKit> {
  kit ??= import("./world-kit").then((m) => m.worldKit).catch((error) => {
    kit = null;
    throw error;
  });
  return kit;
}

/**
 * `loadWorld(el, options)` in card code: a walkable, lit 3D world drawn into
 * `el`, built from rooms, things, lamps, a sun and the view outside (tsx skill,
 * "A 3D world the player walks around in"). Without an element it resolves to
 * `{ THREE, createWorld }`. Every card in the page shares one download; a
 * failed download is not kept, so the next call tries again.
 *
 *   loadWorld(el, { api: api, look: "night" }).then(function (world) { world.room({ ... }); });
 */
export function loadWorld(el?: HTMLElement, options?: WorldOptions): Promise<World | WorldKit> {
  return loadKit().then((k) => (el ? k.createWorld(el, options) : k));
}
