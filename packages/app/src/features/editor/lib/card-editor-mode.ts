import { useEditorStore } from "@/stores/editor";
import { saveEditorMode, type EditorMode } from "./editor-mode";

/**
 * Simple <-> advanced. On a card of one's own it is also the card's default
 * (the draft's `editorMode`, which rides along on the next save). On a card
 * someone shared, it is only this person's preference: kept as the per-card
 * choice in this browser, which `/edit` reads first, so a collaborator who
 * prefers the simple editor doesn't change it for everyone else on the card.
 */
export function setCardEditorMode(mode: EditorMode): void {
  const store = useEditorStore.getState();
  const access = store.access;
  if (!access || access.role === "owner") {
    store.setField("editorMode", mode);
    return;
  }
  if (store.serverWorldId) saveEditorMode(store.serverWorldId, mode);
}
