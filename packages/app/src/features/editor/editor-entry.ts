export type EditorMode = "simple" | "advanced";

/** Opening a saved card and choosing its editor must use the same precedence.
 *
 *  This card's own local choice comes first. The mode switch writes it the
 *  moment it is flipped, while the draft's `editorMode` deliberately does not
 *  dirty the draft (see `setField` in stores/editor.ts) and so reaches the
 *  server only with the next real save — switch to simple and reload without
 *  editing, and the saved field still says "advanced". The saved field is what
 *  another device, with no local choice for this card, goes by. */
export function resolveEditorMode(
  schemaMode: EditorMode | undefined,
  perWorldMode: EditorMode | null,
  globalMode: EditorMode | null,
): EditorMode {
  return perWorldMode ?? schemaMode ?? globalMode ?? "advanced";
}

interface DraftForEntry {
  worldDraft: { id: string };
  serverWorldId: string | null;
  isDirty: boolean;
  saving: boolean;
  saveDraft: () => Promise<boolean>;
}

/** Never navigate away from edits that arrived while the save was in flight. */
export async function prepareStudioEntry(getDraft: () => DraftForEntry): Promise<string | null> {
  const before = getDraft();
  const draftId = before.worldDraft.id;
  if (before.saving) return null;
  if ((before.isDirty || !before.serverWorldId) && !await before.saveDraft()) return null;
  const after = getDraft();
  if (after.isDirty || after.worldDraft.id !== draftId) return null;
  return after.serverWorldId;
}
