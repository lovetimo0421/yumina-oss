/** What an official layout leaves behind when the creator picks another one.
 *
 *  A layout installs the variables it is bound to (an affection meter, a
 *  stamina meter, a location chip). Switching layouts installs the next set —
 *  and the previous set stays, because a variable may have grown a behaviour
 *  or a mention by then and deleting someone's state behind their back is not
 *  a thing to do. But a creator who tries four layouts in a row ends up with
 *  sixteen variables, most of them driving nothing and every one of them
 *  injected into the prompt each turn. This finds the ones that are provably
 *  just leftovers, so the editor can offer to clear them — offer, not do.
 */

import { getUiTemplate, type UiDoc, type Variable, type WorldDefinition } from "@yumina/engine";
import { getVariableIdUsage } from "@/features/editor/lib/variable-id-references";

type TemplateNeed = NonNullable<ReturnType<typeof getUiTemplate>>["needs"][number];

/** Every variable id a uiDoc binds to — element values, text macros, actions. */
export function collectBoundVariableIds(doc: UiDoc | undefined): Set<string> {
  const ids = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "variableId" && typeof child === "string") ids.add(child);
      else if (typeof child === "string" && (key === "template" || key === "text" || key === "content")) {
        for (const match of child.matchAll(/\{\{\s*([^{}\s.[]+)/g)) ids.add(match[1]!);
      } else walk(child);
    }
  };
  walk(doc);
  return ids;
}

/** A variable still shaped exactly as the layout created it: same type, a name
 *  the layout would have given it, the layout's own starting value and range.
 *  Anything the creator has since touched fails this and is theirs to keep. */
export function isTemplateShaped(
  variable: Variable,
  needs: readonly TemplateNeed[],
  variableNames: Record<string, string> | undefined,
): boolean {
  return needs.some((need) => {
    if (need.type !== variable.type) return false;
    // The name is only evidence when the caller can still say what the layout
    // called this need. The layout that made the variable is the PREVIOUS one,
    // and the names on hand are the next one's — a need the next layout does
    // not share has no name here, and its variable is judged on shape alone.
    const name = variable.name.trim();
    const givenName = (variableNames?.[need.key] ?? "").trim();
    if (givenName && name !== need.key && name !== givenName) return false;
    if ((need.min ?? undefined) !== (variable.min ?? undefined)) return false;
    if ((need.max ?? undefined) !== (variable.max ?? undefined)) return false;
    // The portrait is seeded from the cover, and a localized string default is
    // the layout's too — so a string need is matched on name and range alone.
    if (need.type === "string") return true;
    if (need.type === "json") return JSON.stringify(variable.defaultValue ?? []) === JSON.stringify(need.defaultValue);
    return variable.defaultValue === need.defaultValue;
  });
}

export interface TemplateLeftoverArgs {
  /** The draft AFTER the switch — new uiDoc, new variables. */
  world: WorldDefinition;
  /** The uiDoc as it was before the switch. */
  previousDoc: UiDoc | undefined;
  /** Which official layout the previous doc was; null when it was none. */
  previousTemplateId: string | null;
  /** The localized names the layouts give their variables, by need key. */
  variableNames?: Record<string, string>;
}

/** Variables the previous layout bound, the new one does not, nothing else in
 *  the card references, and that still look exactly as the layout made them. */
export function findTemplateLeftovers({ world, previousDoc, previousTemplateId, variableNames }: TemplateLeftoverArgs): Variable[] {
  const template = previousTemplateId ? getUiTemplate(previousTemplateId) : null;
  if (!template || !previousDoc) return [];
  const before = collectBoundVariableIds(previousDoc);
  const after = collectBoundVariableIds(world.uiDoc);
  return world.variables.filter((variable) => {
    if (!before.has(variable.id) || after.has(variable.id)) return false;
    if (!isTemplateShaped(variable, template.needs, variableNames)) return false;
    // `references` is the proven list; code reviews are advisory (a compiled
    // interface file quotes every id it ever bound) and do not count.
    return getVariableIdUsage(world, variable).references.length === 0;
  });
}
