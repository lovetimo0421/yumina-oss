/** A complete, atomically published pair of usage sources. No raw platform usage. */
export interface ModelPopularitySnapshot {
  updatedAt: string;
  /** Exact local Yumina usage window; external pages expose only a reporting date. */
  windowStart: string;
  windowEnd: string;
  /** Date on OpenRouter's public monthly app tables, without a precise cutoff time. */
  externalReportingDate: string;
  sourceApps: number;
  scores: Record<string, number>;
}

/** Normalize each source independently so platform size cannot change 50/50 weights. */
export function blendModelPopularity(
  ids: readonly string[],
  external: Readonly<Record<string, number>>,
  local: Readonly<Record<string, number>>,
): Record<string, number> {
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error("Popularity catalog must contain unique models");
  const value = (source: Readonly<Record<string, number>>, id: string) => {
    const n = source[id] ?? 0;
    if (!Number.isFinite(n) || n < 0) throw new Error("Invalid popularity measurement");
    return n;
  };
  const totals = [external, local].map(source => ids.reduce((n, id) => n + value(source, id), 0));
  if (totals.some(total => !Number.isFinite(total) || total <= 0)) throw new Error("Both popularity sources are required");
  return Object.fromEntries(ids.map(id => [id, 0.5 * value(external, id) / totals[0]! + 0.5 * value(local, id) / totals[1]!]));
}
