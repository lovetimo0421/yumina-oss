import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard containment for a hand-rolled modal.
 *
 * A dialog that only looks like a dialog leaves keyboard and screen-reader
 * users behind the page: Tab walks out of it into the editor underneath, and
 * closing it drops focus at the top of the document. The Radix dialogs get this
 * for free; the panels built out of a plain fixed overlay do not.
 *
 * Moves focus into the panel on mount, keeps Tab inside it while it is open,
 * and returns focus to whatever opened it. Pair with `role="dialog"`,
 * `aria-modal` and an `aria-labelledby` on the same element.
 *
 * `active` exists for a stacked confirmation: the panel underneath hands the
 * trap over rather than fighting the one on top for focus.
 */
export function useModalFocus(ref: RefObject<HTMLElement | null>, active = true): void {
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;
    const panel = ref.current;
    if (!panel) return;

    // Duck-typed rather than `instanceof HTMLElement`: this hook runs inside
    // test DOM stubs that provide document and activeElement but no global
    // HTMLElement constructor, and an unguarded instanceof throws a
    // ReferenceError that takes the whole render down. What we need to know is
    // only whether the thing can be focused again later.
    const previous = document.activeElement as HTMLElement | null;
    if (previous && previous !== document.body && typeof previous.focus === "function") {
      returnTo.current = previous;
    }

    const visible = () =>
      Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (element) => element.getClientRects().length > 0,
      );

    if (!panel.contains(document.activeElement)) {
      (visible()[0] ?? panel).focus({ preventScroll: true });
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const targets = visible();
      const first = targets[0];
      const last = targets.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !panel.contains(current))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (current === last || !panel.contains(current))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      const target = returnTo.current;
      returnTo.current = null;
      // Only if it is still on the page and still visible — a control inside a
      // panel that closed with this one is not somewhere to send focus.
      if (target?.isConnected && target.getClientRects().length > 0) {
        target.focus({ preventScroll: true });
      }
    };
  }, [active, ref]);
}
