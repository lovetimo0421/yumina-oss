import { useTranslation } from "react-i18next";
import { Code2, FileCode2 } from "lucide-react";
import type { FrontendAiCall, Worldbook } from "@yumina/engine";

/**
 * An AI call the card's own code makes, opened in place on the AI block.
 *
 * It has no settings form: the model, lore and output live in the code, and
 * the code is where you change them. What the row CAN say is what the scan
 * read off the call — which situations it draws lore from, whether it rides
 * the session, whether it asks for JSON — and the way to the line itself.
 * A sticky note stuck to this row is where the creator writes the rest.
 */
export function CodeAiCallCard({ call, books, onOpenFile }: {
  call: FrontendAiCall;
  books: readonly Worldbook[];
  onOpenFile?: (file: string, line: number) => void;
}) {
  const { t } = useTranslation("editor");
  const name = (id: string) => {
    const b = books.find((x) => x.id === id);
    return b ? (b.station?.name?.trim() || b.name) : id;
  };
  const picks = call.worldbookIdPrefixes.flatMap((p) => books.filter((b) => b.id.startsWith(p)).map((b) => b.station?.name?.trim() || b.name));
  const lore =
    call.includeLorebook === false ? t("blueprint.codeCall.loreNone")
    : call.includeLorebook === true || call.includeLorebook === "all" ? t("blueprint.codeCall.loreAll")
    : call.includeLorebook === "matched" || call.sessionContext ? t("blueprint.codeCall.loreMatched")
    : t("blueprint.codeCall.loreRaw");
  const rows: Array<[string, string]> = [
    [t("blueprint.codeCall.kind"), t(`blueprint.codeCall.kind_${call.kind}`)],
    [t("blueprint.codeCall.lore"), lore],
  ];
  if (call.worldbookIds.length) rows.push([t("blueprint.codeCall.situations"), call.worldbookIds.map(name).join(" · ")]);
  else if (picks.length) rows.push([t("blueprint.codeCall.picksSituation"), picks.join(" · ")]);
  else if (call.dynamicWorldbookIds) rows.push([t("blueprint.codeCall.situations"), t("blueprint.codeCall.situationsDynamic")]);
  rows.push([t("blueprint.codeCall.session"), call.sessionContext ? t("blueprint.codeCall.yes") : t("blueprint.codeCall.no")]);
  rows.push([t("blueprint.codeCall.answer"), call.json ? t("blueprint.codeCall.answerJson") : t("blueprint.codeCall.answerText")]);
  if (call.model) rows.push([t("blueprint.codeCall.model"), call.model]);

  return (
    <div className="space-y-2 text-[11.5px]" data-code-ai-call={`${call.file}:${call.line}`}>
      <p className="flex items-start gap-1.5 leading-relaxed text-foreground/70">
        <Code2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-300" />
        <span>{t("blueprint.codeCall.intro")}</span>
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-foreground/45">{k}</dt>
            <dd className="min-w-0 break-words text-foreground/85">{v}</dd>
          </div>
        ))}
      </dl>
      <button
        type="button"
        className="nodrag inline-flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-1 text-[11px] text-foreground/80 hover:border-white/25 hover:text-foreground disabled:opacity-50"
        disabled={!onOpenFile}
        onClick={(e) => { e.stopPropagation(); onOpenFile?.(call.file, call.line); }}
      >
        <FileCode2 className="h-3.5 w-3.5" />
        {t("blueprint.codeCall.openAt", { file: call.file, line: call.line })}
      </button>
    </div>
  );
}
