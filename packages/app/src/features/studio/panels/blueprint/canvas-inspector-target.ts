import { blockId, type GraphNode } from "@yumina/engine";

/** Memory is a view of settings that already belong to something else — a
 * module's station, or the card's own — never a new graph entity. Keep the
 * canvas selection on its small block while the edits target the owner. */
export function resolveCanvasInspectorNode(id: string, nodes: readonly GraphNode[]):
  { node: GraphNode; section?: "memory" } | null {
  const direct = nodes.find(node => node.id === id);
  if (direct) return { node: direct };
  if (id === blockId.context()) {
    const world = nodes.find(node => node.kind === "world");
    return world ? { node: world, section: "memory" } : null;
  }
  const module = nodes.find(node => node.kind === "module" &&
    blockId.context(node.id.slice("module:".length)) === id);
  return module ? { node: module, section: "memory" } : null;
}
