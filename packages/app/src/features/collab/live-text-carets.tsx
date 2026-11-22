import { useEffect, useMemo, useReducer, type ReactElement, type RefObject } from "react";
import { createPortal } from "react-dom";
import { peerColor } from "./collab-store";
import { absPos, subscribeLiveText, useLiveCaretStore, type RemoteCaret } from "./live-text";

/**
 * Everyone else's caret and selection inside one text field, with their name,
 * and a small face on the field's corner — Google Docs style. Drawn over the
 * field (not inside it: a textarea can't hold markup), at positions measured
 * with a hidden copy of the field laid out the same way.
 */
export function LiveTextCarets({ field, target }: { field: string; target: RefObject<HTMLInputElement | HTMLTextAreaElement | null> }) {
  const all = useLiveCaretStore((s) => s.carets);
  const here = useMemo(() => Object.values(all).filter((c) => c.field === field), [all, field]);
  const [, redraw] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (here.length === 0) return;
    let frame = 0;
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; redraw(); }); };
    const unsubscribe = subscribeLiveText(field, schedule);
    const el = target.current;
    el?.addEventListener("input", schedule);
    el?.addEventListener("scroll", schedule);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver !== "undefined" && el ? new ResizeObserver(schedule) : null;
    if (el) observer?.observe(el);
    // Layout around the field can move it without an event we hear.
    const poll = setInterval(schedule, 700);
    return () => {
      unsubscribe();
      el?.removeEventListener("input", schedule);
      el?.removeEventListener("scroll", schedule);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
      clearInterval(poll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [field, target, here.length]);

  const el = target.current;
  if (here.length === 0 || !el || typeof document === "undefined" || !el.isConnected) return null;
  const box = el.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return null;
  const people = new Map<string, RemoteCaret>();
  for (const c of here) people.set(c.userId, c);

  const marks: ReactElement[] = [];
  for (const c of here) {
    const head = absPos(field, c.head);
    if (head === null) continue;
    const anchor = absPos(field, c.anchor) ?? head;
    const color = peerColor(c.userId);
    const measured = measure(el, [Math.min(anchor, head), Math.max(anchor, head), head]);
    if (!measured) continue;
    const [start, end, caret] = measured;
    if (anchor !== head) {
      for (const [i, r] of selectionRects(el, start!, end!).entries()) {
        marks.push(<div key={`${c.clientId}-sel-${i}`} style={{ position: "absolute", left: r.left, top: r.top, width: r.width, height: r.height, background: color, opacity: 0.18, pointerEvents: "none" }} />);
      }
    }
    marks.push(
      <div key={`${c.clientId}-caret`} style={{ position: "absolute", left: caret!.left - 1, top: caret!.top, width: 2, height: caret!.height, background: color, pointerEvents: "none" }}>
        <span
          data-live-caret-name=""
          style={{
            position: "absolute", left: 0, ...(caret!.top < 14 ? { top: caret!.height } : { bottom: caret!.height }),
            whiteSpace: "nowrap", fontSize: 10, lineHeight: "14px", padding: "0 4px", borderRadius: 3,
            background: color, color: "#fff", fontWeight: 600, fontFamily: "system-ui, sans-serif",
          }}
        >
          {c.name}
        </span>
      </div>,
    );
  }

  return createPortal(
    <>
      <div
        aria-hidden
        style={{
          position: "fixed", left: box.left, top: box.top, width: box.width, height: box.height,
          overflow: "hidden", pointerEvents: "none", zIndex: 45,
        }}
      >
        {marks}
      </div>
      <div aria-hidden style={{ position: "fixed", left: box.right - 6, top: box.top - 9, transform: "translateX(-100%)", display: "flex", gap: 2, pointerEvents: "none", zIndex: 46 }}>
        {[...people.values()].slice(0, 4).map((c) => (
          <span
            key={c.userId}
            title={c.name}
            data-live-field-editor={c.name}
            style={{
              width: 18, height: 18, borderRadius: 9, background: peerColor(c.userId), color: "#fff",
              fontSize: 10, fontWeight: 700, display: "inline-flex", alignItems: "center", justifyContent: "center",
              border: "2px solid var(--background, #fff)", fontFamily: "system-ui, sans-serif",
            }}
          >
            {(c.name || "?").slice(0, 1).toUpperCase()}
          </span>
        ))}
      </div>
    </>,
    document.body,
  );
}

type Spot = { left: number; top: number; height: number };

const COPIED = [
  "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderStyle",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "fontStretch", "lineHeight",
  "letterSpacing", "wordSpacing", "textTransform", "textIndent", "tabSize", "textAlign", "direction",
  "overflowWrap", "wordBreak",
] as const;

/**
 * Where text positions sit inside the field, relative to its border box as
 * the viewer sees it (scrolled): a hidden copy of the field with the same box
 * and font, holding the text up to each position and a marker after it.
 */
function measure(el: HTMLInputElement | HTMLTextAreaElement, indices: number[]): Spot[] | null {
  const style = window.getComputedStyle(el);
  const mirror = document.createElement("div");
  const isInput = el.tagName === "INPUT";
  for (const prop of COPIED) (mirror.style as unknown as Record<string, string>)[prop] = style[prop as keyof CSSStyleDeclaration] as string;
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-99999px";
  mirror.style.overflow = "hidden";
  mirror.style.height = "auto";
  mirror.style.whiteSpace = isInput ? "pre" : "pre-wrap";
  if (!isInput) mirror.style.overflowWrap = style.overflowWrap || "break-word";
  // A textarea's scrollbar takes width from its text.
  if (!isInput) mirror.style.width = `${el.clientWidth + parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)}px`;
  document.body.appendChild(mirror);
  try {
    const text = el.value;
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3 || 16;
    const borderLeft = parseFloat(style.borderLeftWidth) || 0;
    const borderTop = parseFloat(style.borderTopWidth) || 0;
    const out: Spot[] = [];
    for (const index of indices) {
      const at = Math.max(0, Math.min(index, text.length));
      mirror.textContent = text.slice(0, at);
      const marker = document.createElement("span");
      marker.textContent = text.slice(at) || ".";
      mirror.appendChild(marker);
      // Offsets run from inside the copy's border; the overlay starts at the
      // field's border box. An input centres its one line.
      out.push({
        left: marker.offsetLeft + borderLeft - el.scrollLeft,
        top: isInput ? borderTop + (el.clientHeight - lineHeight) / 2 : marker.offsetTop + borderTop - el.scrollTop,
        height: lineHeight,
      });
    }
    return out;
  } catch {
    return null;
  } finally {
    mirror.remove();
  }
}

/** Highlight boxes for a selection from `a` to `b` (line by line). */
function selectionRects(el: HTMLInputElement | HTMLTextAreaElement, a: Spot, b: Spot) {
  const style = window.getComputedStyle(el);
  const left = parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth);
  const right = el.clientWidth + parseFloat(style.borderLeftWidth) - parseFloat(style.paddingRight);
  if (Math.abs(a.top - b.top) < 1) return [{ left: a.left, top: a.top, width: Math.max(2, b.left - a.left), height: a.height }];
  const rects = [{ left: a.left, top: a.top, width: Math.max(2, right - a.left), height: a.height }];
  if (b.top - (a.top + a.height) > 1) rects.push({ left, top: a.top + a.height, width: right - left, height: b.top - (a.top + a.height) });
  rects.push({ left, top: b.top, width: Math.max(2, b.left - left), height: b.height });
  return rects;
}
