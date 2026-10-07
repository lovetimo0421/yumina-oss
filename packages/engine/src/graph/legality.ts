import type { GraphPort, PortType } from "./types.js";

/** Value port types that a `state` (variable) port accepts on either side. */
const VALUE_TYPES: ReadonlySet<PortType> = new Set(["number", "string", "boolean", "json"]);

/** True when an OUT port may legally feed an IN port. */
export function canConnect(from: GraphPort, to: GraphPort): boolean {
  if (from.direction !== "out" || to.direction !== "in") return false;
  if (from.type === to.type) return true;
  // A concrete value may flow into a generic variable (state) port and vice-versa.
  if (to.type === "state" && VALUE_TYPES.has(from.type)) return true;
  if (from.type === "state" && VALUE_TYPES.has(to.type)) return true;
  // Module activation: gated by a variable condition (state) or by picking an
  // opening (a greeting's `select` signal).
  if (to.type === "module" && (from.type === "state" || from.type === "signal")) return true;
  // Entry gate: a variable condition gates an entry.
  if (to.type === "entry" && from.type === "state") return true;
  return false;
}
