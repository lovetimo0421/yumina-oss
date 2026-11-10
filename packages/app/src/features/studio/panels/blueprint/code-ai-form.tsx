import { useTranslation } from "react-i18next";
import { FileCode2, SlidersHorizontal, Sparkles } from "lucide-react";
import type { GraphLayout, Worldbook } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { DebouncedTextarea } from "@/features/editor/components/debounced-field";
import { cn } from "@/lib/utils";
import { STUDIO_ASK_EVENT, type StudioAskDetail } from "../../lib/block-ask";
import { codeCallFacts } from "./code-ai-call-card";
import { Field, inputClass } from "./controls";
import { requestOpenCode } from "./customization-hints";
import type { PlaceAiRow } from "./place-ais";
import { NOTE_SIZE } from "./sticky-note-layer";

const NO_BOOKS: Worldbook[] = [];
const NO_ENTRIES: Array<{ worldbookId?: string | null }> = [];
const NO_VARIABLES: Array<{ id: string; name?: string }> = [];

/** The note stuck to exactly this one thing, if there is one. */
function noteOn(layout: GraphLayout | undefined, target: string) {
  return (layout?.notes ?? []).find((n) => (n.targets?.length ? n.targets.length === 1 && n.targets[0] === target : n.on === target));
}

/**
 * An AI the card's interface code runs itself (a call, a live voice), opened
 * like any other AI: what it is, what it reads and answers, as far as the
 * code says, and a line saying what it does. It used to open straight onto
 * the code, a page of TSX in place of the form every other AI has (owner,
 * 10/17).
 *
 * Nothing here changes the code. The line is the note stuck to this row:
 * the creator writes it, or asks the creation assistant to (write_note), and
 * the assistant and outside AIs read it like any other sticky note.
 */
export function CodeAiForm({ row }: { row: PlaceAiRow }) {
  const { t } = useTranslation("editor");
  const books = useEditorStore((s) => s.worldDraft.worldbooks ?? NO_BOOKS);
  const variables = useEditorStore((s) => s.worldDraft.variables ?? NO_VARIABLES);
  const allEntries = useEditorStore((s) => s.worldDraft.entries ?? NO_ENTRIES);
  const files = useEditorStore((s) => s.worldDraft.rootComponent?.files);
  const layout = useEditorStore((s) => s.worldDraft.graphLayout);
  const target = `ai:${row.key}`;
  const note = noteOn(layout, target);
  const voice = row.key.startsWith("voice:");
  const game = row.game;
  const at = row.code ? { file: row.code.file, line: row.code.line } : row.codeAt;
  // A live voice is told the room when the interface updates its context.
  const toldScene = voice && Object.values(files ?? {}).some((src) => typeof src === "string" && /\.updateContext\s*\(/.test(src));
  const facts: Array<[string, string]> = game
    ? [
        [t("blueprint.codeAi.kind"), t("blueprint.codeAi.kindGame")],
        ...(game.gets ? [[t("blueprint.codeAi.gets"), game.gets] as [string, string]] : []),
        ...(game.returns ? [[t("blueprint.codeAi.returns"), game.returns] as [string, string]] : []),
        ...(game.book ? [[t("blueprint.codeCall.lore"), t("blueprint.codeAi.gameBook", { name: books.find((b) => b.id === game.book)?.name ?? game.book, count: allEntries.filter((e) => e.worldbookId === game.book).length })] as [string, string]] : []),
        [t("blueprint.codeCall.model"), t("blueprint.codeCall.modelPlayer")],
        ...(game.where ? [[t("blueprint.codeAi.where"), game.where] as [string, string]] : []),
      ]
    : row.code
    ? codeCallFacts(row.code, books, t, variables)
    : [
        [t("blueprint.codeAi.kind"), t("blueprint.codeAi.kindVoice")],
        [t("blueprint.codeAi.scene"), t(toldScene ? "blueprint.codeAi.sceneYes" : "blueprint.codeAi.sceneNo")],
      ];

  const writeNote = (text: string) => {
    const store = useEditorStore.getState();
    const current = store.worldDraft.graphLayout;
    const notes = [...(current?.notes ?? [])];
    const i = notes.findIndex((n) => n === noteOn(current, target));
    const trimmed = text.trim();
    if (!trimmed) { if (i >= 0) notes.splice(i, 1); }
    else if (i >= 0) notes[i] = { ...notes[i]!, text: trimmed };
    else notes.push({ id: `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, x: 0, y: 0, ...NOTE_SIZE, text: trimmed, targets: [target] });
    store.setGraphLayout({ ...(current ?? { version: 5, nodes: {} }), notes });
  };
  const askAssistant = () => {
    if (!at) return;
    const detail: StudioAskDetail = { prompt: t("blueprint.codeAi.askPrompt", { name: row.name, file: at.file, line: at.line, target }) };
    window.dispatchEvent(new CustomEvent(STUDIO_ASK_EVENT, { detail }));
  };
  // A call can be moved out of the code into an AI on the card (a 界面型 AI
  // the code calls by name), whose model and task are then set here like any
  // other's. A compiled bundle has no source to rewrite: a line of a whole
  // app, 1984's is two million characters.
  const lineLength = row.code ? (files?.[row.code.file]?.split("\n")[row.code.line - 1]?.length ?? 0) : 0;
  const bundled = lineLength > 3000;
  const convert = () => {
    if (!row.code) return;
    const detail: StudioAskDetail = { prompt: t("blueprint.codeAi.convertPrompt", { name: row.name, file: row.code.file, line: row.code.line }) };
    window.dispatchEvent(new CustomEvent(STUDIO_ASK_EVENT, { detail }));
  };

  return (
    <div className="space-y-3" data-code-ai-form={row.key}>
      <p className="text-[11.5px] leading-relaxed text-foreground/60">{game?.book ? t("blueprint.codeAi.gameWhatBook", { name: books.find((b) => b.id === game.book)?.name ?? game.book }) : t(game ? "blueprint.codeAi.gameWhat" : voice ? "blueprint.codeAi.voiceWhat" : "blueprint.codeAi.callWhat")}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-foreground/45">{k}</dt>
            <dd className="min-w-0 break-words text-foreground/85">{v}</dd>
          </div>
        ))}
      </dl>
      <Field label={t("blueprint.codeAi.note")} hint={t("blueprint.codeAi.noteHint")}>
        <DebouncedTextarea
          value={note?.text ?? ""}
          onCommit={writeNote}
          syncKey={target}
          rows={3}
          placeholder={t("blueprint.codeAi.notePlaceholder")}
          data-code-ai-note=""
          className={cn(inputClass, "min-h-[64px] resize-y")}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        {!game && <button
          type="button"
          data-code-ai-ask=""
          onClick={askAssistant}
          className="studio-control inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px] text-foreground/85 hover:text-foreground"
        >
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          {t("blueprint.codeAi.ask")}
        </button>}
        {row.code && !bundled && (
          <button
            type="button"
            data-code-ai-convert=""
            onClick={convert}
            title={t("blueprint.codeAi.convertHint")}
            className="studio-control inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px] text-foreground/85 hover:text-foreground"
          >
            <SlidersHorizontal className="h-3.5 w-3.5 text-primary" />
            {t("blueprint.codeAi.convert")}
          </button>
        )}
        {at && (
          <button
            type="button"
            data-code-ai-open=""
            onClick={() => requestOpenCode(at.file, at.line)}
            className="studio-control inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[11.5px] text-foreground/70 hover:text-foreground"
          >
            <FileCode2 className="h-3.5 w-3.5" />
            {t("blueprint.codeCall.openAt", { file: at.file, line: at.line })}
          </button>
        )}
      </div>
      {row.code && (
        <p className="text-[11px] leading-relaxed text-foreground/45" data-code-ai-convert-note="">
          {t(bundled ? "blueprint.codeAi.convertBundled" : "blueprint.codeAi.convertHint")}
        </p>
      )}
    </div>
  );
}
