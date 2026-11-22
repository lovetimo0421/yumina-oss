import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { ListTodo } from "lucide-react";
import { useEditorStore } from "@/stores/editor";
import { useStudioStore } from "@/stores/studio";
import { cn } from "@/lib/utils";
import { openRowOnBoard, templateBlanks } from "../lib/template-blanks";

/**
 * 「还差 2 项」 beside 试玩: the template rows this card cannot play without,
 * and a click that opens the next one. Gone once they are written — it is
 * the simple editor's 必填 badge, said once, where the creator looks before
 * pressing play.
 */
export function TemplateBlanksChip({ className }: { className?: string }) {
  const { t, i18n } = useTranslation(["editor", "templates-content"]);
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const readOnly = useEditorStore((s) => s.readOnlyInspect || s.guestMode);
  const published = useEditorStore((s) => s.worldIsPublished);
  const playing = useStudioStore((s) => s.mode === "playtest");
  const setStagePage = useStudioStore((s) => s.setStagePage);
  const blanks = useMemo(() => templateBlanks(entries ?? []), [entries]);

  if (readOnly || published || playing || blanks.length === 0) return null;

  const names = blanks.map((b) => String(t(b.labelKey as never, { ns: "templates-content" })));
  let list = names.join(", ");
  try { list = new Intl.ListFormat(i18n.language, { type: "conjunction" }).format(names); } catch { /* old browsers: commas */ }
  const label = String(t("studio.blanks.left", { count: blanks.length }));
  const title = String(t("studio.blanks.title", { items: list }));

  return (
    <button
      type="button"
      data-studio-blanks=""
      title={title}
      aria-label={`${label}: ${list}`}
      onClick={() => {
        // The rows live on the board; from the player's screen or the
        // generation page, go back to it first.
        setStagePage("blueprint");
        openRowOnBoard(blanks[0]!.objectId);
      }}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1 rounded-lg text-amber-200/90 transition-colors hover:bg-amber-400/10",
        "px-2 text-xs font-medium",
        className,
      )}
    >
      <ListTodo className="h-3.5 w-3.5 shrink-0" />
      {label}
    </button>
  );
}
