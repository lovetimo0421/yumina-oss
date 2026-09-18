import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type ComponentPropsWithoutRef,
  type FocusEvent,
} from "react";
import { useEditorStore } from "@/stores/editor";

/**
 * Shared "type into local state, commit on a debounced pause" logic — extracted
 * from the entry content textarea (the original fix for multi-second typing lag).
 *
 * Why this exists: every editable field used to bind `value` straight to the
 * global editor store and call its store setter on EVERY keystroke. Each setter
 * rebuilds the whole-world object and re-renders the editor, so on a large world
 * (hundreds of entries) a single character could cost hundreds of ms — and a
 * Chinese IME fires several composition events per character, multiplying it.
 *
 * With this hook each keystroke is a cheap local `setState`; the store is
 * committed only ~once per typing pause (default 300ms), immediately on blur,
 * and on IME composition end (never mid-composition). It resyncs from the store
 * when the bound value changes externally (selection switch, agent edit, undo) —
 * but never while the field is focused/composing, so it won't yank text out from
 * under the user mid-type.
 *
 * Closure note: `scheduleCommit`/`flush` capture the CURRENT `onCommit` at call
 * time. If the component is reused for a different item before a pending timer
 * fires, that timer still commits via the onCommit captured when it was
 * scheduled — i.e. to the item being edited, not the new one. This is the
 * correct, regression-safe behavior and matches the original content textarea.
 */
export function useDebouncedFieldCommit<E extends HTMLInputElement | HTMLTextAreaElement>(
  value: string,
  onCommit: (next: string) => void,
  options: { delay?: number; transform?: (raw: string) => string; syncKey?: string } = {},
) {
  const { delay = 300, transform, syncKey } = options;
  const ref = useRef<E>(null);
  const composingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [local, setLocal] = useState(value);

  // Undo/redo override: a plain worldDraft change is ignored while this field is
  // focused (so typing isn't yanked out), but an explicit undo/redo MUST win or
  // the rollback stays invisible in the field the user is editing — the bug that
  // made Ctrl+Z look dead after fields became debounced.
  const undoEpoch = useEditorStore((s) => s._undoEpoch);
  const prevUndoEpochRef = useRef(undoEpoch);

  // Resync from the store when the bound value (or the selected item) changes
  // externally — but not while focused/composing, so we don't interrupt typing.
  // The one exception is an undo/redo (undoEpoch bumped): force the resync even
  // when focused, cancelling any pending debounced commit so the stale local
  // text can't get flushed back on top of the rollback.
  useEffect(() => {
    if (undoEpoch !== prevUndoEpochRef.current) {
      prevUndoEpochRef.current = undoEpoch;
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      composingRef.current = false;
      setLocal(value);
      return;
    }
    const focused = ref.current !== null && document.activeElement === ref.current;
    if (!composingRef.current && !focused) setLocal(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, syncKey, undoEpoch]);

  // Cancel any pending commit on unmount (mirrors the original; blur flushes the
  // common case). Only clears the timer — never calls onCommit — so there is no
  // stale-closure risk.
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const scheduleCommit = (next: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onCommit(next);
    }, delay);
  };
  const flush = (next: string) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (next !== value) onCommit(next);
  };

  return {
    ref,
    value: local,
    onChange: (e: ChangeEvent<E>) => {
      const next = transform ? transform(e.target.value) : e.target.value;
      setLocal(next);
      // Don't push intermediate IME composition text to the store; commit on end.
      if (!composingRef.current) scheduleCommit(next);
    },
    onCompositionStart: () => { composingRef.current = true; },
    onCompositionEnd: (e: CompositionEvent<E>) => {
      composingRef.current = false;
      const raw = (e.target as E).value;
      const next = transform ? transform(raw) : raw;
      setLocal(next);
      flush(next);
    },
    onBlur: () => flush(local),
  };
}

type InputBaseProps = Omit<ComponentPropsWithoutRef<"input">, "value" | "onChange">;
type TextareaBaseProps = Omit<ComponentPropsWithoutRef<"textarea">, "value" | "onChange">;

interface SharedDebouncedProps {
  /** The committed value from the store. */
  value: string;
  /** Called with the new value once per debounced pause / on blur / IME end. */
  onCommit: (next: string) => void;
  /** Force a resync when the edited item changes (e.g. the selected entry id). */
  syncKey?: string;
  /** Debounce delay in ms (default 300). */
  delay?: number;
  /** Optional per-keystroke transform applied before display + commit (e.g. id sanitization). */
  transform?: (raw: string) => string;
}

/** Debounced, IME-aware `<input>`. Drop-in for inputs that previously called a
 *  store setter on every keystroke. Forwards all other input props. */
export function DebouncedInput({
  value,
  onCommit,
  syncKey,
  delay,
  transform,
  onBlur,
  ...rest
}: InputBaseProps & SharedDebouncedProps) {
  const bound = useDebouncedFieldCommit<HTMLInputElement>(value, onCommit, { delay, transform, syncKey });
  return (
    <input
      {...rest}
      ref={bound.ref}
      value={bound.value}
      onChange={bound.onChange}
      onCompositionStart={bound.onCompositionStart}
      onCompositionEnd={bound.onCompositionEnd}
      onBlur={(e: FocusEvent<HTMLInputElement>) => { bound.onBlur(); onBlur?.(e); }}
    />
  );
}

/** Debounced, IME-aware `<textarea>`. Drop-in for textareas that previously
 *  called a store setter on every keystroke. Forwards all other textarea props. */
export function DebouncedTextarea({
  value,
  onCommit,
  syncKey,
  delay,
  transform,
  onBlur,
  ...rest
}: TextareaBaseProps & SharedDebouncedProps) {
  const bound = useDebouncedFieldCommit<HTMLTextAreaElement>(value, onCommit, { delay, transform, syncKey });
  return (
    <textarea
      {...rest}
      ref={bound.ref}
      value={bound.value}
      onChange={bound.onChange}
      onCompositionStart={bound.onCompositionStart}
      onCompositionEnd={bound.onCompositionEnd}
      onBlur={(e: FocusEvent<HTMLTextAreaElement>) => { bound.onBlur(); onBlur?.(e); }}
    />
  );
}
