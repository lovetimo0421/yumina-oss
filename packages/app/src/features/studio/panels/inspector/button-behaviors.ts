import type { Reaction, Worldbook } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { addAiTo } from "../blueprint/add-ai";

export interface ButtonBehavior {
  /** The behaviour's own id, to open it on the canvas. */
  id: string;
  name: string;
  /** What a button sends to set it off (`action:fired` with this id). */
  actionId: string;
}

/** The behaviours a button can set off: the card's behaviours that listen for
 *  a button (`action:fired`), by the name the canvas shows them under. */
export function buttonBehaviors(reactions: Reaction[] | undefined): ButtonBehavior[] {
  return (reactions ?? []).flatMap((r) => {
    const value = r.when?.eventType === "action:fired" ? r.when.match?.actionId?.value : undefined;
    return typeof value === "string" && value.trim() ? [{ id: r.id, name: r.name?.trim() || value, actionId: value }] : [];
  });
}

/**
 * A new behaviour that listens for a button, named by the creator, made in
 * one undo step. Its name is also what the button sends, so the behaviour's
 * own sentence on the canvas reads the name instead of an id. Returns that
 * action id. It does nothing yet: what it does is set on the canvas.
 */
export function makeButtonBehavior(name: string): string {
  const store = useEditorStore.getState();
  const base = name.trim();
  const taken = new Set(buttonBehaviors(store.worldDraft.reactions).map((b) => b.actionId));
  let actionId = base;
  for (let n = 2; taken.has(actionId); n++) actionId = `${base} ${n}`;
  store.beginBatch();
  try {
    store.addReaction();
    const list = useEditorStore.getState().worldDraft.reactions ?? [];
    const created = list[list.length - 1];
    if (created) {
      store.updateReaction(created.id, {
        name: base,
        when: { eventType: "action:fired", match: { actionId: { operator: "eq", value: actionId } } },
      });
    }
  } finally {
    store.commitBatch();
  }
  return actionId;
}

/** A new character entry under this name, in one undo step: a list of the
 *  card's characters shows it at once, and its text is written on the canvas. */
export function makeCharacter(name: string): void {
  const store = useEditorStore.getState();
  store.beginBatch();
  try {
    store.addEntry("character", "system-presets");
    const list = useEditorStore.getState().worldDraft.entries;
    const created = list[list.length - 1];
    if (created) store.updateEntry(created.id, { name: name.trim() });
  } finally {
    store.commitBatch();
  }
}

/** Leave the interface editor for the canvas, with this behaviour selected. */
export function openBehaviorOnCanvas(reactionId: string) {
  window.dispatchEvent(new CustomEvent("yumina:studio-canvas-focus", { detail: { objId: `reaction:${reactionId}`, open: true } }));
}

/** The card's UI-based AIs (trigger { on: "ui" }): what a button can call. */
export function buttonAis(books: Worldbook[] | undefined): Array<{ id: string; name: string }> {
  return (books ?? [])
    .filter((b) => b.station?.kind === "worker" && b.station.trigger?.on === "ui")
    .map((b) => ({ id: b.id, name: b.name?.trim() || "AI" }));
}

/** A new UI-based AI on the card, for a button to call. Returns its id. */
export function makeButtonAi(): string | null {
  const taken = new Set((useEditorStore.getState().worldDraft.worldbooks ?? []).map((b) => b.name));
  let name = "AI";
  taken.add(name);
  for (let n = 2; taken.has(name); n++) name = `AI ${n}`;
  return addAiTo("card", name, "ui")?.bookId ?? null;
}
