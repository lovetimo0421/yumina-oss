import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Pin, Plus } from "lucide-react";
import type { Worldbook } from "@yumina/engine";
import { DebouncedTextarea } from "./debounced-field";

/**
 * The module's sticky note, sized to what it holds.
 *
 * It used to be a two-row amber textarea with a paragraph under it explaining
 * what a note is, on every module, whether or not anyone had written one. A
 * note that exists is shown; one that does not is a small "add" — the
 * explanation lives in the placeholder, where you see it only while writing.
 */
export function ModuleNoteField({ book, onChange }: { book: Worldbook; onChange: (note: string | undefined) => void }) {
  const { t } = useTranslation("editor");
  const [open, setOpen] = useState(false);
  const has = Boolean(book.note?.trim());
  if (!has && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground/70 transition-colors hover:bg-amber-500/10 hover:text-amber-300"
      >
        <Plus className="h-3 w-3" />
        {t("modules.noteAdd")}
      </button>
    );
  }
  return (
    <div className="flex items-start gap-1.5">
      <Pin className="mt-1.5 h-3 w-3 shrink-0 text-amber-400/80" />
      <DebouncedTextarea
        value={book.note ?? ""}
        onCommit={(v) => {
          onChange(v.trim() ? v : undefined);
          if (!v.trim()) setOpen(false);
        }}
        syncKey={book.id}
        rows={has ? Math.min(4, Math.max(1, (book.note ?? "").split("\n").length)) : 2}
        autoFocus={!has}
        placeholder={t("blueprint.insp.notePlaceholder")}
        className="w-full resize-y rounded-md border border-transparent bg-amber-500/[0.06] px-2 py-1 text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/50 hover:border-amber-500/25 focus:border-amber-400/50 focus:outline-none"
      />
    </div>
  );
}
