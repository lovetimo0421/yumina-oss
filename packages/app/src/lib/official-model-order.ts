import type { CostTier, PlayModel } from "@yumina/shared";

export type OfficialModelSort = "popular" | "recommended" | "costAsc" | "costDesc" | "newest" | "name" | "recent";

/** All cost comparisons use the same uncached reference scenario, never a mix
 * of fleet medians, personal chat estimates, and catalog estimates. */
export function orderOfficialModels(
  models: readonly PlayModel[],
  options: {
    popularityScores?: Readonly<Record<string, number>>;
    tier: CostTier | "all";
    query: string;
    sort: OfficialModelSort;
    pinned: readonly string[];
    favoritesOnly: boolean;
    recent: readonly string[];
    description: (model: PlayModel) => string;
  },
): PlayModel[] {
  const query = options.query.trim().toLocaleLowerCase();
  const pins = new Set(options.pinned);
  const recent = new Map(options.recent.map((id, i) => [id, i]));
  return models.filter(m =>
    (options.tier === "all" || m.tier === options.tier)
    && (!options.favoritesOnly || pins.has(m.id))
    && (!query || `${m.name} ${m.id} ${options.description(m)}`.toLocaleLowerCase().includes(query)),
  ).sort((a, b) => {
    let difference = 0;
    switch (options.sort) {
      case "popular": difference = (options.popularityScores?.[b.id] ?? 0) - (options.popularityScores?.[a.id] ?? 0); break;
      case "costAsc": difference = a.avgCostMushies - b.avgCostMushies; break;
      case "costDesc": difference = b.avgCostMushies - a.avgCostMushies; break;
      case "newest": difference = (b.addedAt ?? "").localeCompare(a.addedAt ?? ""); break;
      case "name": return a.name.localeCompare(b.name, undefined, {numeric:true});
      case "recent": difference = (recent.get(a.id) ?? Infinity) - (recent.get(b.id) ?? Infinity); break;
      default: difference = (a.recommendationRank ?? 999) - (b.recommendationRank ?? 999);
    }
    return difference || a.name.localeCompare(b.name, undefined, {numeric:true});
  });
}
