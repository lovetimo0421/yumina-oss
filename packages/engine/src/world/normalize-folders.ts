import type { WorldDefinition } from "../types/index.js";

export interface NormalizeFoldersResult {
  world: WorldDefinition;
  /** Number of entries whose dangling or cross-book folderId was cleared. */
  fixed: number;
}

/**
 * Referential-integrity heal for entry → folder references.
 *
 * `entry.folderId` is an optional free string with **no** FK constraint to
 * `entryFolders[]` (`engine/src/world/schema.ts`). A whole-blob write that
 * carries entries with `folderId`s but a stale/empty `entryFolders` array
 * leaves entries pointing at folders that no longer exist. The editor's folder
 * UI buckets such entries under a folder it can't render, so they **vanish from
 * view** while still being counted in the section header — the czh123 "created
 * a folder, filed entries, saw nothing; 74 orphaned entries in the DB" symptom.
 *
 * This clears any `folderId` that doesn't resolve to a real folder in the same
 * knowledge base and section, so entries cannot leak into a different book's
 * hierarchy. The entry renders ungrouped instead of disappearing. It is the
 * conservative, no-context heal (used on load and on every standalone schema
 * write); the 3-way merge passes the *merged* result through this so a folder
 * recoverable from base/server isn't dropped before this runs.
 *
 * Pure: returns a new world (shares the original arrays/objects when nothing
 * changed); never mutates the input. Idempotent.
 */
export function normalizeFolders(world: WorldDefinition): NormalizeFoldersResult {
  const entries = world?.entries;
  if (!Array.isArray(entries) || entries.length === 0) {
    return { world, fixed: 0 };
  }

  const foldersById = new Map<string, NonNullable<WorldDefinition["entryFolders"]>[number]>();
  for (const f of world.entryFolders ?? []) {
    if (f && typeof f.id === "string" && f.id) foldersById.set(f.id, f);
  }

  let fixed = 0;
  const nextEntries = entries.map((e) => {
    const folderId = e?.folderId;
    if (typeof folderId === "string" && folderId) {
      const folder = foldersById.get(folderId);
      const sameWorldbook = (folder?.worldbookId ?? undefined) === (e.worldbookId ?? undefined);
      const sameSection = folder?.section === e.section;
      if (folder && sameWorldbook && sameSection) return e;
      fixed++;
      return { ...e, folderId: undefined };
    }
    return e;
  });

  if (fixed === 0) return { world, fixed: 0 };
  return { world: { ...world, entries: nextEntries }, fixed };
}
