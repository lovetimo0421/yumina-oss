import { create } from "zustand";
import { persist } from "zustand/middleware";
import { cachedFetch } from "@/lib/cached-fetch";

interface ShowcasedAchievement {
  id: string;
  key: string;
  title: string;
  badge: string | null;
  tier: string;
}

interface UserProfile {
  id: string;
  name: string;
  email: string;
  image: string | null;
  banner: string | null;
  bio: string | null;
  location: string | null;
  website: string | null;
  username: string | null;
  birthYear: number | null;
  featuredWorldId: string | null;
  showcasedAchievementId: string | null;
  showcasedAchievement: ShowcasedAchievement | null;
  preferences: Record<string, unknown>;
  role: string;
  /** Display hint only; publishing endpoints enforce current permissions. */
  skipReview?: boolean;
  isBanned?: boolean;
  /**
   * Promotion partner. Used ONLY to decide whether the top-bar shortcut is
   * shown — this store is persisted and refreshes on page load, so a freshly
   * flagged partner may not see the shortcut until the next load. Never gate
   * actual access on it: /app/partner and the API do their own authoritative
   * check against the live flag.
   */
  isPartner: boolean;
  /** ISO timestamp of account creation — used by ad-conversion attribution
   *  (fresh account on first profile load = this session's signup). */
  createdAt: string | null;
  /** Server-resolved rollout default; null means inherit the effective window. */
  defaultStoryMemory?: number | null;
}

interface UserProfileState {
  profile: UserProfile | null;
  loading: boolean;
  lastFetchedAt: number | null;
  fetchProfile: () => Promise<void>;
  forceFetchProfile: () => Promise<void>;
  acceptProfile: (data: Record<string, unknown>) => void;
  clear: () => void;
}

let latestProfileRequestId = 0;

const apiBase = import.meta.env?.VITE_API_URL || "";

function mapProfileResponse(data: Record<string, unknown>): UserProfile {
  return {
    id: data.id as string,
    name: data.name as string,
    email: data.email as string,
    image: (data.image as string) ?? null,
    banner: (data.banner as string) ?? null,
    bio: (data.bio as string) ?? null,
    location: (data.location as string) ?? null,
    website: (data.website as string) ?? null,
    username: (data.username as string) ?? null,
    birthYear: (data.birthYear as number) ?? null,
    featuredWorldId: (data.featuredWorldId as string) ?? null,
    showcasedAchievementId: (data.showcasedAchievementId as string) ?? null,
    showcasedAchievement: (data.showcasedAchievement as ShowcasedAchievement) ?? null,
    preferences: (data.preferences as Record<string, unknown>) ?? {},
    role: (data.role as string) ?? "user",
    skipReview: data.skipReview === true,
    isBanned: data.isBanned === true,
    isPartner: data.isPartner === true,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : null,
    defaultStoryMemory: typeof data.defaultStoryMemory === "number" && Number.isFinite(data.defaultStoryMemory)
      ? data.defaultStoryMemory : null,
  };
}

export const useUserProfileStore = create<UserProfileState>()(
  persist(
    (set, get) => ({
      profile: null,
      loading: false,
      lastFetchedAt: null,

      fetchProfile: () =>
        cachedFetch(
          () => get().profile !== null,
          () => ({ lastFetchedAt: get().lastFetchedAt, loading: get().loading }),
          async () => {
            const requestId = ++latestProfileRequestId;
            try {
              const res = await fetch(`${apiBase}/api/users/me`, {
                credentials: "include",
                cache: "no-store",
              });
              if (res.ok) {
                const { data } = await res.json();
                if (requestId !== latestProfileRequestId) return;
                set({
                  profile: mapProfileResponse(data),
                  loading: false,
                  lastFetchedAt: Date.now(),
                });
              } else {
                if (requestId === latestProfileRequestId) set({ loading: false });
              }
            } catch {
              if (requestId === latestProfileRequestId) set({ loading: false });
            }
          },
          (v) => set({ loading: v }),
        ),

      forceFetchProfile: async () => {
        const requestId = ++latestProfileRequestId;
        set({ loading: true, lastFetchedAt: null });
        try {
          const res = await fetch(`${apiBase}/api/users/me`, {
            credentials: "include",
            cache: "no-store",
          });
          if (res.ok) {
            const { data } = await res.json();
            if (requestId !== latestProfileRequestId) return;
            set({
              profile: mapProfileResponse(data),
              loading: false,
              lastFetchedAt: Date.now(),
            });
          } else {
            if (requestId === latestProfileRequestId) set({ loading: false });
          }
        } catch {
          if (requestId === latestProfileRequestId) set({ loading: false });
        }
      },

      acceptProfile: (data) => {
        ++latestProfileRequestId;
        set({
          profile: mapProfileResponse({ ...get().profile, ...data }),
          loading: false,
          lastFetchedAt: Date.now(),
        });
      },

      clear: () => {
        ++latestProfileRequestId;
        set({ profile: null, loading: false, lastFetchedAt: null });
      },
    }),
    {
      name: "yumina-user-profile",
      version: 1,
      partialize: (state) => ({
        profile: state.profile,
      }),
    },
  ),
);
