/** Which of a piece's objects a drop actually has to re-home.
 *
 *  A piece is a block, and a block is a projection of the objects a module
 *  owns — so dropping one on another module is N set-parent patches, not one.
 *  Objects that already live there are skipped: writing a patch for them would
 *  put a no-op on the undo stack, and the creator would have to press undo
 *  twice for one gesture. */
export function pieceMoves(
  ids: readonly string[],
  ownerOf: (id: string) => string | null | undefined,
  targetOwnerId: string | null,
): string[] {
  const moves: string[] = [];
  for (const id of ids) {
    const owner = ownerOf(id);
    if (owner === undefined) continue; // not on this board any more
    if ((owner ?? null) === targetOwnerId) continue;
    moves.push(id);
  }
  return moves;
}
