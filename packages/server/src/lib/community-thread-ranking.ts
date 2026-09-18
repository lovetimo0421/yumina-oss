export const COMMUNITY_HOT_RANKING = {
  replyWeight: 3,
  likeWeight: 4,
  ageOffsetHours: 2,
  decayExponent: 1.2,
} as const;

export type CommunityThreadSort = "latest" | "newest" | "popular";

export function normalizeCommunityThreadSort(value: unknown): CommunityThreadSort {
  return value === "newest" || value === "popular" ? value : "latest";
}

export function scoreCommunityThreadHotness(
  input: { replyCount: number; likeCount: number; activityAt: Date | string },
  now = new Date(),
): number {
  const activityTime = new Date(input.activityAt).getTime();
  if (!Number.isFinite(activityTime)) return 0;

  const ageHours = Math.max(0, (now.getTime() - activityTime) / 3_600_000);
  const engagement =
    Math.log1p(Math.max(0, input.replyCount)) * COMMUNITY_HOT_RANKING.replyWeight
    + Math.log1p(Math.max(0, input.likeCount)) * COMMUNITY_HOT_RANKING.likeWeight;

  return engagement / Math.pow(
    ageHours + COMMUNITY_HOT_RANKING.ageOffsetHours,
    COMMUNITY_HOT_RANKING.decayExponent,
  );
}
