import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent,
  type ComponentPropsWithoutRef,
  type FocusEvent,
  type KeyboardEvent,
} from "react";
import { mergeText, textHunks } from "@yumina/engine";
import { getEditorDocumentEpoch, useEditorStore } from "@/stores/editor";
import { attachLiveText, liveTextActive, type LiveTextHandle } from "@/features/collab/live-text";
import { LiveTextCarets } from "@/features/collab/live-text-carets";
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

/** Where an index lands after `from` became `to` (text before it shifts it). */
function mapIndex(from: string, to: string, index: number): number {
  let shift = 0;
  for (const h of textHunks(from, to)) {
    if (h.start >= index) break;
    if (h.end <= index) shift += h.insert.length - (h.end - h.start);
    else return h.start + shift + h.insert.length;
  }
  return Math.max(0, Math.min(to.length, index + shift));
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
 * and on IME composition end (never mid-composition).
 *
 * The store's value can change while the field is focused — someone else's
 * save, the assistant, a restored version. The field follows it while the
 * person hasn't typed since it last did (the caret stays where it was in the
 * text), and once they have typed, the two are merged (their words and the
 * new ones both stay). Leaving the field commits only what was typed in it:
 * focusing and leaving a field used to write its stale text back over
 * whatever had changed meanwhile.
 *
 * With `sharedKey` (an engine textFieldKey) the field is typed in together:
 * once it is live (features/collab/live-text) it shows and edits the shared
 * text, keystroke by keystroke, with everyone else's carets in it, and the
 * draft follows that text by itself.
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
  options: { delay?: number; transform?: (raw: string) => string; syncKey?: string; forceSyncKey?: string | number; sharedKey?: string } = {},
) {
  const { delay = 300, transform, syncKey, forceSyncKey, sharedKey } = options;
  const ref = useRef<E>(null);
  const composingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<PendingCommit | null>(null);
  const [local, setLocal] = useState(value);
  const localRef = useRef(value);
  localRef.current = local;
  /** The store value the field last took on: what the person started from. */
  const syncedRef = useRef(value);
  const prevSyncKeyRef = useRef(syncKey);
  /** A selection to put back once the new text is on screen. */
  const selectionRef = useRef<[number, number] | null>(null);
  /** The last text this field committed (its echo is not someone else's). */
  const lastCommitRef = useRef<string | null>(null);

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

  // ── typed together ──
  const [live, setLive] = useState<LiveTextHandle | null>(null);
  const liveRef = useRef<LiveTextHandle | null>(null);
  const [bound, setBound] = useState(false);
  const [liveText, setLiveText] = useState("");
  /** What the box shows right now (the DOM), which a keystroke edits. A
   *  remote change can be in the shared text before it is on screen. */
  const shadowRef = useRef("");
  const savedSelectionRef = useRef<ReturnType<LiveTextHandle["saveSelection"]>>(null);
  /** What the box held when its text went into the shared copy (going live). */
  const flushedRef = useRef<string | null>(null);
  /** Whether the box is showing the shared text yet (set before React renders it). */
  const boundRef = useRef(false);
  useEffect(() => {
    if (!sharedKey || !liveTextActive()) return;
    const handle = attachLiveText(sharedKey, {
      flush: () => {
        flushedRef.current = ref.current ? (transform ? transform(ref.current.value) : ref.current.value) : localRef.current;
        flushPending();
      },
      beforeRemote: () => {
        const el = ref.current;
        const h = liveRef.current;
        if (!el || !h || document.activeElement !== el) return;
        savedSelectionRef.current = h.saveSelection(el.selectionStart ?? 0, el.selectionEnd ?? 0);
      },
    });
    if (!handle) return;
    liveRef.current = handle;
    setLive(handle);
    const sync = () => {
      const isLive = handle.live();
      const wasBound = boundRef.current;
      boundRef.current = isLive;
      setBound(isLive);
      if (!isLive) return;
      // Mid-composition the IME owns the box; the shared text waits for it.
      if (composingRef.current) return;
      const el = ref.current;
      if (!wasBound && el) {
        // Going live while the person types: the box may already hold keys
        // typed after its text went into the shared copy. Those go in too,
        // the old path's timer is dropped (they would land twice), and the
        // caret stays after what they typed instead of jumping.
        const shown = transform ? transform(el.value) : el.value;
        const flushed = flushedRef.current;
        flushedRef.current = null;
        cancelPending();
        if (flushed !== null && shown !== flushed) handle.edit(flushed, shown);
        const merged = handle.text();
        shadowRef.current = el.value;
        if (document.activeElement === el && merged !== shown) {
          const start = el.selectionStart ?? shown.length;
          const end = el.selectionEnd ?? start;
          selectionRef.current = [mapIndex(shown, merged, start), mapIndex(shown, merged, end)];
        }
        setLiveText(merged);
        return;
      }
      const text = handle.text();
      setLiveText(text);
      const saved = savedSelectionRef.current;
      savedSelectionRef.current = null;
      if (saved) selectionRef.current = handle.restoreSelection(saved);
    };
    sync();
    const unsubscribe = handle.subscribe(sync);
    if (ref.current && document.activeElement === ref.current) handle.focus();
    return () => {
      unsubscribe();
      handle.release();
      liveRef.current = null;
      boundRef.current = false;
      setLive(null);
      setBound(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharedKey]);

  // Undo/redo override: a plain worldDraft change is merged into a focused
  // field (see above), but an explicit undo/redo MUST win or the rollback stays
  // invisible in the field the user is editing — the bug that made Ctrl+Z look
  // dead after fields became debounced.
  const undoEpoch = useEditorStore((s) => s._undoEpoch);
  const prevUndoEpochRef = useRef(undoEpoch);
  const prevForceSyncKeyRef = useRef(forceSyncKey);

  useEffect(() => {
    if (undoEpoch !== prevUndoEpochRef.current || forceSyncKey !== prevForceSyncKeyRef.current) {
      prevUndoEpochRef.current = undoEpoch;
      prevForceSyncKeyRef.current = forceSyncKey;
      prevSyncKeyRef.current = syncKey;
      cancelPending();
      composingRef.current = false;
      syncedRef.current = value;
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
      syncedRef.current = value;
      setLocal(value);
      return;
    }
    if (value === syncedRef.current) return;
    // Our own commit coming back, or a live field (the shared text is what
    // it shows): nothing to merge.
    if (value === lastCommitRef.current || liveRef.current?.live()) {
      syncedRef.current = value;
      if (liveRef.current?.live()) setLocal(value);
      return;
    }
    const el = ref.current;
    const focused = el !== null && document.activeElement === el;
    if (!focused && !composingRef.current) {
      syncedRef.current = value;
      setLocal(value);
      return;
    }
    // Focused, and the value moved under it (someone else, the assistant).
    // Mid-composition the IME owns the box: catch up when it is done.
    if (composingRef.current) return;
    const mine = localRef.current;
    const typed = mine !== syncedRef.current;
    const next = typed ? mergeText(syncedRef.current, mine, value) : value;
    if (el) {
      const start = el.selectionStart ?? mine.length;
      const end = el.selectionEnd ?? start;
      selectionRef.current = [mapIndex(mine, next, start), mapIndex(mine, next, end)];
    }
    syncedRef.current = value;
    setLocal(next);
    // What was typed and still waiting goes out merged.
    if (pendingRef.current) scheduleCommit(next);
    else if (typed && next !== value) scheduleCommit(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, syncKey, undoEpoch, forceSyncKey]);

  // The caret stays where it was in the text when the text changes around it.
  useLayoutEffect(() => {
    if (liveRef.current?.live() && ref.current && !composingRef.current) shadowRef.current = ref.current.value;
    const sel = selectionRef.current;
    const el = ref.current;
    if (!sel || !el) return;
    selectionRef.current = null;
    if (document.activeElement !== el) return;
    try { el.setSelectionRange(Math.min(sel[0], sel[1]), Math.max(sel[0], sel[1])); } catch { /* not a text input */ }
  });

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
    const commit = onCommit;
    pendingRef.current = { next, commit: (text) => { lastCommitRef.current = text; commit(text); }, epoch: getEditorDocumentEpoch() };
    timerRef.current = setTimeout(() => {
      const pending = pendingRef.current;
      timerRef.current = null;
      pendingRef.current = null;
      runPendingCommit(pending);
    }, delay);
  };
  /** Commit now — only what was typed here (see the hook's doc). */
  const flush = (next: string) => {
    cancelPending();
    if (next !== syncedRef.current && next !== value) { lastCommitRef.current = next; onCommit(next); }
  };

  const compositionBaseRef = useRef("");
  /** The box went from `shown` to `next` under the person's hands: that
   *  change goes into the shared text (with anything that arrived meanwhile),
   *  and the caret stays after what they typed. */
  const applyTyped = (shown: string, next: string) => {
    const handle = liveRef.current;
    if (!handle) return;
    handle.edit(shown, next);
    const text = handle.text();
    shadowRef.current = text;
    const el = ref.current;
    if (text !== next && el) {
      const start = el.selectionStart ?? next.length;
      const end = el.selectionEnd ?? start;
      selectionRef.current = [mapIndex(next, text, start), mapIndex(next, text, end)];
    }
    setLiveText(text);
    sendCaret();
  };

  const sendCaret = () => {
    const el = ref.current;
    if (!el || !liveRef.current || !bound) return;
    liveRef.current.caret(el.selectionDirection === "backward" ? el.selectionEnd ?? 0 : el.selectionStart ?? 0,
      el.selectionDirection === "backward" ? el.selectionStart ?? 0 : el.selectionEnd ?? 0);
  };

  if (bound && live) {
    return {
      ref,
      live,
      value: composingRef.current ? local : liveText,
      onChange: (e: ChangeEvent<E>) => {
        const next = transform ? transform(e.target.value) : e.target.value;
        if (composingRef.current) { setLocal(next); return; }
        applyTyped(shadowRef.current, next);
      },
      onCompositionStart: () => {
        composingRef.current = true;
        compositionBaseRef.current = shadowRef.current;
        setLocal(shadowRef.current);
      },
      onCompositionEnd: (e: CompositionEvent<E>) => {
        composingRef.current = false;
        const raw = (e.target as E).value;
        applyTyped(compositionBaseRef.current, transform ? transform(raw) : raw);
      },
      onFocus: () => { live.focus(); sendCaret(); },
      onBlur: () => { live.blur(); },
      onSelect: () => sendCaret(),
      onKeyDown: (e: KeyboardEvent<E>) => {
        // Each person's Ctrl+Z takes back their own typing here, not the
        // card's last edit (or someone else's words).
        const mod = e.ctrlKey || e.metaKey;
        if (!mod || e.altKey || e.nativeEvent.isComposing) return false;
        const k = e.key.toLowerCase();
        if (k === "z" || k === "y") {
          e.preventDefault();
          e.stopPropagation();
          if (k === "z" && !e.shiftKey) live.undo();
          else live.redo();
          return true;
        }
        return false;
      },
    };
  }

  return {
    ref,
    live,
    value: local,
    onChange: (e: ChangeEvent<E>) => {
      const next = transform ? transform(e.target.value) : e.target.value;
      // Live already, the shared text just isn't on screen yet: this key goes
      // into it, not onto the old path's timer (that copy would be dropped).
      if (boundRef.current && liveRef.current?.live() && !composingRef.current) {
        applyTyped(shadowRef.current, next);
        return;
      }
      setLocal(next);
      // Don't push intermediate IME composition text to the store; commit on end.
      if (!composingRef.current) scheduleCommit(next);
    },
    onCompositionStart: () => { composingRef.current = true; },
    onCompositionEnd: (e: CompositionEvent<E>) => {
      composingRef.current = false;
      const raw = (e.target as E).value;
      let next = transform ? transform(raw) : raw;
      // The value moved while the IME had the box: merge it in now.
      if (value !== syncedRef.current) {
        next = mergeText(syncedRef.current, next, value);
        syncedRef.current = value;
      }
      setLocal(next);
      flush(next);
    },
    onFocus: () => { live?.focus(); },
    onBlur: () => { live?.blur(); flush(localRef.current); },
    onSelect: () => undefined,
    onKeyDown: (_e: KeyboardEvent<E>) => false,
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
  /** Type in this field together with everyone else on the card: the
   *  field's key (engine textFieldKey, e.g. "r:entries:<id>:content"). Its
   *  `onCommit` must write exactly that field. */
  sharedKey?: string;
  /** The field's element, for callers that move its caret themselves. */
  elementRef?: (el: HTMLTextAreaElement | HTMLInputElement | null) => void;
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
  sharedKey,
  elementRef,
  onBlur,
  onFocus,
  onSelect,
  onKeyDown,
  ...rest
}: InputBaseProps & SharedDebouncedProps) {
  const bound = useDebouncedFieldCommit<HTMLInputElement>(value, onCommit, { delay, transform, syncKey, forceSyncKey, sharedKey });
  return (
    <>
      <input
        {...rest}
        // A shared field keeps its own undo (each person's typing); the card's
        // undo shortcut leaves it alone.
        {...(bound.live?.live() ? {} : { "data-editor-undo": "" })}
        ref={(el) => { bound.ref.current = el; elementRef?.(el); }}
        value={bound.value}
        onChange={bound.onChange}
        onCompositionStart={bound.onCompositionStart}
        onCompositionEnd={bound.onCompositionEnd}
        onFocus={(e: FocusEvent<HTMLInputElement>) => { bound.onFocus(); onFocus?.(e); }}
        onBlur={(e: FocusEvent<HTMLInputElement>) => { bound.onBlur(); onBlur?.(e); }}
        onSelect={(e) => { bound.onSelect(); onSelect?.(e); }}
        onKeyDown={e => {
          if (bound.onKeyDown(e)) return;
          if (flushOnSave && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s" && !e.nativeEvent.isComposing) bound.onBlur();
          onKeyDown?.(e);
        }}
      />
      {bound.live && <LiveTextCarets field={bound.live.key} target={bound.ref} />}
    </>
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
  sharedKey,
  elementRef,
  onBlur,
  onFocus,
  onSelect,
  onKeyDown,
  autoGrow,
  ...rest
}: TextareaBaseProps & SharedDebouncedProps & {
  /** Grow with the text (or, empty, with its placeholder) up to `max` px,
   *  scrolling only past that: a box cut off mid-line in a fixed height
   *  reads as broken, and every box that scrolls on its own is one more
   *  place the wheel goes somewhere the eye did not expect. */
  autoGrow?: { max: number };
}) {
  const bound = useDebouncedFieldCommit<HTMLTextAreaElement>(value, onCommit, { delay, transform, syncKey, forceSyncKey, sharedKey });
  const growMax = autoGrow?.max;
  useLayoutEffect(() => {
    const el = bound.ref.current;
    if (!el || growMax === undefined) return;
    const fit = () => {
      el.style.height = "auto";
      let natural = el.scrollHeight;
      // An empty box's placeholder is not counted in its scrollHeight:
      // measure it as if it were the text.
      if (!el.value && el.placeholder) {
        el.value = el.placeholder;
        natural = el.scrollHeight;
        el.value = "";
      }
      const height = Math.min(growMax, natural + (el.offsetHeight - el.clientHeight));
      el.style.height = `${height}px`;
      el.style.overflowY = natural > growMax ? "auto" : "hidden";
    };
    fit();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => fit());
    observer?.observe(el);
    return () => observer?.disconnect();
  }, [bound.value, rest.placeholder, growMax, bound.ref]);
  return (
    <>
      <textarea
        {...rest}
        {...(bound.live?.live() ? {} : { "data-editor-undo": "" })}
        ref={(el) => { bound.ref.current = el; elementRef?.(el); }}
        value={bound.value}
        onChange={bound.onChange}
        onCompositionStart={bound.onCompositionStart}
        onCompositionEnd={bound.onCompositionEnd}
        onFocus={(e: FocusEvent<HTMLTextAreaElement>) => { bound.onFocus(); onFocus?.(e); }}
        onBlur={(e: FocusEvent<HTMLTextAreaElement>) => { bound.onBlur(); onBlur?.(e); }}
        onSelect={(e) => { bound.onSelect(); onSelect?.(e); }}
        onKeyDown={e => {
          if (bound.onKeyDown(e)) return;
          if (flushOnSave && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s" && !e.nativeEvent.isComposing) bound.onBlur();
          onKeyDown?.(e);
        }}
      />
      {bound.live && <LiveTextCarets field={bound.live.key} target={bound.ref} />}
    </>
  );
}
