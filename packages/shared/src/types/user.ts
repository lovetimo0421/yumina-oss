/** A platform achievement the user is showcasing (title + badge on their profile). */
export interface ShowcasedAchievement {
  id: string;
  title: string;
  badge: string | null;
  tier: string;
}

export const PROFILE_WORLD_SORT_OPTIONS = ["newest", "popular"] as const;

export type ProfileWorldSort = (typeof PROFILE_WORLD_SORT_OPTIONS)[number];

/** Keep old or malformed profile preferences on the newest-first default. */
export function normalizeProfileWorldSort(value: unknown): ProfileWorldSort {
  return value === "popular" ? "popular" : "newest";
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
