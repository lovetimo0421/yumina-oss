/** The one localStorage slot that holds an unsaved editor draft. The store's
 *  debounced writer, its crash-recovery offer and the lifecycle backup below
 *  all use this key, so it is spelled once, here, in a module small enough
 *  for the routes to import without pulling in the store. */
export const EDITOR_DRAFT_KEY = "yumina-editor-draft";

interface RecoverableDraft {
  worldDraft: unknown;
  serverWorldId: string | null;
  isDirty: boolean;
  layoutDirty: boolean;
  guestMode: boolean;
  readOnlyInspect: boolean;
  /** The server version the draft was edited from. Optional so callers that
   *  predate it (and test doubles) still fit. */
  baseUpdatedAt?: string | null;
  _baseSchema?: unknown;
}

export interface StoredEditorDraft {
  draft: unknown;
  serverId: string | null;
  savedAt: number;
  /** The server `updatedAt` the draft was edited from. A restore against a
   *  newer server row has to merge, not overwrite: without this the restore
   *  adopted the freshly loaded token, and the next save quietly replaced
   *  whatever the assistant or another device had written in between. */
  baseUpdatedAt?: string | null;
  /** The server schema the draft was edited from — the common ancestor the
   *  restore merges against. Left out when the pair does not fit in storage. */
  baseSchema?: unknown;
}

/**
 * Write a draft, preferring the copy that carries its base schema.
 *
 * The base roughly doubles the size, and localStorage holds a few MB. A draft
 * that only fits without its base is still worth keeping — the restore then
 * knows the card may have moved and keeps the server copy aside instead of
 * guessing — so a quota failure retries without it rather than losing the
 * draft outright.
 */
export function writeStoredDraft(
  entry: StoredEditorDraft,
  storage: Pick<Storage, "setItem">,
): boolean {
  if (entry.baseSchema !== undefined && entry.baseSchema !== null) {
    try {
      storage.setItem(EDITOR_DRAFT_KEY, JSON.stringify(entry));
      return true;
    } catch {
      /* too big with the base — fall through to the smaller copy */
    }
  }
  try {
    const { baseSchema: _baseSchema, ...withoutBase } = entry;
    storage.setItem(EDITOR_DRAFT_KEY, JSON.stringify(withoutBase));
    return true;
  } catch {
    // Private mode / a full quota must not disable the navigation warning.
    return false;
  }
}

/** Use the store's existing recovery format; lifecycle events cannot await its debounce. */
export function backupEditorDraft(
  state: RecoverableDraft,
  storage: Pick<Storage, "setItem">,
  now = Date.now(),
): boolean {
  if (state.guestMode || state.readOnlyInspect || (!state.isDirty && !state.layoutDirty)) return false;
  return writeStoredDraft({
    draft: state.worldDraft,
    serverId: state.serverWorldId,
    savedAt: now,
    baseUpdatedAt: state.baseUpdatedAt ?? null,
    baseSchema: state._baseSchema ?? undefined,
  }, storage);
}
