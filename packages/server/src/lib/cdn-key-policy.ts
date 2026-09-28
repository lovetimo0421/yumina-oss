const PUBLIC_PREFIXES = ["worlds/", "reports/", "studio-chat/", "users/", "bundles/", "dm/", "community/"];
/** Both CDN entry points apply this, including cached ID lookups. */
export function isPublicCdnKey(key: string): boolean {
    return !key.includes("..") && !key.includes("\\") && PUBLIC_PREFIXES.some(prefix => key.startsWith(prefix));
}

/** Validate both lookup sources before a key can be cached or streamed. */
export async function resolvePublicCdnKey(
    cached: string | null,
    lookup: () => Promise<string | null>,
    cache: (key: string) => void,
): Promise<string | null> {
    if (cached && isPublicCdnKey(cached)) return cached;
    const key = await lookup();
    if (!key || !isPublicCdnKey(key)) return null;
    cache(key);
    return key;
}
