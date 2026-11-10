import type { Block } from "@yumina/engine";

export type LearningCanvasTarget = "opening" | "setting" | "memory";

export function findCanvasWritingSection(container: HTMLElement | null, id: string, hostId?: string): HTMLElement | undefined {
  return Array.from(container?.querySelectorAll<HTMLElement>("[data-canvas-writing-object], [data-canvas-writing-empty]") ?? []).find(element => {
    const host = element.closest(".react-flow__node")?.getAttribute("data-id");
    return id.startsWith("block:") ? host === id && element.hasAttribute("data-canvas-writing-empty") :
      element.dataset.canvasWritingObject === id && (!hostId || host === hostId);
  });
}

/** Resolve the current canvas, including its presentation-only empty slots.
 * Learning never creates entries, changes ownership, or changes a card's mode. */
export function resolveLearningCanvasTarget(target: LearningCanvasTarget, blocks: readonly Block[]): string | undefined {
  const matching = blocks.filter(block => target === "memory" ? block.kind === "context" :
    target === "opening" ? block.kind === "opening" : block.kind === "lore" && block.id !== "block:starter:presets");
  // The card's own blocks first: a lesson about the card's setting landed on
  // a situation's setting whenever the situation's block came first.
  const candidates = [...matching.filter(block => !block.ownerId), ...matching.filter(block => block.ownerId)];
  const block = candidates.find(block => block.total > 0) ?? candidates[0];
  if (!block) return undefined;
  if (target === "memory") return block.id;
  return block.head?.id ?? block.rows[0]?.g.id ?? block.id;
}
