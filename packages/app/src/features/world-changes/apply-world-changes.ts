import { diffWorldSchemas, migrateWorldDefinition, type WorldDefinition, type WorldDiff } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";

const apiBase = import.meta.env.VITE_API_URL || "";

/** One of the caller's own cards an incoming file or copy could update. */
export interface ApplyTarget {
  id: string;
  name: string;
  status: string | null;
  thumbnailUrl?: string | null;
  language?: string | null;
  updatedAt?: string | null;
  /** The file was downloaded from exactly this project. */
  exact?: boolean;
}

/** The caller's cards a just-imported file belongs to: the project it was
 *  downloaded from first, then any card sharing its definition id (the same
 *  card's copies and language variants). Empty when it is someone else's card
 *  or a brand-new one — the import then proceeds as a new project. */
export async function findImportTargets(world: WorldDefinition, originWorldId: string | null): Promise<ApplyTarget[]> {
  const params = new URLSearchParams();
  if (originWorldId) params.set("origin", originWorldId);
  if (world.id) params.set("schemaId", world.id);
  if (!params.toString()) return [];
  try {
    const res = await fetch(`${apiBase}/api/world-changes/import-matches?${params}`, { credentials: "include", cache: "no-store" });
    if (!res.ok) return [];
    const { data } = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    // Matching is a convenience; never let it block an import.
    return [];
  }
}

/** What the card holds right now — the held working copy for a published
 *  card — diffed against the incoming content. */
export async function diffAgainstTarget(targetId: string, incoming: WorldDefinition): Promise<WorldDiff> {
  const res = await fetch(`${apiBase}/api/worlds/${targetId}?forEdit=1&_t=${Date.now()}`, { credentials: "include", cache: "no-store" });
  if (!res.ok) throw new Error(`load ${res.status}`);
  const { data } = await res.json();
  const current = migrateWorldDefinition((data?.schema ?? {}) as WorldDefinition);
  // Applying keeps the card's own title and id (see applyIncomingToWorld), so
  // a copy's "X (1)" name is not a change worth listing.
  const next = { ...structuredClone(incoming), name: current.name, id: current.id };
  return diffWorldSchemas(current, migrateWorldDefinition(next), { detail: false });
}

export class ApplyChangesError extends Error {
  constructor(public readonly step: "otherWorldUnsaved" | "backup" | "load" | "save") {
    super(step);
  }
}

/**
 * Put `incoming` onto the caller's card `targetId`, through the editor's own
 * save so a published card's change is held for review like any other edit.
 *
 *  1. Back the card up server-side (version history, "before applying changes").
 *  2. Load it into the editor store, swap in the incoming content — keeping the
 *     card's own name and definition id — and save.
 *
 * Done here rather than on an editor page because the edit route may hand off
 * to the canvas; the caller navigates to the editor once this resolves.
 */
export async function applyIncomingToWorld(args: {
  targetId: string;
  incoming: WorldDefinition;
  /** Shown on the backup in version history, e.g. who the changes came from. */
  note: string;
}): Promise<{ heldForReview: boolean }> {
  const { targetId, incoming, note } = args;
  const store = useEditorStore.getState();

  // The editor may have a different card open with unsaved work (the DM panel
  // floats over it). Save that first rather than discarding it by loading over it.
  if (store.serverWorldId && store.serverWorldId !== targetId && store.isDirty) {
    const ok = await store.saveDraft();
    if (!ok || useEditorStore.getState().isDirty) throw new ApplyChangesError("otherWorldUnsaved");
  }

  const backup = await fetch(`${apiBase}/api/world-changes/backups/${targetId}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
  }).catch(() => null);
  if (!backup?.ok) throw new ApplyChangesError("backup");

  await useEditorStore.getState().loadWorld(targetId);
  const loaded = useEditorStore.getState();
  if (loaded.serverWorldId !== targetId) throw new ApplyChangesError("load");

  // The card keeps its own title (worlds.name is the display truth and a
  // helper's copy is named "X (1)") and its definition id.
  loaded.loadWorldDefinition(
    { ...structuredClone(incoming), name: loaded.worldDraft.name, id: loaded.worldDraft.id },
    { preserveServerState: true },
  );
  const saved = await useEditorStore.getState().saveDraft();
  const after = useEditorStore.getState();
  if (!saved || after.isDirty) throw new ApplyChangesError("save");
  return { heldForReview: after.worldStatus === "published" && !!after.pendingEdit };
}
