import {
  Clapperboard,
  Clock3,
  Download,
  Heart,
  MessagesSquare,
  Star,
  UsersRound,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  formatAverageRating,
  formatAverageSession,
  formatStatCount,
  type ActivityStats,
} from "@/lib/library-detail-stats";

const LIBRARY_ACTIVITY_METRICS = [
  { valueKey: "downloadCount", labelKey: "detail.downloads", Icon: Download, format: formatStatCount },
  { valueKey: "messageCount", labelKey: "detail.chatVolume", Icon: MessagesSquare, format: formatStatCount },
  { valueKey: "favoriteCount", labelKey: "detail.favoriteCount", Icon: Heart, format: formatStatCount },
] as const;

const CREATOR_ACTIVITY_METRICS = [
  { valueKey: "uniquePlayerCount", labelKey: "detail.uniquePlayers", Icon: UsersRound, format: formatStatCount },
  { valueKey: "averageSessionSeconds", labelKey: "detail.averageSession", Icon: Clock3, format: formatAverageSession },
  { valueKey: "averageRating", labelKey: "detail.averageRating", Icon: Star, format: formatAverageRating },
] as const;

interface LibraryDetailActivityCardProps {
  layout: "desktop" | "mobile";
  showCreatorMetrics: boolean;
  stats: ActivityStats;
}

export function LibraryDetailActivityCard({
  layout,
  showCreatorMetrics,
  stats,
}: LibraryDetailActivityCardProps) {
  const { t } = useTranslation("library");
  const headingId = `library-detail-${layout}-activity-heading`;
  const isDesktop = layout === "desktop";
  const metrics = showCreatorMetrics
    ? [...LIBRARY_ACTIVITY_METRICS, ...CREATOR_ACTIVITY_METRICS]
    : LIBRARY_ACTIVITY_METRICS;

  return (
    <section
      aria-labelledby={headingId}
      className={isDesktop
        ? "library-detail-card clouded-glass-panel clouded-glass-panel--soft relative mt-7 overflow-hidden rounded-xl px-6 py-5 md:px-7"
        : "library-detail-mobile-surface mt-4 rounded-2xl px-4 py-4"}
    >
      <div className="relative z-10">
        <h2
          id={headingId}
          className={`flex items-center gap-2 border-b border-white/8 pb-4 font-bold text-foreground ${isDesktop ? "text-lg" : "text-base"}`}
        >
          <Clapperboard className="h-5 w-5 text-primary" aria-hidden="true" />
          {t("detail.activity")}
        </h2>

        <dl className="grid grid-cols-3 pt-3">
          {metrics.map(({ valueKey, labelKey, Icon, format }, index) => (
            <div
              key={valueKey}
              className={`flex min-w-0 flex-col justify-center px-2 py-3 text-center sm:px-4 ${index % 3 !== 2 ? "border-r border-white/8" : ""} ${index >= 3 ? "border-t border-white/8" : ""}`}
            >
              <dt className="flex min-h-10 min-w-0 flex-col items-center justify-center gap-1 text-[10px] font-semibold uppercase leading-tight tracking-[0.06em] text-muted-foreground sm:text-[11px]">
                <Icon className="h-3.5 w-3.5 shrink-0 text-primary/80" aria-hidden="true" />
                <span className="min-w-0 max-w-full break-words text-balance [overflow-wrap:anywhere]">
                  {t(labelKey)}
                </span>
              </dt>
              <dd className="mt-1.5 text-base font-bold tabular-nums text-foreground">
                {format(stats[valueKey])}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </section>
  );
}
