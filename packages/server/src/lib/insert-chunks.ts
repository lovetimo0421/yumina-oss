/**
 * Keep multi-row PostgreSQL INSERTs comfortably below the wire protocol's
 * 65,535-bound-parameter ceiling. The caller owns the surrounding transaction,
 * so splitting one logical insert into several statements remains atomic.
 */
export const INSERT_CHUNK_ROWS = 1_000;

export function chunkRowsForInsert<T>(
  rows: readonly T[],
  size = INSERT_CHUNK_ROWS,
): T[][] {
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new RangeError("Insert chunk size must be a positive safe integer");
  }

  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}
