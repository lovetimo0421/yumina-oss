import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { FileCode2, StickyNote } from "lucide-react";
import { extractAiCallsFromFiles, type FrontendAiCall, type Worldbook } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { CodeAiCallCard } from "./code-ai-call-card";
import { CustomizationHints, requestOpenCode } from "./customization-hints";

/**
 * 「自定义」— the fourth option on a type switch, and what it opens onto.
 *
 * A custom AI or behaviour is a declared slot: the author made the object,
 * named it, chose 自定义, and left a sticky note saying what it should do.
 * The implementation is code — written by the creation assistant, by an
 * outside AI over MCP, or by the author if they can — and this panel shows
 * whichever it finds: the AI calls in the interface that read this
 * situation, the behaviour's own code, the interface code that fires it. When
 * nothing implements it yet, it says so and points at the note, which is the
 * author's half of the deal.
 */
export function EmptyImplementation({ kind }: { kind: "ai" | "behavior" }) {
  const { t } = useTranslation("editor");
  return (
    <div data-custom-empty={kind} className="rounded-lg border border-dashed border-white/15 px-3 py-3 text-[11.5px] leading-relaxed text-foreground/60">
      <p className="font-medium text-foreground/80">{t("blueprint.custom.empty")}</p>
      <p className="mt-1 flex items-start gap-1.5">
        <StickyNote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-300/80" />
        <span>{t("blueprint.custom.noteHint")}</span>
      </p>
    </div>
  );
}

/** The AI calls in the interface that read this situation's lore. */
export function callsImplementing(book: Pick<Worldbook, "id">, files: Record<string, string> | undefined): FrontendAiCall[] {
  if (!files) return [];
  return extractAiCallsFromFiles(files).filter((c) => c.worldbookIds.includes(book.id) || c.worldbookIdPrefixes.some((p) => book.id.startsWith(p)));
}

export function CustomAiPanel({ worldbookId }: { worldbookId: string }) {
  const { t } = useTranslation("editor");
  const books = useEditorStore((s) => s.worldDraft.worldbooks ?? []);
  const files = useEditorStore((s) => s.worldDraft.rootComponent?.files);
  const book = books.find((b) => b.id === worldbookId);
  const calls = useMemo(() => (book ? callsImplementing(book, files) : []), [book, files]);
  if (!book) return null;
  return (
    <div className="space-y-2" data-custom-ai={worldbookId}>
      <p className="text-[11px] leading-relaxed text-foreground/55">{t("blueprint.custom.aiIntro")}</p>
      {calls.length === 0 ? (
        <EmptyImplementation kind="ai" />
      ) : (
        <>
          <p className="text-[11px] font-semibold text-foreground/80">{t("blueprint.custom.implementedBy", { count: calls.length })}</p>
          {calls.map((c) => (
            <div key={`${c.file}:${c.line}`} className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-2">
              <CodeAiCallCard call={c} books={books} onOpenFile={(file, line) => requestOpenCode(file, line)} />
            </div>
          ))}
        </>
      )}
      <CustomizationHints area="ai" />
    </div>
  );
}

/** Where interface code fires a behaviour by id: `api.executeAction("<id>")`. */
export function firesOf(reactionId: string, files: Record<string, string> | undefined): Array<{ file: string; line: number }> {
  if (!files) return [];
  const out: Array<{ file: string; line: number }> = [];
  const re = new RegExp(String.raw`\bexecuteAction\s*\(\s*["'\`]${reactionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`, "g");
  for (const [file, src] of Object.entries(files)) {
    if (typeof src !== "string" || !src.includes("executeAction")) continue;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      let line = 1;
      for (let i = 0; i < m.index; i++) if (src.charCodeAt(i) === 10) line++;
      out.push({ file, line });
    }
  }
  return out;
}

export function CustomBehaviorPanel({ reactionId }: { reactionId: string }) {
  const { t } = useTranslation("editor");
  const reaction = useEditorStore((s) => (s.worldDraft.reactions ?? []).find((r) => r.id === reactionId));
  const files = useEditorStore((s) => s.worldDraft.rootComponent?.files);
  const fires = useMemo(() => firesOf(reactionId, files), [reactionId, files]);
  if (!reaction) return null;
  const codeLines = reaction.code?.trim() ? reaction.code.split("\n").length : 0;
  const implemented = codeLines > 0 || fires.length > 0;
  return (
    <div className="space-y-2" data-custom-behavior={reactionId}>
      <p className="text-[11px] leading-relaxed text-foreground/55">{t("blueprint.custom.behaviorIntro")}</p>
      {!implemented ? (
        <EmptyImplementation kind="behavior" />
      ) : (
        <ul className="space-y-1 text-[11.5px]">
          {codeLines > 0 && (
            <li className="rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5 text-foreground/80">
              {t("blueprint.custom.implementedCode", { count: codeLines })}
            </li>
          )}
          {fires.map((f) => (
            <li key={`${f.file}:${f.line}`}>
              <button
                type="button"
                className="nodrag flex w-full items-center gap-1.5 rounded-lg border border-white/[0.06] bg-white/[0.03] px-2.5 py-1.5 text-left text-foreground/80 hover:border-white/20"
                onClick={(e) => { e.stopPropagation(); requestOpenCode(f.file, f.line); }}
              >
                <FileCode2 className="h-3.5 w-3.5 shrink-0" />
                {t("blueprint.custom.firedFrom", { file: f.file, line: f.line })}
              </button>
            </li>
          ))}
        </ul>
      )}
      <CustomizationHints area="behavior" />
    </div>
  );
}
