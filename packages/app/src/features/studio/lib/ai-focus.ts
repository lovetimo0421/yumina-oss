import { create } from "zustand";

/**
 * What the creator is pointing the assistant at.
 *
 * Selecting something on the canvas puts it here: the assistant works on
 * that, and only that is sent in full (the rest of the card it can still read
 * for itself when it decides it needs to). This is how "rewrite the opening"
 * stops costing a whole card's worth of context, and how "this" in "make this
 * shorter" gets an address.
 *
 * It mirrors the canvas selection, multi-select included (Shift or Ctrl,
 * as the canvas already does). A chip can be taken away without touching the
 * canvas; the next change of selection sets it again.
 */

export type AiFocusKind = "entry" | "greeting" | "variable" | "rule" | "audio" | "module" | "world" | "block" | "frontend";

export interface AiFocusItem {
  /** Graph id: `entry:…`, `greeting:…`, `variable:…`, `block:…`. */
  id: string;
  kind: AiFocusKind;
  title: string;
  /** Characters this item would send — what the chip row adds up. */
  size: number;
}

interface AiFocusState {
  items: AiFocusItem[];
  /** From the canvas selection (single and multi). Replaced as it changes. */
  canvasItems: AiFocusItem[];
  /** Added by Shift/Ctrl-clicking something the canvas cannot multi-select
   *  (a written entry). Kept until removed. */
  extraItems: AiFocusItem[];
  setFromCanvas: (items: AiFocusItem[]) => void;
  toggleExtra: (item: AiFocusItem) => void;
  remove: (id: string) => void;
  clear: () => void;
}

const merge = (canvas: AiFocusItem[], extra: AiFocusItem[]) =>
  [...canvas, ...extra.filter((e) => !canvas.some((c) => c.id === e.id))];
const same = (a: AiFocusItem[], b: AiFocusItem[]) =>
  // The title too: a renamed character kept its old name on the chip.
  a.length === b.length && a.every((item, i) => item.id === b[i]?.id && item.size === b[i]?.size && item.title === b[i]?.title);

export const useAiFocus = create<AiFocusState>((set) => ({
  items: [],
  canvasItems: [],
  extraItems: [],
  setFromCanvas: (canvasItems) => set((state) =>
    same(state.canvasItems, canvasItems) ? state : { canvasItems, items: merge(canvasItems, state.extraItems) }),
  toggleExtra: (item) => set((state) => {
    // The click that adds this also moves the canvas selection onto it; what
    // was selected a moment ago is kept, not dropped.
    const kept = merge(state.extraItems, state.canvasItems);
    const extraItems = state.items.some((e) => e.id === item.id)
      ? kept.filter((e) => e.id !== item.id)
      : [...kept, item];
    return { extraItems, items: merge(state.canvasItems, extraItems) };
  }),
  remove: (id) => set((state) => {
    const canvasItems = state.canvasItems.filter((i) => i.id !== id);
    const extraItems = state.extraItems.filter((i) => i.id !== id);
    return { canvasItems, extraItems, items: merge(canvasItems, extraItems) };
  }),
  clear: () => set({ items: [], canvasItems: [], extraItems: [] }),
}));

/** The element that shows a focus item on the canvas: its row (a variable's,
 *  or a written entry's), or its block. */
export function focusTargetSelector(id: string): string {
  const escaped = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id;
  return `[data-row-anchor="${escaped}"], [data-canvas-writing-object="${escaped}"], .react-flow__node[data-id="${escaped}"]`;
}
