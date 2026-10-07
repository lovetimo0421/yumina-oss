import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function blueprintMenuAnchor(event: { clientX: number; clientY: number; detail?: number; type?: string; currentTarget?: EventTarget | null }, container?: { left: number; top: number }) {
  const keyboard = event.detail === 0 && (event.type === "click" || (event.clientX === 0 && event.clientY === 0));
  const keyboardTrigger = keyboard && event.currentTarget instanceof HTMLElement ? event.currentTarget : undefined;
  const bounds = keyboardTrigger?.getBoundingClientRect();
  return {
    x: (bounds?.left ?? event.clientX) - (container?.left ?? 0),
    y: (bounds?.bottom ?? event.clientY) - (container?.top ?? 0),
    ...(keyboardTrigger ? { keyboardTrigger } : {}),
  };
}

/** Menus may cross the canvas edge, including the adjacent inspector. */
export function BlueprintFloatingMenu({ x, y, children, keyboardTrigger, onEscape }: { x: number; y: number; children: ReactNode; keyboardTrigger?: HTMLElement; onEscape?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x, y });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const place = () => {
      const bounds = element.getBoundingClientRect();
      const next = {
        x: Math.max(8, Math.min(x, window.innerWidth - bounds.width - 8)),
        y: Math.max(8, Math.min(y, window.innerHeight - bounds.height - 8)),
      };
      setPosition(current => current.x === next.x && current.y === next.y ? current : next);
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [x, y]);
  useLayoutEffect(() => {
    if (keyboardTrigger) ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [keyboardTrigger]);
  useEffect(() => {
    if (!onEscape) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopPropagation(); onEscape();
      if (keyboardTrigger?.isConnected) keyboardTrigger.focus({ preventScroll: true });
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [keyboardTrigger, onEscape]);
  return createPortal(<div ref={ref} data-blueprint-context-menu className="fixed z-[10000] min-w-[190px] max-w-[calc(100vw-16px)] max-h-[calc(100vh-16px)] studio-pill overflow-auto rounded-xl border py-1 text-foreground" style={{ left: position.x, top: position.y }} onClick={event => event.stopPropagation()} onKeyDown={event => {
    event.stopPropagation();
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (!items.length) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (current + 1) % items.length : (current - 1 + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  }}>{children}</div>, document.body);
}
