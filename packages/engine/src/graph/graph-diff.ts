import type { CardGraph, GraphEdge, GraphNode } from "./types.js";

/**
 * What one write turn did to the card, expressed in the canvas's own language.
 *
 * The Studio agent applies its changes and then tells you about them, so the
 * contract between author and AI can't be "approve this first" — it has to be
 * "here is exactly what moved, and here is the way back". Diffing the graph of
 * the pre-turn snapshot against the graph of the draft gives the first half;
 * the snapshot itself gives the second.
 */
export interface GraphDiff {
  /** Ids of nodes that appeared. */
  addedNodes: string[];
  /** Whole nodes that vanished — kept intact so the canvas can ghost them. */
  removedNodes: GraphNode[];
  /** Ids of nodes that survived but are not the same as before. */
  changedNodes: string[];
  addedEdges: string[];
  removedEdges: GraphEdge[];
  /** Every difference, counted once. Drives the "+3 −1 ~2" summary. */
  total: number;
  isEmpty: boolean;
}

/** Order-insensitive value key, so `{a,b}` and `{b,a}` compare equal. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
}

/** Everything about a node the author would notice changing. A folded
 *  group's member count is not one of them: it moves exactly when members
 *  are added or removed, which are counted already, and an assistant that
 *  only added two entries was reported as having "changed 1" as well. */
function nodeKey(n: GraphNode): string {
  const folded = n.data && typeof n.data === "object" && "drillTarget" in n.data && "count" in n.data;
  const data = folded ? { ...(n.data as Record<string, unknown>), count: undefined } : n.data;
  return stable({ title: n.title, kind: n.kind, parentId: n.parentId, ports: n.ports, data });
}

export function diffGraphs(before: CardGraph, after: CardGraph): GraphDiff {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));

  const addedNodes: string[] = [];
  const changedNodes: string[] = [];
  for (const [id, node] of afterNodes) {
    const prev = beforeNodes.get(id);
    if (!prev) addedNodes.push(id);
    else if (nodeKey(prev) !== nodeKey(node)) changedNodes.push(id);
  }
  const removedNodes = [...beforeNodes.values()].filter((n) => !afterNodes.has(n.id));

  const beforeEdges = new Map(before.edges.map((e) => [e.id, e]));
  const afterEdgeIds = new Set(after.edges.map((e) => e.id));
  const addedEdges = after.edges.filter((e) => !beforeEdges.has(e.id)).map((e) => e.id);
  const removedEdges = [...beforeEdges.values()].filter((e) => !afterEdgeIds.has(e.id));

  const total =
    addedNodes.length + removedNodes.length + changedNodes.length + addedEdges.length + removedEdges.length;

  return { addedNodes, removedNodes, changedNodes, addedEdges, removedEdges, total, isEmpty: total === 0 };
}
