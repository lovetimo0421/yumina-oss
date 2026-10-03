import { z } from "zod";

export const FEATURED_CHANNELS = ["all", "games", "literature", "roleplays", "anime", "screen"] as const;
export const FEATURED_LANGUAGES = ["default", "en", "zh", "es", "ja"] as const;
export const FEATURED_CONTENT_MODES = ["default", "safe", "sensitive"] as const;
export const FEATURED_MAX_SLOTS = 8;
export type FeaturedChannel = typeof FEATURED_CHANNELS[number];
export const featuredScopeSchema = z.object({
  channel: z.enum(FEATURED_CHANNELS).default("all"),
  language: z.enum(FEATURED_LANGUAGES).default("default"),
  contentMode: z.enum(FEATURED_CONTENT_MODES).default("default"),
}).strict();
export type FeaturedScope = z.infer<typeof featuredScopeSchema>;
export const featuredSlotSchema = z.object({
  slot: z.number().int().min(0).max(FEATURED_MAX_SLOTS - 1),
  worldId: z.string().trim().min(1).max(200),
  note: z.string().max(500).nullable().default(null),
  startsAt: z.string().datetime({ offset: true }).nullable().default(null),
  endsAt: z.string().datetime({ offset: true }).nullable().default(null),
}).strict().refine(s => !s.startsAt || !s.endsAt || Date.parse(s.startsAt) < Date.parse(s.endsAt), "End must follow start");
export type FeaturedSlot = z.infer<typeof featuredSlotSchema>;
export const featuredCollectionWriteSchema = z.object({
  revision: z.string().uuid().nullable(),
  slots: z.array(featuredSlotSchema).max(FEATURED_MAX_SLOTS),
}).strict().superRefine(({ slots }, ctx) => {
  if (new Set(slots.map(s => s.slot)).size !== slots.length || new Set(slots.map(s => s.worldId)).size !== slots.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Slots and worlds must be unique" });
  }
});

/** Complete collections replace their fallback; an intentionally empty list stays empty. */
export function resolveFeaturedCollection<T extends { channel: string; language: string; contentMode: string }>(
  rows: readonly T[], scope: FeaturedScope,
): T | undefined {
  for (const [language, contentMode] of [[scope.language, scope.contentMode], [scope.language, "default"],
    ["default", scope.contentMode], ["default", "default"]]) {
    const row = rows.find(r => r.channel === scope.channel && r.language === language && r.contentMode === contentMode);
    if (row) return row;
  }
  return undefined;
}

export interface FeaturedAdminSlot extends FeaturedSlot {
  languageGroupId: string | null;
  worldName: string | null;
  thumbnailUrl: string | null;
  language: string | null;
  isAvailable: boolean;
  isSensitive: boolean;
}
export interface FeaturedCollectionView {
  scope: FeaturedScope;
  revision: string | null;
  source: FeaturedScope | null;
  inherited: boolean;
  slots: FeaturedAdminSlot[];
}
