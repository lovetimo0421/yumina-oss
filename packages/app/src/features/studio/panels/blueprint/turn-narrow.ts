import type { GraphDiff, WorldDefinition } from "@yumina/engine";

/** Which list of the card a canvas object lives in, by its node id prefix —
 *  the objects one item at a time can be taken back for. */
const ITEM_LISTS = {
  entry: "entries",
  greeting: "entries",
  var: "variables",
  rule: "rules",
  reaction: "reactions",
  module: "worldbooks",
} as const;

/**
 * `before`, with just one object as the turn left it: the turn narrowed to
 * that object. Reverting this "turn" with the same three-way merge takes back
 * that object and nothing else — and still keeps what the author changed in
 * it since. Null for an object that is not one of the lists above, or one
 * the turn removed (there is nothing in `end` to narrow to).
 */
export function turnNarrowedTo(before: WorldDefinition, end: WorldDefinition, nodeId: string): WorldDefinition | null {
  const at = nodeId.indexOf(":");
  const key = ITEM_LISTS[nodeId.slice(0, at) as keyof typeof ITEM_LISTS];
  if (at < 0 || !key) return null;
  const id = nodeId.slice(at + 1);
  type Item = { id: string };
  const was = ((before as unknown as Record<string, Item[] | undefined>)[key] ?? []);
  const became = ((end as unknown as Record<string, Item[] | undefined>)[key] ?? []).find((item) => item.id === id);
  if (!became) return null;
  const list = was.some((item) => item.id === id) ? was.map((item) => (item.id === id ? became : item)) : [...was, became];
  return { ...before, [key]: list } as WorldDefinition;
}

/**
 * The live diff (before the turn → the card now), kept to what the turn
 * itself did: something the author added or changed after the turn (a new
 * interface and its variables, a line they wrote) is theirs, and the banner
 * that says "the assistant's last turn" must not list it or offer to take it
 * back. What the turn did and the author has since undone drops out too,
 * since it is no longer in the live diff.
 */
export function turnOnlyDiff(live: GraphDiff, turn: GraphDiff): GraphDiff {
  const turnNodes = new Set([...turn.addedNodes, ...turn.changedNodes]);
  const turnAdded = new Set(turn.addedNodes);
  const turnRemoved = new Set(turn.removedNodes.map((n) => n.id));
  const turnAddedEdges = new Set(turn.addedEdges);
  const turnRemovedEdges = new Set(turn.removedEdges.map((e) => e.id));
  const addedNodes = live.addedNodes.filter((id) => turnAdded.has(id));
  const changedNodes = live.changedNodes.filter((id) => turnNodes.has(id));
  const removedNodes = live.removedNodes.filter((n) => turnRemoved.has(n.id));
  const addedEdges = live.addedEdges.filter((id) => turnAddedEdges.has(id));
  const removedEdges = live.removedEdges.filter((e) => turnRemovedEdges.has(e.id));
  const total = addedNodes.length + removedNodes.length + changedNodes.length + addedEdges.length + removedEdges.length;
  return { addedNodes, removedNodes, changedNodes, addedEdges, removedEdges, total, isEmpty: total === 0 };
}
