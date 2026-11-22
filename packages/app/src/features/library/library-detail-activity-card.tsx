import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  formatAverageRating,
  formatAveragePlaytimePerPlayer,
  formatStatCount,
  formatTotalPlaytime,
  type ActivityStats,
} from "@/lib/library-detail-stats";

const LIBRARY_ACTIVITY_METRICS = [
  { valueKey: "downloadCount", labelKey: "detail.downloads", format: formatStatCount },
  { valueKey: "messageCount", labelKey: "detail.chatVolume", format: formatStatCount },
  { valueKey: "favoriteCount", labelKey: "detail.favoriteCount", format: formatStatCount },
] as const;

const CREATOR_ACTIVITY_METRICS = [
  { valueKey: "uniquePlayerCount", labelKey: "detail.uniquePlayers", format: formatStatCount },
  { valueKey: "averagePlaytimePerPlayerSeconds", labelKey: "detail.averagePlaytimePerPlayer", format: formatAveragePlaytimePerPlayer },
  { valueKey: "averageRating", labelKey: "detail.averageRating", format: formatAverageRating },
] as const;

/** Shown only where the server shares the all-saves playtime total. */
const PLAYTIME_METRIC = {
  valueKey: "totalPlaytimeSeconds", labelKey: "detail.totalPlaytime", format: formatTotalPlaytime,
} as const;

interface LibraryDetailActivityCardProps {
  /** desktop/mobile: the Library detail; preview: the Discover preview's Overview. */
  layout: "desktop" | "mobile" | "preview";
  showCreatorMetrics: boolean;
  stats: ActivityStats;
  onViewReviews?: () => void;
}

/** The card's engagement numbers — the same card in Library and in Discover. */
export function LibraryDetailActivityCard({
  layout,
  showCreatorMetrics,
  stats,
  onViewReviews,
}: LibraryDetailActivityCardProps) {
  const { t } = useTranslation("library");
  const headingId = `library-detail-${layout}-activity-heading`;
  const isDesktop = layout === "desktop";
  const isPreview = layout === "preview";
  const showPlaytime = typeof stats.totalPlaytimeSeconds === "number" && Number.isFinite(stats.totalPlaytimeSeconds);
  const metrics = [
    ...LIBRARY_ACTIVITY_METRICS,
    ...(showCreatorMetrics ? CREATOR_ACTIVITY_METRICS : []),
    ...(showPlaytime ? [PLAYTIME_METRIC] : []),
  ];
  const ratingCount = typeof stats.reviewCount === "number" && stats.reviewCount > 0 ? stats.reviewCount : null;

  const metricOrder = ["uniquePlayerCount", "messageCount", "totalPlaytimeSeconds", "downloadCount", "favoriteCount", "averagePlaytimePerPlayerSeconds", "averageRating"];
  if (showCreatorMetrics) {
    metrics.sort((a, b) => metricOrder.indexOf(a.valueKey) - metricOrder.indexOf(b.valueKey));
  }
  const noReviews = stats.reviewCount === 0;
  return (
    <section aria-labelledby={headingId} className={`library-activity ${isDesktop
      ? "library-detail-card relative mt-7 border-t border-white/10 px-6 py-5 md:px-7"
      : isPreview ? "border-t border-white/10 py-5" : "mt-4 border-t border-white/10 px-4 py-5"}`}>
      <div className="mb-5 flex items-baseline justify-between gap-3">
        <h2 id={headingId} className="text-base font-semibold text-foreground">{t("detail.activity")}</h2>
        <span className="text-xs text-muted-foreground">{t("detail.allTime")}</span>
      </div>
      <dl
        className={`library-activity-stats${metrics.length <= 3 ? " library-activity-stats-short" : ""}`}
        style={{ "--activity-count": metrics.length } as CSSProperties}
      >
        {metrics.map(({ valueKey, labelKey, format }) => (
          <div key={valueKey} className="library-activity-metric">
            <dt className="text-muted-foreground">
              {t(labelKey)}
              {valueKey === "averageRating" && ratingCount != null && (stats.averageRating ?? 0) > 0 && (
                <span className="ml-1">({ratingCount.toLocaleString()})</span>
              )}
            </dt>
            <dd className="font-medium tabular-nums text-foreground">
              {valueKey === "averageRating" && noReviews
                ? <span className="library-activity-no-reviews">{t("detail.noReviewsYet")}</span>
                : format(stats[valueKey])}
            </dd>
          </div>
        ))}
      </dl>
      {onViewReviews && (
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button type="button" onClick={onViewReviews} className="ml-auto min-h-11 text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">{t("detail.viewReviews")} →</button>
        </div>
      )}
    </section>
  );
}
