import { useEffect } from "react";
import { AI_FOLLOW_EVENT, AI_PRESENCE_EVENT, type AiPresence } from "./lib/agent-job";
import { focusTargetSelector, useAiFocus } from "./lib/ai-focus";

/**
 * Where the assistant is working, marked on the canvas itself: the block it
 * is changing glows and carries a tag saying what it is doing, the way a
 * collaborator's cursor shows in a shared document. The mark is an attribute
 * on the block's own element, so it moves, zooms and scrolls with it.
 */

const STYLE_ID = "yumina-ai-presence-style";
const CSS = `
[data-ai-presence] {
  outline: 2px solid var(--color-primary);
  outline-offset: 5px;
  box-shadow: 0 0 0 7px color-mix(in srgb, var(--color-primary) 14%, transparent), 0 0 36px color-mix(in srgb, var(--color-primary) 40%, transparent);
  animation: yumina-ai-presence 1.8s ease-in-out infinite;
}
[data-ai-presence]::before {
  content: attr(data-ai-presence);
  position: absolute; left: -2px; top: -34px; z-index: 30;
  padding: 2px 10px 2px 22px; border-radius: 999px;
  background: var(--color-primary); color: #17140e;
  font-size: 12px; font-weight: 700; line-height: 20px; white-space: nowrap;
  pointer-events: none;
}
[data-ai-presence]::after {
  content: ""; position: absolute; left: 7px; top: -27px; z-index: 31;
  width: 7px; height: 7px; border-radius: 50%; background: #17140e;
  animation: yumina-ai-presence-dot 1s ease-in-out infinite;
  pointer-events: none;
}
@keyframes yumina-ai-presence { 50% { outline-color: color-mix(in srgb, var(--color-primary) 55%, transparent); } }
@keyframes yumina-ai-presence-dot { 50% { opacity: .25; } }
[data-ai-focus] {
  outline: 2px dashed color-mix(in srgb, var(--color-primary) 85%, transparent);
  outline-offset: 4px;
}
/* On the board the pick is already lit gold on the row itself, and what the
   assistant gets is exactly what is picked: a second, dashed ring around it
   (and around its whole block) only doubled the mark. */
.react-flow [data-ai-focus] { outline: none; }
@media (prefers-reduced-motion: reduce) { [data-ai-presence], [data-ai-presence]::after { animation: none; } }
`;

export function AiPresenceLayer() {
  const focusItems = useAiFocus((s) => s.items);
  // What the creator pointed the assistant at: a dashed mark, quieter than
  // the glow of where the assistant is working.
  useEffect(() => {
    const apply = () => {
      const wanted = new Map<Element, string>();
      focusItems.forEach((item) => {
        document.querySelectorAll(focusTargetSelector(item.id)).forEach((el) => wanted.set(el, ""));
      });
      document.querySelectorAll("[data-ai-focus]").forEach((el) => { if (!wanted.has(el)) el.removeAttribute("data-ai-focus"); });
      wanted.forEach((label, el) => {
        if (el.getAttribute("data-ai-focus") === label) return;
        el.setAttribute("data-ai-focus", label);
        if (el instanceof HTMLElement && getComputedStyle(el).position === "static") el.style.position = "relative";
      });
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      document.querySelectorAll("[data-ai-focus]").forEach((el) => el.removeAttribute("data-ai-focus"));
    };
  }, [focusItems]);

  useEffect(() => {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    let current: AiPresence | null = null;
    const clear = () => document.querySelectorAll("[data-ai-presence]").forEach((el) => el.removeAttribute("data-ai-presence"));
    const apply = () => {
      if (!current) return;
      const targets = Array.isArray(current.target) ? current.target : [current.target];
      let el: HTMLElement | null = null;
      for (const selector of targets) { el = document.querySelector<HTMLElement>(selector); if (el) break; }
      if (el && el.getAttribute("data-ai-presence") !== current.label) {
        clear();
        el.setAttribute("data-ai-presence", current.label);
        if (getComputedStyle(el).position === "static") el.style.position = "relative";
        // A glow below the fold is a glow nobody sees: the board follows.
        const nodeId = el.closest(".react-flow__node")?.getAttribute("data-id");
        if (nodeId) window.dispatchEvent(new CustomEvent(AI_FOLLOW_EVENT, { detail: { nodeId } }));
      }
    };
    const onPresence = (event: Event) => {
      current = (event as CustomEvent<AiPresence | null>).detail ?? null;
      if (!current) clear();
      apply();
    };
    // The canvas re-renders and remounts blocks; keep the mark on whichever
    // element currently answers to the target.
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener(AI_PRESENCE_EVENT, onPresence);
    return () => {
      observer.disconnect();
      window.removeEventListener(AI_PRESENCE_EVENT, onPresence);
      clear();
    };
  }, []);
  return null;
}
