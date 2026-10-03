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

export type BatchedErasureExecutor = unknown;
export interface DiscoveryPurgeOptions {
  batchSize?: number;
  statementTimeoutMs?: number;
  pauseMs?: number;
  budgetMs?: number;
  cursor?: string | null;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}
export interface DiscoveryPurgeResult {
  done: boolean;
  deleted: number;
  statements: number;
  cursor: string | null;
  path: "index" | "scan" | "none";
}
export async function purgeErasedDiscoveryEventsBatched(
  _executor: BatchedErasureExecutor,
  _actors: readonly string[],
  _options?: DiscoveryPurgeOptions,
): Promise<DiscoveryPurgeResult> {
  // Match the hosted implementation's result when discovery tables are absent.
  return { done: true, deleted: 0, statements: 0, cursor: null, path: "none" };
}
