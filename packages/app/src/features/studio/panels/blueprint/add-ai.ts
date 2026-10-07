import { useEditorStore } from "@/stores/editor";

/** The three kinds of AI, by what calls it: the player's turn, the player's
 *  screen, or the card's own logic (a value, a scenario ending, a silence). */
export type AiType = "turn" | "ui" | "code";

/**
 * A new AI that lives in `place` — the card ("card") or a scenario's id —
 * under `name`. An AI is one more API call and nothing else: it carries no
 * entries, values or behaviours of its own; what it knows is the place it is
 * in. A turn-based one answers the player; a UI-based one waits for the
 * player's screen to call it; a code-based one runs when a value says so.
 * One undo step for the whole gesture.
 */
export function addAiTo(place: string, name: string, type: AiType = "turn"): { bookId: string; entryId: string | null } | null {
  const store = useEditorStore.getState();
  let bookId: string | null = null;
  let entryId: string | null = null;
  store.beginBatch();
  try {
    store.addWorldbook(name);
    const books = useEditorStore.getState().worldDraft.worldbooks ?? [];
    const created = books[books.length - 1];
    if (!created) return null;
    bookId = created.id;
    store.updateWorldbook(created.id, {
      // Where it lives decides when it is in play; its own activation is not
      // read (engine computeActiveWorldbookIds).
      activation: { mode: "always" },
      host: place,
      station: type === "turn"
        ? { kind: "narrator", onClose: "keep" }
        : {
            kind: "worker",
            trigger: type === "ui" ? { on: "ui" } : { on: "conditions", conditions: [] },
            inputs: [{ kind: "transcript", from: "core", limit: 20 }],
          },
    });
  } finally {
    store.commitBatch();
  }
  return bookId ? { bookId, entryId } : null;
}

/** Remove an AI and who it is: its own entries go with it, or its brief would
 *  land in the whole card's prompt. Its values and behaviours go back to the
 *  card. One undo step. */
export function removeAi(bookId: string): void {
  const store = useEditorStore.getState();
  store.beginBatch();
  try {
    for (const e of store.worldDraft.entries.filter((x) => x.worldbookId === bookId)) store.removeEntry(e.id);
    store.removeWorldbook(bookId);
  } finally {
    store.commitBatch();
  }
}
