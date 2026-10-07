import type { Condition } from "../types/index.js";

/** Port value/flow types. `signal` = causal pulse; value types mirror Variable.type. */
export type PortType =
  | "signal" | "number" | "string" | "boolean" | "json"
  | "state" | "entry" | "ui" | "module";

/** Node categories — each maps to an existing WorldDefinition structure.
 *  "module" = a worldbook (module container); "greeting" = a role:"greeting"
 *  entry (an opening); "component" = the card frontend (rootComponent);
 *  "world" = the card itself (identity + cover), the root every opening hangs
 *  off. */
export type NodeKind =
  | "event" | "rule" | "variable" | "entry" | "audio" | "image" | "component" | "module" | "greeting"
  | "world";

export interface GraphPort {
  /** Unique within the node (e.g. "trigger", "effect", "write", "read"). */
  id: string;
  type: PortType;
  direction: "in" | "out";
  label?: string;
}

export interface GraphNode {
  /** Stable key: var:<id> / rule:<id> / reaction:<id> / evt:<source> /
   *  entry:<id> / greeting:<entryId> / module:<worldbookId> / audio:<trackId>. */
  id: string;
  kind: NodeKind;
  title: string;
  ports: GraphPort[];
  /** Containing module node id (module:<worldbookId>) — projected from the
   *  member's worldbookId. Undefined = Core (free on the canvas). */
  parentId?: string;
  /** Read-only projection payload for the inspector (e.g. { variableId } / { ruleId }). */
  data: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  from: string;       // node id
  fromPort: string;   // port id on `from`
  to: string;         // node id
  toPort: string;     // port id on `to`
  /** What to write on the wire. Data the creator typed (an operation, a
   *  channel, a value) reads the same in every language and goes here. */
  label?: string;
  /** …but a wire the projection NAMES needs the reader's language, and the
   *  engine has none. It emits the key and the app translates it. Without
   *  this the station wires said 记忆·亲历 to everyone. */
  labelKey?: string;
}

export interface CardGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** An editable mutation. Each maps deterministically onto a worldDraft change. */
export type GraphPatch =
  | { op: "add-edge"; edge: GraphEdge }
  | { op: "remove-edge"; edgeId: string }
  | { op: "add-node"; node: GraphNode }
  | { op: "remove-node"; nodeId: string }
  | { op: "update-node-data"; nodeId: string; data: Record<string, unknown> }
  /** Move a member node into a module container (worldbookId), or out to Core
   *  (parentId undefined). nodeId: var:/entry:/greeting:/reaction:/rule:. */
  | { op: "set-parent"; nodeId: string; parentId: string | undefined }
  /** Edit the payload behind an existing edge in place (the edge inspector):
   *  operator/value of the condition behind a var→module / var→entry edge, or
   *  the seed value behind a greeting→var edge. Stale ids no-op safely. */
  | { op: "update-edge"; edgeId: string; data: { operator?: Condition["operator"]; value?: unknown } };

/** Additive, canvas-only persistence. Keyed by the same stable node ids.
 *  A `pinned` entry is a frame the creator dragged: it stays at that
 *  coordinate while the rest of the board flows around it. A `loose` entry
 *  is a card-level object the creator has not yet put in a module: drawn on
 *  its own on the canvas (at x/y) instead of as a shared row in every
 *  module, until it is dragged into one or sent to all. */
export interface GraphLayout {
  version: number;
  nodes: Record<string, { x: number; y: number; collapsed?: boolean; pinned?: boolean; loose?: boolean }>;
  /** Sticky notes. With `on` (a canvas id: a block, a scenario's frame, an
   *  entry…) the note is stuck beside that thing and `x`/`y` are its offset
   *  from that thing's top-right corner; without, it lies loose at `x`/`y`.
   *  Read by the creation assistant and outside AIs; never by play. */
  notes?: Array<{
    id: string; x: number; y: number; w: number; h: number; text: string;
    /** @deprecated one target; `targets` supersedes it. */
    on?: string;
    /** What it is stuck to: rows (entry:…, var:…, reaction:…), AIs (ai:…),
     *  blocks and scenarios. */
    targets?: string[];
    /** Folded to a small square. */
    collapsed?: boolean;
    color?: "yellow" | "pink" | "blue" | "green";
  }>;
}
