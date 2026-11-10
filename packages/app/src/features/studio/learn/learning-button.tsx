import { BookOpen, GraduationCap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DOCS_URLS } from "@/lib/docs-urls";
import { LEARNING_OPEN_EVENT } from "./learning-catalog";

/** Opens the guide. Its own file so the canvas row can carry it without
 *  pulling the whole guide (and the stores it reads) in with it. */
export function StudioLearningButton() {
  const { t } = useTranslation("learning");
  return <button type="button" data-learning="help" onClick={() => window.dispatchEvent(new Event(LEARNING_OPEN_EVENT))}
    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title={t("help")}>
    <BookOpen className="h-3.5 w-3.5" /><span className="@max-[46rem]:hidden">{t("help")}</span>
  </button>;
}

/** The creator guide on the docs site, opened at the canvas walkthrough: the
 *  classic editor always had this link and the canvas had none. */
export function StudioDocsButton() {
  const { t } = useTranslation("editor");
  return <a href={DOCS_URLS.canvas} target="_blank" rel="noopener noreferrer" data-studio-docs=""
    className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[11px] font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground" title={t("shell.creatorGuide")}>
    <GraduationCap className="h-3.5 w-3.5" /><span className="@max-[46rem]:hidden">{t("shell.creatorGuide")}</span>
  </a>;
}
