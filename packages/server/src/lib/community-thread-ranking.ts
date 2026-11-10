/**
 * "Popular" = what people replied to and liked in the last week.
 *
 * This used to be all-time counts divided by (hours since the last reply)^1.2,
 * which on a forum with a few dozen posts a day made any thread replied to in
 * the last hour outrank everything else: a fresh 2-reply question sat above the
 * 96-reply ONCIN guide, and Popular read as a reshuffled Recent activity
 * (2026-10-15). Counting only the window's replies and likes lets a thread that
 * is genuinely busy this week lead, and lets a big old thread fall away once
 * people stop engaging with it. viewCount stays out: it bumps on every open.
 */
export const COMMUNITY_HOT_RANKING = {
  replyWeight: 3,
  likeWeight: 4,
  windowDays: 7,
} as const;

export type CommunityThreadSort = "latest" | "newest" | "popular";

export function normalizeCommunityThreadSort(value: unknown): CommunityThreadSort {
  return value === "newest" || value === "popular" ? value : "latest";
}

/** Mirrors the SQL in routes/community/threads.ts; kept for the tests. */
export function scoreCommunityThreadHotness(input: { recentReplies: number; recentLikes: number }): number {
  return Math.log1p(Math.max(0, input.recentReplies)) * COMMUNITY_HOT_RANKING.replyWeight
    + Math.log1p(Math.max(0, input.recentLikes)) * COMMUNITY_HOT_RANKING.likeWeight;
}
