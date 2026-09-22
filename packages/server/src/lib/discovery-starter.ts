/** Hosted Discover is unavailable in the local edition. */
export function parseDiscoveryStarter(_query: Record<string, string | undefined>): { interests: string[]; selectedAt: string; key: string } | undefined { return undefined; }
export function buildDiscoveryInterestQuery(..._args: unknown[]): never { throw new Error('Discover is hosted-only'); }
