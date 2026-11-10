import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { LEARNING_PARTS, lessonsOf } from "@/features/studio/learn/learning-catalog";

/** Readable without opening or changing a card; deployed with its editor. */
function LearningGuide() {
  const { t } = useTranslation("learning");
  return <main className="h-full overflow-y-auto px-5 py-8 text-foreground sm:px-8">
    <article className="mx-auto max-w-3xl space-y-10 pb-12">
      <header><h1 className="text-2xl font-semibold">{t("title")}</h1><p className="mt-3 leading-relaxed text-muted-foreground">{t("intro")}</p></header>
      {LEARNING_PARTS.map(part => <section key={part} id={part} className="space-y-6">
        <header><h2 className="text-lg font-semibold text-primary">{t(`parts.${part}.name`)}</h2><p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t(`parts.${part}.blurb`)}</p></header>
        <ol className="space-y-6">{lessonsOf(part).map((lesson, index) => <li key={lesson.id} id={lesson.id} className="rounded-2xl border border-border p-5">
            <h3 className="font-medium"><span className="mr-2 text-primary">{index + 1}.</span>{t(`lessons.${lesson.id}.title`)}</h3>
            <p className="mt-1 text-sm text-primary">{t(`lessons.${lesson.id}.goal`)}</p>
            <p className="mt-2 whitespace-pre-line text-sm leading-7 text-muted-foreground">{t(`lessons.${lesson.id}.body`)}</p>
        </li>)}</ol>
      </section>)}
    </article>
  </main>;
}
export const Route = createFileRoute("/app/learn")({ component: LearningGuide });
