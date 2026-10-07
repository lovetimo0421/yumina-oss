import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { getEditorDocumentEpoch } from "@/stores/editor";
import { FLUSH_PENDING_EDITS_EVENT } from "./debounced-field";

const SEPARATOR_RE = /[,，、]/;

function parseKeywords(raw: string): string[] {
  return raw
    .split(SEPARATOR_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface Props {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  className?: string;
  /** When true, renders a <textarea> instead of a single-line <input>. */
  multiline?: boolean;
  /** Show the "Press Enter to add" hint below the input. Default: true. */
  showHint?: boolean;
  /** Override hint text (defaults to t("entries.keywordsEnterHint")). */
  hintText?: string;
}

/**
 * Multi-keyword input. Accepts comma / 逗号 / 顿号 as separators and treats
 * Enter as a shortcut for inserting ", ". Persists the user's raw text so
 * trailing separators stay visible while typing — important because the
 * canonical value (string[]) drops empty fragments.
 */
export function KeywordsInput({
  value,
  onChange,
  placeholder,
  className,
  multiline,
  showHint = true,
  hintText,
}: Props) {
  const { t } = useTranslation("editor");
  const [raw, setRaw] = useState(() => value.join(", "));
  // Track which array we last emitted so external changes (e.g., switching
  // entries) re-sync the visible text without clobbering in-flight edits.
  const lastEmittedRef = useRef(value);
  // PERF: the text echo (`raw`) stays instant, but the onChange commit — which
  // writes the whole-world store and re-renders the editor — is debounced so it
  // fires ~once per typing pause instead of on every keystroke. On large worlds
  // that's the difference between smooth and multi-second-laggy typing. We flush
  // immediately on blur, Enter, and IME composition end so nothing is lost.
  const composingRef = useRef(false);
  const emitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // What the timer will emit, bound to the emit (and so the onChange) of the
  // render it was typed in and to the open card — see the unmount flush below.
  const pendingRef = useRef<{ text: string; emit: (text: string) => void; epoch: number } | null>(null);
  const flushPending = () => {
    if (emitTimerRef.current) { clearTimeout(emitTimerRef.current); emitTimerRef.current = null; }
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (pending && pending.epoch === getEditorDocumentEpoch()) pending.emit(pending.text);
  };

  useEffect(() => {
    if (arraysEqual(lastEmittedRef.current, value)) return;
    // Text still on the timer belongs to what was being edited before this
    // value arrived (another entry, usually): send it there first, while
    // lastEmittedRef still describes that entry.
    flushPending();
    lastEmittedRef.current = value;
    setRaw(value.join(", "));
  }, [value]);

  // Unmounting inside the pause emits what was typed instead of dropping it
  // (blur covers the common case, but closing the panel does not blur first).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => flushPending(), []);

  // Save paths ask every debounced field to commit before reading the store.
  useEffect(() => {
    const onFlush = () => flushPending();
    window.addEventListener(FLUSH_PENDING_EDITS_EVENT, onFlush);
    return () => window.removeEventListener(FLUSH_PENDING_EDITS_EVENT, onFlush);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = (text: string) => {
    const parsed = parseKeywords(text);
    if (!arraysEqual(parsed, lastEmittedRef.current)) {
      lastEmittedRef.current = parsed;
      onChange(parsed);
    }
  };
  const scheduleEmit = (text: string) => {
    if (emitTimerRef.current) clearTimeout(emitTimerRef.current);
    pendingRef.current = { text, emit, epoch: getEditorDocumentEpoch() };
    emitTimerRef.current = setTimeout(flushPending, 300);
  };
  const flushEmit = (text: string) => {
    if (emitTimerRef.current) { clearTimeout(emitTimerRef.current); emitTimerRef.current = null; }
    pendingRef.current = null;
    emit(text);
  };
  // Update the visible text now; defer the store commit (unless mid-IME).
  const commit = (next: string) => {
    setRaw(next);
    if (!composingRef.current) scheduleEmit(next);
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (e.key !== "Enter") return;
    if (multiline && e.shiftKey) return;
    e.preventDefault();
    const cur = raw;
    if (!cur || SEPARATOR_RE.test(cur.slice(-1)) || /[,，、]\s+$/.test(cur)) return;
    // Enter is an explicit "add" — commit the separator and flush right away.
    const next = cur.replace(/\s+$/, "") + ", ";
    setRaw(next);
    flushEmit(next);
  };

  const sharedProps = {
    value: raw,
    onChange: (
      e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => commit(e.target.value),
    onKeyDown: handleKeyDown,
    onCompositionStart: () => { composingRef.current = true; },
    onCompositionEnd: (
      e: React.CompositionEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      composingRef.current = false;
      const v = (e.target as HTMLInputElement | HTMLTextAreaElement).value;
      setRaw(v);
      scheduleEmit(v);
    },
    onBlur: () => flushEmit(raw),
    placeholder,
    className: cn(
      "w-full rounded-xl border border-border bg-card px-4 py-3 text-sm text-foreground shadow-inner transition-all placeholder:text-muted-foreground/30 focus:border-primary/50 focus:outline-none focus:ring-1 focus:ring-primary/50",
      className,
    ),
  };

  const hint = showHint ? (hintText ?? t("entries.keywordsEnterHint")) : null;

  return (
    <div className="space-y-1.5">
      {multiline ? (
        <textarea {...sharedProps} rows={2} />
      ) : (
        <input type="text" {...sharedProps} />
      )}
      {hint && (
        <p className="text-[11px] text-muted-foreground/50">{hint}</p>
      )}
    </div>
  );
}
