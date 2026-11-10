import type { WorldDefinition } from "@yumina/engine";

/**
 * Whether an edit made since a playtest started changes how that playtest
 * plays. A running test session was built from the card as it was when it
 * started: its variables were seeded, its opening sent, its screen compiled.
 * An edit to any of these only reaches the player on a fresh start, so the
 * panel says so instead of leaving the creator to wonder why the change they
 * just made is not showing.
 *
 * The card's name, cover, tags, description and publishing details are left
 * out on purpose — nothing in play reads them.
 */
const PLAY_FIELDS = [
  "entries", "variables", "rules", "reactions", "worldbooks", "settings",
  "continuity", "uiDoc", "rootComponent", "components", "uiBlueprint",
  "audioTracks", "sceneImages", "backgrounds", "bgmPlaylist", "conditionalBGM",
] as const satisfies ReadonlyArray<keyof WorldDefinition>;

const same = (a: unknown, b: unknown, field: string): boolean => {
  if (a === b) return true;
  if (a === undefined || b === undefined) {
    // An empty list and a missing one play the same.
    const empty = (v: unknown) => v === undefined || (Array.isArray(v) && v.length === 0);
    return empty(a) && empty(b);
  }
  if (field === "rootComponent") {
    // The compiled screen is stamped on every recompile; only its files matter.
    const strip = (v: unknown) => {
      if (!v || typeof v !== "object") return v;
      const { updatedAt: _u, ...rest } = v as Record<string, unknown>;
      return rest;
    };
    return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
  }
  return JSON.stringify(a) === JSON.stringify(b);
};

export function playtestAffectingChange(started: WorldDefinition, now: WorldDefinition): boolean {
  if (started === now) return false;
  for (const field of PLAY_FIELDS) {
    if (!same(started[field], now[field], field)) return true;
  }
  return false;
}
