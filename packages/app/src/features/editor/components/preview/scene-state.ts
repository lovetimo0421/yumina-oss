import type { Worldbook } from "@yumina/engine";

export type SceneVarValue = number | string | boolean | Record<string, unknown> | unknown[];

/**
 * The preview variables that put a module on — what "preview the interface
 * as this module" sets.
 *
 * Only an `eq` condition against a literal names a value to force. A `gte`
 * has no single value, a keyword module is opened by a word not a variable,
 * and a manual one by the player: null for all of those, which the chip
 * shows as "cannot preview". The card's own routing usually reads the same
 * variable, so forcing it shows the module's scene too.
 */
export function moduleSceneState(book: Worldbook): Record<string, SceneVarValue> | null {
  const a = book.activation;
  if (a.mode !== "conditions") return null;
  const out: Record<string, SceneVarValue> = {};
  let any = false;
  for (const c of a.conditions) {
    if (c.operator !== "eq" || c.valueRef) continue;
    out[c.variableId] = c.value;
    any = true;
  }
  return any ? out : null;
}
