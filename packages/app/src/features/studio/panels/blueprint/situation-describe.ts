import type { Worldbook } from "@yumina/engine";

/**
 * How the board groups and colours a card's situations: by how the player
 * gets in, and by which memory a situation's AI keeps.
 */
export type WayIn = "opening" | "always" | "number" | "word" | "screen" | "worker" | "unplaced";

export function wayInOf(book: Worldbook): WayIn {
  // An AI added and not put anywhere is off, whatever kind it is: it stands
  // apart until its settings say where it lives.
  if (book.host === "unplaced") return "unplaced";
  // One that pipes up when things go quiet talks to the player: it stands
  // with the others by how it comes in, not with the writers behind the scenes.
  if (book.station?.kind === "worker" && book.station.trigger?.on !== "quiet") return "worker";
  switch (book.activation.mode) {
    case "greeting": return "opening";
    case "conditions": return "number";
    case "keywords": return "word";
    case "manual": return "screen";
    default: return "always";
  }
}

export const WAY_IN_ORDER: readonly WayIn[] = ["opening", "always", "number", "word", "screen"];

/** Which memory a situation's AI keeps. `null` is the card's own: it remembers
 *  everything. A named pool is shared by every situation that names it. */
export function memoryOf(book: Worldbook): string | null {
  const s = book.station;
  if (!s || s.kind !== "narrator") return null;
  if (s.memoryPool) return s.memoryPool;
  if (s.history === "own") return `own:${book.id}`;
  return null;
}

/** Ring colours for memory pools, the card's own first. */
export const POOL_COLOURS = ["#e0b25a", "#a78bfa", "#2dd4bf", "#fb7185", "#60a5fa", "#a3e635"] as const;

export function poolColours(books: readonly Worldbook[]): Map<string | null, string> {
  const map = new Map<string | null, string>([[null, POOL_COLOURS[0]]]);
  let next = 1;
  for (const book of books) {
    const pool = memoryOf(book);
    if (pool === null) continue;
    // Every pool of one gets the same colour: "only remembers itself" is one
    // idea, whichever dungeon it is.
    const key = pool.startsWith("own:") ? "own:" : pool;
    if (!map.has(key)) map.set(key, POOL_COLOURS[Math.min(next++, POOL_COLOURS.length - 1)]);
    map.set(pool, map.get(key)!);
  }
  return map;
}
