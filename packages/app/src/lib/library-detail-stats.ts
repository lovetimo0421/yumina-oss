import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorldPreviewDetail } from "./world-detail-info";

export interface ActivityStats {
  worldId: string;
  downloadCount: number;
  messageCount: number | null | undefined;
  favoriteCount: number | null | undefined;
  uniquePlayerCount?: number | null;
  averagePlaytimePerPlayerSeconds?: number | null;
  averageRating?: number | null;
  /** How many ratings `averageRating` is made of. */
  reviewCount?: number | null;
  /** Hours played across every save; only sent where the server shares it. */
  totalPlaytimeSeconds?: number | null;
}

interface UseActivityStatsOptions extends ActivityStats {
  apiBase: string;
  enabled: boolean;
  creatorAnalyticsEnabled?: boolean;
  fetcher?: typeof fetch;
}

interface ActivityState {
  stats: ActivityStats;
  sourceKey: string;
  favoriteDirty: boolean;
  favoriteBaseCount: number | null | undefined;
}

function activityStatsEqual(left: ActivityStats, right: ActivityStats) {
  return left.worldId === right.worldId
    && left.downloadCount === right.downloadCount
    && left.messageCount === right.messageCount
    && left.favoriteCount === right.favoriteCount
    && left.uniquePlayerCount === right.uniquePlayerCount
    && left.averagePlaytimePerPlayerSeconds === right.averagePlaytimePerPlayerSeconds
    && left.averageRating === right.averageRating
    && left.reviewCount === right.reviewCount
    && left.totalPlaytimeSeconds === right.totalPlaytimeSeconds;
}

/** Optional figures are set only when known, so "not loaded" stays a missing key. */
function withOptionalStats(
  stats: ActivityStats,
  optional: Pick<ActivityStats, "averageRating" | "reviewCount" | "totalPlaytimeSeconds">,
): ActivityStats {
  const next = { ...stats };
  for (const key of ["averageRating", "reviewCount", "totalPlaytimeSeconds"] as const) {
    if (optional[key] !== undefined) next[key] = optional[key];
  }
  return next;
}

const finiteNumber = (value: unknown): number | undefined => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

function statsForSource(
  state: ActivityState,
  initialStats: ActivityStats,
  sourceKey: string,
) {
  if (state.stats.worldId === initialStats.worldId && state.sourceKey === sourceKey) {
    return state.stats;
  }
  return {
    ...initialStats,
    favoriteCount: favoriteOverrideApplies(state, initialStats)
      ? state.stats.favoriteCount
      : initialStats.favoriteCount,
  };
}

function favoriteOverrideApplies(state: ActivityState, initialStats: ActivityStats) {
  return state.stats.worldId === initialStats.worldId
    && state.favoriteDirty
    && (
      initialStats.favoriteCount == null
      || initialStats.favoriteCount === state.favoriteBaseCount
    );
}

export function useActivityStats({
  apiBase,
  enabled,
  creatorAnalyticsEnabled = false,
  fetcher = fetch,
  worldId,
  downloadCount,
  messageCount,
  favoriteCount,
  averageRating,
  reviewCount,
  totalPlaytimeSeconds,
}: UseActivityStatsOptions) {
  const initialStats = useMemo<ActivityStats>(() => withOptionalStats({
    worldId,
    downloadCount,
    messageCount,
    favoriteCount,
  }, {
    averageRating: reviewCount ? averageRating : undefined,
    reviewCount,
    totalPlaytimeSeconds,
  }), [averageRating, downloadCount, favoriteCount, messageCount, reviewCount, totalPlaytimeSeconds, worldId]);
  const sourceKey = useMemo(
    () => JSON.stringify([
      worldId,
      downloadCount,
      messageCount,
      favoriteCount,
      averageRating,
      reviewCount,
      totalPlaytimeSeconds,
      creatorAnalyticsEnabled,
    ]),
    [averageRating, creatorAnalyticsEnabled, downloadCount, favoriteCount, messageCount, reviewCount, totalPlaytimeSeconds, worldId],
  );
  // The preview response also describes the card (gallery, size, author's
  // note). Library rows lack some of it, so the detail view reads it from here.
  const [detail, setDetail] = useState<{ worldId: string; data: WorldPreviewDetail } | null>(null);
  const [activityState, setActivityState] = useState<ActivityState>(() => ({
    stats: initialStats,
    sourceKey,
    favoriteDirty: false,
    favoriteBaseCount: undefined,
  }));
  const [favoriteRefresh, setFavoriteRefresh] = useState(0);
  const favoriteRevisionRef = useRef(0);

  useEffect(() => {
    favoriteRevisionRef.current = 0;
  }, [worldId]);

  useEffect(() => {
    if (!enabled || (initialStats.messageCount != null && initialStats.favoriteCount != null)) return;

    const controller = new AbortController();
    const favoriteRevision = favoriteRevisionRef.current;
    let ignore = false;

    void (async () => {
      try {
        const response = await fetcher(
          `${apiBase}/api/worlds/${encodeURIComponent(worldId)}?preview=true`,
          { credentials: "include", signal: controller.signal },
        );
        if (!response.ok) return;

        const body = await response.json() as {
          data?: Partial<Pick<ActivityStats, "downloadCount" | "messageCount" | "favoriteCount" | "totalPlaytimeSeconds">>
            & { reviewCount?: number | string | null; averageRating?: number | string | null }
            & WorldPreviewDetail;
        };
        if (ignore || !body.data) return;
        setDetail({ worldId, data: body.data });
        const previewReviewCount = finiteNumber(body.data.reviewCount);
        const previewAverage = finiteNumber(body.data.averageRating);

        setActivityState((current) => {
          if (ignore) return current;
          const currentStats = statsForSource(current, initialStats, sourceKey);
          const preserveFavorite = favoriteOverrideApplies(current, initialStats)
            || (
              current.stats.worldId === worldId
              && favoriteRevisionRef.current !== favoriteRevision
            );
          const nextStats: ActivityStats = withOptionalStats({
            ...currentStats,
            worldId,
            downloadCount: typeof body.data!.downloadCount === "number"
              ? body.data!.downloadCount
              : initialStats.downloadCount,
            messageCount: typeof body.data!.messageCount === "number"
              ? body.data!.messageCount
              : initialStats.messageCount,
            favoriteCount: preserveFavorite
              ? currentStats.favoriteCount
              : typeof body.data!.favoriteCount === "number"
                ? body.data!.favoriteCount
                : initialStats.favoriteCount,
          }, {
            reviewCount: previewReviewCount ?? currentStats.reviewCount,
            averageRating: previewReviewCount === 0
              ? null
              : currentStats.averageRating ?? (previewReviewCount ? previewAverage : undefined),
            // Absent = the server does not share it here; null = unknown.
            totalPlaytimeSeconds: body.data!.totalPlaytimeSeconds !== undefined
              ? finiteNumber(body.data!.totalPlaytimeSeconds) ?? null
              : currentStats.totalPlaytimeSeconds,
          });
          if (
            current.sourceKey === sourceKey
            && current.favoriteDirty === preserveFavorite
            && activityStatsEqual(current.stats, nextStats)
          ) {
            return current;
          }
          return {
            stats: nextStats,
            sourceKey,
            favoriteDirty: preserveFavorite,
            favoriteBaseCount: preserveFavorite ? current.favoriteBaseCount : undefined,
          };
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        // Engagement data is supplementary; keep the explicit unavailable state.
      }
    })();

    return () => {
      ignore = true;
      controller.abort();
    };
  }, [apiBase, enabled, favoriteRefresh, fetcher, initialStats, sourceKey, worldId]);

  useEffect(() => {
    if (!creatorAnalyticsEnabled) return;

    const controller = new AbortController();
    let ignore = false;

    void (async () => {
      try {
        const response = await fetcher(
          `${apiBase}/api/worlds/${encodeURIComponent(worldId)}/activity`,
          { credentials: "include", signal: controller.signal },
        );
        if (!response.ok) return;

        const body = await response.json() as {
          data?: {
            totalUniquePlayers?: number;
            avgPlaytimePerPlayerSeconds?: number;
            averageRating?: number;
            reviewCount?: number;
          };
        };
        if (ignore || !body.data) return;

        setActivityState((current) => {
          if (ignore) return current;
          const currentStats = statsForSource(current, initialStats, sourceKey);
          const totalUniquePlayers = Number.isFinite(body.data!.totalUniquePlayers)
            ? body.data!.totalUniquePlayers!
            : currentStats.uniquePlayerCount;
          const reviewCount = body.data!.reviewCount;
          const nextStats: ActivityStats = {
            ...currentStats,
            uniquePlayerCount: totalUniquePlayers,
            averagePlaytimePerPlayerSeconds: totalUniquePlayers != null && totalUniquePlayers > 0
              && Number.isFinite(body.data!.avgPlaytimePerPlayerSeconds)
              ? body.data!.avgPlaytimePerPlayerSeconds!
              : totalUniquePlayers === 0
                ? null
                : currentStats.averagePlaytimePerPlayerSeconds,
            averageRating: Number.isFinite(reviewCount) && reviewCount === 0
              ? null
              : Number.isFinite(body.data!.averageRating)
                ? body.data!.averageRating!
                : currentStats.averageRating,
            ...(Number.isFinite(reviewCount) ? { reviewCount: reviewCount! } : {}),
          };
          if (current.sourceKey === sourceKey && activityStatsEqual(current.stats, nextStats)) {
            return current;
          }
          return { ...current, stats: nextStats, sourceKey };
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        // Creator analytics are supplementary; keep unavailable values explicit.
      }
    })();

    return () => {
      ignore = true;
      controller.abort();
    };
  }, [apiBase, creatorAnalyticsEnabled, fetcher, initialStats, sourceKey, worldId]);

  const displayedActivityStats = statsForSource(activityState, initialStats, sourceKey);

  const reconcileFavoriteCount = useCallback((nextFavorited: boolean) => {
    favoriteRevisionRef.current += 1;
    if (displayedActivityStats.favoriteCount == null) {
      // The first preview may predate the mutation. Abort it by changing the
      // effect generation and hydrate again after toggleFavorite has resolved.
      setFavoriteRefresh((current) => current + 1);
      return;
    }
    setActivityState((current) => {
      const currentStats = statsForSource(current, initialStats, sourceKey);
      if (currentStats.favoriteCount == null) return current;
      const nextCount = Math.max(0, currentStats.favoriteCount + (nextFavorited ? 1 : -1));
      const nextStats = { ...currentStats, favoriteCount: nextCount };
      const favoriteBaseCount = favoriteOverrideApplies(current, initialStats)
        ? current.favoriteBaseCount
        : currentStats.favoriteCount;
      const favoriteDirty = nextCount !== favoriteBaseCount;
      return current.sourceKey === sourceKey
        && current.favoriteDirty === favoriteDirty
        && current.favoriteBaseCount === favoriteBaseCount
        && activityStatsEqual(current.stats, nextStats)
        ? current
        : { stats: nextStats, sourceKey, favoriteDirty, favoriteBaseCount };
    });
  }, [displayedActivityStats.favoriteCount, initialStats, sourceKey]);

  return {
    activityStats: displayedActivityStats,
    reconcileFavoriteCount,
    detail: detail?.worldId === worldId ? detail.data : null,
  };
}

export function formatStatCount(value: number | null | undefined) {
  return value == null ? "—" : value.toLocaleString();
}

export function formatAveragePlaytimePerPlayer(value: number | null | undefined) {
  if (value == null) return "—";
  if (value <= 0) return "0m";
  if (value < 60) return "<1m";

  const totalMinutes = Math.round(value / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

export function formatAverageRating(value: number | null | undefined) {
  return value == null || value <= 0 ? "—" : value.toFixed(1);
}

/**
 * Whole hours across every save ("<1h" below one); "—" when unknown. Rounded
 * down, as the card stats on Discover are, so 12.5h reads 12h in both places.
 */
export function formatTotalPlaytime(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value < 0) return "—";
  if (value === 0) return "0h";
  const hours = value / 3600;
  if (hours < 1) return "<1h";
  return `${Math.floor(hours).toLocaleString()}h`;
}
