/** Local editions use creator artwork; hosted editorial overrides are absent. */
export async function overlayDiscoverArtwork<T extends { id: string }>(rows: T[]): Promise<T[]> {
  return rows;
}
