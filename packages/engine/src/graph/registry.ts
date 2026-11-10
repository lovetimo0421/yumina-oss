import type { NodeKind } from "./types.js";

export interface NodeTypeDef {
  kind: NodeKind;
  label: string;
  description: string;
}

/** Author-addable node kinds for P1 (logic + data). Display/module kinds arrive in later phases. */
export const NODE_TYPES: NodeTypeDef[] = [
  { kind: "variable", label: "Variable", description: "A piece of game state (number/text/flag)." },
  { kind: "rule", label: "Rule", description: "WHEN something happens, THEN run effects." },
  { kind: "event", label: "Event source", description: "Player input / each turn / session start." },
];

/** P1 palette is system-independent; the param is reserved for when wired modules
 *  (Phase 4) contribute node types via the SystemRegistry. */
export function paletteNodeTypes(_systemIds?: string[]): NodeTypeDef[] {
  return NODE_TYPES;
}
