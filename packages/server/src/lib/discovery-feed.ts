/**
 * Local edition boundary for the hosted discovery transport. The shared worlds
 * router refuses Hub requests via edition.info().features.hub before reaching
 * this stub. No ranking, catalog retrieval, profile or Redis session code ships.
 */
export const DISCOVERY_POLICY_VERSION = 'discovery-unavailable-local';
export class DiscoveryCursorError extends Error {}
export class DiscoveryAdmissionError extends Error {
  constructor(readonly scope: "global" | "actor") { super(); }
}
export const discoveryMeasurementEnabled = () => false;
export async function recordDiscoveryServe(_db: unknown, _page: unknown, _actor: string, _secret: string): Promise<string | undefined> { return undefined; }

export async function serveDiscoveryFeed(_db: unknown, _options: unknown) {
  return {
    data: [] as never[], ids: [] as string[], servedIds: [] as string[], positions: [] as number[],
    feedRequestId: '', offset: 0, nextCursor: null, hasMore: false, scans: 0,
    tier: 'cold' as const, variant: 'control' as const, modelId: null,
    visitId: '', servedAt: '', snapshots: {},
  };
}
