export interface DiscoverAccess { enabled: boolean; publicEnabled: boolean }
export const CLOSED_DISCOVER_ACCESS: DiscoverAccess = { enabled: false, publicEnabled: false };

/** A client response can only describe the current session; it grants no API permissions. */
export function parseDiscoverAccess(value: unknown): DiscoverAccess {
  if (!value || typeof value !== "object" || !("data" in value)) return CLOSED_DISCOVER_ACCESS;
  const data = value.data;
  if (!data || typeof data !== "object" || !("enabled" in data) || !("publicEnabled" in data)) return CLOSED_DISCOVER_ACCESS;
  return { enabled: data.enabled === true, publicEnabled: data.publicEnabled === true };
}

export function currentDiscoverAccess(owner: string, responseOwner: string | null, access: DiscoverAccess): DiscoverAccess {
  return owner === responseOwner ? access : CLOSED_DISCOVER_ACCESS;
}
