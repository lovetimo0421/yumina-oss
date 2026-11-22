/**
 * Open-source edition stub. On the hosted service an account can be barred
 * from generation after abuse; the local build has one user and no such
 * ledger, so nobody is ever restricted.
 */
export async function generationRestricted(_userId: string, _database?: unknown): Promise<boolean> {
  return false;
}
