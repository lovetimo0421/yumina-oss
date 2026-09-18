import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

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

  useEffect(() => {
    if (arraysEqual(lastEmittedRef.current, value)) return;
    lastEmittedRef.current = value;
    setRaw(value.join(", "));
  }, [value]);

  // Cancel any pending emit on unmount (blur flushes the common case).
  useEffect(() => () => { if (emitTimerRef.current) clearTimeout(emitTimerRef.current); }, []);

  const emit = (text: string) => {
    const parsed = parseKeywords(text);
    if (!arraysEqual(parsed, lastEmittedRef.current)) {
      lastEmittedRef.current = parsed;
      onChange(parsed);
    }
  };
  const scheduleEmit = (text: string) => {
    if (emitTimerRef.current) clearTimeout(emitTimerRef.current);
    emitTimerRef.current = setTimeout(() => { emitTimerRef.current = null; emit(text); }, 300);
  };
  const flushEmit = (text: string) => {
    if (emitTimerRef.current) { clearTimeout(emitTimerRef.current); emitTimerRef.current = null; }
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
