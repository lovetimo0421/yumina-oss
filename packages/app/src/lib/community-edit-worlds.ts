/** Adapt API cards for the picker without losing the original citation. */
export function cardsForThreadEdit(cards: ReadonlyArray<{
  id: string;
  citedId?: string;
  name: string;
  description?: string | null;
  thumbnail: string | null;
  downloadCount?: number;
}>) {
  return cards.map((card) => ({
    id: card.id,
    sourceId: card.citedId,
    name: card.name,
    description: card.description ?? null,
    thumbnail: card.thumbnail ?? null,
    downloadCount: card.downloadCount ?? 0,
  }));
}

/**
 * Keep an existing community citation pinned to the originally shared card
 * even when its editor is displaying a localized sibling. Newly selected cards
 * have no sourceId and use their visible id as usual.
 */
export function worldIdsForThreadEdit(
  cards: ReadonlyArray<{ id: string; sourceId?: string }>,
): string[] {
  return cards.map((card) => card.sourceId ?? card.id);
}
