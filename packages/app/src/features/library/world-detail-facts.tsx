import { useTranslation } from "react-i18next";
import { worldDetailFacts } from "@/lib/world-detail-info";

/**
 * The card facts (created, size in tokens, est. play time) as label-over-value
 * columns. Renders bare columns so it can sit inside a caller's flex row: the
 * Library hero's stats bar, or the Discover preview's Details strip.
 */
export function WorldDetailFacts({
  world,
}: {
  world: { totalTokens?: number | null; approxTime?: string | null; createdAt?: string | null };
}) {
  const { t, i18n } = useTranslation("library");
  return (
    <>
      {worldDetailFacts(world, i18n.language).map((fact) => (
        <div key={fact.key} className="flex min-w-0 flex-col">
          <span className="mb-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
            {t(fact.labelKey)}
          </span>
          <span className="text-sm font-medium text-foreground">{fact.value}</span>
        </div>
      ))}
    </>
  );
}
