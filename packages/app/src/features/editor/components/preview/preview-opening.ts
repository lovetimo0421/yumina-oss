import type { WorldEntry } from "@yumina/engine";

const orderedOpenings = (entries: WorldEntry[]) =>
  entries.filter(entry => entry.role === "greeting").sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));

/** Preview selection never mutates the card's opening order or enabled state. */
export function resolvePreviewOpening(entries: WorldEntry[], selectedId?: string) {
  const openings = orderedOpenings(entries);
  return openings.find(entry => entry.id === selectedId)
    ?? openings.find(entry => entry.enabled)
    ?? openings[0];
}

export { orderedOpenings };
