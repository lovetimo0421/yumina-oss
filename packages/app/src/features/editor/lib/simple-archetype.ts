/**
 * What simple mode says a card is, read off its entries — a card carries no
 * "type" field, and a blank project has no template to remember either.
 *
 * `archetype` picks the form's layout and always has an answer: fewer than two
 * characters lays out as a character chat, which is also the right form to
 * fill in a blank card with. `label` is the claim printed at the top of the
 * form, and only makes one when the entries back it up: a card with no
 * character yet (a blank project) is not "一个角色和你 1:1 对话", so it gets no
 * label rather than the chat one.
 */

export type SimpleArchetype = "chat" | "world";

interface EntryLike {
  role?: string;
  presetId?: string | null;
  worldbookId?: string | null;
}

interface BookLike {
  id: string;
  station?: unknown;
}

/** The card's own characters: one in a frame with an AI of its own belongs
 *  to that AI, not to the card's cast. */
function countCharacters(entries: readonly EntryLike[], worldbooks: readonly BookLike[] = []): number {
  const aiFrames = new Set(worldbooks.filter((b) => !!b.station).map((b) => b.id));
  let count = 0;
  for (const e of entries) {
    if (e.worldbookId && aiFrames.has(e.worldbookId)) continue;
    // Two is enough to decide anything below; stop counting there.
    if (!e.presetId && e.role === "character" && ++count >= 2) return count;
  }
  return count;
}

export function simpleArchetypeOf(entries: readonly EntryLike[], worldbooks?: readonly BookLike[]): SimpleArchetype {
  return countCharacters(entries, worldbooks) >= 2 ? "world" : "chat";
}

export function simpleArchetypeLabelOf(entries: readonly EntryLike[], worldbooks?: readonly BookLike[]): SimpleArchetype | null {
  const count = countCharacters(entries, worldbooks);
  if (count === 0) return null;
  return count >= 2 ? "world" : "chat";
}
