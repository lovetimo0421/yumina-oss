/** The inspector's state machine, separated from its pixels.
 *
 *  Everything here is about one question — which element is the creator
 *  pointing at — and the three ways that changes: the picker under the cursor,
 *  the keyboard walking the tree, and the breadcrumb jumping up it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ancestorChain, deepElementFromPoint, elementChildren, ownSourceRef } from "./hit-test";

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Card markup only. The preview is wrapped in studio scaffolding (the shadow
 *  host, the container-query frame), and offering those as selectable blocks
 *  would be offering the creator a chair to edit. An element counts as the
 *  card's when it lives inside the shadow tree and is not marked as frame. */
function isCardElement(el: Element): boolean {
  return el.getRootNode() instanceof ShadowRoot && !el.hasAttribute("data-yc-frame");
}

function rectOf(el: Element, origin: DOMRect): Rect {
  const r = el.getBoundingClientRect();
  return { top: r.top - origin.top, left: r.left - origin.left, width: r.width, height: r.height };
}

export interface InspectorState {
  picking: boolean;
  setPicking: (on: boolean) => void;
  hovered: Element | null;
  selected: Element | null;
  /** Root-first chain of card elements down to the selection. */
  chain: Element[];
  hoverRect: Rect | null;
  selectedRect: Rect | null;
  select: (el: Element | null) => void;
  /** Keyboard tree walk. Returns false when the move had nowhere to go, so the
   *  caller can leave the key to the browser. */
  move: (direction: "up" | "down" | "left" | "right") => boolean;
  onPointerMove: (event: { clientX: number; clientY: number }) => void;
  onPick: (event: { clientX: number; clientY: number }) => void;
  /** The card element under a viewport point, or null off the card. */
  hitTest: (clientX: number, clientY: number) => Element | null;
}

export function useInspector(
  stageRef: React.RefObject<HTMLElement | null>,
  boundaryRef: React.RefObject<HTMLElement | null>,
): InspectorState {
  const [picking, setPickingState] = useState(false);
  const [hovered, setHovered] = useState<Element | null>(null);
  const [selected, setSelected] = useState<Element | null>(null);
  const [chain, setChain] = useState<Element[]>([]);
  const [hoverRect, setHoverRect] = useState<Rect | null>(null);
  const [selectedRect, setSelectedRect] = useState<Rect | null>(null);
  /** Where the pointer was last seen, so a hover can be re-resolved without one.
   *  Cards animate — 92% of the real ones do — and an animating card replaces
   *  DOM under a cursor that never moved. */
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  // The selected element is detached on a recompile, but its shadow host
  // survives. Remember the root while connected: light-DOM queries cannot
  // reach the preview frame and a detached element no longer names its root.
  const selectedRootRef = useRef<ShadowRoot | null>(null);
  /** The selection as of the last `select` call, read by the frame loop: a
   *  loop started for an OLDER selection can still run one frame after a new
   *  one is made, and must not "re-find" the old part over the new one. */
  const latestSelectedRef = useRef<Element | null>(null);

  const select = useCallback(
    (el: Element | null) => {
      const root = el?.getRootNode();
      selectedRootRef.current = root instanceof ShadowRoot ? root : null;
      latestSelectedRef.current = el;
      setSelected(el);
      setChain(el ? ancestorChain(el, boundaryRef.current).filter(isCardElement) : []);
    },
    [boundaryRef],
  );

  const hitTest = useCallback((clientX: number, clientY: number): Element | null => {
    const el = deepElementFromPoint(clientX, clientY);
    return el && isCardElement(el) ? el : null;
  }, []);

  const onPointerMove = useCallback(
    (event: { clientX: number; clientY: number }) => {
      lastPointRef.current = { x: event.clientX, y: event.clientY };
      setHovered(hitTest(event.clientX, event.clientY));
    },
    [hitTest],
  );

  const onPick = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const el = hitTest(event.clientX, event.clientY);
      if (!el) return;
      select(el);
      // Picking is a one-shot gesture, exactly as in devtools: the click that
      // selects also puts the cursor back to normal use. Staying armed would
      // mean every later click re-selects instead of doing what it looks like.
      setPickingState(false);
      setHovered(null);
    },
    [hitTest, select],
  );

  const setPicking = useCallback((on: boolean) => {
    setPickingState(on);
    if (!on) setHovered(null);
  }, []);

  const move = useCallback(
    (direction: "up" | "down" | "left" | "right"): boolean => {
      if (!selected) return false;
      if (direction === "up") {
        const parent = chain[chain.length - 2];
        if (!parent) return false;
        select(parent);
        return true;
      }
      if (direction === "down") {
        const child = elementChildren(selected).find(isCardElement);
        if (!child) return false;
        select(child);
        return true;
      }
      const siblings = chain[chain.length - 2]
        ? elementChildren(chain[chain.length - 2]).filter(isCardElement)
        : [];
      const index = siblings.indexOf(selected);
      if (index < 0) return false;
      const next = siblings[index + (direction === "right" ? 1 : -1)];
      if (!next) return false;
      select(next);
      return true;
    },
    [selected, chain, select],
  );

  // Rects are read every frame rather than on an event, because the things that
  // move them are invisible from here: the card scrolls its own containers,
  // animates, and remounts wholesale on every recompile. A frame loop that only
  // sets state when a number actually changed costs less than being wrong.
  useEffect(() => {
    if (!hovered && !selected) {
      setHoverRect(null);
      setSelectedRect(null);
      return;
    }
    let raf = 0;
    let lastHover = "";
    let lastSelected = "";
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const stage = stageRef.current;
      if (!stage) return;
      const origin = stage.getBoundingClientRect();

      if (hovered) {
        if (!hovered.isConnected) {
          // The card re-rendered under a stationary cursor. Blanking the
          // highlight here would leave the picker looking dead until the
          // creator jiggled the mouse; re-asking the same point is what that
          // jiggle would have produced.
          const point = lastPointRef.current;
          setHovered(point ? hitTest(point.x, point.y) : null);
          return;
        }
        const next = rectOf(hovered, origin);
        const key = `${next.top},${next.left},${next.width},${next.height}`;
        if (key !== lastHover) {
          lastHover = key;
          setHoverRect(next);
        }
      } else {
        // Unconditionally, not `else if (lastHover)`.
        //
        // `lastHover` is per-loop, and the loop is restarted whenever `hovered`
        // changes — so the run that discovers there is nothing hovered always
        // begins with an empty `lastHover` and, under the old guard, skipped
        // the clear. The rect then survived as long as something else kept the
        // loop alive, which is why a selected block left the hover outline
        // stranded in mid-air. Setting the same null twice is free: React bails
        // out on an unchanged state.
        lastHover = "";
        setHoverRect(null);
      }

      if (selected) {
        if (latestSelectedRef.current !== selected) return;
        if (!selected.isConnected) {
          // A recompile replaced the tree. The creator is mid-conversation
          // about this block, so re-find it by the source line it came from
          // rather than dropping the selection out from under them.
          const ref = ownSourceRef(selected);
          const host = selectedRootRef.current;
          // An arranged card's part is found by its element id first: its
          // source line moves whenever an edit adds or wraps code above it
          // (a "show when" condition does exactly that), its id never does.
          const uiId = uiElementIdOf(selected);
          const byUiId = uiId && host?.host.isConnected
            ? host.querySelector(`[data-ui-el="${CSS.escape(uiId)}"]`)
            : null;
          const replacement = byUiId ?? (
            ref && host?.host.isConnected
              ? Array.from(host.querySelectorAll("[data-yc-src]")).find(
                  el => el.getAttribute("data-yc-src") === `${ref.file}:${ref.line}`,
                )
              : null);
          if (replacement) select(replacement);
          else select(null);
          return;
        }
        const next = rectOf(selected, origin);
        const key = `${next.top},${next.left},${next.width},${next.height}`;
        if (key !== lastSelected) {
          lastSelected = key;
          setSelectedRect(next);
        }
      } else {
        // Same reasoning as the hover rect above.
        lastSelected = "";
        setSelectedRect(null);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hovered, selected, stageRef, boundaryRef, select, hitTest]);

  return {
    picking,
    setPicking,
    hovered,
    selected,
    chain,
    hoverRect,
    selectedRect,
    select,
    move,
    onPointerMove,
    onPick,
    hitTest,
  };
}

/** The uiDoc element id a node belongs to, read off it or its nearest stamped
 *  ancestor — still readable after the node has been detached by a remount. */
function uiElementIdOf(node: Element): string | null {
  let cur: Node | null = node;
  for (let depth = 0; cur && depth < 64; depth++) {
    if (cur instanceof Element) {
      const id = cur.getAttribute("data-ui-el");
      if (id) return id;
    }
    cur = cur.parentNode;
  }
  return null;
}
