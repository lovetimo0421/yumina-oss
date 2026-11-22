import { deepEqual, mergeWorldDefinition, migrateWorldDefinition, type WorldDefinition } from "@yumina/engine";

export interface AgentWriteConflict {
  /** Collection name ("entries", "rootComponent.files", …) or "field" for a top-level key. */
  collection: string;
  /** Entity id, filename, or field name. */
  id: string;
}

export interface AgentWriteRebase {
  schema: Record<string, unknown>;
  /** Things both the creator and the agent changed differently. The creator's
   *  version is kept for each; the agent's version of them was NOT saved. */
  conflicts: AgentWriteConflict[];
}

type Json = Record<string, unknown>;

/**
 * Rebase a Studio agent write onto a save the creator made while the agent was
 * working. Three-way: `base` is the working schema the agent's step started
 * from, `current` is what is stored now (the creator's save), `proposed` is the
 * agent's result. Whatever only one side changed is taken from that side; when
 * both changed the same entity/file/field differently, the creator wins and the
 * item is reported as a conflict so the agent can be told its change there did
 * not land. Pure; never mutates its inputs.
 */
export function rebaseAgentWrite(base: Json, current: Json, proposed: Json): AgentWriteRebase {
  const baseWorld = migrateWorldDefinition(base as unknown as WorldDefinition) as unknown as Json;
  const currentWorld = migrateWorldDefinition(current as unknown as WorldDefinition) as unknown as Json;
  const proposedWorld = migrateWorldDefinition(proposed as unknown as WorldDefinition) as unknown as Json;

  // local = the creator (wins on conflict), server = the agent.
  const granular = mergeWorldDefinition(
    baseWorld as unknown as WorldDefinition,
    currentWorld as unknown as WorldDefinition,
    proposedWorld as unknown as WorldDefinition,
  );
  const granularMerged = granular.merged as unknown as Json;

  const merged: Json = {};
  const conflicts: AgentWriteConflict[] = [];
  const keys = new Set([...Object.keys(baseWorld), ...Object.keys(currentWorld), ...Object.keys(proposedWorld)]);
  for (const key of keys) {
    const b = baseWorld[key];
    const c = currentWorld[key];
    const p = proposedWorld[key];
    const agentChanged = !deepEqual(p, b);
    const creatorChanged = !deepEqual(c, b);
    let value: unknown;
    if (!agentChanged) value = c;
    else if (!creatorChanged || deepEqual(p, c)) value = p;
    else {
      // Both changed it: mergeWorldDefinition goes inside (rows by id, the
      // frontend by file, objects key by key) and the creator keeps whatever
      // both changed differently.
      value = granularMerged[key];
      for (const conflict of granular.conflicts) {
        if (conflict.collection === key || conflict.collection.startsWith(`${key}.`)
          || (conflict.collection === "field" && (conflict.id === key || conflict.id.startsWith(`${key}.`)))) {
          conflicts.push({ collection: conflict.collection, id: conflict.id });
        }
      }
    }
    if (value !== undefined) merged[key] = value;
  }
  return { schema: merged, conflicts };
}

/** One line the model can act on, naming what it lost to the creator's save. */
export function describeAgentWriteConflicts(conflicts: AgentWriteConflict[]): string {
  const shown = conflicts.slice(0, 10).map((c) => c.collection === "field" ? c.id : `${c.collection}/${c.id}`);
  const more = conflicts.length > 10 ? ` (+${conflicts.length - 10} more)` : "";
  return `Someone else working on this card (the creator, a collaborator, or another assistant) changed ${shown.join(", ")}${more} while you were working. Their version was kept, so your change to ${conflicts.length === 1 ? "it" : "those"} was NOT saved. Everything else in this change was saved. Re-read ${conflicts.length === 1 ? "it" : "them"} before editing again, and do not undo their edits unless the person you are working for asked you to.`;
}
