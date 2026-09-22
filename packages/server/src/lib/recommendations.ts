/**
 * Open-source edition stub for the recommendation engine.
 *
 * The hub/discover routes still exist inside routes/worlds.ts (they are core
 * code with hosted behaviour), but the local edition never renders a hub, so
 * every ranking entry point returns an empty result and every cache call is a
 * no-op. Types are deliberately loose: the real module's shapes are hosted.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export { normalizeHubLanguage, normalizeWorldLanguage, resolveHubLanguageScope } from "./world-language.js";
export type { HubLanguage } from "./world-language.js";

export type RecommendationProfile = any;
export type HubBaseFilters = any;
export type RankedRecommendationCandidate = any;
export type RecommendationWorldCandidate = any;
export type CachedFeedPage = any;
export type FeedCacheKeyParts = any;

export async function buildHubBaseFilters(..._args: any[]): Promise<any> {
  return {};
}

export function createEmptyRecommendationProfile(userId?: string): any {
  return { userId: userId ?? null };
}

export async function loadRecommendationProfile(..._args: any[]): Promise<any> {
  return createEmptyRecommendationProfile();
}

export async function generateRecommendationCandidates(..._args: any[]): Promise<any> {
  return { data: [], total: 0 };
}

export function rankRecommendedWorlds(..._args: any[]): { data: any[]; total: number } {
  return { data: [], total: 0 };
}

export async function completeRecommendedCatalogPage(..._args: any[]): Promise<{ data: any[]; total: number }> {
  return { data: [], total: 0 };
}

export async function invalidateRecommendationProfile(_userId: string): Promise<void> {}
export async function invalidateRecommendationFeed(_userId: string): Promise<void> {}

export function recommendedFeedCacheKey(_parts: any): string {
  return "";
}

export async function resolveRecommendedFeedCacheKey(_parts: FeedCacheKeyParts): Promise<string | null> {
  return null;
}

export async function readCachedFeedPage(
  _key: string,
  _filters: HubBaseFilters,
  _options: { userId?: string; offset: number; limit: number },
): Promise<CachedFeedPage | null> {
  return null;
}

export async function writeCachedFeedPage(..._args: any[]): Promise<void> {}
