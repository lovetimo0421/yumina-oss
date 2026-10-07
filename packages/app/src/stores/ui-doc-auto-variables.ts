import { nameFromQuestion, uiDocVariableRefs, withAutoVariable, withoutAutoVariables } from "@yumina/engine";
import type { UiDoc, Variable, WorldDefinition } from "@yumina/engine";
import { getVariableIdUsage } from "@/features/editor/lib/variable-id-references";

/**
 * The bookkeeping behind variables the interface editor makes on the
 * creator's behalf (a form question's answer, a popup's message).
 *
 * Pure, so the store stays a thin caller and the rules can be tested alone:
 *
 *  1. A variable made for a part is ADOPTED by the doc (listed in
 *     `uiDoc.autoVariables`) the first time a doc that binds it is set. It is
 *     made a moment before the part that binds it lands, so it waits in
 *     `pending` until then.
 *  2. When an edit stops binding an auto variable — the part was deleted, or
 *     pointed at another variable — and nothing else in the card reads it
 *     (other parts, behaviours, entries: `getVariableIdUsage`), it is removed
 *     in the same edit, so one undo brings both back.
 *  3. A variable the creator made is never on the list and never touched.
 */

const refsOf = (doc: UiDoc | undefined): Set<string> => {
  if (!doc) return new Set();
  const { reads, writes } = uiDocVariableRefs(doc);
  return new Set([...reads, ...writes]);
};

export function reconcileAutoVariables({
  world, nextDoc, pending, keep = false,
}: {
  /** The card as it is BEFORE this edit (its uiDoc is the previous doc). */
  world: WorldDefinition;
  nextDoc: UiDoc | undefined;
  /** Made for a part, not yet adopted by a doc. */
  pending: readonly string[];
  /** A cut: the part is coming back, so its variables stay. */
  keep?: boolean;
}): { doc: UiDoc | undefined; variables: Variable[]; stillPending: string[] } {
  let doc = nextDoc;
  let variables = world.variables;
  if (!doc) return { doc, variables, stillPending: [...pending] };
  const now = refsOf(doc);
  const stillPending: string[] = [];
  for (const id of pending) {
    if (now.has(id)) doc = withAutoVariable(doc, id);
    else if (variables.some((v) => v.id === id)) stillPending.push(id);
  }
  // Forget entries whose variable is already gone (deleted in the 变量 tab).
  const known = (doc.autoVariables ?? []).filter((id) => variables.some((v) => v.id === id));
  if (known.length !== (doc.autoVariables ?? []).length) {
    doc = withoutAutoVariables(doc, (doc.autoVariables ?? []).filter((id) => !known.includes(id)));
  }
  if (keep || known.length === 0) return { doc, variables, stillPending };
  const before = refsOf(world.uiDoc);
  const lost = known.filter((id) => before.has(id) && !now.has(id));
  if (lost.length === 0) return { doc, variables, stillPending };
  const after: WorldDefinition = { ...world, uiDoc: doc };
  const gone = lost.filter((id) => {
    const variable = variables.find((v) => v.id === id);
    return !!variable && getVariableIdUsage(after, variable).references.length === 0;
  });
  if (gone.length === 0) return { doc, variables, stillPending };
  variables = variables.filter((v) => !gone.includes(v.id));
  return { doc: withoutAutoVariables(doc, gone), variables, stillPending };
}

/** `base`, or `base 2`, `base 3`… — whichever no other variable is called. */
export function uniqueVariableName(base: string, variables: readonly Variable[], exceptId?: string): string {
  const taken = new Set(variables.filter((v) => v.id !== exceptId).map((v) => v.name.trim()));
  const stem = base.trim() || "variable";
  let name = stem;
  for (let n = 2; taken.has(name); n++) name = `${stem} ${n}`;
  return name;
}

/**
 * The new name for an auto variable whose question was just reworded, or null
 * to leave it alone.
 *
 * It follows the question only while it is still the editor's: on the doc's
 * auto list, still named what the OLD question would have named it (so the
 * creator has not renamed it by hand), and read by nothing but this one part.
 */
export function autoRenameFor({
  world, variableId, oldText, newText, fallback,
}: {
  world: WorldDefinition;
  variableId: string;
  oldText: string;
  newText: string;
  /** The name used when the question gives none. */
  fallback: string;
}): string | null {
  const doc = world.uiDoc;
  if (!doc || !(doc.autoVariables ?? []).includes(variableId)) return null;
  const variable = world.variables.find((v) => v.id === variableId);
  if (!variable) return null;
  const was = nameFromQuestion(oldText) || fallback;
  const current = variable.name.trim();
  // "名字" or "名字 2": the suffix uniqueVariableName adds.
  const matches = current === was || new RegExp(`^${was.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\d+$`).test(current);
  if (!matches) return null;
  const outside = getVariableIdUsage(world, variable).references.filter((r) => r.area !== "interface");
  if (outside.length > 0) return null;
  const parts = (doc.pages ?? []).flatMap((p) => p.elements).filter((el) => JSON.stringify(el).includes(`"${variableId}"`) || JSON.stringify(el).includes(`{{${variableId}}}`));
  if (parts.length > 1) return null;
  const wanted = nameFromQuestion(newText) || fallback;
  const next = uniqueVariableName(wanted, world.variables, variableId);
  return next === current ? null : next;
}
