import { BookOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
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
