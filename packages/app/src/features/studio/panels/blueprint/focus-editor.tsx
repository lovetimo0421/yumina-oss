import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Check, MessageCircle, BookOpen } from "lucide-react";
import { estimateTokens } from "@yumina/engine";
import { useEditorStore } from "@/stores/editor";
import { DebouncedInput, DebouncedTextarea } from "@/features/editor/components/debounced-field";

/**
 * The big editor. Writing a scene into a 300px block is possible the way
 * writing in a car park is possible — every text row on the board can expand
 * into this: a centred page with a reading-width column, the entry's name as
 * the title, and nothing else on screen asking for attention.
 *
 * One component serves openings and lore alike, because on the board they are
 * the same thing underneath — entries — and the split surfaces (opening
 * textarea, RowEditor body) already commit through the same updateEntry.
 * Edits commit continuously (debounced, IME-safe); Esc or the backdrop just
 * puts the canvas back.
 */
export function FocusEditor({ objId, onClose }: { objId: string; onClose: () => void }) {
  const { t } = useTranslation("editor");
  const entryId = objId.slice(objId.indexOf(":") + 1);
  const entry = useEditorStore((s) => s.worldDraft.entries.find((e) => e.id === entryId));
  const updateEntry = useEditorStore((s) => s.updateEntry);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape inside an IME is the IME's: it drops the candidate, not the page.
      if (e.key !== "Escape" || e.isComposing) return;
      e.stopPropagation();
      // The fields commit on a debounce and flush on blur. A click on Done or
      // the backdrop blurs them on the way; a key does not, so without this
      // the last few hundred milliseconds of typing unmounted unsaved.
      const focused = document.activeElement;
      if (focused instanceof HTMLElement) focused.blur();
      onClose();
    };
    // Capture phase: the stage's own Escape handling must not race this.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  if (!entry) return null;
  const isOpening = entry.role === "greeting";
  const Icon = isOpening ? MessageCircle : BookOpen;

  return (
    <div
      className="absolute inset-0 z-[60] flex items-center justify-center modal-backdrop p-6"
      onClick={onClose}
    >
      <div
        className="flex h-full max-h-[860px] w-[min(860px,94%)] flex-col overflow-hidden rounded-2xl border border-white/[0.08] bg-[#181a24] shadow-[0_24px_80px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-white/[0.07] px-4 py-2.5">
          <Icon className={isOpening ? "h-4 w-4 shrink-0 text-emerald-400" : "h-4 w-4 shrink-0 text-violet-400"} />
          <DebouncedInput
            value={entry.name}
            syncKey={`focus-name-${entry.id}`}
            onCommit={(v) => updateEntry(entry.id, { name: v })}
            placeholder={t("entries.name")}
            className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-foreground focus:outline-none"
          />
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/50">
            ~{estimateTokens(entry.content)} tok
          </span>
          <button
            type="button"
            onClick={onClose}
            title={t("blueprint.rowEdit.close")}
            className="flex shrink-0 items-center gap-1 rounded-md bg-primary/85 px-2.5 py-1 text-[11px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            <Check className="h-3 w-3" />
            {t("blueprint.focus.done")}
          </button>
        </div>
        <DebouncedTextarea
          autoFocus
          value={entry.content}
          syncKey={`focus-body-${entry.id}`}
          onCommit={(v) => updateEntry(entry.id, { content: v })}
          placeholder={t(isOpening ? "blueprint.block.openingPlaceholder" : "blueprint.rowEdit.bodyPlaceholder")}
          className="min-h-0 flex-1 resize-none bg-transparent px-8 py-5 text-[14px] leading-[1.85] text-foreground/90 placeholder:text-muted-foreground/35 focus:outline-none"
        />
        <div className="flex shrink-0 items-center justify-between border-t border-white/[0.06] px-4 py-1.5 text-[10px] text-foreground/35">
          <span>{t("blueprint.focus.autosaves")}</span>
          <span>Esc</span>
        </div>
      </div>
    </div>
  );
}
