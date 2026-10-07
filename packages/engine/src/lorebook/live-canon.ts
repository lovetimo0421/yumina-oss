import type {
  LiveCanonOverlay,
  WorldDefinition,
  WorldEntry,
} from "../types/index.js";

/** Prefix keeps session-created ids out of the author's id namespace. */
export const LIVE_CANON_ENTRY_PREFIX = "live-canon:";

/**
 * Resolve a session overlay without mutating either the cached world or the
 * persisted overlay rows. Base patches inherit author-owned matching and
 * placement fields but are demoted to user-role prompt data. Created entries
 * are normalized to the same lower-trust boundary.
 */
export function resolveLiveCanonOverlay(
  world: WorldDefinition,
  overlay: LiveCanonOverlay,
): WorldDefinition {
  if (overlay.basePatches.length === 0 && overlay.createdEntries.length === 0) {
    return world;
  }

  const patches = new Map(
    overlay.basePatches.map((patch) => [patch.baseEntryId, patch.content]),
  );
  const baseEntries = world.entries.map((entry) => {
    const content = patches.get(entry.id);
    const editableRole = entry.role === "lore" || entry.role === "plot" || entry.role === "custom";
    if (content === undefined || entry.sessionEditPolicy !== "content" || !editableRole) return entry;
    return { ...entry, content, apiRole: "user" as const };
  });

  const lastPosition = baseEntries.reduce(
    (max, entry) => Math.max(max, Number.isFinite(entry.position) ? entry.position : 0),
    0,
  );
  const createdEntries: WorldEntry[] = overlay.createdEntries.map((entry, index) => ({
    id: `${LIVE_CANON_ENTRY_PREFIX}${entry.id}`,
    name: entry.name,
    content: entry.content,
    role: "lore",
    apiRole: "user",
    alwaysSend: entry.alwaysSend,
    keywords: [...entry.keywords],
    conditions: [],
    conditionLogic: "all",
    enabled: entry.enabled,
    matchWholeWords: entry.matchWholeWords ?? false,
    secondaryKeywords: [],
    secondaryKeywordLogic: "AND_ANY",
    preventRecursion: true,
    excludeRecursion: true,
    position: lastPosition + index + 1,
    section: "post-history",
    audience: "ai",
    sessionEditPolicy: "locked",
  }));

  return { ...world, entries: [...baseEntries, ...createdEntries] };
}
