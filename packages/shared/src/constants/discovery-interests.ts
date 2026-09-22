import { canonicalizeTag } from './tags.js';

/** Starter preferences are soft hints, never exact filters or behavioral evidence. */
export const DISCOVERY_INTEREST_IDS = ['relationships', 'fandom', 'idols', 'simulation', 'fantasy', 'mystery',
  'games', 'rpg', 'visual_novel', 'anime', 'books', 'history'] as const;
export type DiscoveryInterestId = typeof DISCOVERY_INTEREST_IDS[number];
export const DISCOVERY_INTEREST_GROUPS: ReadonlyArray<{ id: 'topics' | 'experiences'; interests: readonly DiscoveryInterestId[] }> = [
  { id: 'topics', interests: ['relationships', 'fantasy', 'mystery', 'anime', 'fandom', 'idols', 'books', 'history'] },
  { id: 'experiences', interests: ['games', 'rpg', 'visual_novel', 'simulation'] },
];

// Exact public catalog tags and their canonical multilingual aliases. Do not
// infer interests from a title, demographics or an arbitrary substring match.
export const DISCOVERY_INTEREST_TAGS: Readonly<Record<DiscoveryInterestId, readonly string[]>> = {
  relationships: ['Romance', '恋爱', 'Slowburn', 'Dating', '爱情', '恋人'],
  fandom: ['Fandom', '同人', 'Fanfiction', '二次创作'],
  idols: ['Idol', '偶像', 'kpop', '娱乐圈', 'K-pop', 'Idols', '明星'],
  simulation: ['Simulator', '模拟器', 'Life Sim', 'Simulation', '经营'],
  fantasy: ['Fantasy', '奇幻', '玄幻', '修仙', '魔法', 'Adventure', '冒险', '异世界'],
  mystery: ['Mystery', '悬疑', '推理', 'Detective', 'Suspense'],
  games: ['Game', '游戏'],
  rpg: ['RPG', 'Role-playing game', '角色扮演游戏', 'ロールプレイング'],
  visual_novel: ['Visual Novel', '视觉小说', '視覺小說', 'ビジュアルノベル', 'Novela visual', 'Galgame'],
  anime: ['Anime', '动漫', '動畫', 'アニメ', 'Manga', '漫画', '二次元'],
  books: ['Books', 'Book', 'Literature', '小说', '文学', '名著', 'Classic', 'Novels'],
  history: ['History', '历史', 'Historical', '历史架空'],
};
const keys = new Map<DiscoveryInterestId, ReadonlySet<string>>(DISCOVERY_INTEREST_IDS.map(id =>
  [id, new Set(DISCOVERY_INTEREST_TAGS[id].map(tag => canonicalizeTag(tag).toLowerCase()))]));

export function discoveryInterestsForTags(tags: readonly string[] | null | undefined): DiscoveryInterestId[] {
  const canonical = new Set((tags ?? []).filter(tag => typeof tag === 'string')
    .map(tag => canonicalizeTag(tag).toLowerCase()));
  return DISCOVERY_INTEREST_IDS.filter(id => [...keys.get(id)!].some(tag => canonical.has(tag)));
}

/** Initial policy, not fitted weights: 30-day half-life, zero after eight
 * independent strong-evidence units. Clicks must never be counted as units.
 * Unknown timestamps cannot mint a fresh hint; preference reads never renew it.
 */
export function discoveryStarterStrength(selectedAt: string | null | undefined, now: Date, evidenceWeight: number): number {
  if (!selectedAt || !Number.isFinite(evidenceWeight) || evidenceWeight < 0) return 0;
  const selected = Date.parse(selectedAt);
  const age = now.getTime() - selected;
  if (!Number.isFinite(age) || age < 0) return 0;
  return 2 ** (-age / (30 * 86_400_000)) * Math.max(0, 1 - evidenceWeight / 8);
}
