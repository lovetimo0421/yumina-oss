import { z } from "zod";

export const EDITORIAL_LANGUAGES = ["default", "en", "zh", "es", "ja"] as const;
export const EDITORIAL_CONTENT_MODES = ["default", "safe", "sensitive"] as const;
export const EDITORIAL_LAYOUTS = ["mosaic", "cinema", "gallery"] as const;
export type EditorialLanguage = typeof EDITORIAL_LANGUAGES[number];
export type EditorialContentMode = typeof EDITORIAL_CONTENT_MODES[number];
export type EditorialLayout = typeof EDITORIAL_LAYOUTS[number];
export const editorialSlotSchema = z.object({
  id: z.string().trim().min(1).max(200), worldId: z.string().trim().min(1).max(200),
  note: z.string().max(500).nullable(),
  startsAt: z.string().datetime({ offset: true }).nullable(), endsAt: z.string().datetime({ offset: true }).nullable(),
}).strict().refine(s => !s.startsAt || !s.endsAt || Date.parse(s.startsAt) < Date.parse(s.endsAt), "End must follow start");
export const editorialCategorySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  labels: z.record(z.string().trim().min(1).max(80)).refine(labels => !!labels.en, "An English label is required")
    .refine(labels => Object.keys(labels).every(key => ["en", "zh", "zh-Hant", "es", "ja"].includes(key)), "Unsupported label language"),
  hidden: z.boolean(),
}).strict();
const scope = { language: z.enum(EDITORIAL_LANGUAGES), contentMode: z.enum(EDITORIAL_CONTENT_MODES) };
export const editorialCollectionSchema = z.object({ ...scope, categoryId: z.string(), layout: z.enum(EDITORIAL_LAYOUTS).default("mosaic"), slots: z.array(editorialSlotSchema).max(8) }).strict();
export const editorialHeroCollectionSchema = z.object({ ...scope, slots: z.array(editorialSlotSchema).max(5) }).strict();
export const discoverEditorialConfigSchema = z.object({
  version: z.literal(1), categories: z.array(editorialCategorySchema).min(1).max(24),
  featured: z.array(editorialCollectionSchema).max(360), hero: z.array(editorialHeroCollectionSchema).max(15),
}).strict().superRefine((config, ctx) => {
  const error = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  if (config.categories[0]?.id !== "all" || config.categories[0]?.hidden) error("All must be the first visible category");
  const ids = new Set(config.categories.map(c => c.id));
  if (ids.size !== config.categories.length) error("Category IDs must be unique");
  for (const rows of [config.featured, config.hero]) {
    const keys = rows.map(c => `${"categoryId" in c ? c.categoryId : "hero"}:${c.language}:${c.contentMode}`);
    if (new Set(keys).size !== keys.length) error("Collection scopes must be unique");
    for (const collection of rows) {
      if ("categoryId" in collection && !ids.has(String(collection.categoryId))) error("Unknown category");
      if (new Set(collection.slots.map(s => s.id)).size !== collection.slots.length || new Set(collection.slots.map(s => s.worldId)).size !== collection.slots.length) error("Slot IDs and worlds must be unique within a lineup");
    }
  }
});
export const discoverEditorialWriteSchema = z.object({ revision: z.string().uuid().nullable(), config: discoverEditorialConfigSchema }).strict();
export type EditorialSlot = z.infer<typeof editorialSlotSchema>;
export type EditorialCategory = z.infer<typeof editorialCategorySchema>;
export type EditorialCollection = z.infer<typeof editorialCollectionSchema>;
export type EditorialHeroCollection = z.infer<typeof editorialHeroCollectionSchema>;
export type DiscoverEditorialConfig = z.infer<typeof discoverEditorialConfigSchema>;

function resolveScope<T extends { language: string; contentMode: string }>(rows: readonly T[], language: string, contentMode: string): T | undefined {
  const normalized = language === "zh-Hant" || language === "zh-Hans" ? "zh" : language;
  for (const [lang, mode] of [[normalized, contentMode], [normalized, "default"], ["default", contentMode], ["default", "default"]]) {
    const row = rows.find(r => r.language === lang && r.contentMode === mode);
    if (row) return row;
  }
  return undefined;
}
export function resolveEditorialCollection(config: DiscoverEditorialConfig, categoryId: string, language: string, contentMode: string): EditorialCollection | undefined {
  return resolveScope(config.featured.filter(c => c.categoryId === categoryId), language, contentMode);
}
export function resolveEditorialHero(config: DiscoverEditorialConfig, language: string, contentMode: string): EditorialHeroCollection | undefined {
  return resolveScope(config.hero, language, contentMode);
}
/** A scheduled hero exception applies only while at least one slot is active.
 * Empty lists deliberately suppress fallback. Keep resolveEditorialHero for
 * editing so inactive scheduled slots remain visible in the draft. */
export function resolveActiveEditorialHero(config: DiscoverEditorialConfig, language: string, contentMode: string, now = Date.now()): EditorialHeroCollection | undefined {
  return resolveScope(config.hero.filter(collection => collection.slots.length === 0 || collection.slots.some(slot =>
    (!slot.startsAt || Date.parse(slot.startsAt) <= now) && (!slot.endsAt || Date.parse(slot.endsAt) > now))), language, contentMode);
}
export function editorialCategoryLabel(category: EditorialCategory, locale: string): string {
  return category.labels[locale] ?? (locale === "zh-Hant" ? category.labels.zh : undefined) ?? category.labels.en ?? category.id;
}
export const DEFAULT_EDITORIAL_CATEGORIES: EditorialCategory[] = [
  ["all", "All", "全部", "全部", "Todo", "すべて"],
  ["games", "Games", "游戏", "遊戲", "Juegos", "ゲーム"],
  ["literature", "Novels & Literature", "小说与文学", "小說與文學", "Novelas y literatura", "小説・文学"],
  ["roleplays", "Roleplays", "角色扮演", "角色扮演", "Juegos de rol", "ロールプレイ"],
  ["anime", "Anime", "动漫", "動漫", "Anime", "アニメ"],
  ["screen", "Movies & TVs", "电影与电视", "電影與電視", "Películas y series", "映画・ドラマ"],
].map(([id, en, zh, hant, es, ja]) => ({ id: id!, labels: { en: en!, zh: zh!, "zh-Hant": hant!, es: es!, ja: ja! }, hidden: false }));

/** Minimal administration projection; never includes definitions, prompts or private user data. */
export interface EditorialWorld {
  id: string; name: string; description: string | null;
  creatorId: string; creatorName: string | null; creatorUsername: string | null; creatorImage: string | null;
  thumbnailUrl: string | null; landscapeCoverUrl: string | null;
  coverCrop: unknown | null; galleryCoverCrop: unknown | null; landscapeCoverCrop: unknown | null;
  language: string | null; languageGroupId: string | null; isPrimaryVariant: boolean;
  isPublished: boolean | null; status: string | null; visibility: string | null;
  isNsfw: boolean | null; ageRating: string | null; blurCover: boolean | null;
  messageCount: number; totalPlaytimeSeconds: number | null; gamePath?: string | null;
}
