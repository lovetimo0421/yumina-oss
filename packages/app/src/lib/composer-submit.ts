import { useCallback, useRef } from "react";
import type {
  CompositionEvent as ReactCompositionEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useUiStore } from "@/stores/ui";

/**
 * True when this keydown is part of an in-flight IME composition and must NOT
 * trigger a submit/commit action — e.g. pressing Enter to choose a pinyin
 * candidate (你好) should commit the candidate, not send the message.
 *
 * BOTH checks matter, and `keyCode === 229` is NOT just a legacy fallback:
 * - `nativeEvent.isComposing` catches Chrome/Edge/Firefox, where the commit
 *   Enter's keydown fires while composition is still active.
 * - `keyCode === 229` catches macOS Safari: there `compositionend` fires BEFORE
 *   the keydown, so `isComposing` is already false on the commit Enter — but the
 *   keyCode stays 229 throughout IME processing on every browser/OS tested.
 * For plain ASCII typing both are false, so this is a no-op for non-IME users.
 * (The hook below also tracks a composingRef for the keydown-before-
 * compositionend ordering — same approach as the editor's debounced-field.tsx.)
 */
export function isImeKeydown(e: Pick<ReactKeyboardEvent, "nativeEvent" | "keyCode">): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

/**
 * Whether the device's PRIMARY pointer is coarse (a touch screen used as the
 * main input — phones, tablets). On these, Enter inserts a newline and the user
 * sends with the on-screen button, matching WeChat/Messenger mobile.
 *
 * Deliberately uses `(pointer: coarse)` instead of the old
 * `"ontouchstart" in window || navigator.maxTouchPoints > 0` heuristic, which
 * also fires on touchscreen LAPTOPS (touch points + a physical keyboard) and
 * wrongly disabled Enter-to-send for them. A laptop with a trackpad reports a
 * fine primary pointer, so it keeps Enter-to-send.
 */
export function isTouchPrimary(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

interface ComposerSubmitHandlers {
  onKeyDown: (e: ReactKeyboardEvent) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (e: ReactCompositionEvent) => void;
}

/**
 * IME-safe "press Enter to send" wiring for a message composer. Spread the
 * returned handlers onto the textarea. Behaviour:
 *
 * - Never sends while an IME composition is active (the headline fix).
 * - Touch-primary devices never key-send (use the Send button).
 * - Honors the user's `composerSendKey` preference:
 *     "enter"     → Enter sends, Shift+Enter inserts a newline (Meta default).
 *     "mod-enter" → Ctrl/⌘+Enter sends, plain Enter inserts a newline (WeChat option).
 */
export function useComposerSubmit({ onSubmit }: { onSubmit: () => void }): ComposerSubmitHandlers {
  const composingRef = useRef(false);
  const sendKey = useUiStore((s) => s.composerSendKey);

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key !== "Enter") return;
      // Let the IME commit its candidate — do not send mid-composition.
      if (composingRef.current || isImeKeydown(e)) return;
      // Touch keyboards: Enter = newline, send via the button.
      if (isTouchPrimary()) return;

      if (sendKey === "mod-enter") {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          onSubmit();
        }
        return; // plain Enter / Shift+Enter → newline
      }

      // "enter" mode: Enter sends, Shift+Enter newlines.
      if (!e.shiftKey) {
        e.preventDefault();
        onSubmit();
      }
    },
    [onSubmit, sendKey],
  );

  const onCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);
  const onCompositionEnd = useCallback(() => {
    composingRef.current = false;
  }, []);

  return { onKeyDown, onCompositionStart, onCompositionEnd };
}
