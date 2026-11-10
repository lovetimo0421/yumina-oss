import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import type { WorldEntry } from "@yumina/engine";
import { UI_RULES_ENTRY_ID } from "@yumina/engine";
import { cn } from "@/lib/utils";
import { useEditorStore } from "@/stores/editor";
import { IGNORE_ATTR } from "./hit-test";
import type { Rect } from "./use-inspector";

/**
 * Prototype pieces for the screen-first Studio (?screen=1).
 *
 * The idea is Google Slides': what you edit is what the player sees. The
 * opening is typed into the opening where it shows on the screen, and what
 * the player never sees — the setting the AI reads — sits under the screen,
 * the way speaker notes sit under a slide.
 */

/** A text box laid over the opening on the screen. Enter a new line with
 *  Enter; Ctrl/⌘+Enter or a click away keeps it; Esc puts it back. */
export function OpeningOnScreenEditor({ entryId, rect, onDone }: {
  entryId: string;
  rect: Rect;
  onDone: () => void;
}) {
  const { t } = useTranslation("editor");
  const entry = useEditorStore((s) => s.worldDraft.entries.find((e) => e.id === entryId));
  const updateEntry = useEditorStore((s) => s.updateEntry);
  const [text, setText] = useState(entry?.content ?? "");
  const box = useRef<HTMLTextAreaElement | null>(null);
  const done = useRef(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  // Grow with the text, so what is being typed is never scrolled out of view.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(rect.height + 24, el.scrollHeight)}px`;
  }, [text, rect.height]);

  const finish = (keep: boolean) => {
    if (done.current) return;
    done.current = true;
    if (keep && entry && text !== entry.content) updateEntry(entryId, { content: text });
    onDone();
  };

  if (!entry) return null;
  return (
    <div
      {...{ [IGNORE_ATTR]: "" }}
      className="pointer-events-auto absolute z-20 flex flex-col gap-1"
      style={{ left: rect.left + 8, top: rect.top, width: Math.max(260, rect.width - 16) }}
    >
      <textarea
        ref={box}
        id="screen-first-opening"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
        }}
        className="w-full resize-none rounded-lg border border-primary/70 bg-[#15131d]/95 p-3 text-[14px] leading-relaxed text-foreground shadow-[0_12px_40px_rgba(0,0,0,0.55)] outline-none"
      />
      <span className="self-end rounded-md bg-[#15131d]/90 px-2 py-0.5 text-[10.5px] text-muted-foreground">
        {t("studio.screenFirst.openingKeys")}
      </span>
    </div>
  );
}

/** The dashed ring and label that say "this is the opening, click to change
 *  it" while the pointer is over it. */
export function OpeningHoverRing({ rect }: { rect: Rect }) {
  const { t } = useTranslation("editor");
  return (
    <div className="pointer-events-none absolute z-10 rounded-lg border border-dashed border-primary/80" style={rect}>
      <span className="absolute -top-[22px] left-0 whitespace-nowrap rounded-md bg-primary px-2 py-0.5 text-[10.5px] font-semibold text-primary-foreground">
        {t("studio.screenFirst.editOpening")}
      </span>
    </div>
  );
}

/** What the notes hold: the card's own writing that is not an opening, not an
 *  official preset and not a rule the interface keeps for itself. */
export function settingEntries(entries: WorldEntry[]): WorldEntry[] {
  return entries
    .filter((e) => e.role !== "greeting" && !e.presetId && e.id !== UI_RULES_ENTRY_ID && !e.tags?.includes("ui-rules"))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
}

/**
 * The setting, under the screen. Each entry is a card: a name and its text,
 * nothing else — when it is read and where it goes are in 更多设置.
 */
export function StoryNotes({ readOnly }: { readOnly: boolean }) {
  const { t } = useTranslation("editor");
  const entries = useEditorStore((s) => s.worldDraft.entries);
  const addEntry = useEditorStore((s) => s.addEntry);
  const settings = settingEntries(entries);
  const [open, setOpen] = useState(true);
  const [fresh, setFresh] = useState<string | null>(null);
  const known = useRef(new Set(settings.map((e) => e.id)));

  // A card added from here gets the caret.
  useEffect(() => {
    const added = settings.find((e) => !known.current.has(e.id));
    known.current = new Set(settings.map((e) => e.id));
    if (added) setFresh(added.id);
  }, [settings]);

  return (
    <div data-testid="story-notes" className="flex shrink-0 flex-col border-t border-white/[0.07] bg-[#0f0d14]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-2 px-4 py-2 text-left"
      >
        <span className="text-xs font-semibold text-foreground">{t("studio.screenFirst.notesTitle")}</span>
        <span className="text-[11px] text-muted-foreground">{t("studio.screenFirst.notesHint")}</span>
        <span className="ml-auto text-muted-foreground">{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}</span>
      </button>
      {open && (
        <div className="flex gap-3 overflow-x-auto px-4 pb-3" style={{ scrollbarWidth: "thin" }}>
          {settings.map((entry) => (
            <NoteCard key={entry.id} entry={entry} readOnly={readOnly} autoFocus={fresh === entry.id} />
          ))}
          {!readOnly && (
            <button
              type="button"
              onClick={() => addEntry("custom", "system-presets", { content: "" })}
              className="flex h-[168px] w-[180px] shrink-0 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-white/15 text-xs text-muted-foreground transition-colors hover:border-primary/60 hover:text-foreground"
            >
              <Plus className="h-4 w-4" />
              {t("studio.screenFirst.addNote")}
              <span className="px-4 text-center text-[10.5px] text-muted-foreground/70">{t("studio.screenFirst.addNoteHint")}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NoteCard({ entry, readOnly, autoFocus }: { entry: WorldEntry; readOnly: boolean; autoFocus: boolean }) {
  const { t } = useTranslation("editor");
  const updateEntry = useEditorStore((s) => s.updateEntry);
  const [name, setName] = useState(entry.name ?? "");
  const [text, setText] = useState(entry.content ?? "");
  const nameBox = useRef<HTMLInputElement | null>(null);
  // Someone else (the assistant, the canvas) changed it: show theirs.
  useEffect(() => { setName(entry.name ?? ""); }, [entry.name]);
  useEffect(() => { setText(entry.content ?? ""); }, [entry.content]);
  // A new card arrives with a placeholder name: selected, so typing replaces it.
  useEffect(() => { if (autoFocus) { nameBox.current?.focus(); nameBox.current?.select(); } }, [autoFocus]);

  return (
    <div className={cn("flex h-[168px] w-[300px] shrink-0 flex-col gap-1.5 rounded-lg border border-white/10 bg-[#17151e] p-2.5", entry.enabled === false && "opacity-60")}>
      <input
        ref={nameBox}
        id={`note-name-${entry.id}`}
        value={name}
        readOnly={readOnly}
        placeholder={t("studio.screenFirst.noteNamePlaceholder")}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => { if (name !== (entry.name ?? "")) updateEntry(entry.id, { name }); }}
        className="w-full bg-transparent text-[13px] font-semibold text-foreground outline-none placeholder:text-muted-foreground/50"
      />
      <textarea
        id={`note-text-${entry.id}`}
        value={text}
        readOnly={readOnly}
        placeholder={t("studio.screenFirst.noteTextPlaceholder")}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (text !== (entry.content ?? "")) updateEntry(entry.id, { content: text }); }}
        className="min-h-0 w-full flex-1 resize-none bg-transparent text-[12.5px] leading-relaxed text-foreground/85 outline-none placeholder:text-muted-foreground/50"
      />
    </div>
  );
}
