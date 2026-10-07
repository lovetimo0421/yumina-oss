import { useEffect, useState } from "react";
import type { WorldDefinition } from "@yumina/engine";
import { useAiFocus, type AiFocusItem } from "./ai-focus";
import { describeWritingFocus } from "./ai-focus-describe";

const json = (value: unknown) => {
  try { return JSON.stringify(value ?? "").length; } catch { return 0; }
};

/** The item open in a full-editor section, described as a focus chip. */
export function describeDraftFocus(kind: "entry" | "variable" | "reaction", rawId: string, world: WorldDefinition): AiFocusItem | null {
  if (kind === "entry") return describeWritingFocus(`entry:${rawId}`, world);
  if (kind === "variable") {
    const v = (world.variables ?? []).find((x) => x.id === rawId);
    return v ? { id: `var:${rawId}`, kind: "variable", title: v.name || rawId, size: json(v) } : null;
  }
  const r = (world.reactions ?? []).find((x) => x.id === rawId);
  return r ? { id: `reaction:${rawId}`, kind: "rule", title: r.name || rawId, size: json(r) } : null;
}

/**
 * With the canvas off, the item open in a section is what the creator is
 * pointing at — the same as selecting it on the canvas. Leaving the section
 * (or closing the item) takes it away again. A section that opens its first
 * item by itself is not pointing yet: that only counts once the creator
 * picks something.
 */
export function useEditorFocus(kind: "entry" | "variable" | "reaction", rawId: string | null | undefined, world: WorldDefinition) {
  const [opened] = useState(rawId);
  const [picked, setPicked] = useState(false);
  if (!picked && rawId !== opened) setPicked(true);
  const item = rawId && (picked || rawId !== opened) ? describeDraftFocus(kind, rawId, world) : null;
  const key = item ? `${item.id}|${item.title}|${item.size}` : "";
  useEffect(() => {
    if (!item) return;
    useAiFocus.getState().setFromCanvas([item]);
    // Only take away what this section put there (the canvas may have moved on).
    return () => {
      const { canvasItems, setFromCanvas } = useAiFocus.getState();
      if (canvasItems.length === 1 && canvasItems[0]!.id === item.id) setFromCanvas([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
