import { blockId, type GraphNode } from "@yumina/engine";

const AI_PREFIX = "ai:";
const AI_NARRATOR_ID = "ai:narrator";

/** The inspector id for an AI row: a situation's AI by its book, or the
 *  card's own AI with no book. */
export function aiInspectorId(bookId?: string | null): string {
  return bookId ? `${AI_PREFIX}${bookId}` : AI_NARRATOR_ID;
}

/** Memory is a view of settings that already belong to something else — a
 * module's station, or the card's own — never a new graph entity. Keep the
 * canvas selection on its small block while the edits target the owner. */
export function resolveCanvasInspectorNode(id: string, nodes: readonly GraphNode[]):
  { node: GraphNode; section?: "memory" | "ai" } | null {
  const direct = nodes.find(node => node.id === id);
  if (direct) return { node: direct };
  // An AI row opens in the column too: the card's own AI on the world node,
  // a situation's AI on its module — the settings belong to those.
  if (id === AI_NARRATOR_ID) {
    const world = nodes.find(node => node.kind === "world");
    return world ? { node: world, section: "ai" } : null;
  }
  if (id.startsWith(AI_PREFIX)) {
    const module = nodes.find(node => node.id === `module:${id.slice(AI_PREFIX.length)}`);
    return module ? { node: module, section: "ai" } : null;
  }
  if (id === blockId.context()) {
    const world = nodes.find(node => node.kind === "world");
    return world ? { node: world, section: "memory" } : null;
  }
  const module = nodes.find(node => node.kind === "module" &&
    blockId.context(node.id.slice("module:".length)) === id);
  return module ? { node: module, section: "memory" } : null;
}
