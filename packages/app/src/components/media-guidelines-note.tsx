import { useId } from "react";
import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DOCS_URLS } from "@/lib/docs-urls";
import { useFeature } from "@/edition/edition";
import { cn } from "@/lib/utils";

interface MediaGuidelinesNoteProps {
  usage?: "public" | "assets" | "profile";
  className?: string;
}

/** Short guidance at the point of upload, separate from upload errors. */
export function MediaGuidelinesNote({ usage = "public", className }: MediaGuidelinesNoteProps) {
  const { t } = useTranslation("common");
  const titleId = useId();
  const hasHub = useFeature("hub");

  if (!hasHub) return null;

  return (
    <aside
      role="note"
      aria-labelledby={titleId}
      className={cn("flex items-start gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 text-xs leading-5 text-muted-foreground", className)}
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <div className="min-w-0">
        <p id={titleId} className="font-medium text-foreground">
          {t(`mediaGuidelines.${usage}Title`)}
        </p>
        <p>{t("mediaGuidelines.effectiveNotice")}</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {usage === "profile" ? (
            <>
              <li>{t("mediaGuidelines.profileSafe")}</li>
              <li>{t("mediaGuidelines.profileExplicit")}</li>
            </>
          ) : (
            <>
              <li>
                <strong className="font-medium text-foreground">{t("mediaGuidelines.limited")}</strong>{" "}
                {t("mediaGuidelines.limitedRule")}
              </li>
              <li>
                <strong className="font-medium text-foreground">{t("mediaGuidelines.limitless")}</strong>{" "}
                {t(usage === "assets" ? "mediaGuidelines.limitlessAssetsRule" : "mediaGuidelines.limitlessPublicRule")}
              </li>
            </>
          )}
        </ul>
        <p className="mt-1.5">
          {usage !== "assets" && <>{t("mediaGuidelines.blurRule")} </>}
          <a
            href={DOCS_URLS.publishingMedia}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-sm font-medium text-foreground underline decoration-foreground/40 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("mediaGuidelines.fullRules")}
          </a>
        </p>
      </div>
    </aside>
  );
}
