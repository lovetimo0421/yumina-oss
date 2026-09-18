import type { ApiKeyMetadata } from "@yumina/shared";

export const PRIVATE_MODEL_SYNC_TTL = 5 * 60 * 1000;

export function privateCatalogIsFresh(metadata: ApiKeyMetadata | null, now = Date.now()): boolean {
  const age = now - (metadata?.modelsSyncedAt ?? 0);
  return !!metadata?.models?.length && !!metadata.modelsSyncedAt && age >= 0 && age < PRIVATE_MODEL_SYNC_TTL;
}

function cleanIds(ids: unknown[]): string[] {
  return [...new Set(ids.filter((id): id is string =>
    typeof id === "string" && id.trim().length > 0 && id.length <= 256,
  ))];
}

/** Empty/invalid provider responses never erase a usable saved catalog. */
export function mergePrivateCatalog(previous: ApiKeyMetadata | null, upstream: unknown[], now = Date.now()): ApiKeyMetadata | null {
  const discovered = cleanIds(upstream).slice(0, 500);
  if (discovered.length === 0) return null;
  const oldDiscovered = new Set(previous?.discoveredModels ?? []);
  // Legacy catalogs have no provenance: preserve them instead of guessing which
  // entries were hand-entered. Future discovered-only removals can be reconciled.
  const manual = cleanIds([
    previous?.defaultModel,
    ...(previous?.models ?? []).filter((id) => !oldDiscovered.has(id)),
  ]);
  return {
    ...previous,
    // Cap upstream independently: a full manual list must not hide new models.
    models: cleanIds([...manual, ...discovered]),
    discoveredModels: discovered,
    modelsSyncedAt: now,
  };
}
