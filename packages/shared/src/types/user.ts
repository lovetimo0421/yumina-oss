/** A platform achievement the user is showcasing (title + badge on their profile). */
export interface ShowcasedAchievement {
  id: string;
  title: string;
  badge: string | null;
  tier: string;
}

export const PROFILE_WORLD_SORT_OPTIONS = ["newest", "popular", "alphabetical", "custom"] as const;

export type ProfileWorldSort = (typeof PROFILE_WORLD_SORT_OPTIONS)[number];

/** Keep old or malformed profile preferences on the newest-first default. */
export function normalizeProfileWorldSort(value: unknown): ProfileWorldSort {
  return (PROFILE_WORLD_SORT_OPTIONS as readonly unknown[]).includes(value) ? value as ProfileWorldSort : "newest";
}

/** How many works a custom profile order remembers. A creator with more keeps
 *  the rest after them, newest first. */
export const PROFILE_WORLD_ORDER_MAX = 200;

/** The creator's own order for their works (world ids, first shown first).
 *  Anything malformed reads as no order at all. */
export function normalizeProfileWorldOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const id of value) {
    if (typeof id !== "string" || !id || id.length > 64 || seen.has(id)) continue;
    seen.add(id);
    if (seen.size >= PROFILE_WORLD_ORDER_MAX) break;
  }
  return [...seen];
}

export interface User {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  banner: string | null;
  bio: string | null;
  location: string | null;
  website: string | null;
  username: string | null;
  birthYear: number | null;
  featuredWorldId: string | null;
  showcasedAchievementId: string | null;
  showcasedAchievement?: ShowcasedAchievement | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserProfile {
  id: string;
  name: string;
  image: string | null;
}

export interface UpdateProfileInput {
  name?: string;
  image?: string | null;
  banner?: string | null;
  bio?: string | null;
  location?: string | null;
  website?: string | null;
  username?: string | null;
  featuredWorldId?: string | null;
}
