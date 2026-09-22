/** Local sessions have no hosted discovery telemetry. */
export async function discoveryIdentity(_context: unknown, userId: string) { return { userId }; }
export async function prepareDiscoveryOutcome(_db: unknown, _raw: unknown, _identity: unknown, _world: unknown) { return null; }
export async function recordDiscoveryOutcome(_db: unknown, _prepared: unknown, _eventType: string, _resourceId: string): Promise<void> {}
