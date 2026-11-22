/**
 * Open-source edition stub. The LoRA square (a public gallery of creators'
 * trained models) is a hosted feature. Trigger snapshots exist so a world
 * keeps drawing the same way after a model's owner edits its trigger words;
 * with no shared models there is nothing to snapshot.
 */
export async function snapshotForeignTriggers(
  _bindings: { binding: { modelId: string; trigger?: string } }[],
  _ownerId: string | null | undefined,
): Promise<void> {}
