/** No hosted discovery data exists in the local edition. */
export async function findLinkedDiscoveryGuests(_executor: unknown, _userId: string): Promise<{ guests: string[]; since: Date } | undefined> {
  return undefined;
}
export async function eraseDiscoveryAccountData(
  _tx: unknown, _userId: string, _through?: Date,
  _options?: { knownGuests?: { guests: string[]; since: Date }; deferEventDelete?: boolean },
): Promise<string[]> {
  return [];
}
export async function purgeErasedDiscoveryEvents(_executor: unknown, _actors: readonly string[]): Promise<void> {}
