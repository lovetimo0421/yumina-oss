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

/** The parts of a card the graph does not carry but a turn can still change:
 *  an entry's text, a variable's starting value. Structurally typed so the
 *  pre-turn snapshot (stored JSON) and the live draft both fit. */
export interface GraphDiffContent {
  entries?: ReadonlyArray<{ id: string; role?: string; content?: string | null }> | null;
  variables?: ReadonlyArray<{ id: string; defaultValue?: unknown }> | null;
}

/**
 * Node ids whose content moved between two versions of a card. The graph
 * leaves entry text and variable defaults out on purpose (a node's identity
 * is not its prose, and the canvas rebuilds on every keystroke), so a turn
 * that only rewrote a setting's text or a variable's default diffed as
 * nothing: no banner, no way back. Compared here instead, by length first and
 * then by plain string equality — no serialising of the text.
 */
export function contentChangedNodeIds(before: GraphDiffContent, after: GraphDiffContent): string[] {
  const ids: string[] = [];
  const beforeEntries = new Map((before.entries ?? []).map((e) => [e.id, e]));
  for (const e of after.entries ?? []) {
    const prev = beforeEntries.get(e.id);
    if (!prev) continue; // an added entry is already an added node
    const a = prev.content ?? "";
    const b = e.content ?? "";
    if (a.length !== b.length || a !== b) ids.push(`${e.role === "greeting" ? "greeting" : "entry"}:${e.id}`);
  }
  const beforeVars = new Map((before.variables ?? []).map((v) => [v.id, v]));
  for (const v of after.variables ?? []) {
    const prev = beforeVars.get(v.id);
    if (!prev) continue;
    const a = prev.defaultValue;
    const b = v.defaultValue;
    const same = a === b || (typeof a === "object" && typeof b === "object" && stable(a) === stable(b));
    if (!same) ids.push(`var:${v.id}`);
  }
  return ids;
}

/** Diff two graphs. Pass `content` — the two cards the graphs were compiled
 *  from — to also count nodes whose text or default changed underneath. */
export function diffGraphs(
  before: CardGraph,
  after: CardGraph,
  content?: { before: GraphDiffContent; after: GraphDiffContent },
): GraphDiff {
  const beforeNodes = new Map(before.nodes.map((n) => [n.id, n]));
  const afterNodes = new Map(after.nodes.map((n) => [n.id, n]));

  const addedNodes: string[] = [];
  const changedNodes: string[] = [];
  for (const [id, node] of afterNodes) {
    const prev = beforeNodes.get(id);
    if (!prev) addedNodes.push(id);
    else if (nodeKey(prev) !== nodeKey(node)) changedNodes.push(id);
  }
  if (content) {
    const counted = new Set(changedNodes);
    for (const id of contentChangedNodeIds(content.before, content.after)) {
      // Only a node drawn on both sides: one folded into a summary, or new,
      // has nothing of its own to mark.
      if (counted.has(id) || !beforeNodes.has(id) || !afterNodes.has(id)) continue;
      counted.add(id);
      changedNodes.push(id);
    }
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
