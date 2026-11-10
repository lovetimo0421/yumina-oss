import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type ComponentPropsWithoutRef,
  type FocusEvent,
} from "react";
import { getEditorDocumentEpoch, useEditorStore } from "@/stores/editor";
import { FLUSH_PENDING_EDITS_EVENT } from "./flush-pending-edits";
export { FLUSH_PENDING_EDITS_EVENT, flushPendingEditorFields } from "./flush-pending-edits";

/** A commit that has been typed but not yet sent to the store, bound to the
 *  callback (and document) that were current when it was typed. */
interface PendingCommit {
  next: string;
  commit: (next: string) => void;
  epoch: number;
}

/** Send a pending commit to the item it was typed into — never to a card
 *  that has replaced it in the meantime. */
export function runPendingCommit(pending: PendingCommit | null): void {
  if (!pending) return;
  if (pending.epoch !== getEditorDocumentEpoch()) return;
  pending.commit(pending.next);
}

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
 * The same captured commit is what runs when the field unmounts or its item
 * changes with text still pending, so those no longer drop the last pause of
 * typing either.
 */
export function useDebouncedFieldCommit<E extends HTMLInputElement | HTMLTextAreaElement>(
  value: string,
  onCommit: (next: string) => void,
  options: { delay?: number; transform?: (raw: string) => string; syncKey?: string; forceSyncKey?: string | number } = {},
) {
  const { delay = 300, transform, syncKey, forceSyncKey } = options;
  const ref = useRef<E>(null);
  const composingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<PendingCommit | null>(null);
  const [local, setLocal] = useState(value);
  const prevSyncKeyRef = useRef(syncKey);

  const cancelPending = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    pendingRef.current = null;
  };
  /** Commit what is waiting on the timer, to the item it was typed into. */
  const flushPending = () => {
    const pending = pendingRef.current;
    cancelPending();
    runPendingCommit(pending);
  };

  // Undo/redo override: a plain worldDraft change is ignored while this field is
  // focused (so typing isn't yanked out), but an explicit undo/redo MUST win or
  // the rollback stays invisible in the field the user is editing — the bug that
  // made Ctrl+Z look dead after fields became debounced.
  const undoEpoch = useEditorStore((s) => s._undoEpoch);
  const prevUndoEpochRef = useRef(undoEpoch);
  const prevForceSyncKeyRef = useRef(forceSyncKey);

  // Resync from the store when the bound value (or the selected item) changes
  // externally — but not while focused/composing, so we don't interrupt typing.
  // The one exception is an undo/redo (undoEpoch bumped): force the resync even
  // when focused, cancelling any pending debounced commit so the stale local
  // text can't get flushed back on top of the rollback.
  useEffect(() => {
    if (undoEpoch !== prevUndoEpochRef.current || forceSyncKey !== prevForceSyncKeyRef.current) {
      prevUndoEpochRef.current = undoEpoch;
      prevForceSyncKeyRef.current = forceSyncKey;
      prevSyncKeyRef.current = syncKey;
      cancelPending();
      composingRef.current = false;
      setLocal(value);
      return;
    }
    if (syncKey !== prevSyncKeyRef.current) {
      // A different item now owns this field. Whatever was typed for the old
      // one goes to the old one, and the box shows the new item even while it
      // has focus: keeping the old text on screen meant the next blur
      // committed it — through the NEW item's onCommit — over the new item.
      prevSyncKeyRef.current = syncKey;
      flushPending();
      composingRef.current = false;
      setLocal(value);
      return;
    }
    const focused = ref.current !== null && document.activeElement === ref.current;
    if (!composingRef.current && !focused) setLocal(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, syncKey, undoEpoch, forceSyncKey]);

  // Unmounting with text still on the timer commits it rather than dropping
  // it: closing a panel or switching tabs within the pause used to lose the
  // last words typed. It goes through the onCommit captured when it was typed,
  // and only if the same card is still open.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => flushPending(), []);

  // Save paths ask every field to commit before they read the store.
  useEffect(() => {
    const onFlush = () => flushPending();
    window.addEventListener(FLUSH_PENDING_EDITS_EVENT, onFlush);
    return () => window.removeEventListener(FLUSH_PENDING_EDITS_EVENT, onFlush);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleCommit = (next: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    pendingRef.current = { next, commit: onCommit, epoch: getEditorDocumentEpoch() };
    timerRef.current = setTimeout(() => {
      const pending = pendingRef.current;
      timerRef.current = null;
      pendingRef.current = null;
      runPendingCommit(pending);
    }, delay);
  };
  const flush = (next: string) => {
    cancelPending();
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
  /** An authoritative snapshot revision, passed together with `value`.
   * Unlike syncKey this overrides a focused field. Canvas nodes use the
   * revision accompanying their data because their props can arrive after
   * this field's direct undo subscription has already seen the new epoch. */
  forceSyncKey?: string | number;
  /** Commit the local buffer before Ctrl/Cmd+S reaches the editor shell.
   * This leaves focus and the selection untouched. */
  flushOnSave?: boolean;
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
  forceSyncKey,
  flushOnSave,
  delay,
  transform,
  onBlur,
  onKeyDown,
  ...rest
}: InputBaseProps & SharedDebouncedProps) {
  const bound = useDebouncedFieldCommit<HTMLInputElement>(value, onCommit, { delay, transform, syncKey, forceSyncKey });
  return (
    <input
      {...rest}
      data-editor-undo=""
      ref={bound.ref}
      value={bound.value}
      onChange={bound.onChange}
      onCompositionStart={bound.onCompositionStart}
      onCompositionEnd={bound.onCompositionEnd}
      onBlur={(e: FocusEvent<HTMLInputElement>) => { bound.onBlur(); onBlur?.(e); }}
      onKeyDown={e => {
        if (flushOnSave && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s" && !e.nativeEvent.isComposing) bound.onBlur();
        onKeyDown?.(e);
      }}
    />
  );
}

/** Debounced, IME-aware `<textarea>`. Drop-in for textareas that previously
 *  called a store setter on every keystroke. Forwards all other textarea props. */
export function DebouncedTextarea({
  value,
  onCommit,
  syncKey,
  forceSyncKey,
  flushOnSave,
  delay,
  transform,
  onBlur,
  onKeyDown,
  ...rest
}: TextareaBaseProps & SharedDebouncedProps) {
  const bound = useDebouncedFieldCommit<HTMLTextAreaElement>(value, onCommit, { delay, transform, syncKey, forceSyncKey });
  return (
    <textarea
      {...rest}
      data-editor-undo=""
      ref={bound.ref}
      value={bound.value}
      onChange={bound.onChange}
      onCompositionStart={bound.onCompositionStart}
      onCompositionEnd={bound.onCompositionEnd}
      onBlur={(e: FocusEvent<HTMLTextAreaElement>) => { bound.onBlur(); onBlur?.(e); }}
      onKeyDown={e => {
        if (flushOnSave && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s" && !e.nativeEvent.isComposing) bound.onBlur();
        onKeyDown?.(e);
      }}
    />
  );
}
