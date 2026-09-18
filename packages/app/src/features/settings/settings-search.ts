export interface SettingsSearchItem<TSectionId extends string = string> {
  id: string;
  sectionId: TSectionId;
  targetId: string;
  title: string;
  description?: string;
  category: string;
  keywords?: string[];
  aliases?: string[];
}

interface RankedSettingsSearchItem<TSectionId extends string> {
  item: SettingsSearchItem<TSectionId>;
  score: number;
  index: number;
}

function normalizeSearchValue(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function scoreToken<TSectionId extends string>(
  token: string,
  item: SettingsSearchItem<TSectionId>
): number {
  const title = normalizeSearchValue(item.title);
  const category = normalizeSearchValue(item.category);
  const description = normalizeSearchValue(item.description ?? "");
  const keywords = normalizeSearchValue(item.keywords?.join(" ") ?? "");
  const aliases = normalizeSearchValue(item.aliases?.join(" ") ?? "");

  if (title === token) return 120;
  if (title.startsWith(token)) return 90;
  if (title.includes(token)) return 70;
  if (category === token) return 60;
  if (category.startsWith(token)) return 50;
  if (category.includes(token)) return 40;
  if (aliases.includes(token)) return 32;
  if (description.includes(token)) return 24;
  if (keywords.includes(token)) return 16;
  return 0;
}

function searchableValues<TSectionId extends string>(
  item: SettingsSearchItem<TSectionId>
): string[] {
  return [
    item.title,
    item.category,
    item.description ?? "",
    ...(item.keywords ?? []),
    ...(item.aliases ?? []),
  ].filter((value) => value.trim().length > 0);
}

export function mergeSettingsSearchAliases<TSectionId extends string>(
  primaryItems: SettingsSearchItem<TSectionId>[],
  localizedItemSets: ReadonlyArray<ReadonlyArray<SettingsSearchItem<TSectionId>>>
): SettingsSearchItem<TSectionId>[] {
  const aliasesById = new Map<string, Set<string>>();

  localizedItemSets.forEach((localizedItems) => {
    localizedItems.forEach((item) => {
      const aliases = aliasesById.get(item.id) ?? new Set<string>();
      searchableValues(item).forEach((value) => aliases.add(value));
      aliasesById.set(item.id, aliases);
    });
  });

  return primaryItems.map((item) => {
    const localizedAliases = aliasesById.get(item.id);
    if (!localizedAliases) return item;

    return {
      ...item,
      aliases: [...new Set([...(item.aliases ?? []), ...localizedAliases])],
    };
  });
}

export function searchSettingsItems<TSectionId extends string>(
  items: SettingsSearchItem<TSectionId>[],
  query: string
): SettingsSearchItem<TSectionId>[] {
  const normalizedQuery = normalizeSearchValue(query);
  if (!normalizedQuery) return [];

  const tokens = normalizedQuery.split(" ");
  const ranked: RankedSettingsSearchItem<TSectionId>[] = [];

  items.forEach((item, index) => {
    const tokenScores = tokens.map((token) => scoreToken(token, item));
    if (tokenScores.some((score) => score === 0)) return;

    const title = normalizeSearchValue(item.title);
    const category = normalizeSearchValue(item.category);
    const phraseBonus = title.includes(normalizedQuery)
      ? 50
      : category.includes(normalizedQuery)
        ? 30
        : 0;

    ranked.push({
      item,
      score: tokenScores.reduce((sum, score) => sum + score, 0) + phraseBonus,
      index,
    });
  });

  return ranked
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map(({ item }) => item);
}
