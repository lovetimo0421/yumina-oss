/**
 * Which editor a creator lands in: per card, plus the global fallback that a
 * card they have never opened inherits. Both live in localStorage, and both are
 * read on the way into `/app/worlds/:id/edit` — see `resolveEditorMode` in
 * features/editor/editor-entry.ts for how the two combine with the draft's own
 * `editorMode` field.
 *
 * Every accessor swallows its own failure. localStorage throws in private
 * windows and when site data is blocked, and a creator whose browser refuses to
 * remember a preference must still be able to open their card.
 */

import { saveEditorSurface } from "@/lib/editor-surface";

const EDITOR_MODE_KEY = "yumina-editor-mode";
const GLOBAL_MODE_KEY = "yumina-editor-mode-global";

export type EditorMode = "simple" | "advanced";

const asMode = (value: unknown): EditorMode | null =>
  value === "simple" || value === "advanced" ? value : null;

export function saveEditorMode(worldId: string, mode: EditorMode) {
  try {
    const data = JSON.parse(localStorage.getItem(EDITOR_MODE_KEY) || "{}");
    data[worldId] = mode;
    localStorage.setItem(EDITOR_MODE_KEY, JSON.stringify(data));
  } catch {
    /* ignore */
  }
}

export function getEditorMode(worldId: string): EditorMode | null {
  try {
    const data = JSON.parse(localStorage.getItem(EDITOR_MODE_KEY) || "{}");
    return asMode(data?.[worldId]);
  } catch {
    return null;
  }
}

export function getGlobalEditorMode(): EditorMode | null {
  try {
    return asMode(localStorage.getItem(GLOBAL_MODE_KEY));
  } catch {
    return null;
  }
}

export function saveGlobalEditorMode(mode: EditorMode) {
  try {
    localStorage.setItem(GLOBAL_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

/** The three editors: 简单 (simple), 完整 (classic) and 画布 (visual). Simple is its own
 *  mode; classic and visual are the two surfaces of advanced. */
export type EditorChoice = "simple" | "classic" | "visual";

/** Record a choice made on the switch, so the next time this card — and any
 *  card without a choice of its own — is opened, `/edit` resolves to it:
 *  the per-card mode and the global fallback, and for advanced also which
 *  surface (the surface is global, and simple leaves it alone). */
export function rememberEditorChoice(worldId: string | null | undefined, choice: EditorChoice): void {
  const mode: EditorMode = choice === "simple" ? "simple" : "advanced";
  if (worldId) saveEditorMode(worldId, mode);
  saveGlobalEditorMode(mode);
  if (choice !== "simple") saveEditorSurface(choice);
}
