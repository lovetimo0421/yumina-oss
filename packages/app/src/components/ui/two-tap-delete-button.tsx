import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Two-tap destructive confirm (community request, @noxrift): the first
 * activation ARMS the control instead of deleting, the second one deletes.
 * Chosen over a dialog because most delete affordances in the editor are small
 * inline buttons and the reporter's failure mode is a stray tap on mobile —
 * arming absorbs the stray tap, and a second deliberate tap is exactly the
 * cost a real delete should have.
 *
 * Disarms on blur, and on a timeout as a mobile fallback — a tap elsewhere
 * doesn't reliably blur a button on iOS, so without the timer a stray tap
 * could leave the control silently armed minutes before an unrelated tap
 * lands on it.
 */
const DISARM_MS = 4000;

export function useTwoTapConfirm(onConfirm: () => void) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const disarm = useCallback(() => {
    clearTimeout(timerRef.current);
    setArmed(false);
  }, []);

  const fire = useCallback(() => {
    if (!armed) {
      setArmed(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setArmed(false), DISARM_MS);
      return;
    }
    disarm();
    onConfirm();
  }, [armed, disarm, onConfirm]);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  return { armed, fire, disarm };
}

/**
 * Drop-in two-tap delete button. Keeps whatever look the call site gives it
 * via `className`; while armed, `armedClassName` (default: solid destructive)
 * is appended and `armedChildren`/`armedTitle` replace the resting content —
 * icon-only call sites at minimum get the color flip plus an accessible-name
 * change.
 *
 * Renderable inside `.map()` rows (unlike the bare hook). Clicks do not
 * bubble: every current call site is a row/card whose container has its own
 * onClick, and arming must never also select/navigate the row.
 */
export function TwoTapDeleteButton({
  onConfirm,
  className,
  armedClassName = "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  title,
  armedTitle,
  children,
  armedChildren,
  disabled,
}: {
  onConfirm: () => void;
  className?: string;
  /** Appended while armed; pass "" to keep the resting look. */
  armedClassName?: string;
  title?: string;
  /** Accessible name while armed, e.g. t("twoTapConfirm"). Falls back to title. */
  armedTitle?: string;
  children: React.ReactNode;
  /** Rendered while armed, e.g. a "tap again" label. Falls back to children. */
  armedChildren?: React.ReactNode;
  disabled?: boolean;
}) {
  const { armed, fire, disarm } = useTwoTapConfirm(onConfirm);
  const effectiveTitle = armed ? (armedTitle ?? title) : title;
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        fire();
      }}
      onBlur={disarm}
      className={cn(className, armed && armedClassName)}
      title={effectiveTitle}
      aria-label={effectiveTitle}
    >
      {armed ? (armedChildren ?? children) : children}
    </button>
  );
}
