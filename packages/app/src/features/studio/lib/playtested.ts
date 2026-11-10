/** Whether this browser has playtested a card: one line of the publish
 *  checklist. Per card, remembered locally — a hint, not a gate. */
const key = (worldId: string) => `yumina-playtested:${worldId}`;

export function markPlaytested(worldId: string | null | undefined): void {
  if (!worldId) return;
  try { localStorage.setItem(key(worldId), "1"); } catch { /* private mode: the line stays open */ }
}

export function hasPlaytested(worldId: string | null | undefined): boolean {
  if (!worldId) return false;
  try { return localStorage.getItem(key(worldId)) === "1"; } catch { return false; }
}
